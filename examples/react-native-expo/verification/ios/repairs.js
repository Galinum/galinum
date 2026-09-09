import { AppRegistry, NativeModules, TurboModuleRegistry } from 'react-native';
import * as Notifications from 'expo-notifications';
const H = NativeModules.JournalHarness;
const J = TurboModuleRegistry.getEnforcing('GalinumJournal');
AppRegistry.registerComponent('main', () => () => null);
const config = JSON.parse(H.config());
const { phase, scope } = config;
const baseline = config.expected !== 'fixed';
const installationId = 'ios-repair-' + scope.slice(0, 16);
const categoryId = 'ios-repair-' + scope.slice(0, 8);
const result = { phase, expected: baseline ? 'baseline' : 'fixed', checks: [], observations: {} };
const parse = JSON.parse;
const encode = JSON.stringify;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, name) => { if (!value) throw Error(name); result.checks.push(name); };
const defect = (repaired, name) => { result.observations[name] = repaired; check(baseline ? !repaired : repaired, `${name}:${baseline ? 'reproduced' : 'repaired'}`); };
const until = async (test, name) => { for (let i = 0; i < 800; i++) { if (await test()) return; await wait(10); } throw Error('timeout:' + name); };
const targetId = label => label + '-' + scope.slice(0, 12);
const env = label => ({ version: 1, targetId: targetId(label), attemptId: 'attempt-' + targetId(label), installationId, bindingGeneration: 1, test: true, content: { title: 'Galinum repair proof', body: label, destination: { kind: 'app', url: 'galinum-verify://proof' }, data: {}, actions: [{ id: 'open', title: 'Open' }], ios: { categoryId } } });
let owner, revision, operation = 0, intent = 1;
let state = { version: 2, scope: 'ios-repairs', installationId, session: { userId: 'ios-A', consent: true }, bindingRevision: 1, acknowledgedBindingRevision: 1, pending: null, token: null };
const invoke = (method, ...args) => J[method](scope, owner, ...args);
async function commit(next, restrictive = false) {
  const receipt = parse(await invoke('commitControl', owner + ':' + (++operation), revision ?? -1, encode(next), restrictive));
  revision = receipt.revision; state = next;
  return receipt;
}
async function binding(generation = 1) {
  await invoke('publishBinding', intent, encode({ installationId, generation, userId: state.session.userId, bindingRevision: state.bindingRevision, acknowledgedBindingRevision: state.acknowledgedBindingRevision, appConfirmed: true }));
}
async function publish() {
  const proposal = invoke('proposeDisplay', encode({ controlRevision: revision, operationId: owner + ':' + operation, userId: state.session.userId, deadlineMs: 10000 }));
  await invoke('publishDisplay', proposal);
}
async function setup() {
  owner ||= J.claim(scope);
  await invoke('open');
  invoke('setIntent', intent); invoke('resolveInitialIntent', intent);
  revision = parse(await invoke('readControl'))?.revision;
  await commit(state);
  await binding();
  await invoke('configureNotifications', encode({ foreground: 'display', channels: [], actions: [{ id: 'open', title: 'Open' }], categories: [{ id: categoryId, actions: ['open'] }] }));
  await publish();
}
async function schedule(target) {
  await H.schedule(encode(env(target)));
  await until(async () => parse(await H.delivered()).some(row => row.id === targetId(target)), target);
}
async function run() {
  await Notifications.getPermissionsAsync();
  if (phase === 'permission') { result.granted = await H.permission(); return; }
  if (phase === 'first-claim') {
    H.pause('capture-before-bootstrap');
    const capture = H.capture(encode(env('first-claim-tap')), '');
    await until(() => H.reached('capture-before-bootstrap'), 'native-capture');
    try { owner = J.claim(scope); } catch (error) { result.claimError = { code: error.code, message: error.message }; }
    let reservation;
    if (owner) reservation = parse(invoke('reserve', 0, 'first-claim-event'));
    H.resume('capture-before-bootstrap');
    result.capture = parse(await capture);
    defect(Boolean(owner), 'first-claim-overlaps-native-job');
    await setup();
    if (reservation) await invoke('admitEvent', reservation.id, encode({ eventId: reservation.eventId, event: 'after_capture', propsJson: '{}' }));
    const commands = parse(await invoke('peek', intent)).commands;
    result.commands = commands;
    if (!baseline) check(commands.findIndex(row => row.kind === 'tap') < commands.findIndex(row => row.kind === 'event'), 'orphan-before-new-lease-event');
    return;
  }
  if (phase === 'control-reopen') {
    owner = J.claim(scope); await invoke('open');
    const saved = parse(await invoke('readControl'));
    check(saved.state.session.userId === 'ios-B', 'committed-B-survives-kill');
    result.delivered = parse(await H.delivered());
    defect(!result.delivered.some(row => row.id === targetId('control-kill-A')), 'recovery-cancels-old-user');
    return;
  }
  await setup();
  if (phase === 'seed') return;
  if (phase === 'lease-tail') {
    H.pause('executor');
    const queued = invoke('readControl');
    await until(() => H.reached('executor'), 'lease-work-paused');
    const release = invoke('release');
    await wait(50);
    let rejected = false;
    try { J.claim(scope); } catch { rejected = true; }
    check(rejected, 'released-lease-tail-still-blocks-claim');
    H.resume('executor');
    await Promise.allSettled([queued, release]);
    await until(() => { try { owner = J.claim(scope); return true; } catch { return false; } }, 'lease-tail-drained');
    check(Boolean(owner), 'claim-succeeds-after-lease-tail');
    return;
  }
  if (phase === 'control-lost-reply') {
    await schedule('lost-reply-A');
    H.loseNextReply();
    invoke('setIntent', ++intent);
    let failed = false;
    try { await commit({ ...state, session: { userId: 'ios-B', consent: true }, bindingRevision: 2, acknowledgedBindingRevision: 2 }, true); }
    catch (error) { failed = error.code === 'journal_storage_failure'; }
    check(failed, 'lost-control-reply-injected');
    const saved = parse(await invoke('readControl'));
    check(saved.state.session.userId === 'ios-B', 'lost-reply-keeps-durable-B');
    check(!parse(await H.delivered()).some(row => row.id === targetId('lost-reply-A')), 'control-recovery-cancels-before-return');
    return;
  }
  if (phase === 'main-consent' || phase === 'direct-switch') {
    const switching = phase === 'direct-switch';
    if (switching) await schedule('switch-visible-A');
    const target = switching ? 'switch-held-A' : 'consent-held-A';
    H.pause('presentation-main');
    await H.schedule(encode(env(target)));
    await until(() => H.reached('presentation-main'), 'queued-main-completion');
    const before = H.now();
    if (switching) invoke('setIntent', ++intent); else invoke('restrictDisplay');
    result.restrictMs = (H.now() - before) / 1e6;
    check(result.restrictMs < 100, 'immediate-restriction-does-not-wait-for-main');
    await Promise.race([
      commit({ ...state, session: { userId: switching ? 'ios-B' : 'ios-A', consent: switching }, bindingRevision: switching ? 2 : 1, acknowledgedBindingRevision: switching ? 2 : 1 }, true),
      wait(5000).then(() => { throw Error('control-waited-for-main'); }),
    ]);
    check(H.reached('presentation-main'), 'control-completed-while-main-held');
    result.closeCompletedAt = H.now();
    H.resume('presentation-main');
    await wait(1400);
    result.delivered = parse(await H.delivered());
    defect(!result.delivered.some(row => row.id === targetId(target)), 'main-fence-blocks-stale-presentation');
    if (switching) {
      defect(!result.delivered.some(row => row.id === targetId('switch-visible-A')), 'direct-switch-cancels-A');
      await binding(2); await publish();
      const b = env('switch-visible-B'); b.bindingGeneration = 2;
      await H.schedule(encode(b));
      await until(async () => parse(await H.delivered()).some(row => row.id === b.targetId), 'B-presented');
      await commit({ ...state });
      check(parse(await H.delivered()).some(row => row.id === b.targetId), 'same-user-control-preserves-B');
    }
    return;
  }
  if (phase === 'responses' || phase === 'response-kill' || phase === 'response-reopen') {
    const target = phase === 'responses' ? 'same-response' : 'kill-response';
    if (phase !== 'response-reopen') await schedule(target);
    if (phase === 'response-kill') {
      H.pause('capture-commit-after');
      H.response(targetId(target), 'open').catch(() => {});
      await until(() => H.reached('capture-commit-after'), 'response-commit');
      await H.save('kill-ready', encode({ ok: true, point: 'capture-commit-after', target, trace: parse(H.trace()) }));
      return new Promise(() => {});
    }
    if (phase === 'response-reopen') {
      const prior = parse(await invoke('readInteractions', intent)).filter(row => row.targetId === targetId(target));
      check(prior.length === 1, 'capture-commit-survives-kill');
      result.originalId = prior[0].id;
      await invoke('acknowledgeInteraction', intent, prior[0].id, 'handled');
    } else {
      await H.response(targetId(target), 'open');
      const rows = parse(await invoke('readInteractions', intent)).filter(row => row.targetId === targetId(target));
      check(rows.length === 1, 'first-response-admitted');
      result.originalId = rows[0].id;
      await invoke('acknowledgeInteraction', intent, rows[0].id, 'handled');
    }
    const before = parse(await H.inspect(scope));
    await H.response(targetId(target), 'open');
    const after = parse(await H.inspect(scope));
    result.pending = parse(await invoke('readInteractions', intent)).filter(row => row.targetId === targetId(target));
    result.before = before; result.after = after;
    if (!baseline) {
      check(after.interactions.find(row => row.id === result.originalId)?.status === 'handled', 'original-ID-stays-consumed');
      check(after.commands.length === before.commands.length, 'response-recapture-creates-no-command');
    }
    defect(result.pending.length === 0 && after.interactions.length === before.interactions.length && after.observations.length === before.observations.length, 'exact-response-keeps-consumed-ID');
    return;
  }
  if (phase === 'receipts') {
    const before = parse(await H.inspect(scope));
    result.backlog = parse(await H.receiptBacklog(encode(env('current-installation-receipt'))));
    check(result.backlog.earlierForeign >= 32, 'authenticated-foreign-prefix-established');
    for (let i = 0; i < 3; i++) await invoke('peek', intent);
    const after = parse(await H.inspect(scope));
    const files = parse(await H.receiptFiles());
    check(result.backlog.foreignFiles.every(file => files.includes(file)), 'foreign-receipts-preserved');
    defect(!files.includes(result.backlog.currentFile) && after.observations.length === before.observations.length + 1, 'current-receipt-import-not-starved');
    return;
  }
  if (phase === 'control-kill') {
    await schedule('control-kill-A');
    H.pause('control-commit-after');
    invoke('setIntent', ++intent);
    commit({ ...state, session: { userId: 'ios-B', consent: true }, bindingRevision: 2, acknowledgedBindingRevision: 2 }, true).catch(() => {});
    await until(() => H.reached('control-commit-after'), 'control-committed');
    await H.save('kill-ready', encode({ ok: true, point: 'control-commit-after', trace: parse(H.trace()) }));
    return new Promise(() => {});
  }
  throw Error('unknown-phase:' + phase);
}
run().then(async () => { result.ok = true; result.trace = parse(H.trace()); await H.save(phase, encode(result)); }).catch(async error => {
  for (const point of ['capture-before-bootstrap', 'presentation-main', 'capture-commit-after', 'control-commit-after', 'executor']) H.resume(point);
  result.ok = false; result.error = { code: error.code, message: error.message, stack: error.stack }; result.trace = parse(H.trace()); await H.save(phase, encode(result));
});
