import NativeModule from './specs/NativeGalinumJournal.js';
function nativeJournalModule() { if (!NativeModule) throw new GalinumError('journal_unavailable'); return NativeModule; }
import { GalinumError } from './types.js';
import type { JournalPort } from './journal.js';

function synchronous<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof GalinumError) throw error;
    const message = error instanceof Error ? error.message : '';
    const code = /\b(journal_writer_busy|journal_owner_stale|superseded|invalid_scope|invalid_event|invalid_proposal)\b/.exec(message)?.[1] ?? 'journal_bridge_failure';
    throw new GalinumError(code);
  }
}
async function call<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'journal_storage_failure';
    throw new GalinumError(code);
  }
}
export function createNativeJournal(): JournalPort {
  return {
    claim: scope => synchronous(() => nativeJournalModule().claim(scope)),
    reserve: (scope, owner, intent, eventId) => synchronous(() => JSON.parse(nativeJournalModule().reserve(scope, owner, intent, eventId))),
    resolveInitialIntent: (scope, owner, destination) => { synchronous(() => nativeJournalModule().resolveInitialIntent(scope, owner, destination)); },
    setIntent: (scope, owner, intent) => { synchronous(() => nativeJournalModule().setIntent(scope, owner, intent)); },
    rejectTicket: (scope, owner, ticket) => { synchronous(() => nativeJournalModule().rejectTicket(scope, owner, ticket)); },
    restrictDisplay: (scope, owner) => { synchronous(() => nativeJournalModule().restrictDisplay(scope, owner)); },
    proposeDisplay: (scope, owner, proposal) => synchronous(() => nativeJournalModule().proposeDisplay(scope, owner, JSON.stringify(proposal))),
    open: (scope, owner) => call(() => nativeJournalModule().open(scope, owner)),
    readControl: (scope, owner) => call(async () => JSON.parse(await nativeJournalModule().readControl(scope, owner))),
    commitControl: (scope, owner, operationId, expectedRevision, state, restrict) => call(async () => JSON.parse(await nativeJournalModule().commitControl(scope, owner, operationId, expectedRevision ?? -1, JSON.stringify(state), restrict))),
    operation: (scope, owner, operationId) => call(async () => JSON.parse(await nativeJournalModule().operation(scope, owner, operationId))),
    publishDisplay: (scope, owner, proposal) => call(async () => JSON.parse(await nativeJournalModule().publishDisplay(scope, owner, proposal))),
    closeGate: (scope, owner, intent) => call(() => nativeJournalModule().closeGate(scope, owner, intent)),
    publishBinding: (scope, owner, intent, binding) => call(() => nativeJournalModule().publishBinding(scope, owner, intent, JSON.stringify(binding))),
    admitEvent: (scope, owner, ticket, event) => call(async () => JSON.parse(await nativeJournalModule().admitEvent(scope, owner, ticket, event))),
    peek: (scope, owner, intent) => call(async () => JSON.parse(await nativeJournalModule().peek(scope, owner, intent))),
    acknowledge: (scope, owner, intent, generation, through) => call(() => nativeJournalModule().acknowledge(scope, owner, intent, generation, through)),
    configureNotifications: (scope, owner, setup) => call(async () => JSON.parse(await nativeJournalModule().configureNotifications(scope, owner, JSON.stringify(setup)))),
    readInteractions: (scope, owner, intent) => call(async () => JSON.parse(await nativeJournalModule().readInteractions(scope, owner, intent))),
    acknowledgeInteraction: (scope, owner, intent, interactionId, disposition) => call(() => nativeJournalModule().acknowledgeInteraction(scope, owner, intent, interactionId, disposition)),
    cancelNotifications: (scope, owner) => call(() => nativeJournalModule().cancelNotifications(scope, owner)),
    readCompletion: (scope, owner, userId, deliveryId) => call(() => nativeJournalModule().readCompletion(scope, owner, userId, deliveryId)),
    admitFeedback: (scope, owner, feedback) => call(async () => JSON.parse(await nativeJournalModule().admitFeedback(scope, owner, JSON.stringify(feedback)))),
    peekFeedback: (scope, owner) => call(async () => JSON.parse(await nativeJournalModule().peekFeedback(scope, owner))),
    acknowledgeFeedback: (scope, owner, feedbackId, receipt) => call(() => nativeJournalModule().acknowledgeFeedback(scope, owner, feedbackId, JSON.stringify(receipt))),
    subscribeInteractions: (scope, listener) => {
      const subscription = nativeJournalModule().onInteraction(value => { if (value === scope) listener(); });
      return () => subscription.remove();
    },
    release: (scope, owner) => call(() => nativeJournalModule().release(scope, owner)),
  };
}
