import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { JournalPort, BindingPublication, EventReceipt, JournalPrefix } from '../src/journal.js';
import { GalinumError } from '../src/types.js';
import type { PushCommand } from '@galinum/contracts';

type Waiter = { resolve(value: EventReceipt): void; reject(error: unknown): void };
type Ticket = { id: string; eventId: string; intent: number; event?: { event: string; eventId: string; propsJson: string }; waiters: Waiter[] };
type Stream = { userId: string | null; commands: PushCommand[]; ack: number; batch?: PushCommand[] };
export function testJournal() {
  const streams = new Map<number, Stream>();
  const events = new Map<string, { userId: string; event: string; propsJson: string; generation: number; sequence: number }>();
  const tickets = new Map<string, Ticket>();
  let owner: string | undefined, intent = 0, initial = false, opened = false;
  let binding: BindingPublication | undefined;
  const current = (supplied: string, captured = intent) => { if (supplied !== owner || captured !== intent) throw new GalinumError('superseded'); };
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
    claim: () => { if (owner) throw new GalinumError('journal_writer_busy');intent = 0;initial = false;binding = undefined;owner = randomUUID();return owner; },
    reserve: (_s, supplied, captured, eventId) => {
      current(supplied, captured);
      for (const ticket of tickets.values()) if (eventId && ticket.eventId === eventId && ticket.intent === captured) return { id: ticket.id, eventId, reused: true };
      const id = randomUUID();eventId ||= id;tickets.set(id, { id, eventId, intent: captured, waiters: [] });return { id, eventId };
    },
    resolveInitialIntent: (_s, supplied, destination) => { current(supplied);initial = true;for (const ticket of tickets.values()) if (ticket.intent === 0) ticket.intent = destination;drain(); },
    setIntent: (_s, supplied, value) => { current(supplied);intent = value;binding = undefined;drain(); },
    rejectTicket: (_s, supplied, id) => { current(supplied);const ticket = tickets.get(id);tickets.delete(id);for (const waiter of ticket?.waiters ?? []) waiter.reject(new GalinumError('invalid_event'));drain(); },
    hasStore: async () => opened,
    open: async (_s, supplied) => { current(supplied);opened = true; },
    closeGate: async (_s, supplied) => { current(supplied);binding = undefined; },
    publishBinding: async (_s, supplied, captured, proof) => {
      current(supplied, captured);
      if (proof.bindingRevision !== proof.acknowledgedBindingRevision) throw new GalinumError('binding_unacknowledged');
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
    release: async (_s, supplied) => { current(supplied);binding = undefined;owner = undefined; },
  };
  return { port, released: () => vi.waitFor(() => { if (owner) throw new Error('Journal owner not released'); }) };
}
