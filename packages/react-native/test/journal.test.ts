import { expect, expectTypeOf, it, vi } from 'vitest';
import { JournalController, type JournalPort, type BindingPublication, type JournalPrefix, type EventReceipt, type ControlRow } from '../src/journal.js';
import { GalinumError } from '../src/types.js';
import { deferred, fixture } from './fixture.js';

const seeded = (f: Awaited<ReturnType<typeof fixture>>): ControlRow => ({ revision: f.control.revision()!, state: f.control.state()!, display: 'closed' });

function journal(initial: ControlRow | null = null) {
  let initialResolved = false;
  let owner: string | undefined, intent = 0, serial = 0, gate: BindingPublication | undefined;
  const commands: any[] = [], reservations: string[] = [];
  const tickets = new Map<string, { intent: number; eventId: string; encoded?: string; done?: ReturnType<typeof deferred<EventReceipt>> }>();
  let ack = 0, batch: any[] | undefined;
  let row: ControlRow | null = initial;
  const drain = () => {
    for (const [id, ticket] of tickets) {
      if (ticket.intent === 0 && !initialResolved && intent !== Number.MAX_SAFE_INTEGER) return;
      if (ticket.intent !== intent) { ticket.done?.reject(new GalinumError('superseded')); tickets.delete(id); continue; }
      if (!gate || !ticket.encoded || !ticket.done) return;
      const data = JSON.parse(ticket.encoded);
      commands.push({ id, sequence: commands.length + 1, kind: 'event', eventId: data.eventId, event: data.event, props: JSON.parse(data.propsJson) });
      ticket.done.resolve({ eventId: data.eventId, state: 'queued' }); tickets.delete(id);
    }
  };
  const port: JournalPort = {
    claim: () => { if (owner) throw new GalinumError('journal_writer_busy'); return owner = 'owner'; },
    reserve: (_s, _o, capture, eventId) => {
      if (capture !== intent) throw new GalinumError('superseded');
      const id = `ticket-${++serial}`; eventId ||= id; reservations.push(id); tickets.set(id, { intent: capture, eventId });return { id, eventId };
    },
    resolveInitialIntent: (_s, _o, destination) => { initialResolved = true;for (const ticket of tickets.values()) if (ticket.intent === 0) ticket.intent = destination;drain(); },
    setIntent: (_s, _o, value) => { intent = value;gate = undefined;drain(); },
    rejectTicket: (_s, _o, id) => { tickets.get(id)?.done?.reject(new GalinumError('superseded'));tickets.delete(id);drain(); },
    restrictDisplay: () => {},
    proposeDisplay: () => 'proposal',
    open: vi.fn(async () => {}),
    readControl: vi.fn(async () => structuredClone(row)),
    commitControl: vi.fn(async (_s, _o, operationId, _e, state, restrict) => { row = { revision: (row?.revision ?? 0) + 1, state: structuredClone(state), display: 'closed' };return { operationId, revision: row.revision, display: 'closed' as const, restrictive: restrict }; }),
    operation: vi.fn(async () => ({ state: 'unknown' as const })),
    publishDisplay: vi.fn(async () => { throw new GalinumError('display_ineligible'); }),
    closeGate: vi.fn(async () => { gate = undefined; }),
    publishBinding: vi.fn(async (_s, _o, capture, proof) => { if (capture !== intent) throw new GalinumError('superseded');gate = proof;drain(); }),
    admitEvent: (_s, _o, id, encoded) => { const ticket = tickets.get(id)!;ticket.encoded = encoded;ticket.done = deferred<EventReceipt>();drain();return ticket.done.promise; },
    peek: vi.fn(async () => {
      if (!gate) throw new GalinumError('binding_unacknowledged');
      const prefix = batch ?? commands.slice(ack, ack + 32);if (prefix.length) batch = prefix;
      return { generation: gate.generation, acknowledgedThrough: ack, lastSequence: commands.length, commands: prefix, pendingAdmissions: tickets.size, appConfirmed: gate.appConfirmed } as JournalPrefix;
    }),
    acknowledge: vi.fn(async (_s, _o, _i, _g, through) => { ack = through;batch = undefined; }),
    release: vi.fn(async () => { owner = undefined; }),
  };
  return { port, reservations, commands };
}

it('reserves before a blocked native bootstrap and retains the actual opening barrier after timeout', async () => {
  const j = journal(), opening = deferred<void>();
  vi.mocked(j.port.open).mockReturnValue(opening.promise);
  const controller = new JournalController(j.port, 'scope', 5);
  const ticket = controller.reserve(0, 'business');
  expect(j.port.open).not.toHaveBeenCalled();
  await expect(controller.admit(ticket, JSON.stringify({ event: 'one', eventId: 'business', propsJson: '{}' }))).rejects.toMatchObject({ code: 'journal_storage_timeout', eventId: 'business' });
  expect(j.port.open).toHaveBeenCalledOnce();
  controller.dispose();
  expect(j.port.release).not.toHaveBeenCalled();
  expect(() => new JournalController(j.port, 'scope', 5)).toThrow('journal_writer_busy');
  opening.resolve();
  await vi.waitFor(() => expect(j.port.release).toHaveBeenCalledOnce());
});

it('surfaces a native missing-key bootstrap failure without JS key handling', async () => {
  const j = journal();vi.mocked(j.port.open).mockRejectedValue(new GalinumError('journal_key_missing'));
  const controller = new JournalController(j.port, 'scope', 100);
  await expect(controller.close(0)).rejects.toMatchObject({ code: 'journal_key_missing' });
  await expect(controller.readControl()).rejects.toMatchObject({ code: 'journal_key_missing' });
  expect(j.port.open).toHaveBeenCalledTimes(2);expect(j.port.commitControl).not.toHaveBeenCalled();controller.dispose();
});

it('does not report durable closure until the native write completes', async () => {
  const j = journal(), write = deferred<void>();vi.mocked(j.port.closeGate).mockReturnValue(write.promise);
  const controller = new JournalController(j.port, 'scope', 5);
  await expect(controller.close(0)).rejects.toMatchObject({ code: 'journal_storage_timeout' });
  write.resolve();controller.dispose();
});

it('tracks immediately after identify intent with blocked initialization, without push consent', async () => {
  const f = await fixture(), j = journal(), latch = deferred<void>();f.adapter.journal = j.port;
  vi.mocked(j.port.readControl).mockImplementationOnce(async () => { await latch.promise;return null; });
  const client = f.create();const identify = client.identify('A');
  const event = client.track('ordered', { nested: { array: [null, true, 2.5] } }, { eventId: 'business-E' });
  expect(j.reservations).toHaveLength(1);expect(f.requests).toHaveLength(0);
  latch.resolve();await identify;expect(await event).toEqual({ eventId: 'business-E', state: 'queued' });await client.flush();
  expect(j.commands[0].props).toEqual({ nested: { array: [null, true, 2.5] } });
  expect((await f.inspect())[0].consent).toBe(false);expect(f.adapter.requestPermission).not.toHaveBeenCalled();
  expect(f.requests.filter(r => r.path === '/api/v1/track')).toHaveLength(0);
});

it('retries exact command bodies after a server-applied lost response and preserves nested data', async () => {
  const f = await fixture(), j = journal();f.adapter.journal = j.port;
  let lose = true;
  const client = f.create({ fetch: async (input, init) => { const response = await f.transport(input, init);if (lose && String(input).endsWith('/observations')) throw new Error('response lost');return response; } });
  await client.identify('A');await client.track('ordered', { b: [false, null], a: { value: 3 } }, { eventId: 'same-E' });
  await expect(client.flush()).rejects.toMatchObject({ code: 'transport_uncertain' });
  expect(j.port.acknowledge).not.toHaveBeenCalled();lose = false;await client.flush();
  const requests = f.requests.filter(r => r.path.endsWith('/observations'));
  expect(requests.length).toBeGreaterThan(1);for (const request of requests) expect(request.body).toEqual(requests[0]!.body);
  expect(j.port.acknowledge).toHaveBeenCalledOnce();
});

it('reset closes native admission before waiting on the foundation and rejects old captured work', async () => {
  const f = await fixture(), j = journal();f.adapter.journal = j.port;
  const client = f.create();await client.identify('A');const old = client.session();
  const close = deferred<void>();vi.mocked(j.port.closeGate).mockReturnValueOnce(close.promise);
  let resolved = false;const reset = client.reset().then(() => { resolved = true; });
  await expect(old.track('old')).rejects.toMatchObject({ code: 'superseded' });
  await vi.waitFor(async () => expect((await f.inspect())[0].userId).toBeNull());expect(resolved).toBe(false);
  close.resolve();await reset;
});

it('rehydration alone does not publish app-auth confirmation', async () => {
  const f = await fixture();const seed = f.create();await seed.identify('A');seed.dispose();
  const j = journal(seeded(f));f.adapter.journal = j.port;const client = f.create();await client.start();
  expect(vi.mocked(j.port.publishBinding).mock.calls.at(-1)![3].appConfirmed).toBe(false);
  await client.identify('A');expect(vi.mocked(j.port.publishBinding).mock.calls.at(-1)![3].appConfirmed).toBe(true);
});


it('preserves an earlier unresolved event when identify confirms the same stored user', async () => {
  const f = await fixture();const seed = f.create();await seed.identify('A');seed.dispose();
  const j = journal(seeded(f)), latch = deferred<void>();f.adapter.journal = j.port;
  const read = j.port.readControl;vi.mocked(j.port.readControl).mockImplementationOnce(async (...args) => { await latch.promise;return read(...args); });
  const client = f.create();const event = client.track('earlier', {}, { eventId: 'initial-E' });
  const identity = client.identify('A');latch.resolve();
  expect(await event).toEqual({ eventId: 'initial-E', state: 'queued' });await identity;await client.flush();
  expect(j.commands).toHaveLength(1);
});

it('does not adopt an unresolved old-user event into a different identified user', async () => {
  const f = await fixture();const seed = f.create();await seed.identify('A');seed.dispose();
  const j = journal(seeded(f)), latch = deferred<void>();f.adapter.journal = j.port;
  const read = j.port.readControl;vi.mocked(j.port.readControl).mockImplementationOnce(async (...args) => { await latch.promise;return read(...args); });
  const client = f.create();const event = client.track('earlier', {}, { eventId: 'initial-A' });
  const rejected = expect(event).rejects.toMatchObject({ code: 'superseded' });
  const identity = client.identify('B');latch.resolve();await rejected;await identity;
  expect(j.commands).toHaveLength(0);
});


it('flush covers a later watermark while an older batch is still in flight', async () => {
  const f = await fixture(), j = journal(), held = deferred<void>(), entered = deferred<void>();f.adapter.journal = j.port;
  let first = true;
  const client = f.create({ fetch: async (input, init) => {
    if (String(input).endsWith('/observations') && first) { first = false;entered.resolve();await held.promise; }
    return f.transport(input, init);
  } });
  await client.identify('A');await client.track('first', {}, { eventId: 'one' });await entered.promise;
  await client.track('second', {}, { eventId: 'two' });const flushed = client.flush();held.resolve();await flushed;
  expect(vi.mocked(j.port.acknowledge).mock.calls.at(-1)![4]).toBe(2);
});


it('requires a journal for every adapter and returns an event receipt type', async () => {
  const f = await fixture();
  expectTypeOf<ReturnType<import('../src/client.js').GalinumClient['track']>>().toEqualTypeOf<Promise<EventReceipt>>();
  expectTypeOf<import('../src/types.js').NativeAdapter['journal']>().toEqualTypeOf<JournalPort>();
  const adapter = { ...f.adapter, journal: undefined } as unknown as import('../src/types.js').NativeAdapter;
  expect(() => f.create({ adapter })).toThrow('journal_required');
  expect(f.requests).toHaveLength(0);expect(f.secrets.size).toBe(0);
});
