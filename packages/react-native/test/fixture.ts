import { testJournal } from "./journal-fixture.js";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, vi } from "vitest";
import { createApp } from "../../server/dist/app.js";
import { createProduct, MemoryProductStore } from "../../server/dist/local-product.js";
import { nodeAdapter } from "../../server/dist/node-adapter.js";
import { createGalinumClient } from "../src/client.js";
import type { NativeAdapter, NativeConfig, Permission } from "../src/types.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
export async function fixture() {
  const product = createProduct(new MemoryProductStore(), { projectId: "native-test", secretKey: "secret_test", publishableKey: "pub_test", sdkRateLimit: { perMinute: 5000, perHour: 10000 } });
  cleanup.push(() => product.close());
  const server = createServer(nodeAdapter(createApp(product.handlers)));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const secrets = new Map<string, string>();
  const callbacks: ((token: string | null) => void)[] = [];
  const removed: number[] = [];
  const journal = testJournal();
  const adapter: NativeAdapter = {
    journal: journal.port,
    checkLegacyState: async () => {},
    secrets: { get: async key => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); } },
    randomBytes: async length => new Uint8Array(randomBytes(length)),
    getPermission: vi.fn(async (): Promise<Permission> => "granted"),
    requestPermission: vi.fn(async (): Promise<Permission> => "granted"),
    getToken: vi.fn(async () => "native-test-token"),
    subscribeToken: listener => { const index = callbacks.push(listener) - 1; return () => { removed.push(index); }; },
  };
  const requests: { path: string; method: string; body: Record<string, unknown> | undefined; headers: Headers }[] = [];
  const transport: typeof fetch = async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, headers: new Headers(init?.headers) });
    return fetch(input, init);
  };
  const config: NativeConfig = { apiBase: origin, publishableKey: "pub_test", appId: "com.galinum.fixture", platform: "ios", environment: "development", storageKey: "galinum.native.test", adapter, fetch: transport };
  const create = (overrides: Partial<NativeConfig> = {}) => {
    const client = createGalinumClient({ ...config, ...overrides });
    cleanup.push(client.dispose);
    return client;
  };
  const inspect = async () => (await (await fetch(origin + "/api/v1/installations", { headers: { Authorization: "Bearer secret_test" } })).json()).installations;
  const mutate = async (route: string, fields: Record<string, unknown>) => {
    const record = JSON.parse(secrets.get(config.storageKey)!);
    const [state] = await inspect();
    return fetch(`${origin}/api/v1/sdk/installations/${record.installationId}/${route}`, { method: route === "activity" ? "POST" : "PUT", headers: { Authorization: "Bearer pub_test", "Content-Type": "application/json", "X-Galinum-Installation-Capability": record.capability }, body: JSON.stringify({ requestId: randomBytes(16).toString("hex"), revision: state.revision, bindingGeneration: state.bindingGeneration, ...(route === "token" ? { tokenRevision: state.tokenRevision } : {}), ...fields }) });
  };
  return { create, journalReleased: journal.released, config, adapter, control: journal.control, hooks: journal.hooks, secrets, callbacks, removed, requests, transport, inspect, mutate };
}
