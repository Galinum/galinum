import { createMMKV } from "react-native-mmkv";
import { AppRegistry, Linking, NativeModules } from 'react-native';
import { createGalinumClient, GalinumError, InAppController } from '@galinum/react-native';
import { createExpoAdapter } from '@galinum/react-native/expo';
import { VerificationApp, showInApp } from './inapp';
const harness = NativeModules.JournalHarness;
AppRegistry.registerComponent('main', () => VerificationApp);
const config = JSON.parse(harness.config());
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const timed = <T>(operation: () => T): { value: T; ms: number; startNanos: number; endNanos: number } => {
  const startNanos = harness.now();const value = operation();const end = harness.now();
  return { value, ms: (end - startNanos) / 1e6, startNanos, endNanos: end };
};
async function waitReached(point: string, timeoutMs = 8000) {
  const start = Date.now();
  while (!harness.reached(point)) { if (Date.now() - start > timeoutMs) throw new Error('pause_not_reached:' + point);await sleep(10); }
}
const code = (error: unknown) => (error instanceof GalinumError ? error.code : String(error));
const result: Record<string, unknown> = { phase: config.phase };
async function run() {
  const adapter: ReturnType<typeof createExpoAdapter> = config.carrier === 'bare'
    ? require('@galinum/react-native/bare').createBareAdapter()
    : createExpoAdapter({ androidChannel: { id: 'updates', name: 'Updates' } });
  const nativeToken = adapter.getToken;
  let scope = '', owner = '', intent = 0;
  const port = adapter.journal!;
  const commits: any[] = [], publications: any[] = [];
  adapter.journal = { ...port,
    claim: value => { scope = value;owner = port.claim(value);intent = 0;return owner; },
    setIntent: (s, o, value) => { intent = value;port.setIntent(s, o, value); },
    commitControl: async (s, o, operationId, expected, state, restrict) => {
      const entry: any = { operationId, expected, restrict, userId: state.session.userId, consent: state.session.consent, startedMs: Date.now() };commits.push(entry);
      try { entry.receipt = await port.commitControl(s, o, operationId, expected, state, restrict);return entry.receipt; } catch (error) { entry.error = code(error);throw error; }
    },
    publishDisplay: async (s, o, proposal) => {
      const entry: any = { proposal };publications.push(entry);
      try { entry.receipt = await port.publishDisplay(s, o, proposal);return entry.receipt; } catch (error) { entry.error = code(error);throw error; }
    },
  };
  let offline = false, failFacts = false, loseObservations = false, failReads = false, failedReads = 0;
  let tokenRead: string | null = config.token;
  let heldToken: string | null = null, tokenEntered = false;
  let releaseToken!: () => void;
  let tokenBarrier: Promise<void> = Promise.resolve();
  let releaseReplay!: () => void;
  const replayBarrier = new Promise<void>(resolve => { releaseReplay = resolve; });
  let knownPermission: 'granted' | 'denied' = 'granted';
  let heldPermission: Promise<'granted'> | undefined;
  let permissionEntered = false;
  let tokenCallback: (token: string | null) => void = () => {};
  adapter.getPermission = async () => { permissionEntered = true;return heldPermission ?? knownPermission; };
  let permissionRequests = 0;
  adapter.requestPermission = async () => { permissionRequests++;throw new Error('unexpected_prompt'); };
  adapter.getToken = async () => tokenRead;
  adapter.subscribeToken = listener => { tokenCallback = listener;return () => {}; };
  const bodies: unknown[] = [], http: unknown[] = [];
  const notifications = { foreground: (config.foreground ?? 'display') as 'display' | 'suppress', channels: [{ id: 'updates', name: 'Updates' }], actions: [{ id: 'open', title: 'Open' }, { id: 'later', title: 'Later' }] };
  const makeClient = (storageTimeoutMs = 15000, storageKey = 'galinum.journal.verification', carrier = false) => createGalinumClient({ apiBase: config.origin, publishableKey: config.publishableKey, appId: config.appId, platform: 'android', environment: 'development', storageKey, adapter, requestTimeoutMs: 3000, storageTimeoutMs, ...(carrier ? { notifications } : {}),
    fetch: async (input, init) => {
      if (failReads && init?.method === 'GET') {
        failedReads++;
        http.push({path:new URL(String(input)).pathname,method:'GET',status:503,injected:true});
        return new Response('{}', {status:503});
      }
      if (offline || failFacts && String(input).endsWith('/facts')) throw new Error('fixture-offline');
      const observation = String(input).endsWith('/observations');
      if (observation && config.phase === 'replay') await replayBarrier;
      if (observation) bodies.push(JSON.parse(String(init?.body)));
      if (!carrier && String(input).endsWith('/facts')) {
        const body = JSON.parse(String(init?.body));body.capabilities.channels = ['updates'];
        init = { ...init, body: JSON.stringify(body) };
      }
      const response = await fetch(input, init);
      if (heldToken && String(input).endsWith('/token') && JSON.parse(String(init?.body)).token === heldToken) {
        tokenEntered = true;await tokenBarrier;
      }
      if (observation && loseObservations) throw new Error('lost-response');
      http.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET', status: response.status });
      return response;
    },
  });
  const inspect = async () => JSON.parse(await harness.inspect(scope));
  const prefix = () => port.peek(scope, owner, intent);
  const trace = () => JSON.parse(harness.trace()) as any[];
  const tap = (_label: string) => harness.tap(scope, owner, JSON.stringify({ kind: 'tap', ...config.reference }));
  const phase = config.phase as string;
  const handled: unknown[] = [];
  const waitHandled = async (count: number, timeoutMs: number) => { const start = Date.now();while (handled.length < count) { if (Date.now() - start > timeoutMs) throw new Error('interaction_not_handled');await sleep(50); } };
  const waitObservation = async (targetId: string, statuses: string[], timeoutMs: number) => {
    const start = Date.now();
    while (true) {
      const state = await inspect();
      const found = (state.observations as any[]).find(entry => entry.targetId === targetId && statuses.includes(entry.status));
      if (found) return state;
      if (Date.now() - start > timeoutMs) throw new Error('observation_not_found:' + targetId + ':' + statuses.join('|'));
      await sleep(200);
    }
  };
  if (phase === 'inapp-terminal' || phase === 'inapp-completion') {
    const client = makeClient();
    await client.start();
    result.confirmedBeforeIdentify = client.inApp.getSnapshot().appConfirmed;
    check(result.confirmedBeforeIdentify === false, 'rehydration_never_authorizes_inapp');
    await client.identify('journal-A');
    let entry = 0, routed = false;
    const captured = client.session();
    const controller = new InAppController(client.inApp, client.feedback, {
      id: () => client.inApp.getSnapshot().owner + ':' + (++entry),
      appSchemes: ['galinum-verify'],
      openDestination: async destination => {
        await Linking.openURL(destination.url);
        await captured.track('inapp_native_clicked');
        routed = true;
      },
    });
    showInApp(controller, config.phase);
    await harness.save('ready', JSON.stringify({ phase, verified: true }));
    if (phase === 'inapp-terminal') {
      const deadline = Date.now() + 120000;
      while (!routed) { if (Date.now() > deadline) throw new Error('inapp_action_not_routed'); await sleep(100); }
      check(await client.feedback.isCompleted('journal-A', config.deliveryId), 'terminal_completion_durable');
      await client.feedback.flush();
      result.routed = routed;
      result.locallyCompleted = true;
    } else {
      check(await client.feedback.isCompleted('journal-A', config.deliveryId), 'completion_survives_process_restart');
      const deadline = Date.now() + 15000;
      while (controller.getSnapshot().phase !== 'empty') { if (Date.now() > deadline) throw new Error('completed_delivery_represented'); await sleep(100); }
      const other = makeClient(15000, 'galinum.journal.verification.other');
      await other.identify('journal-A');
      check(!(await other.feedback.isCompleted('journal-A', config.deliveryId)), 'second_client_has_no_local_completion');
      const decision = await other.inApp.decide({ userId: 'journal-A', entryId: other.inApp.getSnapshot().owner + ':entry', requestId: other.inApp.getSnapshot().owner + ':request', path: '/settings' }, new AbortController().signal);
      check(!decision.messages.some(message => message.deliveryId === config.deliveryId), 'shared_server_completion_suppresses_second_client');
      result.sharedCompletion = true;
      other.dispose();
    }
    result.controller = controller.getSnapshot();
  } else if (phase === 'carrier-seed') {
    const client = makeClient(15000, 'galinum.journal.verification', true);
    await client.identify('journal-A');
    await client.setConsent(true);
    result.installation = client.getSnapshot().installation;
    result.control = await inspect();
    result.resolvedService = harness.resolvedService();
    check((result.control as any).control.display === 'open', 'seed_display_open');
    check((result.control as any).settings && (result.control as any).settings.channels.includes('updates'), 'native_channel_configured');
    check((result.installation as any).capabilities.channels.includes('updates') && (result.installation as any).capabilities.actions.includes('open'), 'capabilities_advertised_from_native_setup');
    if (config.carrier === 'bare') {
      result.resolvedReceiver = harness.bareReceiver();
      check(result.resolvedReceiver === 'com.galinum.journal.GalinumFirebaseReceiver', 'galinum_bare_receiver_resolved');
    } else check(result.resolvedService === 'com.galinum.journal.GalinumExpoMessagingService', 'galinum_service_resolved');
  } else if (phase === 'carrier-provider-token') {
    const token = await nativeToken();
    check(typeof token === 'string' && token.length > 0, 'native_fcm_token_available');
    await harness.save('provider-token-private', JSON.stringify({ token }));
    result.nativeTokenAvailable = true;
  } else if (phase === 'carrier-open') {
    const client = makeClient(15000, 'galinum.journal.verification', true);
    client.setNotificationHandler(interaction => { handled.push(interaction); });
    await client.start();
    await sleep(300);
    result.handledBeforeIdentify = handled.length;
    await client.identify('journal-A');
    await waitHandled(1, 10000);
    await client.flush();
    result.handled = handled;
    result.state = await inspect();
    check(result.handledBeforeIdentify === 0, 'no_handler_before_identity_confirmation');
  } else if (phase === 'carrier-warm') {
    const client = makeClient(15000, 'galinum.journal.verification', true);
    client.setNotificationHandler(interaction => { handled.push(interaction); });
    await client.identify('journal-A');
    await harness.save('ready', JSON.stringify({ phase, pid: 0, verified: true }));
    await waitHandled(1, 120000);
    await client.flush();
    result.handled = handled;
    result.state = await inspect();
  } else if (phase === 'carrier-suppress' || phase === 'carrier-revoked' || phase === 'carrier-token-revoked') {
    const client = makeClient(15000, 'galinum.journal.verification', true);
    client.setNotificationHandler(interaction => { handled.push(interaction); });
    await client.identify('journal-A');
    if (phase === 'carrier-revoked') await client.setConsent(false);
    if (phase === 'carrier-token-revoked') { tokenRead = null; tokenCallback(null); await client.syncDevice(); }
    await harness.save('ready', JSON.stringify({ phase, pid: 0, verified: true }));
    result.state = await waitObservation(config.reference.targetId, ['pending', 'admitted'], 120000);
    await sleep(500);
    result.state = await inspect();
    result.handled = handled;
    check(!(result.state as any).notifications.some((entry: any) => entry.targetId === config.reference.targetId), 'no_notification_row');
    if (phase === 'carrier-revoked') await client.setConsent(true);
    await client.flush();
    result.final = await inspect();
  } else if (phase === 'carrier-old-user') {
    const client = makeClient(15000, 'galinum.journal.verification', true);
    client.setNotificationHandler(interaction => { handled.push(interaction); });
    await client.identify('journal-A');
    await client.reset();
    await client.identify('journal-B');
    await harness.save('ready', JSON.stringify({ phase, pid: 0, verified: true }));
    result.state = await waitObservation(config.reference.targetId, ['retired'], 120000);
    result.handled = handled;
    check(handled.length === 0 && !(result.state as any).notifications.some((entry: any) => entry.targetId === config.reference.targetId), 'old_user_envelope_retired_without_display');
    await client.reset();
    await client.identify('journal-A');
    await client.flush();
  } else if (phase === 'seed') {
    const client = makeClient();
    await client.identify('journal-A');
    await client.setConsent(true);
    result.installation = client.getSnapshot().installation;
    result.gate = await prefix();
    result.control = await inspect();
    result.provisioning = trace().filter(entry => entry.kind === 'provision' || entry.kind === 'bootstrap' || entry.kind === 'open-commit');
    check((result.control as any).control.display === 'open', 'seed_display_open');
    check((result.control as any).registryExists && (result.control as any).keyExists, 'native_registry_and_key');
  } else if (phase === 'latency') {
    const client = makeClient();
    const baseline = timed(() => harness.now());
    harness.pause('bootstrap');
    const opening = port.open(scope, owner);
    await waitReached('bootstrap');
    const reachedNanos = harness.now();
    const reserveE = timed(() => client.track('journal_goal', { nested: { values: [null, false, 2.5, 'before-tap'] } }, { eventId: 'atomic-E' }));
    const reserveT = timed(() => tap('T1'));
    const identifyCall = timed(() => client.identify('journal-A'));
    const bootstrapRevoke = timed(() => client.setConsent(false));
    await waitReached('bootstrap');
    await sleep(150);
    check(bodies.length === 0, 'admission_waits_for_bootstrap');
    const memoryTrace = trace();
    const releaseNanos = harness.now();
    harness.resume('bootstrap');
    await opening;
    result.bootstrapOverlap = [reserveE, reserveT, identifyCall, bootstrapRevoke].map(({startNanos,endNanos,ms}) => ({reachedNanos,startNanos,endNanos,releaseNanos,ms}));
    check((result.bootstrapOverlap as any[]).every(v => v.reachedNanos < v.startNanos && v.startNanos < v.endNanos && v.endNanos < v.releaseNanos), 'reached_overlap');
    result.receiptE = await reserveE.value;
    await identifyCall.value;
    await bootstrapRevoke.value;
    const afterFirst = await prefix();
    check(afterFirst.appConfirmed, 'same_initial_identity_preserved');
    const durableTrace = trace();
    harness.pause('executor');
    const blocked = harness.block(scope);
    await waitReached('executor');
    const reserveT2 = timed(() => tap('T2'));
    const reserveE2 = timed(() => client.track('journal_goal', { order: 'after-tap' }, { eventId: 'atomic-E2' }));
    const memoryTrace2 = trace();
    await sleep(100);
    harness.resume('executor');
    await blocked;
    result.receiptE2 = await reserveE2.value;
    const durable = await inspect();
    const durableTrace2 = trace();
    const commandFor = (ticketId: string) => (durable.commands as any[]).find(command => command.id === ticketId);
    const reserved = [...memoryTrace, ...memoryTrace2].filter(entry => entry.kind === 'reserve' || entry.kind === 'reserve-native');
    const admitted = [...durableTrace, ...durableTrace2].filter(entry => entry.kind === 'admitted');
    const sequences = reserved.map(entry => ({ id: entry.detail, kind: entry.kind, ordinal: entry.ordinal, reservedNanos: entry.nanos, sequence: commandFor(entry.detail)?.sequence, admittedNanos: admitted.find(item => item.detail === entry.detail)?.nanos }));
    result.baselineBridgeMs = baseline.ms;
    result.synchronous = { E: reserveE.ms, T: reserveT.ms, identify: identifyCall.ms, T2: reserveT2.ms, E2: reserveE2.ms };
    result.order = sequences;
    result.memoryTrace = [...memoryTrace, ...memoryTrace2];
    result.durableTrace = [...durableTrace, ...durableTrace2].filter(entry => entry.kind !== 'reserve');
    result.durableCommands = durable.commands;
    check(sequences.length === 4 && sequences.every(entry => typeof entry.sequence === 'number'), 'all_four_tickets_durable');
    check(sequences[0]!.sequence! < sequences[1]!.sequence! && sequences[2]!.sequence! < sequences[3]!.sequence!, 'ticket_order_preserved_both_directions');
    const firstAdmission = (ids: string[]) => Math.min(...admitted.filter(item => ids.includes(item.detail)).map(item => item.nanos));
    const pairs = [[sequences[0]!, sequences[1]!], [sequences[2]!, sequences[3]!]];
    check(pairs.every(pair => pair.every(entry => entry.reservedNanos < firstAdmission(pair.map(item => item.id)))), 'reservations_precede_pair_durable_admission');
    result.flush = await client.flush().then(() => 'ok', error => code(error));
    result.acknowledged = await prefix();
    await client.setConsent(true);
  } else if (phase === 'submission') {
    const client = makeClient();
    await client.start();
    result.afterStart = await inspect();
    check((result.afterStart as any).control.display === 'open' && (result.afterStart as any).memoryDisplayOpen, 'display_open_from_disk');
    harness.pause('submission-gap');
    const attempt1 = harness.submit(scope);
    await waitReached('submission-gap');
    const revoke = timed(() => client.setConsent(false));
    void revoke.value.catch(() => {});
    const trackDuringGap = timed(() => client.track('journal_goal', { during: 'submission-gap' }, { eventId: 'atomic-gap-E' }));
    void trackDuringGap.value.catch(() => {});
    const tapDuringGap = timed(() => tap('gap'));
    await sleep(100);
    const gapTrace = trace();
    harness.resume('submission-gap');
    result.attempt1 = JSON.parse(await attempt1);
    await revoke.value;
    result.gapEvent = await trackDuringGap.value.then(receipt => receipt, error => ({ error: code(error) }));
    result.afterRevoke = await inspect();
    result.gapSynchronous = { revoke: revoke.ms, track: trackDuringGap.ms, tap: tapDuringGap.ms, tapTicket: tapDuringGap.value };
    result.gapTrace = gapTrace;
    result.gapCommits = trace().filter(entry => entry.kind === 'control-commit' || entry.kind === 'submission-evaluated' || entry.kind === 'submission-initiated' || entry.kind === 'restrict-display');
    check((result.attempt1 as any).state === 'suppressed' && (result.attempt1 as any).reason === 'restricted-after-evaluation', 'gap_submission_suppressed');
    check((result.afterRevoke as any).control.display === 'closed' && (result.afterRevoke as any).control.state.session.consent === false && (result.afterRevoke as any).submitted.length === 0, 'revoke_closed_atomically');
    await client.setConsent(true);
    result.reopened = await inspect();
    check((result.reopened as any).control.display === 'open' && (result.reopened as any).memoryDisplayOpen, 'reopen_after_consent');
    trace();
    harness.pause('submission-handoff');
    const attempt2 = harness.submit(scope);
    await waitReached('submission-handoff');
    const revoke2 = timed(() => client.setConsent(false));
    void revoke2.value.catch(() => {});
    await sleep(100);
    harness.resume('submission-handoff');
    result.attempt2 = JSON.parse(await attempt2);
    await revoke2.value;
    result.handoffTrace = trace().filter(entry => ['submission-initiated', 'submission-settled', 'restrict-display', 'control-commit'].includes(entry.kind));
    const closeCommit = (result.handoffTrace as any[]).find(entry => entry.kind === 'control-commit' && entry.restrictive);
    const initiated = (result.handoffTrace as any[]).find(entry => entry.kind === 'submission-initiated');
    check((result.attempt2 as any).state === 'submitted' && closeCommit && initiated && initiated.nanos < closeCommit.nanos && closeCommit.submissionsBeforeClose === 1, 'close_accounts_for_inflight_handoff');
    result.handoffSynchronous = { revoke: revoke2.ms };
    result.afterHandoffClose = await inspect();
    result.attempt3 = JSON.parse(await harness.submit(scope));
    check((result.attempt3 as any).state === 'suppressed' && (result.attempt3 as any).reason === 'closed-on-disk', 'no_submission_after_durable_close');
  } else if (phase === 'owners') {
    const client = makeClient();
    await client.start();await client.setConsent(true);
    permissionEntered = false;
    let release!: (value: 'granted') => void;
    heldPermission = new Promise(resolve => { release = resolve; });
    const older = client.syncDevice().catch(code);
    while (!permissionEntered) await sleep(5);
    trace();offline = true;
    const revoke = client.setConsent(false).catch(code);
    release('granted');heldPermission = undefined;
    result.olderSync = await older;result.offlineRevoke = await revoke;
    result.offlineControl = await inspect();
    result.offlineTrace = trace();
    check((result.offlineControl as any).control.display === 'closed' && !(result.offlineControl as any).control.state.session.consent, 'offline_closure');
    check(!(result.offlineTrace as any[]).some(e => e.kind === 'open-commit'), 'older_sync_never_reopens');
    offline = false;await client.setConsent(true);
    knownPermission = 'denied';failFacts = true;
    result.denied = await client.syncDevice().then(() => 'unexpected', code);
    result.deniedControl = await inspect();
    check((result.deniedControl as any).control.display === 'closed', 'denied_closes_before_http');
    failFacts = false;knownPermission = 'granted';await client.syncDevice();
    check((await inspect()).memoryDisplayOpen, 'eligible_sync_reopens');
    permissionEntered = false;
    heldPermission = new Promise(resolve => { release = resolve; });
    const blocked = client.syncDevice().catch(code);
    while (!permissionEntered) await sleep(5);
    const callback = timed(() => tokenCallback(null));
    result.nullCallbackMs = callback.ms;
    result.nullControl = await inspect();
    for (let n = 0; n < 100 && (result.nullControl as any).control.display !== 'closed'; n++) {
      await sleep(10);result.nullControl = await inspect();
    }
    check((result.nullControl as any).control.display === 'closed', 'null_callback_closes_while_sync_blocked');
    release('granted');heldPermission = undefined;await blocked;await client.syncDevice();
    await client.track('journal_goal', { replay: true }, {eventId:'corrected-replay'});
    await client.flush();
    const before = http.length;
    result.replay = await client.track('journal_goal', { replay: true }, {eventId:'corrected-replay'});
    await client.flush();result.replayHttp = http.slice(before);
    check((result.replay as any).state === 'acknowledged' && !(result.replayHttp as any[]).some(r => r.path === '/api/v1/identify'), 'replay_no_identify');
    harness.loseNextReply();
    await client.syncDevice();
    result.replyLossRecovery = await inspect();
    check((result.replyLossRecovery as any).operations.length <= 2, 'receipt_retirement_bounded');
    const priorCommit = commits.at(-1)!;
    result.retiredReplay = await port.commitControl(scope, owner, priorCommit.operationId, priorCommit.receipt.revision,
      (result.replyLossRecovery as any).control.state, false).then(() => 'unexpected', code);
    check(result.retiredReplay === 'operation_retired', 'retired_id_cannot_replay');
    const old = client.session();await client.identify('journal-B');await client.setConsent(true);
    result.staleSession = await old.setConsent(false).then(() => 'unexpected', code);
    result.newOwner = await inspect();
    check(result.staleSession === 'superseded' && (result.newOwner as any).memoryDisplayOpen, 'obsolete_session_does_not_restrict');
    await client.identify('journal-A');await client.setConsent(true);
  } else if (phase === 'uncertain') {
    const client = makeClient();await client.start();loseObservations = true;
    await client.track('journal_goal', { uncertain: true }, {eventId:'corrected-uncertain'});
    await client.flush().catch(() => {});
    result.prefix = await prefix();
    await client.track('journal_goal', { later: true }, {eventId:'corrected-later'});
    await client.flush().catch(() => {});
    result.afterAppend = await prefix();
    check(JSON.stringify((result.prefix as any).commands) === JSON.stringify((result.afterAppend as any).commands), 'exact_uncertain_prefix_after_append');
  } else if (phase === 'replay') {
    const client = makeClient();await client.start();
    result.beforeReplay = await prefix();releaseReplay();await client.flush();
    result.afterReplay = await prefix();
    const before = http.length;
    result.replayedReceipt = await client.track('journal_goal', { uncertain: true }, {eventId:'corrected-uncertain'});
    await client.flush();result.replayHttp = http.slice(before);
    check((result.replayedReceipt as any).state === 'acknowledged' && !(result.replayHttp as any[]).some(r => r.path === '/api/v1/identify'), 'reopened_replay_no_identify');
  } else if (phase === 'token-observations') {
    const client = makeClient();await client.start();await client.setConsent(true);
    permissionEntered = false;
    let release!: (value: 'granted') => void;
    heldPermission = new Promise(resolve => { release = resolve; });
    const held = client.syncDevice();while (!permissionEntered) await sleep(5);
    trace();
    tokenCallback(config.token + '-older');
    const barrier = client.recordForegroundActivity().then(() => { failReads = true; });
    tokenCallback(null);
    let closed = await inspect();
    for (let n=0;n<100 && closed.control.display !== 'closed';n++) { await sleep(10);closed=await inspect(); }
    check(closed.control.display === 'closed', 'queued_null_durable_before_release');
    release('granted');heldPermission=undefined;
    await held;await barrier;await client.flush();
    result.queuedFailureReads=failedReads;result.queuedTrace=trace();result.afterQueued=await inspect();
    check(failedReads>0 && !(result.queuedTrace as any[]).some(e=>e.kind==='open-commit') && !(result.afterQueued as any).memoryDisplayOpen, 'obsolete_token_cannot_adopt_null_fence');
    failReads=false;tokenCallback(config.token);await client.recordForegroundActivity();
    check((await inspect()).memoryDisplayOpen, 'newer_callback_still_opens');

    tokenEntered=false;heldToken=config.token + '-inflight';
    tokenBarrier=new Promise(resolve=>{releaseToken=resolve;});
    tokenCallback(heldToken);while(!tokenEntered) await sleep(5);
    const inflightBarrier=client.recordForegroundActivity().then(()=>{failReads=true;});
    trace();tokenCallback(null);
    closed=await inspect();
    for(let n=0;n<100 && closed.control.display!=='closed';n++){await sleep(10);closed=await inspect();}
    check(closed.control.display==='closed','inflight_null_durable');
    releaseToken();await inflightBarrier;await client.flush();
    failReads=false;heldToken=null;tokenRead=null;
    await client.syncDevice();
    result.inflightTrace=trace();result.afterInflightToken=await inspect();
    check(!(result.inflightTrace as any[]).some(e=>e.kind==='open-commit') && !(result.afterInflightToken as any).memoryDisplayOpen, 'awaited_old_token_cannot_clear_revocation');
    tokenRead=config.token;tokenCallback(config.token);await client.recordForegroundActivity();
    check((await inspect()).memoryDisplayOpen,'newest_callback_recovers');
  } else if (phase === 'first-control-failure') {
    const client=makeClient(15000,'galinum.initial-control-recovery');
    const initialOwner=owner;
    harness.failControlWrites(scope,true);
    result.firstFailure=await client.start().then(()=> 'unexpected',code);
    result.absent=await inspect();
    check(result.firstFailure==='journal_storage_failure' && (result.absent as any).control===null && (result.absent as any).operations.length===0 && http.length===0,'first_insert_rolled_back');
    const failedIds=commits.map(c=>c.operationId);
    harness.failControlWrites(scope,false);
    await client.start();await client.identify('same-client-recovered');
    result.recovered=await inspect();result.failureTrace=trace();
    check(owner===initialOwner && (result.recovered as any).control.state.session.userId==='same-client-recovered','same_client_same_lease_recovers');
    check(new Set(commits.map(c=>c.operationId)).size===commits.length && commits.some(c=>!failedIds.includes(c.operationId)&&c.receipt), 'fresh_operation_after_unknown_absent');
    await harness.removeControl(scope);
    result.establishedMissing=await client.syncDevice().then(()=> 'unexpected',code);
    result.establishedRetry=await client.start().then(()=> 'unexpected',code);
    result.stillAbsent=await inspect();
    check(result.establishedMissing==='control_recovery_failed' && result.establishedRetry==='control_recovery_failed' && (result.stillAbsent as any).control===null,'established_loss_stays_closed');
  } else if (phase === 'stale') {
    const client = makeClient(1500);
    await client.start();
    await client.setConsent(true);
    const before = await inspect();
    check(before.control.display === 'open', 'stale_precondition_open');
    const lastControl = commits.at(-1)!;
    trace();
    harness.pause('executor');
    const blocked = harness.block(scope);
    await waitReached('executor');
    const staleId = port.proposeDisplay(scope, owner, { operationId: lastControl.operationId, controlRevision: lastControl.receipt.revision, userId: 'journal-A', deadlineMs: 10000 });
    const stale = port.publishDisplay(scope, owner, staleId).then(receipt => ({ receipt }), error => ({ error: code(error) }));
    port.restrictDisplay(scope, owner);
    const expiredId = port.proposeDisplay(scope, owner, { operationId: lastControl.operationId, controlRevision: lastControl.receipt.revision, userId: 'journal-A', deadlineMs: 50 });
    const expired = port.publishDisplay(scope, owner, expiredId).then(receipt => ({ receipt }), error => ({ error: code(error) }));
    await sleep(200);
    harness.resume('executor');
    await blocked;
    result.queuedStale = await stale;
    result.queuedExpired = await expired;
    result.queuedTrace = trace();
    check((result.queuedStale as any).error === 'publication_stale' && (result.queuedExpired as any).error === 'publication_expired', 'queued_proposals_rejected_before_execution');
    check(!(result.queuedTrace as any[]).some(entry => entry.kind === 'open-commit'), 'no_open_commit_for_queued_proposals');
    await client.setConsent(false);
    result.closedBeforeInflight = await inspect();
    check(result.closedBeforeInflight && (result.closedBeforeInflight as any).control.display === 'closed', 'inflight_precondition_closed');
    trace();
    harness.pause('open-commit-before');
    const reopen = client.setConsent(true).then(() => 'resolved', error => code(error));
    await waitReached('open-commit-before');
    const timedOut = await reopen;
    result.timedOut = timedOut;
    check(timedOut === 'journal_storage_timeout', 'caller_timeout_reported_not_cancellation');
    const cancel = client.setConsent(false).then(() => 'resolved', error => code(error));
    await sleep(100);
    result.duringInflight = { memory: trace() };
    harness.resume('open-commit-before');
    result.cancel = await cancel;
    await sleep(100);
    result.inflightTrace = trace().filter(entry => ['open-commit', 'control-commit', 'restrict-display', 'pause-released'].includes(entry.kind));
    result.publications = publications;
    result.afterInflight = await inspect();
    const openCommit = (result.inflightTrace as any[]).find(entry => entry.kind === 'open-commit');
    const closeCommit = (result.inflightTrace as any[]).find(entry => entry.kind === 'control-commit' && entry.restrictive);
    check(openCommit && closeCommit && openCommit.nanos < closeCommit.nanos && openCommit.state === 'open-then-restricted', 'open_committed_before_close_reported_honestly');
    check((result.afterInflight as any).control.display === 'closed' && (result.afterInflight as any).operations.length <= 2, 'inflight_open_committed_then_closed_at_newer_revision');
  } else if (phase === 'lease') {
    const client = makeClient();
    await client.start();
    await client.setConsent(true);
    result.secondLiveLease = (() => { try { makeClient();return 'unexpected'; } catch (error) { return code(error); } })();
    check(result.secondLiveLease === 'journal_writer_busy', 'second_live_lease_rejected');
    trace();
    harness.pause('close-commit-before');
    const pending = client.setConsent(false).then(() => 'resolved', error => code(error));
    await waitReached('close-commit-before');
    client.dispose();
    await sleep(50);
    result.claimDuringTail = (() => { try { makeClient();return 'unexpected'; } catch (error) { return code(error); } })();
    check(result.claimDuringTail === 'journal_writer_busy', 'disposed_lease_keeps_unsettled_tail');
    harness.resume('close-commit-before');
    result.pending = await pending;
    let next: ReturnType<typeof makeClient> | undefined;
    for (let attempt = 0;attempt < 50 && !next;attempt++) { try { next = makeClient(); } catch (error) { result.lastClaimError = code(error);await sleep(20); } }
    check(next, 'new_lease_after_tail_settles');
    await next!.start();
    result.afterReattach = await inspect();
    result.leaseTrace = trace().filter(entry => ['release', 'attach', 'control-commit'].includes(entry.kind));
    check((result.afterReattach as any).control.state.session.consent === false && (result.afterReattach as any).control.display === 'closed' && (result.afterReattach as any).leaseLive, 'tail_commit_honored_and_new_lease_live');
    result.gateAfterReattach = await prefix().then(value => value.appConfirmed, error => code(error));
    check(result.gateAfterReattach === false, 'reattach_does_not_confirm_application');
    await next!.setConsent(true);
    harness.pause('lease-detached');
    harness.reloadLease(scope, owner);
    await waitReached('lease-detached');
    result.concurrentClaim = (() => { try { makeClient();return 'unexpected'; } catch (error) { return code(error); } })();
    check(result.concurrentClaim === 'journal_writer_busy', 'cleanup_admission_atomic');
    harness.resume('lease-detached');
    let reloaded: ReturnType<typeof makeClient> | undefined;
    for (let n=0;n<100 && !reloaded;n++) { try { reloaded=makeClient(); } catch { await sleep(10); } }
    check(reloaded, 'reload_tail_settled');
    await reloaded!.start();
    result.reloadControl = await inspect();
    check((result.reloadControl as any).memoryDisplayOpen && (result.reloadControl as any).control.display === 'open', 'reload_memory_disk_agree');

  } else if (phase.startsWith('kill-')) {
    const point = { 'kill-c1': 'close-commit-before', 'kill-c2': 'close-commit-after', 'kill-o1': 'open-commit-before', 'kill-o2': 'open-commit-after' }[phase]!;
    const client = makeClient();
    await client.start();
    if (phase.startsWith('kill-c')) await client.setConsent(true);
    else await client.setConsent(false);
    result.beforeKill = await inspect();
    check((result.beforeKill as any).control.display === (phase.startsWith('kill-c') ? 'open' : 'closed'), 'kill_precondition');
    harness.pause(point);
    const operation = phase.startsWith('kill-o') ? client.setConsent(true) : client.setConsent(false);
    void operation.catch(() => {});
    await waitReached(point);
    await sleep(50);
    result.commits = commits;result.publications = publications;result.point = point;
    await harness.save('marker', JSON.stringify({ ...result, verified: true }));
    return;
  } else if (phase === 'o3') {
    const client = makeClient();
    await client.start();
    result.afterStart = await inspect();
    await client.setConsent(false);
    result.afterClose = await inspect();
    check((result.afterStart as any).control.display === 'open' && (result.afterClose as any).control.display === 'closed', 'newer_close_after_reply_lost_open');
  } else if (phase === 'legacy') {
    const namespace = 'galinum.atomic.legacy-only';
    const old = createMMKV({ id: namespace + '.state', encryptionKey: '0123456789abcdef0123456789abcdef', encryptionType: 'AES-256', mode: 'single-process' });
    const saved = JSON.stringify({ session: { userId: 'legacy-owner', consent: true }, pending: { route: 'activity', body: { requestId: 'exact-old-request' } } });
    old.set('state', saved);
    const client = makeClient(15000, namespace);
    const before = http.length;
    result.legacyResult = await client.start().then(() => 'unexpected', code);
    result.legacyPreserved = old.getString('state') === saved;
    result.legacyEncrypted = old.isEncrypted;
    result.legacyFiles = JSON.parse(await harness.files(scope));
    check(result.legacyResult === 'legacy_format' && result.legacyPreserved && result.legacyEncrypted && http.length === before, 'old_format_preserved_before_http');
    check(!(result.legacyFiles as any).dbExists && !(result.legacyFiles as any).registryExists, 'no_native_authority_over_legacy');
  } else if (phase === 'inspect') {
    makeClient();
    result.inspection = await inspect();
  } else throw new Error('unknown_phase');
  check(permissionRequests === 0, 'no_permission_prompt');
  result.permissionRequests = permissionRequests;result.requests = bodies;result.http = http;result.commits = commits;result.publications = publications;
  await harness.save(config.phase, JSON.stringify({ ...result, verified: true }));
}
void run().catch(async error => { await harness.save(config.phase, JSON.stringify({ ...result, verified: false, code: error.code ?? error.message, stack: String(error.stack ?? '') })); });
