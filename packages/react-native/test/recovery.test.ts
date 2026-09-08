import { expect, it, vi } from "vitest";
import { deferred, fixture } from "./fixture.js";

for (const order of ["identify-first", "start-first", "identify-only"] as const) {
  it(`preserves saved A consent and token with ${order}`, async () => {
    const f = await fixture();
    const first = f.create();
    await first.identify("A");
    await first.setConsent(true);
    const before = (await f.inspect())[0];
    first.dispose();
    await f.journalReleased();
    const client = f.create();
    if (order === "identify-first") await Promise.all([client.identify("A"), client.start()]);
    if (order === "start-first") await Promise.all([client.start(), client.identify("A")]);
    if (order === "identify-only") await client.identify("A");
    expect((await f.inspect())[0]).toMatchObject({ userId: "A", consent: true, hasToken: true, tokenRevision: before.tokenRevision, bindingGeneration: before.bindingGeneration });
    expect(client.getSnapshot()).toMatchObject({ userId: "A", consent: true });
  });
}

for (const read of ["getToken", "getPermission"] as const) {
  for (const next of ["reset", "switch"] as const) {
    it(`${next} persists and progresses while ${read} never resolves`, async () => {
      const f = await fixture();
      const client = f.create();
      await client.identify("A");
      await client.setConsent(true);
      const started = deferred<void>();
      vi.mocked(f.adapter[read]).mockImplementationOnce(() => { started.resolve(); return new Promise<never>(() => {}); });
      const blocked = client.syncDevice();
      const rejected = expect(blocked).rejects.toMatchObject({ code: "superseded" });
      await started.promise;
      if (next === "reset") await client.reset();
      else await client.identify("B");
      await rejected;
      const userId = next === "reset" ? null : "B";
      expect(JSON.parse(f.storage.get(f.config.storageKey)!).session).toEqual({ userId, consent: false });
      expect((await f.inspect())[0]).toMatchObject({ userId, consent: false, hasToken: false });
      client.dispose();
      await f.journalReleased();
      const restarted = f.create();
      await restarted.start();
      expect(restarted.getSnapshot()).toMatchObject({ userId, consent: false });
    });
  }
}

it("writes reset intent while essential HTTP remains blocked, and reconciles after restart", async () => {
  const f = await fixture();
  let block = false;
  const started = deferred<void>();
  const release = deferred<void>();
  const client = f.create({ requestTimeoutMs: 100, fetch: async (input, init) => {
    if (block && String(input).endsWith("/activity")) { started.resolve(); await release.promise; }
    return f.transport(input, init);
  } });
  await client.identify("A");
  await client.setConsent(true);
  block = true;
  const track = client.recordForegroundActivity();
  const trackFailure = expect(track).rejects.toMatchObject({ code: "superseded" });
  await started.promise;
  const reset = client.reset();
  await vi.waitFor(() => expect(JSON.parse(f.storage.get(f.config.storageKey)!).session.userId).toBeNull(), { interval: 1 });
  expect((await f.inspect())[0].userId).toBe("A");
  await reset;
  await trackFailure;
  release.resolve();
  client.dispose();
  await f.journalReleased();
  const restarted = f.create();
  await restarted.start();
  expect((await f.inspect())[0]).toMatchObject({ userId: null, consent: false, hasToken: false });
});

it("serializes delayed old writes before the latest intent without claiming early persistence", async () => {
  const f = await fixture();
  const client = f.create({ storageTimeoutMs: 25 });
  await client.identify("A");
  await client.setConsent(true);
  const started = deferred<void>();
  const release = deferred<void>();
  const set = f.adapter.storage.set;
  let delay = true;
  let active = 0;
  let peak = 0;
  f.adapter.storage.set = async (key, value) => {
    active++;
    peak = Math.max(peak, active);
    if (delay) { delay = false; started.resolve(); await release.promise; }
    await set(key, value);
    active--;
  };
  const old = client.syncDevice();
  const oldFailure = expect(old).rejects.toMatchObject({ code: "storage_timeout" });
  await started.promise;
  const reset = client.reset();
  const resetFailure = expect(reset).rejects.toMatchObject({ code: "storage_timeout" });
  expect(client.getSnapshot().userId).toBeNull();
  expect(JSON.parse(f.storage.get(f.config.storageKey)!).session.userId).toBe("A");
  await Promise.all([oldFailure, resetFailure]);
  expect(client.getSnapshot()).toMatchObject({ status: "error", error: { code: "storage_timeout" } });
  release.resolve();
  await vi.waitFor(() => expect(JSON.parse(f.storage.get(f.config.storageKey)!).session.userId).toBeNull());
  expect(peak).toBe(1);
  client.dispose();
  await f.journalReleased();
  const restarted = f.create();
  await restarted.start();
  expect((await f.inspect())[0]).toMatchObject({ userId: null, hasToken: false, consent: false });
});

it("late A storage completions cannot overwrite B's persisted intent", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  await client.setConsent(true);
  const started = deferred<void>();
  const release = deferred<void>();
  const set = f.adapter.storage.set;
  let delay = true;
  f.adapter.storage.set = async (key, value) => {
    if (delay) { delay = false; started.resolve(); await release.promise; }
    await set(key, value);
  };
  const old = client.syncDevice();
  const oldFailure = expect(old).rejects.toMatchObject({ code: "superseded" });
  await started.promise;
  const reset = client.reset();
  const b = client.identify("B");
  release.resolve();
  await Promise.all([oldFailure, reset, b]);
  expect(JSON.parse(f.storage.get(f.config.storageKey)!).session).toEqual({ userId: "B", consent: false });
  client.dispose();
  await f.journalReleased();
  const restarted = f.create();
  await restarted.start();
  expect(restarted.getSnapshot()).toMatchObject({ userId: "B", consent: false });
});

it("reports unavailable storage without claiming reset success", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  f.adapter.storage.set = async () => { throw new Error("unavailable"); };
  await expect(client.reset()).rejects.toMatchObject({ code: "storage_failure" });
  expect(client.getSnapshot()).toMatchObject({ userId: null, status: "error", error: { code: "storage_failure" } });
  expect(JSON.parse(f.storage.get(f.config.storageKey)!).session.userId).toBe("A");
  expect((await f.inspect())[0].userId).toBe("A");
});

it("eligible null token reads preserve a valid registration without revision churn", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  await client.setConsent(true);
  const before = (await f.inspect())[0];
  vi.mocked(f.adapter.getToken).mockResolvedValue(null);
  await client.syncDevice();
  expect((await f.inspect())[0]).toMatchObject({ hasToken: true, tokenRevision: before.tokenRevision });
  f.callbacks.at(-1)!(null);
  await client.track("barrier");
  expect((await f.inspect())[0].hasToken).toBe(false);
});

it("deduplicates unchanged tokens but repairs missing server registration", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  await client.setConsent(true);
  const before = (await f.inspect())[0];
  await client.syncDevice();
  f.callbacks.at(-1)!("native-test-token");
  await client.track("barrier");
  expect((await f.inspect())[0].tokenRevision).toBe(before.tokenRevision);
  expect((await f.mutate("token", { token: null })).status).toBe(200);
  await client.syncDevice();
  expect((await f.inspect())[0]).toMatchObject({ hasToken: true, tokenRevision: before.tokenRevision + 2 });
});

it("uses the prompt result when a passive read started before it resolves afterward", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  const passive = deferred<"denied">();
  const started = deferred<void>();
  vi.mocked(f.adapter.getPermission).mockImplementationOnce(() => { started.resolve(); return passive.promise; });
  const sync = client.syncDevice();
  await started.promise;
  const prompt = client.requestPermission();
  await vi.waitFor(() => expect(f.adapter.requestPermission).toHaveBeenCalledOnce());
  passive.resolve("denied");
  await Promise.all([sync, prompt]);
  expect((await f.inspect())[0].permission).toBe("granted");
});

it("reinstall-surviving credentials never restore identity without app state", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  await client.setConsent(true);
  const credentials = f.secrets.get(f.config.storageKey);
  expect(credentials).not.toContain('"session"');
  client.dispose();
  await f.journalReleased();
  f.storage.clear();
  const restarted = f.create();
  await restarted.start();
  expect(f.secrets.get(f.config.storageKey)).toBe(credentials);
  expect((await f.inspect())[0]).toMatchObject({ userId: null, consent: false, hasToken: false });
});

it("fails closed on key rotation and a different API scope without touching credentials", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  client.dispose();
  await f.journalReleased();
  const credentials = f.secrets.get(f.config.storageKey);
  for (const overrides of [{ publishableKey: "pub_rotated" }, { apiBase: "https://other.example.com" }]) {
    const other = f.create(overrides);
    await expect(other.start()).rejects.toMatchObject({ code: "scope_mismatch" });
    other.dispose();await f.journalReleased();
  }
  expect(f.secrets.get(f.config.storageKey)).toBe(credentials);
  expect((await f.inspect())[0].userId).toBe("A");
});

it("bounds native reads without a session change", async () => {
  const f = await fixture();
  vi.mocked(f.adapter.getPermission).mockReturnValue(new Promise(() => {}));
  const client = f.create({ nativeTimeoutMs: 5 });
  await expect(client.start()).rejects.toMatchObject({ code: "adapter_timeout" });
  await client.reset();
  expect((await f.inspect())[0].userId).toBeNull();
});

it("a real cold-start A to B switch clears consent and token", async () => {
  const f = await fixture();
  const first = f.create();
  await first.identify("A");
  await first.setConsent(true);
  first.dispose();
  await f.journalReleased();
  const client = f.create();
  await client.identify("B");
  expect((await f.inspect())[0]).toMatchObject({ userId: "B", consent: false, hasToken: false });
  expect([...f.secrets.values()].every(value => value.length < 512)).toBe(true);
});

it("retains the acknowledged identity snapshot when an unrelated track fails", async () => {
  const f = await fixture();
  const client = f.create({ fetch: (input, init) => String(input).endsWith("/observations") ? Promise.reject(new Error("offline")) : f.transport(input, init) });
  await client.identify("A");
  expect((await client.track("failed")).state).toBe("queued");
  await expect(client.flush()).rejects.toMatchObject({ code: "transport_uncertain" });
  expect(client.getSnapshot()).toMatchObject({ userId: "A", installation: { userId: "A" }, error: { code: "transport_uncertain" } });
});

it("does not automatically replace corrupt secrets or send to a non-loopback HTTP endpoint", async () => {
  const f = await fixture();
  f.secrets.set(f.config.storageKey, "null");
  await expect(f.create().start()).rejects.toMatchObject({ code: "invalid_storage" });
  expect(f.secrets.get(f.config.storageKey)).toBe("null");
  expect(f.requests).toHaveLength(0);
  expect(() => f.create({ apiBase: "http://api.example.com" })).toThrow("invalid_config");
});

it("recovers a lost token acknowledgement without an extra registration mutation", async () => {
  const f = await fixture();
  const client = f.create({ fetch: async (input, init) => {
    const response = await f.transport(input, init);
    if (String(input).endsWith("/token")) throw new Error("response lost");
    return response;
  } });
  await client.identify("A");
  await expect(client.setConsent(true)).rejects.toMatchObject({ code: "transport_uncertain" });
  const revision = (await f.inspect())[0].tokenRevision;
  client.dispose();
  await f.journalReleased();
  const restarted = f.create();
  await restarted.start();
  expect((await f.inspect())[0].tokenRevision).toBe(revision);
  expect(f.requests.filter(request => request.path.endsWith("/token"))).toHaveLength(3);
});

it("does not time out a human permission decision or block reset behind it", async () => {
  const f = await fixture();
  const decision = deferred<"granted">();
  vi.mocked(f.adapter.requestPermission).mockReturnValue(decision.promise);
  const client = f.create({ nativeTimeoutMs: 5 });
  await client.identify("A");
  const prompt = client.requestPermission();
  const rejected = expect(prompt).rejects.toMatchObject({ code: "superseded" });
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(client.getSnapshot().error).toBeNull();
  await client.reset();
  await rejected;
  decision.resolve("granted");
  expect((await f.inspect())[0]).toMatchObject({ userId: null, consent: false });
});

it("a reentrant identity subscriber cannot give A the epoch of B", async () => {
  const f = await fixture();
  const client = f.create();
  await client.start();
  let b: Promise<void> | undefined;
  const unsubscribe = client.subscribe(() => {
    if (client.getSnapshot().userId === "A" && !b) b = client.identify("B");
  });
  await expect(client.identify("A")).rejects.toMatchObject({ code: "superseded" });
  await b;
  unsubscribe();
  expect((await f.inspect())[0]).toMatchObject({ userId: "B", consent: false });
});
