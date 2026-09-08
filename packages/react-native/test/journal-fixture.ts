import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { JournalPort, BindingPublication, EventReceipt, JournalPrefix, ControlRow, ControlReceipt, DisplayTag, DisplayReceipt } from '../src/journal.js';
import type { LocalState } from '../src/storage.js';
import { GalinumError } from '../src/types.js';
import type { PushCommand } from '@galinum/contracts';

type Waiter = { resolve(value: EventReceipt): void; reject(error: unknown): void };
type Ticket = { id: string; eventId: string; intent: number; event?: { event: string; eventId: string; propsJson: string }; waiters: Waiter[] };
type Stream = { userId: string | null; commands: PushCommand[]; ack: number; batch?: PushCommand[] };
type Proposal = { fence: number; deadline: number; controlRevision: number; userId: string; operationId: string };
export type ControlHooks = { commit: (perform: () => Promise<ControlReceipt>, context: { state: LocalState; restrict: boolean }) => Promise<ControlReceipt>; read: (perform: () => Promise<ControlRow | null>) => Promise<ControlRow | null>; publish: (perform: () => Promise<DisplayReceipt>) => Promise<DisplayReceipt> };
export function testJournal() {
  const streams = new Map<number, Stream>();
  const events = new Map<string, { userId: string; event: string; propsJson: string; generation: number; sequence: number }>();
  const tickets = new Map<string, Ticket>();
  const operations = new Map<string, { revision: number; kind: string; disposition: string }>();
  const proposals = new Map<string, Proposal>();
  let row: ControlRow | null = null;
  let owner: string | undefined, intent = 0, initial = false, opened = false, fence = 0, displayOpen = false, inFlight = 0;
  let binding: BindingPublication | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  let releasing = false;
  const serial = <T>(run: () => Promise<T>) => { const next = writes.then(run); writes = next.catch(() => {}); return next; };
  const hooks: ControlHooks = { commit: perform => perform(), read: perform => perform(), publish: perform => perform() };
  const operationLog: { kind: string; id: string; revision: number }[] = [];
  const current = (supplied: string, captured = intent) => { if (supplied !== owner || captured !== intent) throw new GalinumError('superseded'); };
  const restrict = () => { fence++; displayOpen = false; };
  const drain = () => {
    for (const [id, ticket] of tickets) {
      if (ticket.intent === 0 && !initial && intent !== Number.MAX_SAFE_INTEGER) return;
      if (ticket.intent !== intent) { tickets.delete(id);for (const waiter of ticket.waiters) waiter.reject(new GalinumError('superseded'));continue; }
      if (!opened || !binding || !ticket.event) return;
      try {
        if (!binding.userId) throw new GalinumError('identify_required');
        const stream = streams.get(binding.generation)!;
        const old = events.get(ticket.eventId);
        if (old && (old.userId !== binding.userId || old.event !== ticket.event.event || old.propsJson !== ticket.event.propsJson)) throw new GalinumError('event_conflict');
        if (old && old.generation !== binding.generation && old.sequence > streams.get(old.generation)!.ack) throw new GalinumError('event_pending_old_binding');
        if (!old) {
          const sequence = stream.commands.length + 1;
          stream.commands.push({ kind: 'event', id, sequence, eventId: ticket.eventId, event: ticket.event.event, props: JSON.parse(ticket.event.propsJson) });
          events.set(ticket.eventId, { ...ticket.event, userId: binding.userId, generation: binding.generation, sequence });
        }
        const saved = events.get(ticket.eventId)!;
        const receipt: EventReceipt = { eventId: ticket.eventId, state: saved.sequence <= streams.get(saved.generation)!.ack ? 'acknowledged' : 'queued' };
        for (const waiter of ticket.waiters) waiter.resolve(receipt);
      } catch (error) { for (const waiter of ticket.waiters) waiter.reject(error); }
      tickets.delete(id);
    }
  };
  const port: JournalPort = {
    claim: () => {
      if (owner || inFlight > 0) throw new GalinumError('journal_writer_busy');
      intent = 0;initial = false;binding = undefined;fence++;releasing = false;owner = randomUUID();return owner;
    },
    reserve: (_s, supplied, captured, eventId) => {
      current(supplied, captured);
      for (const ticket of tickets.values()) if (eventId && ticket.eventId === eventId && ticket.intent === captured) return { id: ticket.id, eventId, reused: true };
      const id = randomUUID();eventId ||= id;tickets.set(id, { id, eventId, intent: captured, waiters: [] });return { id, eventId };
    },
    resolveInitialIntent: (_s, supplied, destination) => { current(supplied);initial = true;for (const ticket of tickets.values()) if (ticket.intent === 0) ticket.intent = destination;drain(); },
    setIntent: (_s, supplied, value) => { current(supplied);intent = value;binding = undefined;restrict();drain(); },
    rejectTicket: (_s, supplied, id) => { current(supplied);const ticket = tickets.get(id);tickets.delete(id);for (const waiter of ticket?.waiters ?? []) waiter.reject(new GalinumError('invalid_event'));drain(); },
    restrictDisplay: (_s, supplied) => { current(supplied);restrict(); },
    proposeDisplay: (_s, supplied, proposal) => {
      current(supplied);const id = randomUUID();
      proposals.set(id, { fence, deadline: Date.now() + proposal.deadlineMs, controlRevision: proposal.controlRevision, userId: proposal.userId, operationId: proposal.operationId });
      return id;
    },
    open: async (_s, supplied) => { current(supplied);opened = true; },
    readControl: (_s, supplied) => hooks.read(async () => { current(supplied);return structuredClone(row); }),
    commitControl: (_s, supplied, operationId, expected, state, restrictRequested) => {
      current(supplied);if (releasing) throw new GalinumError("journal_owner_stale");
      state = structuredClone(state);
      inFlight++;
      return serial(() => hooks.commit(async () => {
        current(supplied);
        if ((row ? row.revision : null) !== expected) throw new GalinumError('control_stale');
        const previous = row?.state;
        const restrictive = restrictRequested || !!previous && (previous.session.userId !== state.session.userId || previous.session.consent !== state.session.consent || previous.bindingRevision !== state.bindingRevision);
        const display: DisplayTag = restrictive ? 'closed' : row?.display ?? 'closed';
        row = { revision: (row?.revision ?? 0) + 1, state: structuredClone(state), display };
        if (restrictive) displayOpen = false;
        operations.set(operationId, { revision: row.revision, kind: 'control', disposition: restrictive ? 'closed' : 'kept' });
        operationLog.push({ kind: restrictive ? 'close' : 'control', id: operationId, revision: row.revision });
        return { operationId, revision: row.revision, display, restrictive };
      }, { state, restrict: restrictRequested })).finally(() => { inFlight--; });
    },
    operation: async (_s, supplied, operationId) => { current(supplied);const saved = operations.get(operationId);return saved ? { state: 'committed', ...saved } : { state: 'unknown' }; },
    publishDisplay: async (_s, supplied, id) => {
      current(supplied);const proposal = proposals.get(id);proposals.delete(id);
      if (!proposal) throw new GalinumError('invalid_proposal');
      if (proposal.fence !== fence) throw new GalinumError('publication_stale');
      if (Date.now() > proposal.deadline) throw new GalinumError('publication_expired');
      inFlight++;
      try { return await hooks.publish(async () => {
        if (!operations.has(proposal.operationId)) throw new GalinumError('publication_stale');
        if (!row || row.revision !== proposal.controlRevision || row.state.session.userId !== proposal.userId || !row.state.session.consent || row.state.bindingRevision !== row.state.acknowledgedBindingRevision) throw new GalinumError('display_ineligible');
        row = { ...row, display: 'open' };
        operations.set(id, { revision: row.revision, kind: 'open', disposition: 'open' });
        operationLog.push({ kind: 'open', id, revision: row.revision });
        const live = proposal.fence === fence;
        if (live) displayOpen = true;
        return { state: live ? 'open' : 'open-then-restricted', publicationId: id, controlRevision: row.revision };
      }); } finally { inFlight--; }
    },
    closeGate: async (_s, supplied) => { current(supplied);binding = undefined; },
    publishBinding: async (_s, supplied, captured, proof) => {
      current(supplied, captured);
      if (proof.bindingRevision !== proof.acknowledgedBindingRevision) throw new GalinumError('binding_unacknowledged');
      if (!row || row.state.bindingRevision !== proof.bindingRevision || row.state.acknowledgedBindingRevision !== proof.acknowledgedBindingRevision || row.state.session.userId !== proof.userId || row.state.installationId !== proof.installationId) throw new GalinumError('binding_unacknowledged');
      if (!streams.has(proof.generation)) streams.set(proof.generation, { userId: proof.userId, commands: [], ack: 0 });
      if (streams.get(proof.generation)!.userId !== proof.userId) throw new GalinumError('binding_generation_conflict');
      binding = structuredClone(proof);drain();
    },
    admitEvent: (_s, supplied, id, encoded) => new Promise((resolve, reject) => {
      current(supplied);const ticket = tickets.get(id);if (!ticket) throw new GalinumError('ticket_missing');
      const event = JSON.parse(encoded);
      if (ticket.event && JSON.stringify(ticket.event) !== encoded) throw new GalinumError('event_conflict');
      ticket.event = event;ticket.waiters.push({ resolve, reject });drain();
    }),
    peek: async (_s, supplied, captured): Promise<JournalPrefix> => {
      current(supplied, captured);if (!binding) throw new GalinumError('binding_unacknowledged');
      const stream = streams.get(binding.generation)!;
      const batch = stream.batch ?? stream.commands.slice(stream.ack, stream.ack + 32);
      while (Buffer.byteLength(JSON.stringify({ bindingGeneration: binding.generation, commands: batch })) > 65536) batch.pop();
      if (batch.length) stream.batch = batch;
      return structuredClone({ generation: binding.generation, acknowledgedThrough: stream.ack, lastSequence: stream.commands.length, commands: batch, pendingAdmissions: tickets.size, appConfirmed: binding.appConfirmed });
    },
    acknowledge: async (_s, supplied, captured, generation, through) => { current(supplied, captured);const stream = streams.get(generation)!;if (stream.batch?.at(-1)?.sequence !== through) throw new GalinumError('invalid_acknowledgement');stream.ack = through;stream.batch = undefined; },
    release: (_s, supplied) => {
      current(supplied);releasing = true;binding = undefined;restrict();
      return serial(async () => { if (row) row = { ...row, display: 'closed' };owner = undefined; });
    },
  };
  const control = {
    state: () => structuredClone(row?.state),
    display: () => row?.display ?? 'closed',
    displayOpen: () => displayOpen,
    revision: () => row?.revision ?? null,
    size: () => (row ? 1 : 0),
    log: () => operationLog.slice(),
    set: (state: LocalState) => { row = { revision: row?.revision ?? 1, state: structuredClone(state), display: row?.display ?? 'closed' }; },
    clear: () => { row = null; },
  };
  return { port, hooks, control, released: () => vi.waitFor(() => { if (owner) throw new Error('Journal owner not released'); }) };
}
