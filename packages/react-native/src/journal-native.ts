import NativeModule from './specs/NativeGalinumJournal.js';
function nativeJournalModule() { if (!NativeModule) throw new GalinumError('journal_unavailable'); return NativeModule; }
import { GalinumError } from './types.js';
import type { JournalPort } from './journal.js';

function synchronous<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof GalinumError) throw error;
    const message = error instanceof Error ? error.message : '';
    const code = /\b(journal_writer_busy|journal_owner_stale|superseded|invalid_scope|invalid_event)\b/.exec(message)?.[1] ?? 'journal_bridge_failure';
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
    resolveInitialIntent: (scope, owner, destination) => synchronous(() => nativeJournalModule().resolveInitialIntent(scope, owner, destination)),
    setIntent: (scope, owner, intent) => synchronous(() => nativeJournalModule().setIntent(scope, owner, intent)),
    rejectTicket: (scope, owner, ticket) => synchronous(() => nativeJournalModule().rejectTicket(scope, owner, ticket)),
    hasStore: scope => call(() => nativeJournalModule().hasStore(scope)),
    open: (scope, owner, key) => call(() => nativeJournalModule().open(scope, owner, key)),
    closeGate: (scope, owner, intent) => call(() => nativeJournalModule().closeGate(scope, owner, intent)),
    publishBinding: (scope, owner, intent, binding) => call(() => nativeJournalModule().publishBinding(scope, owner, intent, JSON.stringify(binding))),
    admitEvent: (scope, owner, ticket, event) => call(async () => JSON.parse(await nativeJournalModule().admitEvent(scope, owner, ticket, event))),
    peek: (scope, owner, intent) => call(async () => JSON.parse(await nativeJournalModule().peek(scope, owner, intent))),
    acknowledge: (scope, owner, intent, generation, through) => call(() => nativeJournalModule().acknowledge(scope, owner, intent, generation, through)),
    release: (scope, owner) => call(() => nativeJournalModule().release(scope, owner)),
  };
}
