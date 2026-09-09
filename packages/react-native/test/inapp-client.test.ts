import { expect, it, vi } from 'vitest';
import { fixture, deferred } from './fixture.js';

const input = (userId = 'A', requestId = 'request-1') => ({ userId, entryId: 'entry-1', requestId, path: '/settings' });

it('keeps one frozen port snapshot and never grants authority from rehydration', async () => {
  const f = await fixture();
  const first = f.create();
  await first.identify('A');
  const owner = first.inApp.getSnapshot().owner;
  first.dispose(); await f.journalReleased();
  const client = f.create();
  const port = client.inApp;
  const initial = port.getSnapshot();
  expect(port.getSnapshot()).toBe(initial);
  expect(Object.isFrozen(initial)).toBe(true);
  await client.start();
  expect(port.getSnapshot()).toBe(initial);
  expect(initial.appConfirmed).toBe(false);
  expect(initial.owner).not.toBe(owner);
  await expect(port.decide(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'identify_required' });
  await client.identify('A');
  expect(client.inApp).toBe(port);
  expect(port.getSnapshot()).toMatchObject({ userId: 'A', appConfirmed: true, facts: 1 });
});

it('invalidates same-user traits at invocation and waits for the actual write before selecting', async () => {
  const f = await fixture();
  const entered = deferred<void>(), release = deferred<void>();
  let held = false, decisions = 0;
  const client = f.create({ fetch: async (url, init) => {
    if (held && String(url).endsWith('/identify')) { entered.resolve(); await release.promise; }
    if (String(url).includes('/api/v1/messages?')) decisions++;
    return f.transport(url, init);
  } });
  await client.identify('A');
  const before = client.inApp.getSnapshot();
  held = true;
  const writing = client.identify('A', { plan: 'pro' });
  expect(client.inApp.getSnapshot().facts).toBe(before.facts + 1);
  const deciding = client.inApp.decide(input(), new AbortController().signal);
  await entered.promise;
  expect(decisions).toBe(0);
  release.resolve(); await writing;
  expect(await deciding).toMatchObject({ userId: 'A', entryId: 'entry-1', requestId: 'request-1', messages: [] });
});

it('invalidates track facts before returning and acknowledges them before a fresh decision', async () => {
  const f = await fixture();
  const calls: { url: string; cache?: RequestCache; capability: string | null }[] = [];
  const client = f.create({ fetch: async (url, init) => {
    calls.push({ url: String(url), cache: init?.cache, capability: new Headers(init?.headers).get('X-Galinum-Installation-Capability') });
    return f.transport(url, init);
  } });
  await client.identify('A');
  const before = client.inApp.getSnapshot();
  const writing = client.track('plan_selected', { plan: 'pro' });
  expect(client.inApp.getSnapshot().facts).toBe(before.facts + 1);
  const deciding = client.inApp.decide(input(), new AbortController().signal);
  await writing; await deciding;
  await client.inApp.decide(input('A', 'request-2'), new AbortController().signal);
  const decisions = calls.filter(call => call.url.includes('/api/v1/messages?'));
  expect(decisions).toHaveLength(2);
  expect(decisions.every(call => call.cache === 'no-store' && call.capability === null)).toBe(true);
  expect(calls.findIndex(call => call.url.endsWith('/observations'))).toBeLessThan(calls.findIndex(call => call.url.includes('/api/v1/messages?')));
});

it('rejects an old response after a same-user invocation without waiting for that invocation', async () => {
  const f = await fixture();
  const entered = deferred<void>(), release = deferred<void>();
  const client = f.create({ fetch: async (url, init) => {
    const response = await f.transport(url, init);
    if (String(url).includes('/api/v1/messages?')) { entered.resolve(); await release.promise; }
    return response;
  } });
  await client.identify('A');
  const deciding = client.inApp.decide(input(), new AbortController().signal);
  await entered.promise;
  const writing = client.identify('A', { plan: 'pro' });
  release.resolve();
  await expect(deciding).rejects.toMatchObject({ code: 'superseded' });
  await writing;
});

it('rejects decision correlation errors and fences router aborts and identity reset', async () => {
  const f = await fixture();
  const client = f.create({ fetch: async (url, init) => {
    if (String(url).includes('/api/v1/messages?')) return new Response(JSON.stringify({ ...input(), requestId: 'wrong', messages: [] }));
    return f.transport(url, init);
  } });
  await client.identify('A');
  await expect(client.inApp.decide(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' });
  const signal = new AbortController(); signal.abort();
  await expect(client.inApp.decide(input(), signal.signal)).rejects.toMatchObject({ code: 'superseded' });
  const listener = vi.fn(); const off = client.inApp.subscribe(listener);
  const reset = client.reset();
  expect(client.inApp.getSnapshot()).toMatchObject({ userId: null, appConfirmed: false });
  expect(listener).toHaveBeenCalledTimes(1);
  await reset; off();
  client.dispose();
  expect(listener).toHaveBeenCalledTimes(1);
});

it('does not select from stale facts when the latest identify failed', async () => {
  const f = await fixture();
  let fail = false;
  const client = f.create({ fetch: async (url, init) => {
    if (fail && String(url).endsWith('/identify')) return new Response('{}', { status: 400 });
    return f.transport(url, init);
  } });
  await client.identify('A'); fail = true;
  await expect(client.identify('A', { plan: 'pro' })).rejects.toMatchObject({ code: 'http_error' });
  expect(client.inApp.getSnapshot().appConfirmed).toBe(false);
  await expect(client.inApp.decide(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'identify_required' });
  expect(f.requests.some(request => request.path === '/api/v1/messages')).toBe(false);
});

it('confirms a new identity only after reconciliation and keeps confirmed same-user authority stable', async () => {
  const f = await fixture();
  const entered = deferred<void>(), release = deferred<void>();
  let hold = true;
  const client = f.create({ fetch: async (url, init) => {
    if (hold && String(url).endsWith('/identify')) { entered.resolve(); await release.promise; }
    return f.transport(url, init);
  } });
  const writing = client.identify('A');
  expect(client.inApp.getSnapshot()).toMatchObject({ userId: 'A', appConfirmed: false });
  await entered.promise;
  await expect(client.inApp.decide(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'identify_required' });
  release.resolve(); await writing; hold = false;
  const states: unknown[] = [];
  const off = client.inApp.subscribe(() => { const { owner, userId, appConfirmed } = client.inApp.getSnapshot(); states.push({ owner, userId, appConfirmed }); });
  const before = client.inApp.getSnapshot();
  await client.identify('A', { plan: 'pro' });
  expect(states).toEqual([{ owner: before.owner, userId: 'A', appConfirmed: true }]);
  off();
});

it('fails closed when native identity invalidation throws synchronously', async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify('A');
  const spy = vi.spyOn(f.adapter.journal!, 'setIntent').mockImplementation(() => { throw new Error('native bridge unavailable'); });
  await expect(client.identify('B')).rejects.toMatchObject({ code: 'journal_bridge_failure' });
  expect(client.inApp.getSnapshot()).toMatchObject({ userId: 'B', appConfirmed: false });
  await expect(client.inApp.decide(input('B'), new AbortController().signal)).rejects.toMatchObject({ code: 'identify_required' });
  expect(f.requests.some(request => request.path === '/api/v1/messages')).toBe(false);
  spy.mockRestore();
});

it('rejects malformed renderer fields before returning external messages', async () => {
  const f = await fixture();
  let message: unknown;
  const client = f.create({ fetch: async (url, init) => {
    if (String(url).includes('/api/v1/messages?')) return new Response(JSON.stringify({ ...input(), messages: [message] }));
    return f.transport(url, init);
  } });
  await client.identify('A');
  const base = { deliveryId: 'delivery', campaignId: 'campaign', variantId: 'variant' };
  const malformed = [
    { content: { title: {} } }, { content: { body: [] } }, { content: { presentation: 1 } },
    { content: { media: null } }, { content: { media: { url: 3 } } }, { content: { media: { url: 'https://example.test/a.png', alt: {} } } },
    { content: { media: { url: 'https://example.test/a.png', decorative: 'yes' } } },
    { content: { cta: { label: {} } } }, { content: { cta: { label: 'Open', destination: [] } } },
    { content: { cta: { label: 'Open', destination: { kind: 'website', url: {} } } } },
    { content: {}, pages: [3] }, { content: {}, pages: 'settings' },
  ];
  for (const fields of malformed) {
    message = { ...base, ...fields };
    await expect(client.inApp.decide(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' });
  }
  message = { ...base, pages: ['/settings'], content: { title: 'Ready', body: 'New report', media: { url: 'https://example.test/report.png', decorative: true }, cta: { label: 'Open', destination: { kind: 'app', url: 'example://reports' } } } };
  expect((await client.inApp.decide(input(), new AbortController().signal)).messages).toEqual([message]);
});
