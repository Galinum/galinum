import type { InstallationState } from "@galinum/contracts";

export type Permission = InstallationState["permission"];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Properties = { [key: string]: JsonValue };
export type KeyValueStore = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
export type NativeAdapter = {
  secrets: KeyValueStore;
  storage: KeyValueStore;
  randomBytes(length: number): Promise<Uint8Array>;
  getPermission(signal?: AbortSignal): Promise<Permission>;
  requestPermission(signal?: AbortSignal): Promise<Permission>;
  getToken(signal?: AbortSignal): Promise<string | null>;
  subscribeToken(listener: (token: string | null) => void): () => void;
};
export type NativeConfig = {
  apiBase: string;
  publishableKey: string;
  appId: string;
  platform: "ios" | "android";
  environment: "development" | "production";
  storageKey: string;
  adapter: NativeAdapter;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  nativeTimeoutMs?: number;
  storageTimeoutMs?: number;
};
export type InstallationSnapshot = Readonly<Omit<InstallationState, "capabilities">> & {
  readonly capabilities: { readonly actions: readonly string[]; readonly channels: readonly string[]; readonly richImages: boolean };
};
export type NativeSnapshot = {
  readonly status: "idle" | "starting" | "ready" | "error" | "disposed";
  readonly userId: string | null;
  readonly consent: boolean;
  readonly installation: InstallationSnapshot | null;
  readonly error: { readonly code: string; readonly status?: number } | null;
};
export class GalinumError extends Error {
  constructor(public readonly code: string, public readonly status?: number) {
    super(status === undefined ? `Galinum ${code}` : `Galinum ${code} (${status})`);
    this.name = "GalinumError";
  }
}
