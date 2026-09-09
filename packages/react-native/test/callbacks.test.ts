import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { deferred, fixture } from './fixture.js';
import type { NotificationInteraction } from '../src/journal.js';
import type { GalinumSession, NotificationHandler } from '../src/types.js';

const interaction = (id: string, userId: string, bindingGeneration: number): NotificationInteraction => ({
  id, userId, bindingGeneration, kind: 'tap', targetId: `target-${id}`, attemptId: `attempt-${id}`,
  test: false, destination: { kind: 'app', url: 'example://notification' }, data: {},
  title: 'Notification', body: 'Callback fixture', receivedAt: 1, interactedAt: 2,
});
const settleCallbacks = async () => { await setImmediate(); await setImmediate(); };

it.each(['client', 'session'] as const)('lets a cold callback await %s.track without blocking identify or ingress order', async source => {
  const f = await fixture();
  const previous = f.create();
  await previous.identify('A');
  const generation = previous.getSnapshot().installation!.bindingGeneration;
  previous.dispose();
  await f.journalReleased();
  f.control.capture(interaction('cold', 'A', generation));
  const client = f.create();
  const receipts: string[] = [];
  client.setNotificationHandler(async (notification, session) => {
    expect(Object.isFrozen(session)).toBe(true);
    const receipt = await (source === 'client' ? client : session).track('opened', {}, { eventId: notification.id });
    receipts.push(receipt.eventId);
  });
  await client.identify('A');
  await vi.waitFor(() => expect(receipts).toEqual(['cold']));
  await vi.waitFor(() => expect(f.control.interactions()).toEqual([{ id: 'cold', status: 'handled' }]));
  await client.track('after_callback', {}, { eventId: 'after' });
  await client.flush();
  const commands = f.requests.filter(request => request.path.endsWith('/observations'))
    .flatMap(request => request.body!.commands as { eventId: string; sequence: number }[]);
  expect(commands.map(command => [command.eventId, command.sequence])).toEqual([['cold', 1], ['after', 2]]);
});

it.each(['switch', 'reset'] as const)('allows %s and new callbacks while an old callback is pending', async change => {
  const f = await fixture();
  const client = f.create();
  await client.identify('A');
  const release = deferred<void>();
  let captured: GalinumSession | undefined;
  const resumed: unknown[] = [];
  const seen: string[] = [];
  const acknowledge = vi.spyOn(f.adapter.journal, 'acknowledgeInteraction');
  client.setNotificationHandler(async (notification, session) => {
    seen.push(notification.id);
    if (notification.id === 'old') {
      captured = session;
      await release.promise;
      try { await session.track('late', {}, { eventId: 'late' }); } catch (error) { resumed.push(error); }
    }
  });
  f.control.capture(interaction('old', 'A', client.getSnapshot().installation!.bindingGeneration));
  try {
    await vi.waitFor(() => expect(captured).toBeDefined());
    if (change === 'reset') await client.reset();
    const userId = change === 'reset' ? 'A' : 'B';
    await client.identify(userId);
    f.control.capture(interaction('new', userId, client.getSnapshot().installation!.bindingGeneration));
    await vi.waitFor(() => expect(seen).toEqual(['old', 'new']));
    await vi.waitFor(() => expect(f.control.interactions()[1]?.status).toBe('handled'));
    const calls = f.requests.length;
    for (const run of [
      () => captured!.track('stale', {}, { eventId: 'stale' }),
      () => captured!.setConsent(true), () => captured!.requestPermission(),
      () => captured!.syncDevice(), () => captured!.recordForegroundActivity(),
    ]) await expect(run()).rejects.toMatchObject({ code: 'superseded' });
    expect(f.requests).toHaveLength(calls);
  } finally { release.resolve(); }
  await settleCallbacks();
  expect(resumed).toEqual([expect.objectContaining({ code: 'superseded' })]);
  expect(acknowledge.mock.calls.map(call => call.slice(3))).toEqual([['new', 'handled']]);
});

it('leaves a completed callback pending after its router unregisters', async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify('A');
  const release = deferred<void>();
  let captured: GalinumSession | undefined;
  const handler = vi.fn<NotificationHandler>(async (_notification, session) => { captured = session; await release.promise; });
  const unregister = client.setNotificationHandler(handler);
  f.control.capture(interaction('unregistered', 'A', client.getSnapshot().installation!.bindingGeneration));
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  unregister();
  await expect(captured!.track('unregistered')).rejects.toMatchObject({ code: 'superseded' });
  release.resolve();
  await settleCallbacks();
  expect(f.control.interactions()).toEqual([{ id: 'unregistered', status: 'pending' }]);
  const retry = vi.fn();
  client.setNotificationHandler(retry);
  await vi.waitFor(() => expect(f.control.interactions()[0]?.status).toBe('handled'));
  expect(retry.mock.calls[0]![0].id).toBe('unregistered');
});

it('gives each router registration its own fence even when the function is reused', async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify('A');
  const release = deferred<void>();
  const acknowledge = vi.spyOn(f.adapter.journal, 'acknowledgeInteraction');
  const handler = vi.fn<NotificationHandler>(async () => { if (handler.mock.calls.length === 1) await release.promise; });
  const unregister = client.setNotificationHandler(handler);
  f.control.capture(interaction('replacement', 'A', client.getSnapshot().installation!.bindingGeneration));
  try {
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    client.setNotificationHandler(handler);
    unregister();
    await vi.waitFor(() => expect(f.control.interactions()[0]?.status).toBe('handled'));
    expect(handler).toHaveBeenCalledTimes(2);
  } finally { release.resolve(); }
  await settleCallbacks();
  expect(handler).toHaveBeenCalledTimes(2);
  expect(acknowledge).toHaveBeenCalledOnce();
});

it('fences disposed callback sessions and acknowledgements after another owner attaches', async () => {
  const f = await fixture();
  const first = f.create();
  await first.identify('A');
  const release = deferred<void>();
  let captured: GalinumSession | undefined;
  first.setNotificationHandler(async (_notification, session) => { captured = session; await release.promise; });
  f.control.capture(interaction('owner', 'A', first.getSnapshot().installation!.bindingGeneration));
  await vi.waitFor(() => expect(captured).toBeDefined());
  first.dispose();
  await f.journalReleased();
  const second = f.create();
  await second.identify('A');
  const acknowledge = vi.spyOn(f.adapter.journal, 'acknowledgeInteraction');
  release.resolve();
  await settleCallbacks();
  await expect(captured!.track('stale')).rejects.toMatchObject({ code: 'disposed' });
  expect(acknowledge).not.toHaveBeenCalled();
  expect(f.control.interactions()[0]?.status).toBe('pending');
  second.setNotificationHandler(() => {});
  await vi.waitFor(() => expect(f.control.interactions()[0]?.status).toBe('handled'));
});

it('serializes callbacks within a live registration while business operations continue', async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify('A');
  const release = deferred<void>();
  const seen: string[] = [];
  client.setNotificationHandler(async notification => {
    seen.push(notification.id);
    if (notification.id === 'first') await release.promise;
  });
  const generation = client.getSnapshot().installation!.bindingGeneration;
  f.control.capture(interaction('first', 'A', generation));
  f.control.capture(interaction('second', 'A', generation));
  try {
    await vi.waitFor(() => expect(seen).toEqual(['first']));
    await client.track('independent', {}, { eventId: 'independent' });
    await client.flush();
    expect(seen).toEqual(['first']);
  } finally { release.resolve(); }
  await vi.waitFor(() => expect(f.control.interactions().map(entry => entry.status)).toEqual(['handled', 'handled']));
  expect(seen).toEqual(['first', 'second']);
});

it.each(['switch', 'replace'] as const)('discards an obsolete interaction read after router or identity %s', async change => {
  const f = await fixture();
  const client = f.create();
  await client.identify('A');
  const generation = client.getSnapshot().installation!.bindingGeneration;
  f.control.capture(interaction('read', 'A', generation));
  const release = deferred<void>();
  const read = f.adapter.journal.readInteractions;
  const pending = vi.spyOn(f.adapter.journal, 'readInteractions').mockImplementationOnce(async (...args) => {
    const entries = await read(...args);
    await release.promise;
    return entries;
  });
  const old = vi.fn();
  const next = vi.fn();
  const acknowledge = vi.spyOn(f.adapter.journal, 'acknowledgeInteraction');
  client.setNotificationHandler(old);
  try {
    await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
    if (change === 'switch') {
      await client.identify('B');
      f.control.capture(interaction('new-read', 'B', client.getSnapshot().installation!.bindingGeneration));
    }
    client.setNotificationHandler(next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
  } finally { release.resolve(); }
  await settleCallbacks();
  expect(old).not.toHaveBeenCalled();
  expect(acknowledge.mock.calls.map(call => call.slice(3))).toEqual([[change === 'switch' ? 'new-read' : 'read', 'handled']]);
});

it('retries the stable interaction ID when acknowledgement fails after application work', async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify('A');
  const acknowledge = vi.spyOn(f.adapter.journal, 'acknowledgeInteraction').mockRejectedValueOnce(new Error('lost acknowledgement'));
  const handler = vi.fn<NotificationHandler>(async (notification, session) => {
    await session.track('opened', {}, { eventId: notification.id });
  });
  client.setNotificationHandler(handler);
  await settleCallbacks();
  f.control.capture(interaction('ack-retry', 'A', client.getSnapshot().installation!.bindingGeneration));
  await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
  expect(f.control.interactions()[0]?.status).toBe('pending');
  client.setNotificationHandler(handler);
  await vi.waitFor(() => expect(f.control.interactions()[0]?.status).toBe('handled'));
  expect(handler.mock.calls.map(call => call[0].id)).toEqual(['ack-retry', 'ack-retry']);
  await client.flush();
  const commands = f.requests.filter(request => request.path.endsWith('/observations'))
    .flatMap(request => request.body!.commands as { eventId: string }[]);
  expect(commands.map(command => command.eventId)).toEqual(['ack-retry']);
});

it('fences a pending callback when reconciliation discovers a new binding for the same user', async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify('A');
  const generation = client.getSnapshot().installation!.bindingGeneration;
  const release = deferred<void>();
  let captured: GalinumSession | undefined;
  const acknowledge = vi.spyOn(f.adapter.journal, 'acknowledgeInteraction');
  client.setNotificationHandler(async (notification, session) => {
    if (notification.id === 'old-binding') { captured = session; await release.promise; }
  });
  f.control.capture(interaction('old-binding', 'A', generation));
  try {
    await vi.waitFor(() => expect(captured).toBeDefined());
    expect((await f.mutate('binding', { userId: null })).status).toBe(200);
    expect((await f.mutate('binding', { userId: 'A' })).status).toBe(200);
    await client.start();
    const nextGeneration = client.getSnapshot().installation!.bindingGeneration;
    expect(nextGeneration).toBeGreaterThan(generation);
    f.control.capture(interaction('new-binding', 'A', nextGeneration));
    await vi.waitFor(() => expect(f.control.interactions()[1]?.status).toBe('handled'));
    await expect(captured!.track('stale')).rejects.toMatchObject({ code: 'superseded' });
  } finally { release.resolve(); }
  await settleCallbacks();
  expect(acknowledge.mock.calls.map(call => call.slice(3))).toEqual([['new-binding', 'handled']]);
});
