import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProduct, MemoryProductStore, type ProductStore, type ProductStoreSession } from "./local-product.js";
import { createPostgresProductStore } from "./postgres-product.js";
import { createApp } from "./app.js";
import type { PushEnvelope } from "@galinum/push";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(pg: boolean) {
  const sent: PushEnvelope[] = []; const accepted: number[] = [];
  const options = { projectId: "admission_" + randomUUID(), now: () => 1780000000000, pushEncryptionKey: randomBytes(32).toString("base64"),
    pushProvider: { send: async (_credential: unknown, _installation: unknown, envelope: PushEnvelope) => { sent.push(envelope); return { kind: "accepted" as const, providerId: "fixture" }; } },
    pushRecordAcceptance: async (_tx: unknown, value: { acceptedAt: number }) => { accepted.push(value.acceptedAt); } };
  const store: ProductStore = pg ? await createPostgresProductStore({ ...options, connectionString: process.env.DATABASE_URL! }) : new MemoryProductStore();
  const product = createProduct(store, options); cleanup.push(() => product.close());
  const app = createApp(product.handlers); const capability = randomBytes(32).toString("base64url");
  const call = async (path: string, method: string, body?: object, sdk = false) => {
    const response = await app(new Request("http://local/api/v1/" + path, { method, headers: { authorization: "Bearer " + (sdk ? product.publishableKey : product.secretKey), "content-type": "application/json", "x-galinum-installation-capability": capability }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const value = await response.json(); expect(response.status, JSON.stringify(value)).toBeLessThan(300); return value;
  };
  const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await call("push/credentials", "PUT", { appId: "app", platform: "ios", environment: "development", expectedRevision: 0, credential: { provider: "apns", topic: "app", privateKey, teamId: "ABCDEFGHIJ", keyId: "0123456789" } });
  for (const userId of ["A", "B"]) {
    await call("identify", "POST", { userId }, true);
    let state = (await call("sdk/installations", "POST", { installationId: userId, appId: "app", platform: "ios", environment: "development", capability }, true)).installation;
    for (const [suffix, value] of [["binding", { userId }], ["token", { token: "fixture-" + userId, tokenRevision: 0 }], ["facts", { permission: "granted", consent: true, capabilities: { actions: [], categories: [], channels: [], richImages: false } }]] as const) {
      state = (await call("sdk/installations/" + userId + "/" + suffix, "PUT", { requestId: randomUUID(), revision: state.revision, bindingGeneration: state.bindingGeneration, ...value }, true)).installation;
    }
  }
  const campaign = (await call("campaigns", "POST", { name: "Admission", channel: "push", launch: true, push: { appId: "app", selection: { kind: "all" } }, message: { title: "Title", body: "Body", destination: { kind: "website", url: "https://example.test" } } })).campaign;
  return { store, product, options, sent, accepted, campaign, call };
}
for (const pg of [false, true]) {
  const suite = pg && process.env.RUN_DB_INTEGRATION !== "1" ? describe.skip : describe;
  suite((pg ? "Postgres" : "memory") + " public work admission", () => {
    it("performs no store work when the initial unit/page/deadline budget is exhausted", async () => {
      const f = await fixture(pg); const transactions = vi.spyOn(f.store, "transaction");
      for (const budget of [{ maxUnits: 0 }, { maxPages: 0 }, { deadline: 10, clock: () => 10 }]) {
        const result = await f.product.push.runPass(budget); expect(result.admittedUnits).toBe(0); expect(result.pages).toBe(0); expect(result.stopped).not.toBeNull();
      }
      expect(transactions).not.toHaveBeenCalled(); expect(f.sent).toEqual([]);
    });
    it("retains partial recipient progress and lets repeated one-unit passes reach both users", async () => {
      const f = await fixture(pg);
      const first = await f.product.push.runPass({ campaignId: f.campaign.id, maxUnits: 1 });
      expect(first).toMatchObject({ admittedUnits: 1, units: { recipient: 1, dispatch: 0 }, stopped: "unit_limit" });
      const staged = await f.product.push.inspect(f.campaign.id); expect(staged.targets).toHaveLength(1); expect(staged.attempts).toEqual([]); expect(staged.outcomes).toEqual([]);
      for (let index = 0; index < 12 && f.sent.length < 2; index++) expect((await f.product.push.runPass({ campaignId: f.campaign.id, maxUnits: 1 })).admittedUnits).toBeLessThanOrEqual(1);
      expect(f.sent).toHaveLength(2); expect(new Set(f.sent.map((value) => value.installationId)).size).toBe(2);
      const done = await f.product.push.inspect(f.campaign.id); expect(done.attempts).toHaveLength(2); expect(done.devices.possibleSubmissions).toBe(0);
      await f.product.push.runPass({ campaignId: f.campaign.id }); expect(f.sent).toHaveLength(2);
    });
    it.each([[true, 1], [false, 1], [true, 100], [false, 100]] as const)("makes progress with one discovery page per pass (campaign scoped: %s, units: %s)", async (scoped, maxUnits) => {
      const f = await fixture(pg);
      if (!scoped) await f.call("campaigns", "POST", { name: "Next campaign", channel: "push", launch: true, push: { appId: "app", selection: { kind: "all" } }, message: { title: "Next", body: "Body", destination: { kind: "website", url: "https://example.test" } } });
      const expectedSends = scoped ? 2 : 4;
      const reads: string[] = []; const original = f.store.transaction.bind(f.store);
      f.store.transaction = async function<T>(work: (tx: ProductStoreSession) => Promise<T>): Promise<T> {
        return original((tx) => work(new Proxy(tx, { get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (key === "queryCampaigns" || key === "queryPushUsers" || key === "queryPushRecords" && args[1] && typeof args[1] === "object" && "dueAt" in args[1]) reads.push(String(key));
            return value.apply(target, args);
          };
        } })));
      };
      const counts: { pages: number; reads: number }[] = [];
      for (let index = 0; index < 36 && f.sent.length < expectedSends; index++) {
        reads.length = 0;
        const result = await f.product.push.runPass({ ...(scoped ? { campaignId: f.campaign.id } : {}), maxPages: 1, maxUnits });
        expect(result.errors).toEqual([]); expect(result.pages).toBe(1);
        expect(reads.length).toBeLessThanOrEqual(1); expect(result.admittedUnits).toBeLessThanOrEqual(maxUnits);
        counts.push({ pages: result.pages, reads: reads.length });
      }
      expect(f.sent).toHaveLength(expectedSends); expect(new Set(f.sent.map((value) => value.installationId)).size).toBe(2);
      for (const count of counts) expect(count.reads).toBe(count.pages);
      const done = await f.product.push.inspect(f.campaign.id);
      expect(done.attempts).toHaveLength(2); expect(done.outcomes.every((value) => value.result.kind === "accepted")).toBe(true);
      expect(done.devices.possibleSubmissions).toBe(0);
    });
    it("does not reserve work when execution time expires during discovery", async () => {
      const f = await fixture(pg); let clock = 0; const original = f.store.transaction.bind(f.store);
      f.store.transaction = async function<T>(work: (tx: ProductStoreSession) => Promise<T>): Promise<T> {
        return original((tx) => work(new Proxy(tx, { get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== "queryCampaigns") return typeof value === "function" ? value.bind(target) : value;
          return async (...args: unknown[]) => { const result = await value.apply(target, args); clock = 100; return result; };
        } })));
      };
      const result = await f.product.push.runPass({ deadline: 10, clock: () => clock });
      expect(result.pages).toBe(1);
      expect(result).toMatchObject({ admittedUnits: 0, stopped: "deadline" }); expect(f.sent).toEqual([]);
      expect((await f.product.push.inspect(f.campaign.id)).attempts).toEqual([]);
    });
    it("finishes an admitted reservation after deadline without inventing an unknown outcome", async () => {
      const f = await fixture(pg); await f.product.push.plan(f.campaign.id); let clock = 0; const original = f.store.transaction.bind(f.store);
      f.store.transaction = async function<T>(work: (tx: ProductStoreSession) => Promise<T>): Promise<T> {
        const value = await original(work);
        if (value && typeof value === "object" && "attempt" in value) clock = 100;
        return value;
      };
      const result = await f.product.push.runPass({ campaignId: f.campaign.id, maxUnits: 10, deadline: 10, clock: () => clock });
      expect(result.stopped).toBe("deadline"); expect(f.sent).toHaveLength(1); expect(f.accepted).toEqual([f.options.now()]);
      const view = await f.product.push.inspect(f.campaign.id); expect(view.outcomes).toHaveLength(1); expect(view.outcomes[0].result.kind).toBe("accepted"); expect(view.devices.possibleSubmissions).toBe(0);
      expect(view.slots.filter((slot) => slot.state.kind === "ready")).toHaveLength(1);
    });
    it("holds the provider fence through deadline exhaustion and does not admit the next send", async () => {
      const f = await fixture(pg); await f.product.push.plan(f.campaign.id);
      let clock = 0; let enter!: () => void; let release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; }); const pending = new Promise<void>((resolve) => { release = resolve; });
      f.options.pushProvider.send = async (_credential, _installation, envelope) => { f.sent.push(envelope); clock = 100; enter(); await pending; return { kind: "accepted", providerId: "fixture" }; };
      const pass = f.product.push.runPass({ campaignId: f.campaign.id, maxUnits: 10, deadline: 10, clock: () => clock }); await entered;
      let mutated = false; const mutation = f.store.transaction(async (tx) => { await tx.lockInstallations(); mutated = true; });
      const pool = pg ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
      try {
        if (pool) {
          let blocked = false;
          for (let i = 0; i < 100; i++) {
            const locks = await pool.query("select count(*)::int as count from pg_locks where locktype='advisory' and classid=74102 and objid = (hashtext($1)::bigint & 4294967295)::oid and not granted", [f.options.projectId]);
            if (locks.rows[0].count > 0) { blocked = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
        } else await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mutated).toBe(false);
      } finally { release(); await pool?.end(); }
      const result = await pass; await mutation;
      expect(result.stopped).toBe("deadline"); expect(mutated).toBe(true); expect(f.sent).toHaveLength(1);
      const evidence = await f.product.push.inspect(f.campaign.id); expect(evidence.attempts).toHaveLength(1); expect(evidence.outcomes[0].result.kind).toBe("accepted");
      expect(evidence.slots.filter((slot) => slot.state.kind === "ready")).toHaveLength(1);
    });
  });
}
