import { expect, it, vi } from 'vitest';
import { deferred, fixture } from './fixture.js';

it('persists offline revoke before network reconciliation', async () => {
  const f = await fixture(); let offline = false;
  const c = f.create({ fetch: (input, init) => offline ? Promise.reject(new Error('offline')) : f.transport(input, init) });
  await c.identify('A'); await c.setConsent(true); offline = true;
  await expect(c.setConsent(false)).rejects.toMatchObject({ code: 'transport_uncertain' });
  expect(f.control.state()!.session.consent).toBe(false);
  expect(f.control.display()).toBe('closed');
});
it('an older sync cannot reopen after invoked revoke while HTTP fails', async () => {
  const f = await fixture(); let offline = false;
  const c = f.create({ fetch: (input, init) => offline ? Promise.reject(new Error('offline')) : f.transport(input, init) });
  await c.identify('A'); await c.setConsent(true);
  const entered = deferred<void>(), release = deferred<'granted'>();
  vi.mocked(f.adapter.getPermission).mockImplementationOnce(() => { entered.resolve(); return release.promise; });
  const sync = c.syncDevice().catch(() => {}); await entered.promise;
  const before = f.control.log().filter(e => e.kind === 'open').length;
  offline = true; const revoke = c.setConsent(false).catch(() => {}); release.resolve('granted');
  await Promise.all([sync,revoke]);
  expect(f.control.log().filter(e => e.kind === 'open')).toHaveLength(before);
  expect(f.control.displayOpen()).toBe(false);
  expect(f.control.state()!.session.consent).toBe(false);
});
it('known denied permission closes before a failed facts PUT', async () => {
  const f = await fixture(); let fail = false;
  const c = f.create({ fetch: (input, init) => fail && String(input).endsWith('/facts') ? Promise.reject(new Error('offline')) : f.transport(input,init) });
  await c.identify('A'); await c.setConsent(true); fail = true;
  vi.mocked(f.adapter.getPermission).mockResolvedValue('denied');
  await expect(c.syncDevice()).rejects.toMatchObject({code:'transport_uncertain'});
  expect(f.control.displayOpen()).toBe(false); expect(f.control.display()).toBe('closed');
});
it('definite null callback closes while HTTP is blocked', async () => {
  const f = await fixture(); const c = f.create();
  await c.identify('A'); await c.setConsent(true);
  const entered = deferred<void>(), release = deferred<'granted'>();
  vi.mocked(f.adapter.getPermission).mockImplementationOnce(() => { entered.resolve();return release.promise; });
  const sync = c.syncDevice(); await entered.promise;
  f.callbacks.at(-1)!(null);
  const suppressed = f.control.displayOpen();
  await vi.waitFor(() => expect(f.control.display()).toBe('closed')).finally(() => release.resolve('granted'));
  await sync; expect(suppressed).toBe(false);
});
it('obsolete session cannot restrict a new identity and bridge errors reject promises', async () => {
  const f = await fixture(); const c = f.create();
  await c.identify('A'); const old = c.session(); await c.identify('B'); await c.setConsent(true);
  await expect(old.setConsent(false)).rejects.toMatchObject({code:'superseded'});
  expect(f.control.displayOpen()).toBe(true);
  f.adapter.journal.restrictDisplay = () => { throw new Error('bridge'); };
  let result: Promise<void> | undefined;
  expect(() => { result = c.setConsent(false); }).not.toThrow();
  await expect(result).rejects.toThrow();
});
it('held port payload remains A before the later B write', async () => {
  const f = await fixture(); const c = f.create(); await c.identify('A');
  const entered = deferred<void>(), release = deferred<void>(); let hold = true; let actual = '';
  f.hooks.commit = async (perform, context) => {
    if (hold) { hold = false;entered.resolve(); await release.promise;actual = context.state.session.userId!; }
    return perform();
  };
  const sync = c.syncDevice().catch(() => {}); await entered.promise;
  const b = c.identify('B'); release.resolve(); await Promise.all([sync,b]);
  expect(actual).toBe('A'); expect(f.control.state()!.session.userId).toBe('B');
});
it('blocks preserved legacy operational state before credentials or HTTP', async () => {
 const f=await fixture();
 (f.adapter as any).checkLegacyState=async ()=>{throw new Error('legacy_format');};
 await expect(f.create().start()).rejects.toThrow();
 expect(f.requests).toHaveLength(0);expect(f.secrets.size).toBe(0);expect(f.control.size()).toBe(0);
});
