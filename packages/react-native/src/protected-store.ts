import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { createMMKV, existsMMKV, type MMKV } from "react-native-mmkv";
import { GalinumError, type KeyValueStore } from "./types.js";

function authenticate(value: string | null, key: string) {
  const encoder = new TextEncoder();
  const authenticationKey = hmac(sha256, encoder.encode(key), encoder.encode("galinum-state-auth-v2"));
  return Array.from(hmac(sha256, authenticationKey, encoder.encode(JSON.stringify(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
export function createProtectedStore(secrets: KeyValueStore, randomBytes: (length: number) => Promise<Uint8Array>): KeyValueStore {
  const instances = new Map<string, Promise<{ store: MMKV; key: string }>>();
  const open = (key: string) => {
    let instance = instances.get(key);
    if (!instance) {
      instance = (async () => {
        const id = `${key}.state`;
        const exists = existsMMKV(id);
        let encryptionKey = await secrets.get(`${key}.encryption`);
        if (encryptionKey === null) {
          if (exists) throw new GalinumError("missing_storage_key");
          const bytes = await randomBytes(32);
          if (bytes.length !== 32) throw new GalinumError("random_failure");
          encryptionKey = Array.from(bytes, byte => alphabet[byte & 63]).join("");
          await secrets.set(`${key}.encryption`, encryptionKey);
        }
        if (!/^[A-Za-z0-9_-]{32}$/.test(encryptionKey)) throw new GalinumError("invalid_storage_key");
        const store = createMMKV({ id, encryptionKey, encryptionType: "AES-256", mode: "single-process", recoveryStrategy: "recover-on-error" });
        if (!store.isEncrypted) throw new GalinumError("storage_unprotected");
        if (exists) {
          if (store.getString("format") !== "galinum.state.2" || store.getString("state") === undefined) throw new GalinumError("storage_corrupt");
        } else {
          store.set("state", JSON.stringify({ value: null, mac: authenticate(null, encryptionKey) }));
          store.set("format", "galinum.state.2");
        }
        return { store, key: encryptionKey };
      })();
      instances.set(key, instance);
      void instance.catch(() => { instances.delete(key); });
    }
    return instance;
  };
  return {
    get: async key => {
      const { store, key: secret } = await open(key);
      const value = store.getString("state");
      if (value === undefined) throw new GalinumError("storage_corrupt");
      let record: { value: string | null; mac: string };
      try { record = JSON.parse(value); } catch { throw new GalinumError("storage_corrupt"); }
      if (!record || !(record.value === null || typeof record.value === "string") || record.mac !== authenticate(record.value, secret)) throw new GalinumError("storage_corrupt");
      return record.value;
    },
    set: async (key, value) => {
      const { store, key: secret } = await open(key);
      const record = JSON.stringify({ value, mac: authenticate(value, secret) });
      store.set("state", record);
      if (store.getString("state") !== record) throw new GalinumError("storage_failure");
    },
  };
}
