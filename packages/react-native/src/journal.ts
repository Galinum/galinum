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
export type NotificationSetup = { foreground?: 'display' | 'suppress'; channels?: { id: string; name: string; importance?: 'default' | 'high' | 'low' }[]; actions?: { id: string; title: string }[]; categories?: { id: string; actions: string[] }[]; android?: { smallIcon?: string } };
export type NotificationCapabilities = InstallationState['capabilities'];
export type NotificationInteraction = Readonly<{ id: string; kind: 'tap' | 'action'; actionId?: string; targetId: string; attemptId: string; test: boolean; userId: string; bindingGeneration: number; destination: { kind: 'website' | 'app'; url: string }; data: Readonly<Record<string, string>>; title: string; body: string; receivedAt: number; interactedAt: number }>;
export type InteractionDisposition = 'handled' | 'retired';
export type FeedbackType = 'shown' | 'clicked' | 'dismissed' | 'converted';
export type JournalFeedback = { userId: string; deliveryId: string; type: FeedbackType; feedbackId: string; shownFeedbackId: string };
export type FeedbackReceipt = Readonly<{ feedbackId: string; state: 'queued' | 'acknowledged' }>;
export type FeedbackAcknowledgement = { userId: string; deliveryId: string; type: FeedbackType; receiptId: string; acknowledgedAt: number };
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
  configureNotifications(scope: string, owner: string, setup: NotificationSetup): Promise<NotificationCapabilities>;
  readInteractions(scope: string, owner: string, intent: number): Promise<NotificationInteraction[]>;
  acknowledgeInteraction(scope: string, owner: string, intent: number, interactionId: string, disposition: InteractionDisposition): Promise<void>;
  cancelNotifications(scope: string, owner: string): Promise<void>;
  readCompletion(scope: string, owner: string, userId: string, deliveryId: string): Promise<boolean>;
  admitFeedback(scope: string, owner: string, feedback: JournalFeedback): Promise<FeedbackReceipt>;
  peekFeedback(scope: string, owner: string): Promise<JournalFeedback[]>;
  acknowledgeFeedback(scope: string, owner: string, feedbackId: string, receipt: FeedbackAcknowledgement): Promise<void>;
  subscribeInteractions(scope: string, listener: () => void): () => void;
  release(scope: string, owner: string): Promise<void>;
}

export class JournalController {
  readonly owner: string;
  private opening: Promise<void> | undefined;
  private disposed = false;
  private unsubscribe: (() => void) | undefined;
  constructor(readonly port: JournalPort, readonly scope: string, private readonly timeout: number, private readonly checkLegacy: () => Promise<void> = async () => {}) {
    this.owner = port.claim(scope);
  }
  listen(listener: () => void) {
    this.unsubscribe?.();
    this.unsubscribe = this.disposed ? undefined : this.port.subscribeInteractions(this.scope, listener);
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
  async configureNotifications(setup: NotificationSetup): Promise<NotificationCapabilities> {
    await this.ready();
    return bounded(this.port.configureNotifications(this.scope, this.owner, setup), this.timeout, 'journal_storage_timeout');
  }
  async readInteractions(intent: number): Promise<NotificationInteraction[]> {
    await this.ready();
    return bounded(this.port.readInteractions(this.scope, this.owner, intent), this.timeout, 'journal_storage_timeout');
  }
  async acknowledgeInteraction(intent: number, interactionId: string, disposition: InteractionDisposition) {
    await this.ready();
    await bounded(this.port.acknowledgeInteraction(this.scope, this.owner, intent, interactionId, disposition), this.timeout, 'journal_storage_timeout');
  }
  async cancelNotifications() {
    await this.ready();
    await bounded(this.port.cancelNotifications(this.scope, this.owner), this.timeout, 'journal_storage_timeout');
  }
  async readCompletion(userId: string, deliveryId: string): Promise<boolean> {
    await this.ready();
    return bounded(this.port.readCompletion(this.scope, this.owner, userId, deliveryId), this.timeout, 'journal_storage_timeout');
  }
  async admitFeedback(feedback: JournalFeedback): Promise<FeedbackReceipt> {
    await this.ready();
    return bounded(this.port.admitFeedback(this.scope, this.owner, feedback), this.timeout, 'journal_storage_timeout');
  }
  async peekFeedback(): Promise<JournalFeedback[]> {
    await this.ready();
    return bounded(this.port.peekFeedback(this.scope, this.owner), this.timeout, 'journal_storage_timeout');
  }
  async acknowledgeFeedback(feedbackId: string, receipt: FeedbackAcknowledgement) {
    await this.ready();
    await bounded(this.port.acknowledgeFeedback(this.scope, this.owner, feedbackId, receipt), this.timeout, 'journal_storage_timeout');
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.port.setIntent(this.scope, this.owner, Number.MAX_SAFE_INTEGER);
    void (this.opening ?? Promise.resolve()).catch(() => {}).then(() => this.port.release(this.scope, this.owner)).catch(() => {});
  }
}
