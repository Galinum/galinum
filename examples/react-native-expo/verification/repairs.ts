import { AppRegistry, NativeModules } from 'react-native';
import { createGalinumClient, type InstallationSnapshot, type NotificationInteraction } from '@galinum/react-native';
import { createExpoAdapter } from '@galinum/react-native/expo';

type Installation = { -readonly [K in keyof InstallationSnapshot]: InstallationSnapshot[K] };

AppRegistry.registerComponent('main', () => () => null);
const harness = NativeModules.JournalHarness;
const config = JSON.parse(harness.config());
const result: Record<string, unknown> = { variant: config.variant, phase: config.phase };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (check: () => boolean, label: string) => {
  const until = Date.now() + 12000;
  while (!check()) { if (Date.now() > until) throw new Error(label); await sleep(10); }
};
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const tray = () => JSON.parse(harness.tray()) as { tag: string; actions: string[] }[];
function setup(name: string) {
  const adapter = createExpoAdapter({ androidChannel: { id: 'updates', name: 'Updates' } });
  adapter.getPermission = async () => 'granted';
  adapter.getToken = async () => 'local-repair-token';
  adapter.subscribeToken = () => () => {};
  const port = adapter.journal!;
  let scope = '', owner = '';
  adapter.journal = { ...port, claim: value => { scope = value; owner = port.claim(value); return owner; } };
  let state: Installation = config.installation ?? { id: '', appId: 'com.galinum.repairs', platform: 'android', environment: 'development', userId: null, bindingGeneration: 0, revision: 0, tokenRevision: 0, hasToken: false, permission: 'unknown', consent: false, capabilities: { actions: [], channels: [], richImages: false }, lastActiveAt: null, createdAt: 1 };
  const make = () => createGalinumClient({ apiBase: 'http://127.0.0.1:19997', publishableKey: 'pub_local_repairs', appId: state.appId, platform: 'android', environment: 'development', storageKey: 'galinum.repairs.' + config.variant + '.' + name, adapter, storageTimeoutMs: 15000,
    notifications: { channels: [{ id: 'updates', name: 'Updates' }], actions: [{ id: 'open', title: 'Registered title' }] },
    fetch: async (input, init) => {
      const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/identify')) return new Response('{}', { status: 200 });
      if (path.endsWith('/observations')) return new Response(JSON.stringify({ acknowledgedThrough: body.commands.at(-1).sequence }), { status: 200 });
      if (init?.method === 'POST' && path.endsWith('/installations')) state.id = body.installationId;
      if (init?.method === 'PUT') {
        if (path.endsWith('/binding')) { if (state.userId !== body.userId) state.bindingGeneration++; state.userId = body.userId; }
        if (path.endsWith('/facts')) { state.permission = body.permission; state.consent = body.consent; state.capabilities = body.capabilities; }
        if (path.endsWith('/token')) { state.tokenRevision++; state.hasToken = body.token !== null; }
        state.revision++;
      }
      return new Response(JSON.stringify({ installation: state }), { status: 200 });
    },
  });
  const envelope = (id: string, action = 'open') => ({ version: 1, targetId: id, attemptId: id + '-attempt', installationId: state.id, bindingGeneration: state.bindingGeneration, test: true, content: { title: 'Repair ' + id, body: 'Private native repair fixture', destination: { kind: 'app', url: 'galinum-verify://repair' }, android: { channelId: 'updates' }, actions: [{ id: action, title: 'Hello personalized A' }] } });
  const ingress = (value: unknown) => harness.ingress(JSON.stringify(value)).then(JSON.parse);
  const inspect = () => harness.inspect(scope).then(JSON.parse);
  const release = async (client: ReturnType<typeof make>) => { client.dispose(); await wait(() => { const s = JSON.parse(harness.leaseState(scope)); return s.released && !s.leaseWork; }, 'lease_release'); };
  const seed = async () => { const client = make(); await client.identify('A'); await client.setConsent(true); return client; };
  return { make, envelope, ingress, inspect, release, seed, get scope() { return scope; }, get owner() { return owner; }, get state() { return state; } };
}
async function run() {
  if (config.phase === 'repairs') {
    for (const kind of ['ingress', 'capture']) {
      const f = setup(kind); let client = await f.seed();
      const target = kind + '-' + Date.now();
      if (kind === 'capture') await f.ingress(f.envelope(target));
      await f.release(client);
      const point = kind === 'ingress' ? 'ingress-before-receive' : 'capture-before-bootstrap';
      harness.pause(point);
      const native = kind === 'ingress' ? f.ingress(f.envelope(target)) : harness.capturePosted(f.scope, target, true);
      await wait(() => harness.reached(point), point);
      const paused = JSON.parse(harness.leaseState(f.scope));
      let constructorError: string | null = null;
      try { client = f.make(); } catch (error: any) { constructorError = error.code ?? String(error); }
      const observation: { paused: unknown; constructorError: string | null; durable?: unknown } = { paused, constructorError };
      result[kind] = observation;
      harness.resume(point); await native;
      if (!constructorError) { await client.identify('A'); observation.durable = await f.inspect(); await f.release(client); }
      check(config.variant === 'baseline' ? constructorError === 'journal_writer_busy' : constructorError === null, kind + '_constructor');
    }
    const f = setup('switch'); const client = await f.seed();
    const id = 'switch-' + Date.now();
    await f.ingress(f.envelope(id));
    result.actionTitle = tray().find(n => n.tag === 'galinum:' + id)?.actions[0];
    const unknown = await f.ingress(f.envelope(id + '-unknown', 'unregistered'));
    result.unregistered = unknown;
    check(unknown.reason === 'action-not-registered', 'unknown_action_not_authorized');
    harness.pause('submission-before-post');
    const handoff = f.ingress(f.envelope(id + '-pending'));
    await wait(() => harness.reached('submission-before-post'), 'pending_handoff');
    const switching = client.identify('B');
    result.immediateRestriction = !JSON.parse(harness.leaseState(f.scope)).displayOpen;
    harness.resume('submission-before-post');
    await handoff; await switching;
    await client.setConsent(true);
    await f.ingress(f.envelope(id + '-B'));
    const trayAfterSwitch = tray();
    result.trayAfterSwitch = trayAfterSwitch;
    await client.identify('B');
    const trayAfterSameUser = tray();
    result.trayAfterSameUser = trayAfterSameUser;
    check(result.immediateRestriction, 'switch_restricts_synchronously');
    check(trayAfterSameUser.some((n) => n.tag === 'galinum:' + id + '-B'), 'B_notification_preserved');
    const old = trayAfterSwitch.filter((n) => n.tag === 'galinum:' + id || n.tag === 'galinum:' + id + '-pending');
    check(config.variant === 'baseline' ? old.length === 2 : old.length === 0, 'A_notification_cleanup');
    check(result.actionTitle === (config.variant === 'baseline' ? 'Registered title' : 'Hello personalized A'), 'personalized_title');
    result.switchState = await f.inspect();
    await f.release(client);
    const r = setup('restored'); let restored = await r.seed();
    const target = 'restored-' + Date.now();
    await r.ingress(r.envelope(target));
    await r.release(restored);
    const handle = await harness.capturePosted(r.scope, target, false);
    restored = r.make(); await restored.identify('A');
    await sleep(100);
    const first = await r.inspect();
    await harness.recapture(r.scope, handle, false); await sleep(100);
    const second = await r.inspect();
    result.restored = { first: first.interactions, second: second.interactions };
    check(config.variant === 'baseline' ? first.interactions.length === 0 : first.interactions.length === 1, 'restored_capture');
    check(second.interactions.length === first.interactions.length, 'capture_deduplicated');
    await r.release(restored);
    const l = setup('old-lease'); const lease = await l.seed();
    harness.pause('executor'); const blocked = harness.block(l.scope);
    await wait(() => harness.reached('executor'), 'lease_work_paused');
    lease.dispose();
    await wait(() => JSON.parse(harness.leaseState(l.scope)).released, 'released_with_write_tail');
    let error: string | null = null; try { l.make(); } catch (e: any) { error = e.code ?? String(e); }
    result.oldLease = { error, state: JSON.parse(harness.leaseState(l.scope)) };
    check(error === 'journal_writer_busy', 'old_lease_fenced');
    harness.resume('executor'); await blocked;
  } else if (config.phase === 'transport-seed') {
    const f = setup('transport'); await f.seed();
    result.scope = f.scope; result.installation = f.state;
  } else if (config.phase === 'transport-recover') {
    const f = setup('transport'); const client = f.make();
    await client.identify('A'); result.state = await f.inspect();
  } else if (config.phase === 'repair-seed-death') {
    const f = setup('death'); const client = await f.seed();
    const target = 'death-' + Date.now(); await f.ingress(f.envelope(target));
    result.scope = f.scope; result.installation = f.state; result.target = target;
    await f.release(client);
  } else if (config.phase === 'repair-before-death') {
    await wait(() => harness.reached('capture-before-bootstrap'), 'cold_capture_paused');
    const f = setup('death');
    try { f.make(); result.constructorSucceeded = true; } catch (error: any) { result.constructorError = error.code ?? String(error); }
    result.paused = JSON.parse(harness.leaseState(config.scope));
  } else if (config.phase === 'repair-after-death') {
    const f = setup('death'); const client = f.make();
    const handled: NotificationInteraction[] = [];
    client.setNotificationHandler(value => { handled.push(value); });
    await client.start(); result.beforeIdentify = handled.length;
    await client.identify('A');
    await sleep(500); result.handled = handled; result.state = await f.inspect();
    check(result.beforeIdentify === 0, 'no_unconfirmed_handler');
    check(handled.length === (config.variant === 'baseline' ? 0 : 1), 'restored_after_process_death');
  }
  result.verified = true;
}
run().catch(error => { result.error = error.code ?? String(error); result.stack = error.stack; result.verified = false; }).finally(async () => { result.trace = JSON.parse(harness.trace()); await harness.save(config.phase, JSON.stringify(result)); });
