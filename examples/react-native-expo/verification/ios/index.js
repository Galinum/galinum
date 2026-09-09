import { AppRegistry, NativeModules, TurboModuleRegistry } from 'react-native';
import * as Notifications from 'expo-notifications';
const H = NativeModules.JournalHarness;
const J = TurboModuleRegistry.getEnforcing('GalinumJournal');
AppRegistry.registerComponent('main', () => () => null);
const config = JSON.parse(H.config());
const phase = config.phase || 'permission';
const scope = config.scope || 'b'.repeat(64);
const installationId = 'ios-proof-' + scope.slice(0, 16);
const categoryId = 'galinum-proof-' + scope.slice(0, 8);
const result = { phase, checks: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, name) => { if (!value) throw Error(name); result.checks.push(name); };
const parse = text => JSON.parse(text);
const fail = async (call, expected) => { try { await call(); } catch (error) { check(error.code === expected, `${expected}:${error.code}`); return; } throw Error(`expected:${expected}`); };
const envelope = (target = 'ios-default') => ({ version: 1, targetId: target, attemptId: 'attempt-' + target, installationId, bindingGeneration: 1, test: true, content: { title: 'Galinum iOS proof', body: target, destination: { kind: 'app', url: 'galinum://proof' }, data: { source: 'simulator' }, actions: [{ id: 'open', title: 'Open' }], ios: { categoryId } } });
async function run() {
  await Notifications.getPermissionsAsync();
  if (phase === 'permission') { result.granted = await H.permission(); return; }
  if (phase === 'cold-ingress') result.coldCapture = parse(await H.capture(JSON.stringify(envelope('cold-native-action')), 'open'));
  const owner = J.claim(scope);
  const hints = [];
  const subscription = J.onInteraction(value => hints.push(value));
  const invoke = (method, ...args) => J[method](scope, owner, ...args);
  const captured = [];
  let admission;
  if (phase === 'kernel') {
    H.pause('bootstrap');
    const opening = J.open(scope, owner);
    for (let i = 0; i < 800 && !H.reached('bootstrap'); i++) await wait(10);
    check(H.reached('bootstrap'), 'bootstrap-paused');
    const before = H.now();
    const ticket = parse(J.reserve(scope, owner, 0, 'ios-event-before-tap'));
    result.reserveMs = (H.now() - before) / 1e6;
    check(result.reserveMs < 100, 'memory-reservation-does-not-wait-for-bootstrap');
    admission = J.admitEvent(scope, owner, ticket.id, JSON.stringify({ eventId: ticket.eventId, event: 'before_tap', propsJson: '{}' }));
    captured.push(H.capture(JSON.stringify(envelope('ordered-tap')), ''));
    await wait(100);
    H.resume('bootstrap');
    await opening;
  } else await J.open(scope, owner);
  J.setIntent(scope, owner, 1);
  J.resolveInitialIntent(scope, owner, 1);
  let control = parse(await J.readControl(scope, owner));
  const state = { version: 2, scope: 'ios-proof', installationId, session: { userId: 'ios-A', consent: true }, bindingRevision: 1, acknowledgedBindingRevision: 1, pending: null, token: null };
  const receipt = parse(await J.commitControl(scope, owner, owner + ':1', control?.revision ?? -1, JSON.stringify(state), false));
  const proof = { installationId: state.installationId, generation: 1, userId: 'ios-A', bindingRevision: 1, acknowledgedBindingRevision: 1, appConfirmed: phase !== 'cold' && phase !== 'cold-ingress' };
  await J.publishBinding(scope, owner, 1, JSON.stringify(proof));
  if (phase === 'kernel') {
    const defaults = parse(await invoke('configureNotifications', '{}'));
    check(defaults.actions.length === 0 && parse(await H.inspect(scope)).settings.foreground === 'display', 'canonical-optional-setup-defaults');
  }
  const setup = { foreground: 'display' , channels: [], actions: [{ id: 'open', title: 'Open' }], categories: [{ id: categoryId, actions: ['open'] }] };
  const capabilities = parse(await invoke('configureNotifications', JSON.stringify(setup)));
  check(capabilities.actions.join() === 'open' && capabilities.categories[0].actions[0].id === 'open', 'exact-category-capabilities');
  check(capabilities.richImages === Boolean(config.receipts), config.receipts ? 'configured-extension-capability' : 'no-rich-image-claim-without-extension');
  result.delegate = parse(await H.delegateState());
  check(result.delegate.composed && result.delegate.previous.includes('NotificationCenterManager'), 'expo-delegate-composed');
  const proposal = J.proposeDisplay(scope, owner, JSON.stringify({ controlRevision: receipt.revision, operationId: owner + ':1', userId: 'ios-A', deadlineMs: 10000 }));
  await J.publishDisplay(scope, owner, proposal);
  if (phase === 'kernel') {
    await admission;
    await Promise.all(captured);
    H.failControlWrites(scope, true);
    await fail(() => invoke('configureNotifications', JSON.stringify({ ...setup, categories: [{ id: categoryId + '-failed', actions: ['open'] }] })), 'journal_storage_failure');
    H.failControlWrites(scope, false);
    const restored = parse(await H.delegateState());
    check(restored.categories.some(category => category.id === categoryId) && !restored.categories.some(category => category.id === categoryId + '-failed'), 'failed-setup-restores-categories');
    const prefix = parse(await J.peek(scope, owner, 1));
    result.prefix = prefix;
    check(prefix.appConfirmed === true, 'canonical-prefix-identity-shape');
    const bodies = prefix.batch?.commands ?? prefix.commands ?? [];
    check(bodies[0]?.kind === 'event' && bodies[1]?.kind === 'tap', 'event-before-native-tap');
    await wait(20);
    check(hints.includes(scope), 'canonical-interaction-event-emitter');
    const pending = parse(await invoke('readInteractions', 1));
    check(pending.some(row => row.targetId === 'ordered-tap' && row.userId === 'ios-A'), 'interaction-shared-shape');
    await invoke('acknowledgeInteraction', 1, pending[0].id, 'handled');
    check(!parse(await invoke('readInteractions', 1)).some(row => row.id === pending[0].id), 'interaction-acknowledged');
    const foreign = envelope('old-binding'); foreign.bindingGeneration = 0;
    result.retired = parse(await H.capture(JSON.stringify(foreign), ''));
    check(result.retired.state === 'retired', 'old-binding-retired');
    result.badAction = parse(await H.capture(JSON.stringify(envelope('bad-action')), 'unknown'));
    check(result.badAction.state === 'invalid', 'unknown-action-rejected');
    await H.capture(JSON.stringify(envelope('named-action')), 'open');
    check(parse(await invoke('readInteractions', 1)).some(row => row.kind === 'action' && row.actionId === 'open'), 'named-action-captured');
    proof.appConfirmed = false;
    await J.publishBinding(scope, owner, 1, JSON.stringify(proof));
    await fail(() => invoke('readInteractions', 1), 'binding_unacknowledged');
    proof.appConfirmed = true;
    await J.publishBinding(scope, owner, 1, JSON.stringify(proof));
  }
  if (phase === 'feedback') {
    const shown = { userId: 'ios-A', deliveryId: 'delivery-ios', type: 'shown', feedbackId: 'shown-ios', shownFeedbackId: 'shown-ios' };
    const terminal = { ...shown, type: 'clicked', feedbackId: 'clicked-ios' };
    await fail(() => invoke('admitFeedback', JSON.stringify(terminal)), 'feedback_shown_required');
    check(parse(await invoke('admitFeedback', JSON.stringify(shown))).state === 'queued', 'shown-committed');
    check(parse(await invoke('admitFeedback', JSON.stringify(terminal))).state === 'queued', 'terminal-committed');
    check(await invoke('readCompletion', 'ios-A', 'delivery-ios'), 'completion-atomic');
    check(!(await invoke('readCompletion', 'ios-B', 'delivery-ios')), 'completion-user-scoped');
    await fail(() => invoke('admitFeedback', JSON.stringify({ ...terminal, deliveryId: 'different' })), 'feedback_conflict');
    const feedback = parse(await invoke('peekFeedback'));
    check(feedback.map(row => row.type).join() === 'shown,clicked', 'feedback-admission-order');
    await fail(() => invoke('acknowledgeFeedback', 'shown-ios', JSON.stringify({ userId: 'ios-B', deliveryId: 'delivery-ios', type: 'shown', receiptId: 'shown-ios', acknowledgedAt: Date.now() })), 'feedback_receipt_mismatch');
    check(parse(await invoke('peekFeedback')).length === 2, 'bad-receipt-stays-pending');
    await invoke('acknowledgeFeedback', 'shown-ios', JSON.stringify({ userId: 'ios-A', deliveryId: 'delivery-ios', type: 'shown', receiptId: 'shown-ios', acknowledgedAt: Date.now() }));
    check(parse(await invoke('admitFeedback', JSON.stringify(shown))).state === 'acknowledged', 'feedback-idempotent-replay');
    const rollback = { userId: 'ios-A', deliveryId: 'rollback-ios', type: 'shown', feedbackId: 'shown-rollback', shownFeedbackId: 'shown-rollback' };
    await invoke('admitFeedback', JSON.stringify(rollback));
    H.failControlWrites(scope, true);
    await fail(() => invoke('admitFeedback', JSON.stringify({ ...rollback, type: 'dismissed', feedbackId: 'terminal-rollback' })), 'journal_storage_failure');
    H.failControlWrites(scope, false);
    check(!(await invoke('readCompletion', 'ios-A', 'rollback-ios')), 'storage-failure-rolls-back-completion');
    check(!parse(await invoke('peekFeedback')).some(row => row.feedbackId === 'terminal-rollback'), 'storage-failure-never-queued');
    await invoke('acknowledgeFeedback', 'shown-rollback', JSON.stringify({ userId: 'ios-A', deliveryId: 'rollback-ios', type: 'shown', receiptId: 'shown-rollback', acknowledgedAt: Date.now() }));
    result.nseFallback = parse(await H.nseFallback());
    check(result.nseFallback.title === 'Fallback title' && result.nseFallback.attachments === 0, 'nse-text-fallback');
  }
  if (phase === 'reopen') {
    check(await invoke('readCompletion', 'ios-A', 'delivery-ios'), 'completion-survives-process-death');
    const pending = parse(await invoke('peekFeedback'));
    check(pending.length === 1 && pending[0].feedbackId === 'clicked-ios' && pending[0].userId === 'ios-A', 'pending-feedback-keeps-original-user');
  }
  if (phase === 'notifications') {
    await H.schedule(JSON.stringify(envelope('foreground-display'))); await wait(2200);
    result.displayed = parse(await H.delivered());
    check(result.displayed.some(row => row.id === 'foreground-display'), 'real-foreground-default-displayed');
    await invoke('configureNotifications', JSON.stringify({ ...setup, foreground: 'suppress' }));
    await H.schedule(JSON.stringify(envelope('foreground-suppress'))); await wait(2200);
    check(!parse(await H.delivered()).some(row => row.id === 'foreground-suppress'), 'real-foreground-suppress');
    await invoke('configureNotifications', JSON.stringify(setup));
    H.pause('submission-gap');
    await H.schedule(JSON.stringify(envelope('foreground-gap')));
    for (let i = 0; i < 500 && !H.reached('submission-gap'); i++) await wait(10);
    check(H.reached('submission-gap'), 'real-handoff-gap-paused');
    const before = H.now();
    J.restrictDisplay(scope, owner);
    result.restrictMs = (H.now() - before) / 1e6;
    check(result.restrictMs < 100, 'restriction-does-not-wait-for-handoff');
    const closed = J.commitControl(scope, owner, owner + ':2', receipt.revision, JSON.stringify({ ...state, session: { userId: 'ios-A', consent: false } }), true);
    H.resume('submission-gap');
    await closed;
    check(!parse(await H.delivered()).some(row => row.id === 'foreground-gap'), 'no-handoff-after-durable-close');
    await invoke('configureNotifications', JSON.stringify(setup));
    await H.schedule(JSON.stringify(envelope('foreground-restricted'))); await wait(2200);
    check(!parse(await H.delivered()).some(row => row.id === 'foreground-restricted'), 'restricted-foreground-suppressed');
    await invoke('cancelNotifications');
    check(!parse(await H.delivered()).some(row => row.id === 'foreground-display'), 'delivered-cancelled');
  }
  if (phase === 'receipts') {
    const before = parse(await H.inspect(scope));
    result.receipt = parse(await H.receiptProbe(JSON.stringify(envelope('authenticated-extension-receipt'))));
    check(result.receipt.encrypted && result.receipt.tamperRejected, 'receipt-encryption-and-authentication');
    await J.peek(scope, owner, 1);
    const imported = parse(await H.inspect(scope));
    check(imported.observations.length === before.observations.length + 1, 'receipt-imported-through-journal');
    await H.restoreReceipt();
    await J.publishBinding(scope, owner, 1, JSON.stringify(proof));
    const replayed = parse(await H.inspect(scope));
    check(replayed.observations.length === imported.observations.length && replayed.commands.length === imported.commands.length, 'receipt-import-idempotent');
  }
  if (phase === 'composition') {
    await H.installBareDelegate();
    const bare = parse(await H.delegateState());
    check(bare.composed && bare.previous === 'GJFixtureDelegate', 'bare-delegate-composed');
    await H.scheduleForeign(); await wait(2200);
    check(H.forwardedCount() === 1, 'non-galinum-forwarded-once');
    check(parse(await H.delivered()).some(row => row.id === 'host-foreign'), 'host-presentation-preserved');
    await invoke('cancelNotifications');
    check(parse(await H.delivered()).some(row => row.id === 'host-foreign'), 'cancellation-preserves-host-notifications');
  }
  if (phase === 'cold' || phase === 'cold-ingress') {
    await fail(() => invoke('readInteractions', 1), 'binding_unacknowledged');
    proof.appConfirmed = true;
    await J.publishBinding(scope, owner, 1, JSON.stringify(proof));
    result.interactions = parse(await invoke('readInteractions', 1));
    if (phase === 'cold-ingress') check(result.coldCapture.state === 'captured' && result.interactions.some(row => row.targetId === 'cold-native-action' && row.actionId === 'open' && row.userId === 'ios-A'), 'cold-action-waits-for-current-identity');
  }
  if (phase === 'identity') {
    J.setIntent(scope, owner, 2);
    await J.commitControl(scope, owner, owner + ':2', receipt.revision, JSON.stringify({ ...state, session: { userId: 'ios-B', consent: false }, bindingRevision: 2, acknowledgedBindingRevision: 2 }), true);
    await J.publishBinding(scope, owner, 2, JSON.stringify({ ...proof, generation: 2, userId: 'ios-B', bindingRevision: 2, acknowledgedBindingRevision: 2 }));
    check(parse(await invoke('readInteractions', 2)).length === 0, 'identity-switch-retires-old-interactions');
    check(parse(await invoke('peekFeedback')).every(row => row.userId === 'ios-A'), 'identity-switch-preserves-feedback-user');
    check(await invoke('readCompletion', 'ios-A', 'delivery-ios'), 'identity-switch-preserves-original-completion');
    check(!(await invoke('readCompletion', 'ios-B', 'delivery-ios')), 'new-user-has-no-old-completion');
    check(parse(await H.capture(JSON.stringify(envelope('stale-after-switch')), 'open')).state === 'retired', 'old-response-cannot-bind-to-new-user');
  }
  if (phase === 'os-response') {
    const target = 'r7-os-response-' + scope.slice(0, 8);
    await H.schedule(JSON.stringify(envelope(target)));
    await H.save('os-ready', JSON.stringify({ ok: true, target }));
    let received;
    for (let i = 0; i < 600 && !received; i++) {
      received = parse(await invoke('readInteractions', 1)).find(row => row.targetId === target && row.actionId === 'open');
      if (!received) await wait(100);
    }
    check(Boolean(received), 'real-OS-action-routed');
    await invoke('acknowledgeInteraction', 1, received.id, 'handled');
    await wait(1000);
    check(!parse(await invoke('readInteractions', 1)).some(row => row.id === received.id), 'real-OS-response-completed-and-acknowledged');
    result.osInteraction = received;
  }
  result.hints = hints;
  subscription.remove();
  result.inspection = parse(await H.inspect(scope));
  result.trace = parse(H.trace());
}
run().then(async () => { result.ok = true; await H.save(phase, JSON.stringify(result)); }).catch(async error => {
  result.ok = false; result.error = { code: error.code, message: error.message, stack: error.stack }; result.trace = parse(H.trace()); await H.save(phase, JSON.stringify(result));
});
