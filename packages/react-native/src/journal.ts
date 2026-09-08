import type { InstallationState, PushCommand } from '@galinum/contracts';
import type { KeyValueStore } from './types.js';
import { GalinumError } from './types.js';
import { bounded } from './storage.js';

export type EventReceipt = Readonly<{ eventId: string; state: 'queued' | 'acknowledged' }>;
export class EventAdmissionError extends GalinumError {
  constructor(code: string, public readonly eventId: string) { super(code); }
}
export type IngressTicket = Readonly<{ id: string; eventId: string; reused?: boolean }>;
export type BindingPublication = { installationId: string; userId: string | null; generation: number; bindingRevision: number; acknowledgedBindingRevision: number; serverRevision: number; appConfirmed: boolean };
export type JournalPrefix = { generation: number; acknowledgedThrough: number; lastSequence: number; commands: PushCommand[]; pendingAdmissions: number; appConfirmed: boolean };
export interface JournalPort {
  claim(scope: string): string;
  reserve(scope: string, owner: string, intent: number, eventId: string): IngressTicket;
  resolveInitialIntent(scope: string, owner: string, destination: number): void;
  setIntent(scope: string, owner: string, intent: number): void;
  rejectTicket(scope: string, owner: string, ticket: string): void;
  hasStore(scope: string): Promise<boolean>;
  open(scope: string, owner: string, key: string): Promise<void>;
  closeGate(scope: string, owner: string, intent: number): Promise<void>;
  publishBinding(scope: string, owner: string, intent: number, binding: BindingPublication): Promise<void>;
  admitEvent(scope: string, owner: string, ticket: string, event: string): Promise<EventReceipt>;
  peek(scope: string, owner: string, intent: number): Promise<JournalPrefix>;
  acknowledge(scope: string, owner: string, intent: number, generation: number, through: number): Promise<void>;
  release(scope: string, owner: string): Promise<void>;
}

export class JournalController {
  readonly owner: string;
  private opening: Promise<void> | undefined;
  private disposed = false;
  constructor(readonly port: JournalPort, readonly scope: string, private readonly secrets: KeyValueStore, private readonly random: (length: number) => Promise<Uint8Array>, private readonly timeout: number) {
    this.owner = port.claim(scope);
  }
  reserve(intent: number, eventId = ''): IngressTicket {
    if (this.disposed) throw new GalinumError('disposed');
    return this.port.reserve(this.scope, this.owner, intent, eventId);
  }
  reject(ticket: IngressTicket) { if (ticket.reused) return; this.port.rejectTicket(this.scope, this.owner, ticket.id); }
  resolveInitial(destination: number) { this.port.resolveInitialIntent(this.scope, this.owner, destination); }
  intent(intent: number) { this.port.setIntent(this.scope, this.owner, intent); }
  private initialize(): Promise<void> {
    this.opening ??= (async () => {
      const keyName = this.scope + '.journal-key';
      let key = await this.secrets.get(keyName);
      if (key === null) {
        if (await this.port.hasStore(this.scope)) throw new GalinumError('journal_key_missing');
        const bytes = await this.random(32);
        if (bytes.length !== 32) throw new GalinumError('random_failure');
        key = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        await this.secrets.set(keyName, key);
      }
      if (!/^[a-f0-9]{64}$/.test(key)) throw new GalinumError('invalid_journal_key');
      if (this.disposed) throw new GalinumError('disposed');
      await this.port.open(this.scope, this.owner, key);
    })().catch(error => { this.opening = undefined; throw error; });
    return this.opening;
  }
  private async ready() { await bounded(this.initialize(), this.timeout, 'journal_storage_timeout'); }
  async close(intent: number) {
    await this.ready();
    await bounded(this.port.closeGate(this.scope, this.owner, intent), this.timeout, 'journal_storage_timeout');
  }
  async publish(intent: number, state: InstallationState, bindingRevision: number, acknowledgedBindingRevision: number, appConfirmed: boolean) {
    await this.ready();
    await bounded(this.port.publishBinding(this.scope, this.owner, intent, { installationId: state.id, userId: state.userId, generation: state.bindingGeneration, bindingRevision, acknowledgedBindingRevision, serverRevision: state.revision, appConfirmed }), this.timeout, 'journal_storage_timeout');
  }
  async admit(ticket: IngressTicket, event: string): Promise<EventReceipt> {
    const admission = this.port.admitEvent(this.scope, this.owner, ticket.id, event);
    void admission.catch(() => {});
    try { await this.ready(); return await bounded(admission, this.timeout, 'journal_storage_timeout'); }
    catch (error) { throw new EventAdmissionError(error instanceof GalinumError ? error.code : 'journal_admission_uncertain', ticket.eventId); }
  }
  async peek(intent: number) { await this.ready(); return bounded(this.port.peek(this.scope, this.owner, intent), this.timeout, 'journal_storage_timeout'); }
  async acknowledge(intent: number, generation: number, through: number) {
    await bounded(this.port.acknowledge(this.scope, this.owner, intent, generation, through), this.timeout, 'journal_storage_timeout');
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.port.setIntent(this.scope, this.owner, Number.MAX_SAFE_INTEGER);
    void (this.opening ?? Promise.resolve()).catch(() => {}).then(() => this.port.release(this.scope, this.owner)).catch(() => {});
  }
}
