import { AppRegistry, NativeModules } from 'react-native';
import { createGalinumClient } from '@galinum/react-native';
import { createExpoAdapter } from '@galinum/react-native/expo';
const harness = NativeModules.JournalHarness;
AppRegistry.registerComponent('main', () => () => null);
const config = JSON.parse(harness.config());
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
async function run() {
  const adapter = createExpoAdapter({ androidChannel: { id: 'updates', name: 'Updates' } });
  let scope = '', owner = '', intent = 0;
  const port = adapter.journal!;
  adapter.journal = { ...port,
    claim: value => { scope = value; owner = port.claim(value); return owner; },
    setIntent: (s, o, value) => { intent = value; port.setIntent(s, o, value); },
  };
  let release!: () => void;
  const latch = new Promise<void>(resolve => { release = resolve; });
  const get = adapter.secrets.get;
  let blocked = false, permissionRequests = 0;
  adapter.secrets.get = async key => { if (config.phase === 'ordered' && key.endsWith('.journal-key')) { blocked = true; await latch; } return get(key); };
  adapter.getPermission = async () => 'granted';
  adapter.requestPermission = async () => { permissionRequests++; throw new Error('unexpected_prompt'); };
  adapter.getToken = async () => config.token;
  adapter.subscribeToken = () => () => {};
  const bodies: unknown[] = [];
  const http: unknown[] = [];
  const client = createGalinumClient({ apiBase: config.origin, publishableKey: config.publishableKey, appId: config.appId, platform: 'android', environment: 'development', storageKey: 'galinum.journal.verification', adapter, requestTimeoutMs: 3000, storageTimeoutMs: 15000,
    fetch: async (input, init) => {
      const observation = String(input).endsWith('/observations');
      if (observation) {
        bodies.push(JSON.parse(String(init?.body)));
        if (config.phase === 'reopen') await latch;
      }
      if (String(input).endsWith('/facts')) {
        const body = JSON.parse(String(init?.body));body.capabilities.channels = ['updates'];
        init = { ...init, body: JSON.stringify(body) };
      }
      const response = await fetch(input, init);
      http.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", status: response.status });
      if (observation && config.phase === 'uncertain') throw new Error('lost_response');
      return response;
    },
  });
  const prefix = () => port.peek(scope, owner, intent);
  const result: Record<string, unknown> = { phase: config.phase };
  if (config.phase === 'seed') {
    await client.identify('journal-A');
    await client.setConsent(true);
    result.installation = client.getSnapshot().installation;
    result.gate = await prefix();
  } else if (config.phase === 'ordered') {
    const before = performance.now();
    const event = client.track('journal_goal', { nested: { values: [null, false, 2.5, 'before-tap'] } }, { eventId: 'native-E' });
    const reservedMs = performance.now() - before;
    const tap = harness.tap(scope, owner, JSON.stringify({ kind: 'tap', ...config.reference }));
    const confirming = client.identify('journal-A');
    await new Promise(resolve => setTimeout(resolve, 150));
    check(blocked && bodies.length === 0, 'admission_waits_for_key');
    release();
    result.receipt = await event;
    result.rehydrated = await prefix();
    await confirming;
    check((result.rehydrated as {appConfirmed: boolean}).appConfirmed, 'same_initial_identity_preserved');
    await client.flush();
    await client.identify('journal-A');
    result.acknowledged = await prefix();
    result.tap = tap; result.reservedMs = reservedMs;
    check((result.acknowledged as {acknowledgedThrough: number}).acknowledgedThrough === 2, 'E_then_T_cursor');
  } else if (config.phase === 'uncertain') {
    await client.start();
    result.receipt = await client.track('journal_goal', { nested: { values: ['uncertain'] } }, { eventId: 'native-U' });
    await client.flush().catch(() => {});
    result.uncertain = await prefix();
    await client.track('journal_goal', { after: true }, { eventId: 'native-V' });
    await client.flush().catch(() => {});
    result.afterAppend = await prefix();
    check(JSON.stringify((result.uncertain as any).commands) === JSON.stringify((result.afterAppend as any).commands), 'uncertain_prefix_is_exact');
  } else if (config.phase === 'reopen') {
    await client.start();
    result.beforeReplay = await prefix();
    check(!(result.beforeReplay as any).appConfirmed, 'reopen_auth_closed');
    release();
    await client.flush();
    result.afterReplay = await prefix();
    result.duplicate = await client.track('journal_goal', { nested: { values: ['uncertain'] } }, { eventId: 'native-U' });
    check((result.duplicate as any).state === 'acknowledged', 'stable_business_event');
    await client.identify('journal-A');
    result.confirmed = await prefix();
    const oldSession = client.session();
    await client.reset();
    result.closed = await prefix().then(() => false, () => true);
    await client.identify('journal-B');
    result.staleSession = await oldSession.track('stale-A', {}, { eventId: 'stale-A' }).then(() => 'unexpected', (error: any) => error.code);
    check(result.staleSession === 'superseded', 'old_session_fenced');
    harness.tap(scope, owner, JSON.stringify({ kind: 'tap', ...config.reference }));
    result.newUser = await client.track('journal_goal', { owner: 'B' }, { eventId: 'native-B' });
    await client.flush();result.switched = await prefix();
  } else if (config.phase === 'pressure') {
    await client.identify('journal-B');
    result.before = await prefix();
    result.capacity = JSON.parse(await harness.capacity(scope, owner, true));
    let failedId = '', successful = 0;
    for (let index = 0; index < 32; index++) {
      const eventId = 'pressure-' + index;
      try { await client.track('journal_pressure', { value: 'p'.repeat(3900) }, { eventId });successful++; }
      catch (error: any) { result.failure = error.code;failedId = error.eventId;break; }
    }
    check(result.failure === 'journal_storage_full' && failedId, 'primary_storage_full_preserved');
    result.conflict = await client.track('journal_pressure', { value: 'changed' }, { eventId: failedId }).then(() => 'unexpected', (error: any) => error.code);
    check(result.conflict === 'event_conflict', 'conflicting_retry_rejected');
    result.invalid = await client.track('journal_pressure', { value: 'x'.repeat(5000) }, { eventId: failedId }).then(() => 'unexpected', (error: any) => error.code);
    check(result.invalid === 'invalid_event', 'invalid_retry_rejected');
    result.failed = await prefix();
    check((result.failed as any).pendingAdmissions === 1, 'uncertain_ticket_retained');
    await harness.capacity(scope, owner, false);
    result.recovered = await client.track('journal_pressure', { value: 'p'.repeat(3900) }, { eventId: failedId });
    await client.flush();result.after = await prefix();
    check((result.after as any).lastSequence === (result.before as any).lastSequence + successful + 1, 'no_pressure_sequence_gap');
    result.successfulBeforePressure = successful;
  }
  check(permissionRequests === 0, 'no_permission_prompt');
  result.permissionRequests = permissionRequests;result.requests = bodies;result.http = http;
  await harness.save(config.phase, JSON.stringify({ ...result, verified: true }));
}
void run().catch(async error => { await harness.save(config.phase, JSON.stringify({ verified: false, code: error.code ?? error.message })); });
