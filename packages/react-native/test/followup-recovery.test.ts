import { expect, it, vi } from 'vitest';
import { deferred, fixture } from './fixture.js';
import { GalinumError } from '../src/types.js';

it('queued T then null cannot reopen before the null job fails initialization', async () => {
 const f = await fixture();let failReads=false, failedReads=0;
 const c=f.create({fetch:(input,init)=>{
  if(failReads && init?.method==='GET'){failedReads++;return Promise.resolve(new Response('{}',{status:503}));}
  return f.transport(input,init);
 }});
 await c.identify('A');await c.setConsent(true);
 const entered=deferred<void>(),release=deferred<'granted'>();
 vi.mocked(f.adapter.getPermission).mockImplementationOnce(()=>{entered.resolve();return release.promise;});
 const held=c.syncDevice();await entered.promise;
 const before=f.control.log().filter(e=>e.kind==='open').length;
 f.callbacks.at(-1)!('older-T');
 const barrier=c.recordForegroundActivity().then(()=>{failReads=true;});
 f.callbacks.at(-1)!(null);
 await vi.waitFor(()=>expect(f.control.display()).toBe('closed'));
 release.resolve('granted');await held;await barrier;
 await vi.waitFor(()=>expect(failedReads).toBeGreaterThan(0));
 expect(f.control.log().filter(e=>e.kind==='open')).toHaveLength(before);
 expect(f.control.displayOpen()).toBe(false);
 expect(f.requests.some(r=>r.body?.token==='older-T')).toBe(false);
 failReads=false;f.callbacks.at(-1)!('newer-T');await c.recordForegroundActivity();
 expect(f.requests.some(r=>r.body?.token==='newer-T')).toBe(true);
 expect(f.control.displayOpen()).toBe(true);
});

it('a token callback held inside token HTTP cannot clear a later revocation', async () => {
 const f=await fixture();const entered=deferred<void>(),release=deferred<void>();let failReads=false,failedReads=0;
 const c=f.create({fetch:async(input,init)=>{
  if(failReads && init?.method==='GET'){failedReads++;return new Response('{}',{status:503});}
  const response=await f.transport(input,init);
  if(String(input).endsWith('/token') && JSON.parse(String(init?.body)).token==='inflight-T'){entered.resolve();await release.promise;}
  return response;
 }});
 await c.identify('A');await c.setConsent(true);
 f.callbacks.at(-1)!('inflight-T');await entered.promise;
 const barrier=c.recordForegroundActivity().then(()=>{failReads=true;});
 const before=f.control.log().filter(e=>e.kind==='open').length;
 f.callbacks.at(-1)!(null);await vi.waitFor(()=>expect(f.control.display()).toBe('closed'));
 release.resolve();await barrier;await vi.waitFor(()=>expect(failedReads).toBeGreaterThan(0));
 expect(f.control.log().filter(e=>e.kind==='open')).toHaveLength(before);
 expect(f.control.displayOpen()).toBe(false);
 failReads=false;vi.mocked(f.adapter.getToken).mockResolvedValue(null);await c.syncDevice();
 expect(f.control.displayOpen()).toBe(false);
});

it('retries a failed first native insert on the same client with fresh operation IDs', async () => {
 const f=await fixture();let fail=true;let attempts=0;
 f.hooks.commit=async perform=>{attempts++;if(fail)throw new GalinumError('journal_storage_failure');return perform();};
 const c=f.create();const first=await c.start().catch(e=>e);expect(first).toBeInstanceOf(GalinumError);
 expect(f.control.size()).toBe(0);expect(f.requests).toHaveLength(0);
 const before=attempts;fail=false;await c.start();
 expect(attempts).toBeGreaterThan(before);expect(f.control.size()).toBe(1);
});
it('still fails closed when established control state disappears', async () => {
 const f=await fixture();const c=f.create();await c.identify('A');let fail=true;
 f.hooks.commit=async perform=>{if(fail){f.control.clear();throw new GalinumError('journal_storage_failure');}return perform();};
 await expect(c.syncDevice()).rejects.toMatchObject({code:'control_recovery_failed'});
 fail=false;await expect(c.start()).rejects.toMatchObject({code:'control_recovery_failed'});
 expect(f.control.size()).toBe(0);
});
it('still closes a known denial when its token observation becomes obsolete during the permission read', async () => {
 const f=await fixture();let failReads=false,failedReads=0;
 const c=f.create({fetch:(input,init)=>{
  if(failReads && init?.method==='GET'){failedReads++;return Promise.resolve(new Response('{}',{status:503}));}
  return f.transport(input,init);
 }});
 await c.identify('A');await c.setConsent(true);
 const entered=deferred<void>(),release=deferred<'denied'>();
 vi.mocked(f.adapter.getPermission).mockImplementationOnce(()=>{entered.resolve();return release.promise;});
 f.callbacks.at(-1)!('T1');await entered.promise;
 const barrier=c.recordForegroundActivity().then(()=>{failReads=true;});
 f.callbacks.at(-1)!('T2');release.resolve('denied');await barrier;
 await vi.waitFor(()=>expect(failedReads).toBeGreaterThan(0));
 expect(f.control.display()).toBe('closed');expect(f.control.displayOpen()).toBe(false);
});
