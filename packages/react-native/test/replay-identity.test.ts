import { expect, it } from 'vitest';
import { deferred, fixture } from './fixture.js';

it('acknowledged event replay validates the installation without a new identify mutation', async () => {
  const f = await fixture();const client = f.create();
  await client.identify('A');
  await client.track('once', { nested: { value: 1 } }, { eventId: 'one-business-event' });
  await client.flush();
  const before = f.requests.length;
  expect(await client.track('once', { nested: { value: 1 } }, { eventId: 'one-business-event' })).toEqual({ eventId: 'one-business-event', state: 'acknowledged' });
  await client.flush();
  const replay = f.requests.slice(before);
  expect(replay.filter(request => request.path === '/api/v1/identify')).toHaveLength(0);
  expect(replay.some(request => request.method === 'GET' && request.path.includes('/installations/'))).toBe(true);
  expect(replay.filter(request => request.method !== 'GET')).toHaveLength(0);
});

it('acknowledged replay still reconciles an externally changed binding', async () => {
  const f = await fixture();const client = f.create();
  await client.identify('A');await client.track('once', {}, { eventId: 'binding-replay' });await client.flush();
  expect((await f.mutate('binding', { userId: null })).status).toBe(200);
  const before = f.requests.length;
  expect((await client.track('once', {}, { eventId: 'binding-replay' })).state).toBe('acknowledged');
  expect((await f.inspect())[0].userId).toBe('A');
  const replay = f.requests.slice(before);
  expect(replay.filter(request => request.path.endsWith('/binding') && request.method === 'PUT')).toHaveLength(1);
  expect(replay.filter(request => request.path === '/api/v1/identify')).toHaveLength(0);
});

it('acknowledged replay does not bypass failed current installation validation', async () => {
  const f = await fixture();let rejectRead = false;
  const client = f.create({ fetch: (input, init) => rejectRead && init?.method === 'GET' ? Promise.resolve(new Response('{}', { status: 401 })) : f.transport(input, init) });
  await client.identify('A');await client.track('once', {}, { eventId: 'read-replay' });await client.flush();rejectRead = true;
  await expect(client.track('once', {}, { eventId: 'read-replay' })).rejects.toMatchObject({ code: 'http_error', eventId: 'read-replay' });
});

it('explicit identify and start still send identification while cold replay validates without it', async () => {
  const f = await fixture();const client = f.create();
  await client.identify('A');await client.track('once', {}, { eventId: 'cold-replay' });await client.flush();
  let before = f.requests.length;
  await client.identify('A', { plan: 'updated' });
  expect(f.requests.slice(before).filter(request => request.path === '/api/v1/identify').map(request => request.body)).toEqual([{ userId: 'A', traits: { plan: 'updated' } }]);
  before = f.requests.length;await client.start();
  expect(f.requests.slice(before).filter(request => request.path === '/api/v1/identify')).toHaveLength(1);
  client.dispose();await f.journalReleased();
  const cold = f.create();before = f.requests.length;
  expect((await cold.track('once', {}, { eventId: 'cold-replay' })).state).toBe('acknowledged');
  expect(f.requests.slice(before).filter(request => request.path === '/api/v1/identify')).toHaveLength(0);
  expect(f.requests.slice(before).some(request => request.method === 'GET')).toBe(true);
});

it('replay waits for actual storage writes and remains fenced by a newer identity', async () => {
  const f = await fixture();const client = f.create();
  await client.identify('A');await client.track('once', {}, { eventId: 'fenced-replay' });await client.flush();
  const entered = deferred<void>(), release = deferred<void>();const set = f.adapter.storage.set;let hold = true;
  f.adapter.storage.set = async (key, value) => { if (hold) { hold = false;entered.resolve();await release.promise; } await set(key, value); };
  const replay = client.track('once', {}, { eventId: 'fenced-replay' });
  const rejected = expect(replay).rejects.toMatchObject({ code: 'superseded' });
  await entered.promise;const switched = client.identify('B');release.resolve();await rejected;await switched;
  expect((await f.inspect())[0].userId).toBe('B');
});
