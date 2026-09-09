import { destinationUrl, matchesPages, normalizePath, sameEntry, type EntryCapture } from '@galinum/contracts/entry';
import type { FeedbackPort, InAppActions, InAppClientPort, InAppDestination, InAppFeedback, InAppMessage, InAppSession } from './inapp-types.js';

export type InAppState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'consumed' | 'empty';
  capture?: EntryCapture; message?: InAppMessage; host?: symbol; error?: string;
}>;
type Entry = { capture: EntryCapture; userId: string; path: string; messages: InAppMessage[]; index: number; consumed: boolean; closed?: boolean; presented?: boolean; shown?: Promise<void>; terminal?: 'clicked' | 'dismissed'; working?: Promise<void> };
export type InAppOptions = { id(): string; timeoutMs?: number; appSchemes?: readonly string[]; openDestination(destination: InAppDestination): Promise<void> };

export class InAppController {
  private state: InAppState = { phase: 'idle' };
  private listeners = new Set<() => void>();
  private hosts = new Set<symbol>();
  private entry?: Entry;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private session: InAppSession;
  private unsubscribe: () => void;
  private route?: { key: string; path: string };
  private ready = false;
  private active = false;
  private disposed = false;
  constructor(readonly client: InAppClientPort, readonly feedback: FeedbackPort, private options: InAppOptions) {
    if (controllers.has(client)) throw new Error('Use one in-app controller per client');
    controllers.set(client, this);
    this.session = { ...client.getSnapshot() };
    this.unsubscribe = client.subscribe(() => {
      const next = client.getSnapshot();
      if (next.owner === this.session.owner && next.userId === this.session.userId && next.facts === this.session.facts && next.appConfirmed === this.session.appConfirmed) return;
      const sameAuthority = next.owner === this.session.owner && next.userId === this.session.userId && next.appConfirmed === this.session.appConfirmed;
      this.session = { ...next };
      if (sameAuthority && this.entry?.consumed) return;
      this.begin();
    });
  }
  getSnapshot = (): InAppState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: InAppState) { this.state = state; for (const listener of this.listeners) listener(); }
  private cancel() { this.abort?.abort(); clearTimeout(this.timer); }
  private eligible() { return !this.disposed && this.active && this.ready && this.session.appConfirmed && !!this.session.userId && !!this.route; }
  private current(entry: Entry) {
    const live = this.client.getSnapshot();
    return this.entry === entry && !entry.closed && this.eligible() && live.appConfirmed && live.userId === entry.userId
      && JSON.stringify([live.owner, live.userId]) === entry.capture.identity && (entry.consumed || live.facts === entry.capture.facts)
      && !!this.state.capture && sameEntry(this.state.capture, entry.capture);
  }
  navigate(key: string, path: string, ready: boolean) {
    const normalized = normalizePath(path);
    if (this.route?.key === key && this.route.path === normalized) {
      if (this.ready === ready) return;
      this.ready = ready;
      if (this.entry) {
        if (!ready) {
          this.cancel(); this.entry.closed = true; this.entry.consumed = true;
          this.publish({ phase: this.state.phase === 'consumed' ? 'consumed' : 'empty', capture: this.entry.capture });
        }
        return;
      }
    }
    this.route = { key, path: normalized }; this.ready = ready; this.begin();
  }
  foreground(active: boolean) { if (this.active === active) return; this.active = active; this.begin(); }
  private begin() {
    this.cancel(); this.entry = undefined;
    if (!this.eligible()) { this.publish({ phase: 'idle' }); return; }
    const capture: EntryCapture = { identity: JSON.stringify([this.session.owner, this.session.userId]), facts: this.session.facts, entryId: this.options.id(), requestId: this.options.id() };
    const entry: Entry = { capture, userId: this.session.userId!, path: this.route!.path, messages: [], index: 0, consumed: false };
    this.entry = entry; this.abort = new AbortController();
    this.publish({ phase: 'loading', capture });
    this.deadline(entry);
    void this.load(entry, this.abort.signal);
    void this.feedback.flush().catch(() => {});
  }
  private deadline(entry: Entry) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.current(entry) && this.state.phase === 'loading') this.empty(entry); }, this.options.timeoutMs ?? 10000);
  }
  private empty(entry: Entry) { if (!this.current(entry)) return; this.cancel(); entry.consumed = true; this.publish({ phase: 'empty', capture: entry.capture }); }
  private async load(entry: Entry, signal: AbortSignal) {
    try {
      const decision = await this.client.decide({ userId: entry.userId, entryId: entry.capture.entryId, requestId: entry.capture.requestId, path: entry.path }, signal);
      if (!this.current(entry) || entry.consumed) return;
      if (decision.userId !== entry.userId || decision.entryId !== entry.capture.entryId || decision.requestId !== entry.capture.requestId || !Array.isArray(decision.messages)) { this.empty(entry); return; }
      entry.messages = decision.messages;
      await this.select(entry);
    } catch { this.empty(entry); }
  }
  private async select(entry: Entry) {
    try {
      while (this.current(entry) && !entry.consumed) {
        const message = entry.messages[entry.index];
        if (!message) { this.empty(entry); return; }
        const destination = message.content.cta?.destination;
        const allowed = matchesPages(message.pages, entry.path) && (!destination || destinationUrl(destination, this.options.appSchemes) !== null);
        const completed = allowed && await this.feedback.isCompleted(entry.userId, message.deliveryId);
        if (!this.current(entry) || entry.consumed) return;
        if (allowed && !completed) {
          clearTimeout(this.timer);
          this.publish({ phase: 'ready', capture: entry.capture, message, host: this.hosts.values().next().value }); return;
        }
        entry.index++;
      }
    } catch { this.empty(entry); }
  }
  attach(host: symbol) {
    this.hosts.add(host);
    if (this.state.phase === 'ready' && !this.state.host) this.publish({ ...this.state, host });
    return () => {
      this.hosts.delete(host);
      if (this.state.host !== host) return;
      if (this.entry?.consumed) this.publish({ phase: 'consumed', capture: this.entry.capture });
      else this.publish({ ...this.state, host: this.hosts.values().next().value });
    };
  }
  skip(host: symbol, capture: EntryCapture, message: InAppMessage) {
    const entry = this.entry;
    if (!entry || !this.current(entry) || !sameEntry(capture, entry.capture) || entry.consumed || this.state.host !== host || this.state.message !== message) return;
    entry.index++; this.publish({ phase: 'loading', capture: entry.capture }); this.deadline(entry); void this.select(entry);
  }
  commit(host: symbol, capture: EntryCapture, message: InAppMessage) {
    const entry = this.entry;
    if (!entry || !this.current(entry) || !sameEntry(capture, entry.capture) || entry.consumed || this.state.host !== host || this.state.message !== message) return;
    entry.consumed = true;
    this.publish({ ...this.state, phase: 'consumed' });
  }
  presented(host: symbol, capture: EntryCapture, message: InAppMessage) {
    const entry = this.entry;
    if (!entry || !this.current(entry) || !sameEntry(capture, entry.capture) || !entry.consumed || this.state.host !== host || this.state.message !== message || entry.presented) return;
    entry.presented = true;
    void this.shown(entry).catch(() => {});
  }
  private input(entry: Entry, type: InAppFeedback['type']): InAppFeedback {
    const deliveryId = entry.messages[entry.index]!.deliveryId;
    const prefix = entry.capture.entryId;
    return { userId: entry.userId, deliveryId, type, feedbackId: prefix + ':' + type, shownFeedbackId: prefix + ':shown' };
  }
  private async admit(entry: Entry, type: InAppFeedback['type']) {
    const input = this.input(entry, type);
    const receipt = await this.feedback.admit(input);
    if (receipt.feedbackId !== input.feedbackId || !['queued', 'acknowledged'].includes(receipt.state)) throw new Error('Invalid feedback admission');
    void this.feedback.flush().catch(() => {});
  }
  private shown(entry: Entry): Promise<void> {
    entry.shown ??= this.admit(entry, 'shown').catch(error => {
      entry.shown = undefined;
      if (this.current(entry)) this.publish({ ...this.state, error: 'Could not save message feedback. Try again.' });
      throw error;
    });
    return entry.shown;
  }
  actions(host: symbol, capture: EntryCapture, message: InAppMessage): InAppActions {
    const ownsPresentation = (entry: Entry) => this.current(entry) && sameEntry(capture, entry.capture)
      && entry.presented && this.state.host === host && this.state.message === message;
    const act = async (type?: 'clicked' | 'dismissed') => {
      const entry = this.entry;
      if (!entry || !ownsPresentation(entry)) return;
      if (entry.working) return entry.working;
      if (type && entry.terminal && type !== entry.terminal) throw new Error('Retry the pending action');
      if (type) entry.terminal = type;
      entry.working = (async () => {
        try {
          await this.shown(entry);
          if (!ownsPresentation(entry)) return;
          if (!entry.terminal) { this.publish({ ...this.state, error: undefined }); return; }
          await this.admit(entry, entry.terminal);
          if (!ownsPresentation(entry)) return;
          const destination = entry.messages[entry.index]!.content.cta?.destination;
          if (entry.terminal === 'clicked' && destination && destinationUrl(destination, this.options.appSchemes)) await this.options.openDestination(destination);
          if (ownsPresentation(entry)) this.publish({ phase: 'consumed', capture: entry.capture });
        } catch (error) {
          if (ownsPresentation(entry)) this.publish({ ...this.state, error: 'Could not complete message action. Try again.' });
          throw error;
        } finally { entry.working = undefined; }
      })();
      return entry.working;
    };
    return { dismiss: () => act('dismissed'), click: () => act('clicked'), retry: () => act() };
  }
  dispose() { if (this.disposed) return; controllers.delete(this.client); this.disposed = true; this.cancel(); this.unsubscribe(); this.entry = undefined; this.publish({ phase: 'idle' }); this.hosts.clear(); }
}

const controllers = new WeakMap<InAppClientPort, InAppController>();
export function getInAppController(client: InAppClientPort, feedback: FeedbackPort, options: InAppOptions): InAppController {
  let controller = controllers.get(client);
  if (!controller) { controller = new InAppController(client, feedback, options); controllers.set(client, controller); }
  return controller;
}
