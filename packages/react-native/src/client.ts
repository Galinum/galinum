import { JournalController, EventAdmissionError, type EventReceipt, type FeedbackAcknowledgement, type FeedbackReceipt, type IngressTicket, type JournalFeedback, type NotificationCapabilities } from './journal.js';
import type { InstallationState, PushObservationBatch } from "@galinum/contracts";
import { GalinumError, type GalinumSession, type InAppClientPort, type InAppDecision, type InAppSession, type NativeConfig, type NativeSnapshot, type NotificationHandler, type Permission, type Properties } from "./types.js";
import { copyJson, digest, freeze, parseInstallation } from "./wire.js";
import { bounded, InstallationStorage, type Pending } from "./storage.js";
import { validInAppMessage } from './inapp-wire.js';

type JournalIntent = { version: number; userId: string | null | undefined; confirmed: boolean; redirect?: JournalIntent };
type Context = { epoch: number };
type NotificationRegistration = { handler: NotificationHandler };
const emptyCapabilities: NotificationCapabilities = { actions: [], channels: [], richImages: false };
const feedbackTypes = ['shown', 'clicked', 'dismissed', 'converted'];
const eligible = (permission: Permission) => permission === "granted" || permission === "provisional";

export function createGalinumClient(config: NativeConfig) { return new GalinumClient(config); }

export class GalinumClient {
  private readonly config: NativeConfig;
  private readonly storage: InstallationStorage;
  private state: InstallationState | null = null;
  private readonly journal: JournalController;
  private journalInitialResolved = false;
  private journalIntent: JournalIntent = { version: 0, userId: undefined, confirmed: false };
  private capabilities: NotificationCapabilities = emptyCapabilities;
  private configuredNotifications = false;
  private registration: NotificationRegistration | undefined;
  private dispatching: Promise<void> = Promise.resolve();
  private dispatchCancellation = new AbortController();
  private displayRestricted = true;
  private displayRevision = 0;
  private consentRevision = 0;
  private tokenRevoked = false;
  private sender: Promise<void> | undefined;
  private epoch = 0;
  private cancellation = new AbortController();
  private tokenSequence = 0;
  private promptSequence = 0;
  private permissionVersion = 0;
  private promptPermission: Permission | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private disposed = false;
  private unsubscribeToken: (() => void) | undefined;
  private listeners = new Set<() => void>();
  private inAppListeners = new Set<() => void>();
  private inAppSnapshot!: InAppSession;
  private factsWrite: Promise<unknown> = Promise.resolve();
  private identityConfirmation = 0;
  private snapshot: NativeSnapshot = freeze({ status: "idle", userId: null, consent: false, installation: null, error: null });

  constructor(config: NativeConfig) {
    let url: URL;
    try { url = new URL(config.apiBase); } catch { throw new GalinumError("invalid_config"); }
    const insecureDevelopment = config.environment === "development" && ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && insecureDevelopment) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !config.publishableKey || !config.appId || !/^[\w.-]+$/.test(config.storageKey) || [config.requestTimeoutMs, config.nativeTimeoutMs, config.storageTimeoutMs].some(value => value !== undefined && (!Number.isFinite(value) || value <= 0))) throw new GalinumError("invalid_config");
    this.config = { ...config, apiBase: url.origin };
    if (!config.adapter.journal) throw new GalinumError("journal_required");
    this.journal = new JournalController(config.adapter.journal, digest(JSON.stringify([url.origin, config.publishableKey, config.appId, config.platform, config.environment, config.storageKey])), config.storageTimeoutMs ?? 10000, () => config.adapter.checkLegacyState(config.storageKey));
    this.storage = new InstallationStorage(this.config, this.journal);
    this.inAppSnapshot = freeze({ owner: this.journal.owner, userId: null, facts: 0, appConfirmed: false });
  }

  private invalidateInApp(userId = this.inAppSnapshot.userId, appConfirmed = this.inAppSnapshot.appConfirmed) {
    this.inAppSnapshot = freeze({ owner: this.journal.owner, userId, appConfirmed, facts: this.inAppSnapshot.facts + 1 });
    for (const listener of this.inAppListeners) { try { listener(); } catch {} }
  }

  readonly inApp: InAppClientPort = Object.freeze({
    getSnapshot: () => this.inAppSnapshot,
    subscribe: (listener: () => void) => { this.inAppListeners.add(listener); return () => { this.inAppListeners.delete(listener); }; },
    decide: async (input: Parameters<InAppClientPort['decide']>[0], signal: AbortSignal) => {
      const capture = this.inAppSnapshot;
      const capturedInput = copyJson(input);
      const current = () => {
        if (this.disposed) throw new GalinumError('disposed');
        if (signal.aborted || capture !== this.inAppSnapshot) throw new GalinumError('superseded');
        if (!capture.appConfirmed || !capture.userId || capturedInput.userId !== capture.userId) throw new GalinumError('identify_required');
      };
      current();
      await bounded(Promise.resolve().then(() => this.queue), undefined, 'superseded', signal);
      await bounded(this.factsWrite, undefined, 'superseded', signal);
      current();
      await bounded(this.flush(), undefined, 'superseded', signal);
      current();
      const response = await this.request('/api/v1/messages?' + new URLSearchParams(capturedInput), 'GET', undefined, false, signal, true) as InAppDecision | null;
      current();
      if (!response || response.userId !== capturedInput.userId || response.entryId !== capturedInput.entryId || response.requestId !== capturedInput.requestId || !Array.isArray(response.messages)
        || !response.messages.every(validInAppMessage)) throw new GalinumError('invalid_response');
      return freeze(copyJson(response));
    },
  });

  getSnapshot = (): NativeSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(status: NativeSnapshot["status"] = "ready", error: GalinumError | null = null) {
    if (this.disposed && status !== "disposed") return;
    const session = status === "disposed" ? { userId: null, consent: false } : this.storage.local?.session ?? { userId: null, consent: false };
    const installation = status !== "starting" && status !== "disposed" && this.state?.userId === session.userId ? copyJson(this.state) : null;
    this.snapshot = freeze({ status, ...session, installation, error: error ? { code: error.code, ...(error.status === undefined ? {} : { status: error.status }) } : null });
    for (const listener of this.listeners) { try { listener(); } catch {} }
  }

  private assertCurrent(epoch: number) {
    if (this.disposed) throw new GalinumError("disposed");
    if (epoch !== this.epoch) throw new GalinumError("superseded");
  }

  private enqueue<T>(run: () => Promise<T>, context: Context): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.disposed) throw new GalinumError("disposed");
      try { return await run(); } catch (error) {
        const safe = error instanceof GalinumError ? error : new GalinumError("adapter_failure");
        if (context.epoch === this.epoch && safe.code !== "superseded") this.publish("error", safe);
        throw safe;
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async native<T>(run: (signal: AbortSignal) => Promise<T>, epoch: number, prompt = false): Promise<T> {
    this.assertCurrent(epoch);
    const signal = this.cancellation.signal;
    try {
      const result = await bounded(run(signal), prompt ? undefined : this.config.nativeTimeoutMs ?? 10000, "adapter_timeout", signal);
      this.assertCurrent(epoch);
      return result;
    } catch (error) {
      this.assertCurrent(epoch);
      throw error instanceof GalinumError ? error : new GalinumError("adapter_failure");
    }
  }

  private identity(userId: string | null, reset: boolean, context: Context): Promise<void> {
    const apply = () => {
      if (this.disposed) throw new GalinumError("disposed");
      const local = this.storage.local!;
      if (reset || local.session.userId !== userId) {
        if (local.bindingRevision === Number.MAX_SAFE_INTEGER) throw new GalinumError("invalid_storage");
        local.bindingRevision++;
        local.session = { userId, consent: false };
        local.pending = null;
        this.epoch++;
        context.epoch = this.epoch;
        this.cancellation.abort();
        this.cancellation = new AbortController();
        this.promptPermission = undefined;
        this.permissionVersion++;
        this.publish("starting");
        if (this.initialized && context.epoch === this.epoch) this.listen();
      } else context.epoch = this.epoch;
      return this.storage.persist();
    };
    let ready: Promise<void>;
    try { ready = this.storage.local ? apply() : this.storage.load().then(apply); } catch (error) { ready = Promise.reject(error); }
    void ready.catch(() => {});
    return ready;
  }

  private async request(path: string, method: string, body?: unknown, installation = true, signal?: AbortSignal, fresh = false): Promise<unknown> {
    if (this.disposed) throw new GalinumError("disposed");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      return await bounded((async () => {
        const response = await (this.config.fetch ?? globalThis.fetch)(this.config.apiBase + path, {
          method, signal: controller.signal,
          ...(fresh ? { cache: 'no-store' as const } : {}),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.publishableKey}`, ...(installation ? { "X-Galinum-Installation-Capability": this.storage.credentials!.capability } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status !== 200) throw new GalinumError("http_error", response.status);
        try { return await response.json(); } catch { throw new GalinumError("invalid_response"); }
      })(), this.config.requestTimeoutMs ?? 10000, "transport_uncertain", signal);
    } catch (error) { throw error instanceof GalinumError ? error : new GalinumError("transport_uncertain"); }
    finally { signal?.removeEventListener('abort', abort); controller.abort(); }
  }

  private async retry<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await run(); } catch (error) {
        const retryable = error instanceof GalinumError && (error.code === "transport_uncertain" || error.status === 408 || error.status !== undefined && error.status >= 500);
        if (!retryable || attempt >= 1) throw error;
      }
    }
  }

  private path() { return `/api/v1/sdk/installations/${this.storage.credentials!.installationId}`; }
  private async read() {
    const state = parseInstallation(await this.retry(() => this.request(this.path(), "GET")));
    if (state.id !== this.storage.credentials!.installationId || state.appId !== this.config.appId || state.platform !== this.config.platform || state.environment !== this.config.environment) throw new GalinumError("identity_mismatch");
    if (this.state && state.bindingGeneration !== this.state.bindingGeneration) this.cancelDispatch();
    this.state = state;
  }

  private async clearPending(pending: Pending) {
    if (this.storage.local!.pending === pending) this.storage.local!.pending = null;
    await this.storage.persist();
  }

  private async rejectPending(error: unknown, pending: Pending) {
    if (error instanceof GalinumError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) await this.clearPending(pending);
    throw error;
  }

  private async settle() {
    const pending = this.storage.local!.pending;
    if (!pending) return;
    if (pending.route === "binding" && pending.body.userId !== this.storage.local!.session.userId) { await this.clearPending(pending); return; }
    let acknowledgement: InstallationState | undefined;
    try {
      acknowledgement = parseInstallation(await this.retry(() => {
        if (this.storage.local!.pending !== pending) throw new GalinumError("superseded");
        return this.request(`${this.path()}/${pending.route}`, pending.route === "activity" ? "POST" : "PUT", pending.body);
      }));
    } catch (error) {
      if (!(error instanceof GalinumError) || error.status !== 409) await this.rejectPending(error, pending);
    }
    await this.read();
    if (pending.route === "token" && this.storage.local!.pending === pending && acknowledgement?.tokenRevision === this.state!.tokenRevision) {
      this.storage.local!.token = typeof pending.body.token === "string" && this.state!.hasToken ? { hash: digest(pending.body.token), revision: acknowledgement.tokenRevision } : null;
    }
    await this.clearPending(pending);
  }

  private async mutate(route: Pending["route"], fields: Record<string, unknown>, epoch?: number) {
    await this.settle();
    const generation = this.state!.bindingGeneration;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (epoch !== undefined) this.assertCurrent(epoch);
      if (route !== "binding" && (this.state!.bindingGeneration !== generation || epoch !== undefined && this.state!.userId !== this.storage.local!.session.userId)) throw new GalinumError("binding_changed");
      const body = { ...fields, requestId: await this.storage.random(16), bindingGeneration: this.state!.bindingGeneration, revision: this.state!.revision, ...(route === "token" ? { tokenRevision: this.state!.tokenRevision } : {}) };
      if (epoch !== undefined) this.assertCurrent(epoch);
      const pending: Pending = { route, body };
      this.storage.local!.pending = pending;
      await this.storage.persist();
      if (epoch !== undefined) this.assertCurrent(epoch);
      let acknowledgement: InstallationState;
      try {
        acknowledgement = parseInstallation(await this.retry(() => {
          if (epoch !== undefined) this.assertCurrent(epoch);
          return this.request(`${this.path()}/${route}`, route === "activity" ? "POST" : "PUT", body);
        }));
      } catch (error) {
        if (!(error instanceof GalinumError) || error.status !== 409) await this.rejectPending(error, pending);
        await this.read();
        await this.clearPending(pending);
        continue;
      }
      await this.read();
      await this.clearPending(pending);
      if (epoch !== undefined) this.assertCurrent(epoch);
      return acknowledgement!;
    }
    throw new GalinumError("revision_conflict");
  }

  private async initialize() {
    await this.storage.load();
    await this.storage.persist();
    if (this.config.notifications && !this.configuredNotifications) {
      this.capabilities = freeze(copyJson(await this.journal.configureNotifications(copyJson(this.config.notifications))));
      this.configuredNotifications = true;
    }
    if (!this.initialized) {
      const { installationId, capability } = this.storage.credentials!;
      parseInstallation(await this.retry(() => this.request("/api/v1/sdk/installations", "POST", { installationId, capability, appId: this.config.appId, platform: this.config.platform, environment: this.config.environment })));
    }
    await this.read();
    await this.settle();
    if (this.disposed) throw new GalinumError("disposed");
    if (!this.initialized) { this.initialized = true; this.listen(); }
  }

  private listen() {
    this.unsubscribeToken?.();
    this.journal.listen(() => { this.scheduleFlush(); this.dispatch(); });
    const context = { epoch: this.epoch };
    this.unsubscribeToken = this.config.adapter.subscribeToken(token => {
      if (context.epoch !== this.epoch || this.disposed) return;
      const sequence = ++this.tokenSequence;
      this.tokenRevoked = token === null;
      let closure: Promise<void>;
      try { closure = token === null ? this.closeDisplay(context.epoch) : Promise.resolve(); }
      catch { return; }
      void closure.catch(() => {});
      void this.enqueue(async () => {
        this.assertCurrent(context.epoch);
        if (sequence !== this.tokenSequence) return;
        await closure;
        if (sequence !== this.tokenSequence) return;
        await this.initialize();
        await this.sync(context.epoch, undefined, { token, sequence });
        this.publish();
      }, context).catch(() => {});
    });
  }

  private journalIdentity(userId: string | null, reset: boolean) {
    const previous = this.journalIntent;
    const unresolved = !this.journalInitialResolved && previous.version === 0 && previous.userId === undefined;
    if (reset || this.journalIntent.userId !== userId) {
      this.cancelDispatch();
      this.journalIntent = { version: this.journalIntent.version + 1, userId, confirmed: true };
      this.journal.intent(this.journalIntent.version);
      this.displayRestricted = true;
      this.displayRevision++;
      this.tokenRevoked = false;
    } else this.journalIntent.confirmed = true;
    const capture = this.journalIntent;
    const savedUser = !unresolved ? Promise.resolve(null) : this.storage.local ? Promise.resolve(this.storage.local.session.userId) : this.storage.load().then(() => this.storage.local!.session.userId);
    const resolution = unresolved ? savedUser.then(storedUser => {
      if (this.journalInitialResolved) return;
      const same = !reset && capture === this.journalIntent && storedUser === userId;
      if (same) previous.redirect = capture;
      this.journal.resolveInitial(same ? capture.version : -1);
      this.journalInitialResolved = true;
    }) : Promise.resolve();
    const closed = Promise.all([resolution, this.journal.close(capture.version)]).then(() => {});
    void closed.catch(() => {});
    return closed;
  }
  private async publishJournal() {
    const intent = this.journalIntent;
    if (!this.journalInitialResolved) { this.journal.resolveInitial(intent.version === 0 ? 0 : -1); this.journalInitialResolved = true; }
    if (intent.userId === undefined) intent.userId = this.storage.local!.session.userId;
    if (intent.userId !== this.state!.userId) throw new GalinumError('superseded');
    await this.journal.publish(intent.version, this.state!, this.storage.local!.bindingRevision, this.storage.local!.acknowledgedBindingRevision!, intent.confirmed);
  }
  private async publishDisplay(epoch: number, revision: number) {
    if (revision !== this.displayRevision || this.tokenRevoked) return;
    this.assertCurrent(epoch);
    const local = this.storage.local!, state = this.state!;
    const open = local.session.consent && local.session.userId !== null && local.acknowledgedBindingRevision === local.bindingRevision && state.userId === local.session.userId && eligible(state.permission) && state.hasToken;
    if (!open) {
      if (this.storage.display === "open") { this.journal.restrict(); this.displayRestricted = true; await this.storage.persist(true); }
      return;
    }
    if (this.storage.display === "open" && !this.displayRestricted || this.storage.revision === null || !this.storage.receipt) return;
    const proposal = this.journal.propose({ operationId: this.storage.receipt.operationId, controlRevision: this.storage.revision, userId: local.session.userId!, deadlineMs: this.config.storageTimeoutMs ?? 10000 });
    const receipt = await this.journal.publishDisplay(proposal);
    this.assertCurrent(epoch);
    if (receipt.state === "open" && this.storage.revision === receipt.controlRevision) { this.storage.display = "open"; this.displayRestricted = false; }
  }

  private async bind(userId: string | null, epoch?: number, traits?: Properties, force = false) {
    if (epoch !== undefined) this.assertCurrent(epoch);
    if (userId !== null) await this.retry(() => this.request("/api/v1/identify", "POST", { userId, ...(traits === undefined ? {} : { traits }) }, false));
    await this.reconcileBinding(userId, epoch, force);
  }

  private async reconcileBinding(userId: string | null, epoch?: number, force = false) {
    if (epoch !== undefined) this.assertCurrent(epoch);
    const bindingRevision = this.storage.local!.bindingRevision;
    if (force || this.state!.userId !== userId || this.storage.local!.acknowledgedBindingRevision !== bindingRevision) {
      await this.mutate("binding", { userId }, epoch);
      if (this.storage.local!.bindingRevision === bindingRevision && this.storage.local!.session.userId === userId) {
        this.storage.local!.acknowledgedBindingRevision = bindingRevision;
        await this.storage.persist();
      }
    }
  }

  private async token(token: string | null, epoch?: number) {
    if (epoch !== undefined) this.assertCurrent(epoch);
    const previous = this.storage.local!.token;
    const hash = token === null ? null : digest(token);
    if (token === null ? !this.state!.hasToken : this.state!.hasToken && previous?.hash === hash && previous.revision === this.state!.tokenRevision) return;
    const acknowledgement = await this.mutate("token", { token }, epoch);
    if (epoch !== undefined) this.assertCurrent(epoch);
    this.storage.local!.token = hash === null || acknowledgement.tokenRevision !== this.state!.tokenRevision || !this.state!.hasToken ? null : { hash, revision: acknowledgement.tokenRevision };
    await this.storage.persist();
  }

  private closeDisplay(epoch: number, consent?: false): Promise<void> {
    this.assertCurrent(epoch);
    this.journal.restrict();
    this.displayRestricted = true;
    this.displayRevision++;
    const apply = () => {
      this.assertCurrent(epoch);
      if (consent === false) this.storage.local!.session = { ...this.storage.local!.session, consent: false };
      return this.storage.persist(true);
    };
    const durable = this.storage.local ? apply() : this.storage.load().then(apply);
    return durable.then(() => this.journal.cancelNotifications().catch(() => {}));
  }

  private async sync(epoch: number, permission?: Permission, update?: { token: string | null; sequence: number }) {
    const sequence = update?.sequence ?? this.tokenSequence;
    if (sequence !== this.tokenSequence) return;
    const displayRevision = this.displayRevision;
    const version = this.permissionVersion;
    let currentPermission = permission ?? await this.native(signal => this.config.adapter.getPermission(signal), epoch);
    this.assertCurrent(epoch);
    if (permission === undefined && version !== this.permissionVersion && this.promptPermission !== undefined) currentPermission = this.promptPermission;
    if (!eligible(currentPermission)) await this.closeDisplay(epoch);
    if (update && sequence !== this.tokenSequence) return;
    const { userId, consent } = this.storage.local!.session;
    if (this.state!.permission !== currentPermission || this.state!.consent !== consent || JSON.stringify(this.state!.capabilities) !== JSON.stringify(this.capabilities)) await this.mutate("facts", { permission: currentPermission, consent, capabilities: copyJson(this.capabilities) }, epoch);
    if (update && sequence !== this.tokenSequence) return;
    if (!consent || userId === null || !eligible(currentPermission)) { await this.token(null, epoch); return; }
    const token = update ? update.token : await this.native(signal => this.config.adapter.getToken(signal), epoch);
    this.assertCurrent(epoch);
    if (sequence !== this.tokenSequence) return;
    if (token !== null || update) await this.token(token, epoch);
    if (sequence !== this.tokenSequence) return;
    if (token !== null) this.tokenRevoked = false;
    await this.publishDisplay(epoch, displayRevision);
  }

  start = (): Promise<void> => {
    const context = { epoch: this.epoch };
    return this.enqueue(async () => {
      await this.storage.load();
      this.assertCurrent(context.epoch);
      this.publish("starting");
      await this.initialize();
      this.assertCurrent(context.epoch);
      await this.bind(this.storage.local!.session.userId, context.epoch);
      if (!this.storage.local!.session.consent) await this.token(null, context.epoch);
      await this.publishJournal();
      await this.sync(context.epoch);
      this.publish();
      this.scheduleFlush();
    }, context).then(() => { this.dispatch(); });
  };

  identify = (userId: string, traits?: Properties): Promise<void> => {
    if (this.disposed) return Promise.reject(new GalinumError("disposed"));
    if (typeof userId !== "string" || Array.from(userId).length < 1 || Array.from(userId).length > 256) return Promise.reject(new GalinumError("invalid_user"));
    const input = traits === undefined ? undefined : copyJson(traits);
    const confirmation = ++this.identityConfirmation;
    this.invalidateInApp(userId, this.inAppSnapshot.userId === userId && this.inAppSnapshot.appConfirmed);
    const failConfirmation = () => {
      if (confirmation === this.identityConfirmation && !this.disposed) this.invalidateInApp(userId, false);
    };
    let nativeClosed: Promise<void>;
    try { nativeClosed = this.journalIdentity(userId, false); }
    catch (error) {
      failConfirmation();
      const failed = Promise.reject(error instanceof GalinumError ? error : new GalinumError('journal_bridge_failure'));
      void failed.catch(() => {});
      this.factsWrite = failed;
      return failed;
    }
    const context = { epoch: this.epoch };
    const durable = this.identity(userId, false, context);
    const writing = this.enqueue(async () => {
      await durable;
      this.assertCurrent(context.epoch);
      await this.initialize();
      await nativeClosed;
      await this.bind(userId, context.epoch, input);
      if (!this.storage.local!.session.consent) await this.token(null, context.epoch);
      await this.publishJournal();
      await this.sync(context.epoch);
      this.publish();
      this.scheduleFlush();
    }, context).then(() => {
      if (confirmation === this.identityConfirmation && !this.disposed && !this.inAppSnapshot.appConfirmed) {
        this.inAppSnapshot = freeze({ ...this.inAppSnapshot, appConfirmed: true });
        for (const listener of this.inAppListeners) { try { listener(); } catch {} }
      }
      this.dispatch();
    }, error => { failConfirmation(); throw error; });
    this.factsWrite = writing;
    return writing;
  };

  reset = (): Promise<void> => {
    if (this.disposed) return Promise.reject(new GalinumError("disposed"));
    this.identityConfirmation++;
    this.invalidateInApp(null, false);
    const nativeClosed = this.journalIdentity(null, true);
    const context = { epoch: this.epoch };
    const durable = this.identity(null, true, context);
    return this.enqueue(async () => {
      await durable;
      await this.initialize();
      await this.bind(null, undefined, undefined, true);
      await this.token(null);
      await nativeClosed;
      await this.journal.cancelNotifications().catch(() => {});
      if (context.epoch === this.epoch) this.publish();
    }, context);
  };

  setNotificationHandler = (handler: NotificationHandler): (() => void) => {
    if (this.disposed) throw new GalinumError('disposed');
    if (typeof handler !== 'function') throw new GalinumError('invalid_handler');
    this.cancelDispatch();
    const registration = { handler };
    this.registration = registration;
    this.dispatch();
    return () => {
      if (this.registration !== registration) return;
      this.registration = undefined;
      this.cancelDispatch();
    };
  };
  private cancelDispatch() {
    this.dispatchCancellation.abort();
    this.dispatchCancellation = new AbortController();
  }
  private dispatch() {
    if (this.disposed || !this.registration || !this.initialized) return;
    this.dispatching = this.dispatching.then(() => this.dispatchInteractions()).catch(() => {});
  }
  private async dispatchInteractions() {
    await this.queue;
    const intent = this.journalIntent;
    const epoch = this.epoch;
    const registration = this.registration;
    const signal = this.dispatchCancellation.signal;
    const userId = this.storage.local?.session.userId;
    const generation = this.state?.bindingGeneration;
    if (this.disposed || !registration || !this.initialized || !intent.confirmed || !this.journalInitialResolved || !userId || this.state?.userId !== userId) return;
    const current = () => !this.disposed && !signal.aborted && epoch === this.epoch && intent === this.journalIntent && registration === this.registration && this.state?.userId === userId && this.state.bindingGeneration === generation;
    const captured = this.session();
    const run = <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        this.assertCurrent(epoch);
        if (!current()) throw new GalinumError('superseded');
        return operation();
      } catch (error) { return Promise.reject(error); }
    };
    const session: GalinumSession = Object.freeze({
      track: (event, props, options) => run(() => captured.track(event, props, options)),
      setConsent: consent => run(() => captured.setConsent(consent)),
      requestPermission: () => run(() => captured.requestPermission()),
      syncDevice: () => run(() => captured.syncDevice()),
      recordForegroundActivity: () => run(() => captured.recordForegroundActivity()),
    });
    let interactions;
    try { interactions = await bounded(this.journal.readInteractions(intent.version), undefined, 'superseded', signal); } catch { return; }
    for (const interaction of interactions) {
      if (!current()) return;
      if (interaction.userId !== userId || interaction.bindingGeneration !== generation) { await this.journal.acknowledgeInteraction(intent.version, interaction.id, 'retired'); continue; }
      try { await bounded(Promise.resolve(registration.handler(freeze(copyJson(interaction)), session)), undefined, 'superseded', signal); } catch { return; }
      if (!current()) return;
      await this.journal.acknowledgeInteraction(intent.version, interaction.id, 'handled');
    }
  }

  feedback = Object.freeze({
    isCompleted: (userId: string, deliveryId: string): Promise<boolean> => {
      if (this.disposed) return Promise.reject(new GalinumError('disposed'));
      if (typeof userId !== 'string' || !userId || typeof deliveryId !== 'string' || !deliveryId) return Promise.reject(new GalinumError('invalid_feedback'));
      return this.journal.readCompletion(userId, deliveryId);
    },
    admit: (input: JournalFeedback): Promise<FeedbackReceipt> => {
      if (this.disposed) return Promise.reject(new GalinumError('disposed'));
      const valid = input && typeof input === 'object' && [input.userId, input.deliveryId, input.feedbackId, input.shownFeedbackId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256) && feedbackTypes.includes(input.type);
      if (!valid) return Promise.reject(new GalinumError('invalid_feedback'));
      const feedback: JournalFeedback = { userId: input.userId, deliveryId: input.deliveryId, type: input.type, feedbackId: input.feedbackId, shownFeedbackId: input.shownFeedbackId };
      return this.journal.admitFeedback(feedback).then(receipt => { this.scheduleFlush(); return freeze(receipt); });
    },
    flush: (): Promise<void> => this.flush(),
  });
  private async sendFeedback() {
    while (true) {
      if (this.disposed) throw new GalinumError('disposed');
      const pending = await this.journal.peekFeedback();
      if (!pending.length) return;
      for (const feedback of pending) {
        const response = await this.retry(() => this.request(`/api/v1/deliveries/${encodeURIComponent(feedback.deliveryId)}/event`, 'POST', { userId: feedback.userId, type: feedback.type, feedbackId: feedback.feedbackId }, false)) as Partial<FeedbackAcknowledgement> | null;
        const receipt = response && typeof response === 'object' ? response : null;
        if (!receipt || receipt.userId !== feedback.userId || receipt.deliveryId !== feedback.deliveryId || receipt.type !== feedback.type || receipt.receiptId !== feedback.feedbackId || typeof receipt.acknowledgedAt !== 'number' || !Number.isFinite(receipt.acknowledgedAt) || receipt.acknowledgedAt < 0) throw new GalinumError('invalid_acknowledgement');
        await this.journal.acknowledgeFeedback(feedback.feedbackId, { userId: receipt.userId, deliveryId: receipt.deliveryId, type: receipt.type, receiptId: receipt.receiptId, acknowledgedAt: receipt.acknowledgedAt });
      }
    }
  }

  track = (event: string, props?: Properties, options?: { eventId?: string }): Promise<EventReceipt> => this.session().track(event, props, options);
  setConsent = (consent: boolean): Promise<void> => this.session().setConsent(consent);
  requestPermission = (): Promise<void> => this.session().requestPermission();
  syncDevice = (): Promise<void> => this.session().syncDevice();
  recordForegroundActivity = (): Promise<void> => this.session().recordForegroundActivity();

  session() {
    const context = { epoch: this.epoch };
    const capturedIntent = this.journalIntent;
    const run = (operation: () => Promise<void>) => this.enqueue(async () => {
      this.assertCurrent(context.epoch);
      await this.initialize();
      this.assertCurrent(context.epoch);
      if (this.state!.userId !== this.storage.local!.session.userId) throw new GalinumError("binding_changed");
      await operation();
      this.assertCurrent(context.epoch);
      this.publish();
    }, context);
    return Object.freeze({
      track: (event: string, props?: Properties, options?: { eventId?: string }): Promise<EventReceipt> => this.orderedTrack(capturedIntent, event, props, options),
      setConsent: (consent: boolean): Promise<void> => {
        let durable: Promise<void>;
        let revision: number;
        try {
          this.assertCurrent(context.epoch);
          if (typeof consent !== "boolean") throw new GalinumError("invalid_consent");
          revision = ++this.consentRevision;
          durable = consent ? Promise.resolve() : this.closeDisplay(context.epoch, false);
        } catch (error) { return Promise.reject(error); }
        void durable.catch(() => {});
        return this.enqueue(async () => {
          await durable;
          this.assertCurrent(context.epoch);
          await this.storage.load();
          this.assertCurrent(context.epoch);
          if (consent && revision === this.consentRevision) {
            if (!this.storage.local!.session.userId) throw new GalinumError("identify_required");
            this.storage.local!.session = { ...this.storage.local!.session, consent: true };
            await this.storage.persist();
          }
          await this.initialize();
          this.assertCurrent(context.epoch);
          if (!this.storage.local!.session.consent) await this.token(null, context.epoch);
          await this.sync(context.epoch);
          this.publish();
        }, context);
      },
      requestPermission: async () => {
        this.assertCurrent(context.epoch);
        const sequence = ++this.promptSequence;
        try {
          const permission = await this.native(signal => this.config.adapter.requestPermission(signal), context.epoch, true);
          if (sequence !== this.promptSequence) throw new GalinumError("superseded");
          this.promptPermission = permission;
          this.permissionVersion++;
          if (!eligible(permission)) await this.closeDisplay(context.epoch);
          await run(() => this.sync(context.epoch, permission));
        } catch (error) {
          if (context.epoch === this.epoch && error instanceof GalinumError && error.code !== "superseded") this.publish("error", error);
          throw error;
        }
      },
      syncDevice: () => run(() => this.sync(context.epoch)),
      recordForegroundActivity: () => run(async () => {
        if (!this.storage.local!.session.userId) throw new GalinumError("identify_required");
        await this.mutate("activity", {}, context.epoch);
      }),
    });
  }


  private orderedTrack(capture: typeof this.journalIntent, event: string, props: Properties | undefined, options?: { eventId?: string }): Promise<EventReceipt> {
    let ticket: IngressTicket;
    try { ticket = this.journal.reserve((capture.redirect ?? capture).version, options?.eventId); } catch (error) { return Promise.reject(error); }
    let encoded: string;
    try {
      const propsJson = canonicalProperties(props ?? {});
      if (!event || [...event].length > 80 || !ticket.eventId || [...ticket.eventId].length > 128 || new TextEncoder().encode(propsJson).length > 4096) throw new GalinumError('invalid_event');
      encoded = JSON.stringify({ event, eventId: ticket.eventId, propsJson });
    } catch (error) {
      this.journal.reject(ticket);
      return Promise.reject(new EventAdmissionError('invalid_event', ticket.eventId));
    }
    if ((capture.redirect ?? capture) === this.journalIntent) this.invalidateInApp();
    const admission = this.journal.admit(ticket, encoded);
    void admission.catch(() => {});
    const writing = this.enqueue(async () => {
      try {
        await this.initialize();
        if ((capture.redirect ?? capture) !== this.journalIntent) throw new GalinumError('superseded');
        const userId = this.storage.local!.session.userId;
        if (!userId) { this.journal.reject(ticket); throw new GalinumError('identify_required'); }
        await this.reconcileBinding(userId, this.epoch);
        await this.publishJournal();
        const receipt = await admission;
        if ((capture.redirect ?? capture) !== this.journalIntent) throw new GalinumError('superseded');
        this.scheduleFlush();
        return freeze(receipt);
      } catch (error) {
        throw error instanceof EventAdmissionError ? error : new EventAdmissionError(error instanceof GalinumError ? error.code : 'journal_admission_uncertain', ticket.eventId);
      }
    }, { epoch: this.epoch });
    if ((capture.redirect ?? capture) === this.journalIntent) this.factsWrite = writing;
    return writing;
  }

  private scheduleFlush() { void this.flush().catch(() => {}); }
  flush = (): Promise<void> => {
    const prior = this.queue;
    return prior.then(async () => {
        const capture = this.journalIntent;
      const initial = await this.journal.peek(capture.version);
      const end = initial.lastSequence;
      const previous = this.sender ?? Promise.resolve();
      const sending = previous.catch(() => {}).then(async () => {
        await this.sendFeedback();
        while (true) {
          if (this.disposed || capture !== this.journalIntent) throw new GalinumError('superseded');
          const prefix = await this.journal.peek(capture.version);
          if (prefix.acknowledgedThrough >= end) {
            if (initial.pendingAdmissions && prefix.pendingAdmissions) throw new GalinumError('journal_admission_pending');
            this.publish();
            return;
          }
          const batch: PushObservationBatch = { bindingGeneration: prefix.generation, commands: [] };
          for (const command of prefix.commands) {
            batch.commands.push(command);
            if (new TextEncoder().encode(JSON.stringify(batch)).length > 65536) { batch.commands.pop(); break; }
          }
          if (!batch.commands.length || batch.commands[0]!.sequence !== prefix.acknowledgedThrough + 1) throw new GalinumError('journal_prefix_invalid');
          const ack = await this.retry(() => {
            if (capture !== this.journalIntent) throw new GalinumError('superseded');
            return this.request(this.path() + '/observations', 'POST', batch);
          }) as { acknowledgedThrough?: unknown };
          const through = batch.commands.at(-1)!.sequence;
          if (ack.acknowledgedThrough !== through) throw new GalinumError('invalid_acknowledgement');
          if (capture !== this.journalIntent) throw new GalinumError('superseded');
          await this.journal.acknowledge(capture.version, prefix.generation, through);
        }
      }).catch(error => {
        const safe = error instanceof GalinumError ? error : new GalinumError('journal_storage_failure');
        if (capture === this.journalIntent && safe.code !== 'superseded') this.publish('error', safe);
        throw safe;
      }).finally(() => { if (this.sender === sending) this.sender = undefined; });
      this.sender = sending;
      return sending;
    });
  };

  dispose = () => {
    this.disposed = true;
    this.identityConfirmation++;
    this.invalidateInApp(null, false);
    this.inAppListeners.clear();
    this.registration = undefined;
    this.cancelDispatch();
    this.epoch++;
    this.cancellation.abort();
    this.unsubscribeToken?.();
    this.journal.dispose();
    this.state = null;
    this.publish("disposed");
    this.listeners.clear();
  };
}

function canonicalProperties(value: Properties): string {
  const visiting = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || visiting.has(item)) throw new GalinumError('invalid_event');
    visiting.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map(normalize);
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new GalinumError('invalid_event');
      result = Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key])]));
    }
    visiting.delete(item);
    return result;
  };
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new GalinumError('invalid_event');
  return JSON.stringify(normalize(value));
}
