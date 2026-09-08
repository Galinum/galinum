import type { NativeConfig } from "./types.js";
import { GalinumError } from "./types.js";
import { digest } from "./wire.js";

export type Session = { userId: string | null; consent: boolean };
export type Pending = { route: "binding" | "facts" | "token" | "activity"; body: Record<string, unknown> };
type Credentials = { version: 2; scope: string; installationId: string; capability: string };
export type LocalState = { version: 2; scope: string; installationId: string; session: Session; bindingRevision: number; acknowledgedBindingRevision: number | null; pending: Pending | null; token: { hash: string; revision: number } | null };

export async function bounded<T>(promise: Promise<T>, milliseconds: number | undefined, code: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      if (milliseconds !== undefined) timer = setTimeout(() => reject(new GalinumError(code)), milliseconds);
      abort = () => reject(new GalinumError("superseded"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export class InstallationStorage {
  credentials: Credentials | null = null;
  local: LocalState | null = null;
  private loaded: Promise<void> | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly scope: string;

  constructor(private readonly config: NativeConfig) {
    this.scope = digest(JSON.stringify([config.apiBase, config.publishableKey, config.appId, config.platform, config.environment]));
  }

  async random(length: number): Promise<string> {
    const bytes = await bounded(this.config.adapter.randomBytes(length), this.config.nativeTimeoutMs ?? 10000, "adapter_timeout");
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new GalinumError("random_failure");
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async io<T>(promise: Promise<T>): Promise<T> {
    try { return await bounded(promise, this.config.storageTimeoutMs ?? 10000, "storage_timeout"); }
    catch (error) { throw error instanceof GalinumError ? error : new GalinumError("storage_failure"); }
  }

  private write(run: () => Promise<void>) {
    const result = this.writes.then(run);
    this.writes = result.catch(() => {});
    return this.io(result);
  }

  persist() {
    return this.write(() => this.config.adapter.storage.set(this.config.storageKey, JSON.stringify(this.local)));
  }

  load(): Promise<void> {
    this.loaded ??= this.read().catch(error => { this.loaded = undefined; throw error; });
    return this.loaded;
  }

  private async read() {
    await this.io(this.writes);
    const secret = await this.io(this.config.adapter.secrets.get(this.config.storageKey));
    let credentials: Credentials | null;
    let local: LocalState | null;
    try {
      credentials = secret === null ? null : JSON.parse(secret);
    } catch { throw new GalinumError("invalid_storage"); }
    if (secret !== null && (!credentials || typeof credentials !== "object")) throw new GalinumError("invalid_storage");
    if (credentials) {
      if (credentials.version !== 2 || !/^[a-f0-9]{64}$/.test(credentials.scope) || !/^[a-f0-9]{32}$/.test(credentials.installationId) || !/^[a-f0-9]{64}$/.test(credentials.capability)) throw new GalinumError("invalid_storage");
      if (credentials.scope !== this.scope) throw new GalinumError("scope_mismatch");
    }
    const data = await this.io(this.config.adapter.storage.get(this.config.storageKey));
    try { local = data === null ? null : JSON.parse(data); } catch { throw new GalinumError("invalid_storage"); }
    if (data !== null && (!local || typeof local !== "object")) throw new GalinumError("invalid_storage");
    if (!credentials) {
      if (local) throw new GalinumError("missing_credentials");
      credentials = { version: 2, scope: this.scope, installationId: await this.random(16), capability: await this.random(32) };
      const value = JSON.stringify(credentials);
      await this.write(() => this.config.adapter.secrets.set(this.config.storageKey, value));
    }
    if (local) {
      if (local.version !== 2 || local.installationId !== credentials.installationId || !local.session || !(local.session.userId === null || typeof local.session.userId === "string" && local.session.userId.length > 0) || typeof local.session.consent !== "boolean" || local.pending !== null && (!local.pending || !["binding", "facts", "token", "activity"].includes(local.pending.route) || typeof local.pending.body !== "object" || local.pending.body === null) || local.token !== null && (!local.token || !/^[a-f0-9]{64}$/.test(local.token.hash) || !Number.isSafeInteger(local.token.revision) || local.token.revision < 0)) throw new GalinumError("invalid_storage");
      if (local.scope !== this.scope) throw new GalinumError("scope_mismatch");
      if (!Number.isSafeInteger(local.bindingRevision) || local.bindingRevision < 0 || local.acknowledgedBindingRevision !== null && (!Number.isSafeInteger(local.acknowledgedBindingRevision) || local.acknowledgedBindingRevision < 0 || local.acknowledgedBindingRevision > local.bindingRevision)) throw new GalinumError("invalid_storage");
    } else local = { version: 2, scope: this.scope, installationId: credentials.installationId, session: { userId: null, consent: false }, bindingRevision: 0, acknowledgedBindingRevision: null, pending: null, token: null };
    this.credentials = credentials;
    this.local = local;
    await this.persist();
  }
}
