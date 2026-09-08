import type { InstallationState } from "@galinum/contracts";
import { GalinumError, type NativeConfig, type NativeSnapshot, type Permission, type Properties } from "./types.js";
import { copyJson, digest, freeze, parseInstallation } from "./wire.js";
import { bounded, InstallationStorage, type Pending } from "./storage.js";

type Context = { epoch: number };
const emptyCapabilities = { actions: [], channels: [], richImages: false };
const eligible = (permission: Permission) => permission === "granted" || permission === "provisional";

export function createGalinumClient(config: NativeConfig) { return new GalinumClient(config); }

export class GalinumClient {
  private readonly config: NativeConfig;
  private readonly storage: InstallationStorage;
  private state: InstallationState | null = null;
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
  private snapshot: NativeSnapshot = freeze({ status: "idle", userId: null, consent: false, installation: null, error: null });

  constructor(config: NativeConfig) {
    let url: URL;
    try { url = new URL(config.apiBase); } catch { throw new GalinumError("invalid_config"); }
    const insecureDevelopment = config.environment === "development" && ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && insecureDevelopment) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !config.publishableKey || !config.appId || !/^[\w.-]+$/.test(config.storageKey) || [config.requestTimeoutMs, config.nativeTimeoutMs, config.storageTimeoutMs].some(value => value !== undefined && (!Number.isFinite(value) || value <= 0))) throw new GalinumError("invalid_config");
    this.config = { ...config, apiBase: url.origin };
    this.storage = new InstallationStorage(this.config);
  }

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

  private async request(path: string, method: string, body?: unknown, installation = true): Promise<unknown> {
    if (this.disposed) throw new GalinumError("disposed");
    const controller = new AbortController();
    try {
      return await bounded((async () => {
        const response = await (this.config.fetch ?? globalThis.fetch)(this.config.apiBase + path, {
          method, signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.publishableKey}`, ...(installation ? { "X-Galinum-Installation-Capability": this.storage.credentials!.capability } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status !== 200) throw new GalinumError("http_error", response.status);
        try { return await response.json(); } catch { throw new GalinumError("invalid_response"); }
      })(), this.config.requestTimeoutMs ?? 10000, "transport_uncertain");
    } catch (error) { throw error instanceof GalinumError ? error : new GalinumError("transport_uncertain"); }
    finally { controller.abort(); }
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
    const context = { epoch: this.epoch };
    this.unsubscribeToken = this.config.adapter.subscribeToken(token => {
      if (context.epoch !== this.epoch || this.disposed) return;
      this.tokenSequence++;
      void this.enqueue(async () => {
        this.assertCurrent(context.epoch);
        await this.initialize();
        await this.sync(context.epoch, undefined, { token });
        this.publish();
      }, context).catch(() => {});
    });
  }

  private async bind(userId: string | null, epoch?: number, traits?: Properties, force = false) {
    if (epoch !== undefined) this.assertCurrent(epoch);
    if (userId !== null) await this.retry(() => this.request("/api/v1/identify", "POST", { userId, ...(traits === undefined ? {} : { traits }) }, false));
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

  private async sync(epoch: number, permission?: Permission, update?: { token: string | null }) {
    const sequence = this.tokenSequence;
    const version = this.permissionVersion;
    let currentPermission = permission ?? await this.native(signal => this.config.adapter.getPermission(signal), epoch);
    this.assertCurrent(epoch);
    if (permission === undefined && version !== this.permissionVersion && this.promptPermission !== undefined) currentPermission = this.promptPermission;
    const { userId, consent } = this.storage.local!.session;
    if (this.state!.permission !== currentPermission || this.state!.consent !== consent || JSON.stringify(this.state!.capabilities) !== JSON.stringify(emptyCapabilities)) await this.mutate("facts", { permission: currentPermission, consent, capabilities: emptyCapabilities }, epoch);
    if (!consent || userId === null || !eligible(currentPermission)) { await this.token(null, epoch); return; }
    const token = update ? update.token : await this.native(signal => this.config.adapter.getToken(signal), epoch);
    this.assertCurrent(epoch);
    if (sequence !== this.tokenSequence || token === null && !update) return;
    await this.token(token, epoch);
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
      await this.sync(context.epoch);
      this.publish();
    }, context);
  };

  identify = (userId: string, traits?: Properties): Promise<void> => {
    if (typeof userId !== "string" || Array.from(userId).length < 1 || Array.from(userId).length > 256) return Promise.reject(new GalinumError("invalid_user"));
    const input = traits === undefined ? undefined : copyJson(traits);
    const context = { epoch: this.epoch };
    const durable = this.identity(userId, false, context);
    return this.enqueue(async () => {
      await durable;
      this.assertCurrent(context.epoch);
      await this.initialize();
      await this.bind(userId, context.epoch, input);
      if (!this.storage.local!.session.consent) await this.token(null, context.epoch);
      await this.sync(context.epoch);
      this.publish();
    }, context);
  };

  reset = (): Promise<void> => {
    const context = { epoch: this.epoch };
    const durable = this.identity(null, true, context);
    return this.enqueue(async () => {
      await durable;
      await this.initialize();
      await this.bind(null, undefined, undefined, true);
      await this.token(null);
      if (context.epoch === this.epoch) this.publish();
    }, context);
  };

  track = (event: string, props?: Properties): Promise<void> => this.session().track(event, props);
  setConsent = (consent: boolean): Promise<void> => this.session().setConsent(consent);
  requestPermission = (): Promise<void> => this.session().requestPermission();
  syncDevice = (): Promise<void> => this.session().syncDevice();
  recordForegroundActivity = (): Promise<void> => this.session().recordForegroundActivity();

  session() {
    const context = { epoch: this.epoch };
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
      track: (event: string, props?: Properties) => {
        const body = copyJson({ event, ...(props === undefined ? {} : { props }) });
        return run(async () => {
          const userId = this.storage.local!.session.userId;
          if (!userId) throw new GalinumError("identify_required");
          if (!event || Array.from(event).length > 80) throw new GalinumError("invalid_event");
          await this.request("/api/v1/track", "POST", { ...body, userId }, false);
        });
      },
      setConsent: (consent: boolean) => run(async () => {
        if (typeof consent !== "boolean") throw new GalinumError("invalid_consent");
        if (!this.storage.local!.session.userId && consent) throw new GalinumError("identify_required");
        this.storage.local!.session = { ...this.storage.local!.session, consent };
        await this.storage.persist();
        this.assertCurrent(context.epoch);
        if (!consent) await this.token(null, context.epoch);
        await this.sync(context.epoch);
      }),
      requestPermission: async () => {
        this.assertCurrent(context.epoch);
        const sequence = ++this.promptSequence;
        try {
          const permission = await this.native(signal => this.config.adapter.requestPermission(signal), context.epoch, true);
          if (sequence !== this.promptSequence) throw new GalinumError("superseded");
          this.promptPermission = permission;
          this.permissionVersion++;
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

  dispose = () => {
    this.disposed = true;
    this.epoch++;
    this.cancellation.abort();
    this.unsubscribeToken?.();
    this.state = null;
    this.publish("disposed");
    this.listeners.clear();
  };
}
