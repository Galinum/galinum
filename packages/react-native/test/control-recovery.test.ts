import { expect, it } from 'vitest';
import { fixture } from './fixture.js';
import { GalinumError } from '../src/types.js';
it('recovers an applied commit whose reply is lost before later writes', async () => {
 const f=await fixture();const c=f.create();await c.identify('A');
 let once=true;
 f.hooks.commit=async perform=>{const r=await perform();if(once){once=false;throw new GalinumError('journal_storage_failure');}return r;};
 await c.setConsent(true);
 expect(f.control.state()!.session.consent).toBe(true);
 await c.identify('B'); expect(f.control.state()!.session.userId).toBe('B');
});
it('reads back a stale revision and writes current intent without rebasing pending bytes', async () => {
 const f=await fixture();const c=f.create();await c.identify('A');
 const commit=f.adapter.journal.commitControl;let once=true;
 f.adapter.journal.commitControl=async (...args)=>{
  if(once){once=false;const state=structuredClone(args[4]);await commit(args[0],args[1],'external',args[3],state,false);}
  return commit(...args);
 };
 await c.setConsent(true);expect(f.control.state()!.session.consent).toBe(true);
});
