import type { InstallationState, PushCommand } from '@galinum/contracts';
import { GalinumError } from './types.js';
import { bounded, type LocalState } from './storage.js';

export type EventReceipt = Readonly<{ eventId: string; state: 'queued' | 'acknowledged' }>;
export class EventAdmissionError extends GalinumError {
  constructor(code: string, public readonly eventId: string) { super(code); }
}
export type IngressTicket = Readonly<{ id: string; eventId: string; reused?: boolean }>;
export type BindingPublication = { installationId: string; userId: string | null; generation: number; bindingRevision: number; acknowledgedBindingRevision: number; serverRevision: number; appConfirmed: boolean };
export type JournalPrefix = { generation: number; acknowledgedThrough: number; lastSequence: number; commands: PushCommand[]; pendingAdmissions: number; appConfirmed: boolean };
export type DisplayTag = 'closed' | 'open';
export type ControlRow = { revision: number; state: LocalState; display: DisplayTag };
export type ControlReceipt = { operationId: string; revision: number; display: DisplayTag; restrictive: boolean };
export type OperationReceipt = { state: 'committed' | 'unknown'; revision?: number; kind?: string; disposition?: string };
export type DisplayProposal = { operationId: string; controlRevision: number; userId: string; deadlineMs: number };
export type DisplayReceipt = { state: 'open' | 'open-then-restricted'; publicationId: string; controlRevision: number };
export interface JournalPort {
  claim(scope: string): string;
  reserve(scope: string, owner: string, intent: number, eventId: string): IngressTicket;
  resolveInitialIntent(scope: string, owner: string, destination: number): void;
  setIntent(scope: string, owner: string, intent: number): void;
  rejectTicket(scope: string, owner: string, ticket: string): void;
  restrictDisplay(scope: string, owner: string): void;
  proposeDisplay(scope: string, owner: string, proposal: DisplayProposal): string;
  open(scope: string, owner: string): Promise<void>;
  readControl(scope: string, owner: string): Promise<ControlRow | null>;
  commitControl(scope: string, owner: string, operationId: string, expectedRevision: number | null, state: LocalState, restrict: boolean): Promise<ControlReceipt>;
  operation(scope: string, owner: string, operationId: string): Promise<OperationReceipt>;
  publishDisplay(scope: string, owner: string, proposal: string): Promise<DisplayReceipt>;
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
  constructor(readonly port: JournalPort, readonly scope: string, private readonly timeout: number, private readonly checkLegacy: () => Promise<void> = async () => {}) {
    this.owner = port.claim(scope);
  }
  reserve(intent: number, eventId = ''): IngressTicket {
    if (this.disposed) throw new GalinumError('disposed');
    return this.port.reserve(this.scope, this.owner, intent, eventId);
  }
  reject(ticket: IngressTicket) { if (ticket.reused) return; this.port.rejectTicket(this.scope, this.owner, ticket.id); }
  resolveInitial(destination: number) { this.port.resolveInitialIntent(this.scope, this.owner, destination); }
  intent(intent: number) { this.port.setIntent(this.scope, this.owner, intent); }
  restrict() { if (!this.disposed) this.port.restrictDisplay(this.scope, this.owner); }
  propose(proposal: DisplayProposal): string {
    if (this.disposed) throw new GalinumError('disposed');
    return this.port.proposeDisplay(this.scope, this.owner, proposal);
  }
  private initialize(): Promise<void> {
    this.opening ??= (async () => {
      await Promise.resolve();
      await this.checkLegacy();
      if (this.disposed) throw new GalinumError('disposed');
      await this.port.open(this.scope, this.owner);
    })().catch(error => { this.opening = undefined; throw error; });
    return this.opening;
  }
  private async ready() { await bounded(this.initialize(), this.timeout, 'journal_storage_timeout'); }
  async readControl(): Promise<ControlRow | null> {
    await this.ready();
    return this.port.readControl(this.scope, this.owner);
  }
  async commitControl(operationId: string, expectedRevision: number | null, state: LocalState, restrict: boolean): Promise<ControlReceipt> {
    await this.ready();
    return this.port.commitControl(this.scope, this.owner, operationId, expectedRevision, state, restrict);
  }
  async operation(operationId: string): Promise<OperationReceipt> {
    await this.ready();
    return this.port.operation(this.scope, this.owner, operationId);
  }
  async publishDisplay(proposal: string): Promise<DisplayReceipt> {
    await this.ready();
    return bounded(this.port.publishDisplay(this.scope, this.owner, proposal), this.timeout, 'journal_storage_timeout');
  }
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
