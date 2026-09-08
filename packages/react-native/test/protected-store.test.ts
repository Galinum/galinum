import { randomBytes } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mmkv = vi.hoisted(() => ({ files: new Map<string, Map<string, string>>(), configs: [] as any[] }));
vi.mock("react-native-mmkv", () => ({
  existsMMKV: (id: string) => mmkv.files.has(id),
  createMMKV: (config: any) => {
    mmkv.configs.push(config);
    const values = mmkv.files.get(config.id) ?? new Map<string, string>();
    mmkv.files.set(config.id, values);
    return { isEncrypted: true, getString: (key: string) => values.get(key), set: (key: string, value: string) => { values.set(key, value); } };
  },
}));
import { createProtectedStore } from "../src/protected-store.js";

beforeEach(() => { mmkv.files.clear(); mmkv.configs.length = 0; });
function fixture() {
  const values = new Map<string, string>();
  const secrets = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { expect(value.length).toBeLessThan(512); values.set(key, value); },
  };
  const random = async (length: number) => new Uint8Array(randomBytes(length));
  return { values, secrets, create: () => createProtectedStore(secrets, random) };
}

it("uses encrypted app storage for a 2 MiB record and keeps only its small key in secure storage", async () => {
  const f = fixture();
  const store = f.create();
  const value = JSON.stringify({ pending: "😀".repeat(524288) });
  expect(await store.get("test")).toBeNull();
  await store.set("test", value);
  expect(await f.create().get("test")).toBe(value);
  expect(f.values.size).toBe(1);
  expect(f.values.get("test.encryption")).toHaveLength(32);
  expect(mmkv.configs[0]).toMatchObject({ encryptionType: "AES-256", mode: "single-process", recoveryStrategy: "recover-on-error" });
});

it("does not overwrite an existing encrypted store when its key is missing", async () => {
  const f = fixture();
  await f.create().set("test", "operational-state");
  f.values.clear();
  await expect(f.create().get("test")).rejects.toMatchObject({ code: "missing_storage_key" });
  expect(f.values.size).toBe(0);
});

it("reports corrupt, missing or unauthenticated records without treating them as fresh state", async () => {
  const f = fixture();
  await f.create().set("test", "operational-state");
  const file = mmkv.files.get("test.state")!;
  file.set("state", JSON.stringify({ value: "changed-state", mac: "incorrect" }));
  await expect(f.create().get("test")).rejects.toMatchObject({ code: "storage_corrupt" });
  file.delete("state");
  await expect(f.create().get("test")).rejects.toMatchObject({ code: "storage_corrupt" });
});

it("does not create app storage if secure key persistence fails", async () => {
  const f = fixture();
  f.secrets.set = async () => { throw new Error("locked keychain"); };
  await expect(f.create().set("test", "data")).rejects.toThrow("locked keychain");
  expect(mmkv.files.size).toBe(0);
});
