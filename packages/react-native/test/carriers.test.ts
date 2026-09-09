import { expect, it, vi } from 'vitest';
import { fixture } from './fixture.js';
import type { NotificationInteraction } from '../src/journal.js';

const notifications = { channels: [{ id: 'updates', name: 'Updates' }], actions: [{ id: 'open', title: 'Open' }] };
const interaction = (id: string, userId: string, bindingGeneration: number, actionId?: string): NotificationInteraction => ({ id, kind: actionId ? 'action' : 'tap', ...(actionId ? { actionId } : {}), targetId: 'target-' + id, attemptId: 'attempt-' + id, test: false, userId, bindingGeneration, destination: { kind: 'app', url: 'galinum-verify://journal' }, data: {}, title: 'Journal', body: 'Native fixture', receivedAt: 1, interactedAt: 2 });

it('advertises only the capabilities returned by native notification setup', async () => {
  const f = await fixture();
  const plain = f.create();
  await plain.identify('A');
  expect((await f.inspect())[0].capabilities).toEqual({ actions: [], channels: [], richImages: false });
  plain.dispose();await f.journalReleased();
  const client = f.create({ notifications });
  await client.start();
  expect((await f.inspect())[0].capabilities).toEqual({ actions: ['open'], channels: ['updates'], richImages: false });
  expect(f.control.capabilities()).toEqual({ actions: ['open'], channels: ['updates'], richImages: false });
});

it('releases captured interactions only after this owner confirms identity through identify', async () => {
  const f = await fixture();
  const first = f.create();
  await first.identify('A');
  const generation = (await f.inspect())[0].bindingGeneration;
  first.dispose();await f.journalReleased();
  f.control.capture(interaction('cold-tap', 'A', generation));
  const handled: NotificationInteraction[] = [];
  const client = f.create();
  client.setNotificationHandler(interaction => { handled.push(interaction); });
  await client.start();
  await client.flush();
  expect(handled).toHaveLength(0);
  expect(f.control.interactions()).toEqual([{ id: 'cold-tap', status: 'pending' }]);
  await client.identify('A');
  await vi.waitFor(() => expect(f.control.interactions()).toEqual([{ id: 'cold-tap', status: 'handled' }]));
  expect(handled.map(item => item.id)).toEqual(['cold-tap']);
  expect(handled[0]).toMatchObject({ kind: 'tap', targetId: 'target-cold-tap', userId: 'A', destination: { kind: 'app', url: 'galinum-verify://journal' } });
  expect(Object.isFrozen(handled[0])).toBe(true);
  expect(f.control.interactions()).toEqual([{ id: 'cold-tap', status: 'handled' }]);
});

it('retires interactions captured for another user without invoking the handler', async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify('A');
  const generation = (await f.inspect())[0].bindingGeneration;
  await client.reset();
  await client.identify('B');
  f.control.capture(interaction('old-user', 'A', generation));
  f.control.capture(interaction('new-user', 'B', (await f.inspect())[0].bindingGeneration, 'open'));
  const handler = vi.fn();
  client.setNotificationHandler(handler);
  await vi.waitFor(() => expect(f.control.interactions().find(entry => entry.id === 'new-user')?.status).toBe('handled'));
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler.mock.calls[0]![0]).toMatchObject({ id: 'new-user', kind: 'action', actionId: 'open', userId: 'B' });
  expect(f.control.interactions().find(entry => entry.id === 'old-user')?.status).toBe('pending');
});

it('keeps an interaction pending when the handler fails and redelivers it later', async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify('A');
  const generation = (await f.inspect())[0].bindingGeneration;
  let fail = true;
  const seen: string[] = [];
  client.setNotificationHandler(async interaction => { seen.push(interaction.id);if (fail) throw new Error('router not ready'); });
  f.control.capture(interaction('retry', 'A', generation));
  await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
  await client.flush();
  const attempts = seen.length;
  expect(f.control.interactions()).toEqual([{ id: 'retry', status: 'pending' }]);
  fail = false;
  await client.identify('A');
  await vi.waitFor(() => expect(f.control.interactions()).toEqual([{ id: 'retry', status: 'handled' }]));
  expect(seen).toEqual(Array(attempts + 1).fill('retry'));
  expect(f.control.interactions()).toEqual([{ id: 'retry', status: 'handled' }]);
});

it('sends admitted feedback with its captured user before observation batches and validates the receipt tuple', async () => {
  const f = await fixture();
  const receipts: Record<string, unknown>[] = [];
  let corrupt = false;
  const client = f.create({ fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/api/v1/deliveries/')) {
      const body = JSON.parse(String(init?.body));
      receipts.push({ path: url.pathname, ...body, capability: new Headers(init?.headers).get('X-Galinum-Installation-Capability') });
      return new Response(JSON.stringify({ userId: body.userId, deliveryId: decodeURIComponent(url.pathname.split('/')[4]!), type: body.type, receiptId: corrupt ? 'other' : body.feedbackId, acknowledgedAt: 1700000000000 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return f.transport(input, init);
  } });
  await client.identify('A');
  expect(await client.feedback.isCompleted('A', 'delivery-1')).toBe(false);
  await expect(client.feedback.admit({ userId: 'A', deliveryId: 'delivery-1', type: 'clicked', feedbackId: 'A:clicked', shownFeedbackId: 'A:shown' })).rejects.toMatchObject({ code: 'feedback_shown_required' });
  expect(await client.feedback.admit({ userId: 'A', deliveryId: 'delivery-1', type: 'shown', feedbackId: 'A:shown', shownFeedbackId: 'A:shown' })).toEqual({ feedbackId: 'A:shown', state: 'queued' });
  expect(await client.feedback.admit({ userId: 'A', deliveryId: 'delivery-1', type: 'clicked', feedbackId: 'A:clicked', shownFeedbackId: 'A:shown' })).toEqual({ feedbackId: 'A:clicked', state: 'queued' });
  expect(await client.feedback.isCompleted('A', 'delivery-1')).toBe(true);
  await client.track('dependent_purchase', {}, { eventId: 'after-click' });
  await client.feedback.flush();
  expect(receipts.map(item => [item.type, item.userId, item.capability])).toEqual([['shown', 'A', null], ['clicked', 'A', null]]);
  const observation = f.requests.findIndex(request => {
    const commands = request.body?.commands;
    return request.path.endsWith('/observations') && Array.isArray(commands)
      && commands.some((command: unknown) => command !== null && typeof command === 'object' && 'eventId' in command && command.eventId === 'after-click');
  });
  expect(observation).toBeGreaterThan(-1);
  expect(f.control.feedback().map(item => item.status)).toEqual(['acknowledged', 'acknowledged']);
  expect(await client.feedback.admit({ userId: 'A', deliveryId: 'delivery-1', type: 'shown', feedbackId: 'A:shown', shownFeedbackId: 'A:shown' })).toEqual({ feedbackId: 'A:shown', state: 'acknowledged' });
  corrupt = true;
  await client.feedback.admit({ userId: 'A', deliveryId: 'delivery-2', type: 'shown', feedbackId: 'A:shown-2', shownFeedbackId: 'A:shown-2' });
  await expect(client.feedback.flush()).rejects.toMatchObject({ code: 'invalid_acknowledgement' });
  expect(f.control.feedback().at(-1)).toMatchObject({ feedbackId: 'A:shown-2', status: 'pending' });
});

it('sends old-user feedback with its original user after reset', async () => {
  const f = await fixture();
  const receipts: Record<string, unknown>[] = [];
  const client = f.create({ fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/api/v1/deliveries/')) {
      const body = JSON.parse(String(init?.body));receipts.push(body);
      return new Response(JSON.stringify({ userId: body.userId, deliveryId: 'delivery-1', type: body.type, receiptId: body.feedbackId, acknowledgedAt: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return f.transport(input, init);
  } });
  await client.identify('A');
  await client.feedback.admit({ userId: 'A', deliveryId: 'delivery-1', type: 'shown', feedbackId: 'A:shown', shownFeedbackId: 'A:shown' });
  await client.reset();
  await client.identify('B');
  await client.flush();
  expect(receipts).toEqual([{ userId: 'A', type: 'shown', feedbackId: 'A:shown' }]);
});
