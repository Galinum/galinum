import { describe, expect, it, vi } from "vitest";
import { deferred, fixture } from "./fixture.js";

describe("native client against installation HTTP contracts", () => {
  it("persists bootstrap capability before sending and replays lost responses across restart", async () => {
    const f = await fixture();
    let fail = true;
    const send: typeof fetch = async (input, init) => {
      expect(f.control.size()).toBe(1);
      const response = await f.transport(input, init);
      if (fail && String(input).endsWith("/installations")) throw new Error("response lost");
      return response;
    };
    const first = f.create({ fetch: send });
    await expect(first.start()).rejects.toMatchObject({ code: "transport_uncertain" });
    const saved = f.secrets.get(f.config.storageKey);
    first.dispose();
    await f.journalReleased();
    fail = false;
    const second = f.create({ fetch: send });
    await second.start();
    expect((await f.inspect()).length).toBe(1);
    expect(JSON.parse(f.secrets.get(f.config.storageKey)!).capability).toBe(JSON.parse(saved!).capability);
    const bootstraps = f.requests.filter(r => r.path.endsWith("/installations"));
    expect(bootstraps).toHaveLength(3);
    expect(bootstraps[0]!.body).toEqual(bootstraps[2]!.body);
  });

  it("does not bootstrap when durable storage fails", async () => {
    const f = await fixture();
    const commit = f.hooks.commit;
    f.hooks.commit = async () => { throw new Error("disk unavailable"); };
    const client = f.create();
    await expect(client.start()).rejects.toMatchObject({ code: "storage_failure" });
    await expect(client.start()).rejects.toMatchObject({ code: "storage_failure" });
    expect(f.requests).toHaveLength(0);
    f.hooks.commit = commit;
    await client.start();
    expect(await f.inspect()).toHaveLength(1);
  });

  it("never prompts or claims activity at init, identify, consent, or token refresh", async () => {
    const f = await fixture();
    const client = f.create();
    await client.start();
    await client.identify("A", { plan: "team" });
    await client.setConsent(true);
    f.callbacks.at(-1)!("rotated-token");
    await client.track("activated_workspace", { workspaceId: "one" });
    await client.flush();
    expect(f.adapter.requestPermission).not.toHaveBeenCalled();
    expect(f.requests.filter(r => r.path.endsWith("/activity"))).toHaveLength(0);
    expect((await f.inspect())[0]).toMatchObject({ userId: "A", hasToken: true, consent: true, lastActiveAt: null });
    await client.recordForegroundActivity();
    expect((await f.inspect())[0].lastActiveAt).toEqual(expect.any(Number));
    expect(f.requests.find(r => r.path.endsWith("/observations"))!.body).toMatchObject({ bindingGeneration: 1, commands: [{ kind: "event", event: "activated_workspace", props: { workspaceId: "one" } }] });
    expect(f.requests.find(r => r.path === "/api/v1/identify")!.headers.has("X-Galinum-Installation-Capability")).toBe(false);
  });

  it("keeps product consent independent of OS permission", async () => {
    const f = await fixture();
    vi.mocked(f.adapter.getPermission).mockResolvedValue("denied");
    const client = f.create();
    await client.identify("A");
    await client.setConsent(true);
    expect((await f.inspect())[0]).toMatchObject({ consent: true, permission: "denied", hasToken: false });
    expect(f.adapter.getToken).not.toHaveBeenCalled();
    await client.requestPermission();
    expect((await f.inspect())[0]).toMatchObject({ consent: true, permission: "granted", hasToken: true });
    await client.setConsent(false);
    expect((await f.inspect())[0]).toMatchObject({ consent: false, hasToken: false });
    expect(f.adapter.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("granting permission does not grant product consent", async () => {
    const f = await fixture();
    const client = f.create();
    await client.identify("A");
    await client.requestPermission();
    expect((await f.inspect())[0]).toMatchObject({ permission: "granted", consent: false, hasToken: false });
  });

  it("serializes concurrent writes and rebases same-binding revision conflicts", async () => {
    const f = await fixture();
    let conflict = false;
    const client = f.create({ fetch: async (input, init) => {
      if (conflict && String(input).endsWith("/facts")) {
        conflict = false;
        expect((await f.mutate("activity", {})).status).toBe(200);
      }
      return f.transport(input, init);
    } });
    await client.identify("A");
    conflict = true;
    await Promise.all([client.setConsent(true), client.setConsent(false), client.recordForegroundActivity()]);
    const [state] = await f.inspect();
    expect(state).toMatchObject({ userId: "A", consent: false, hasToken: false });
    expect(client.getSnapshot().installation?.revision).toBe(state.revision);
    const facts = f.requests.filter(r => r.path.endsWith("/facts"));
    expect(new Set(facts.map(r => r.body!.requestId)).size).toBe(facts.length);
  });

  it("replays an uncertain mutation once and reads current state after an old acknowledgement", async () => {
    const f = await fixture();
    let lose = true;
    const client = f.create({ fetch: async (input, init) => {
      const response = await f.transport(input, init);
      if (String(input).endsWith("/activity") && lose) {
        lose = false;
        expect((await f.mutate("token", { token: "new-external-token" })).status).toBe(200);
        throw new Error("response lost");
      }
      return response;
    } });
    await client.identify("A");
    await client.recordForegroundActivity();
    const writes = f.requests.filter(r => r.path.endsWith("/activity"));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.body).toEqual(writes[1]!.body);
    const [state] = await f.inspect();
    expect(client.getSnapshot().installation).toEqual(state);
    expect(state.hasToken).toBe(true);
  });

  it("does not rebase old-user facts onto an externally changed binding", async () => {
    const f = await fixture();
    let conflict = false;
    const client = f.create({ fetch: async (input, init) => {
      if (conflict && String(input).endsWith("/facts")) {
        conflict = false;
        expect((await f.mutate("binding", { userId: null })).status).toBe(200);
      }
      return f.transport(input, init);
    } });
    await client.identify("A");
    conflict = true;
    await expect(client.setConsent(true)).rejects.toMatchObject({ code: "binding_changed" });
    expect((await f.inspect())[0]).toMatchObject({ userId: null, consent: false });
  });

  it("reset then identify B fences delayed permission results and captured A callbacks", async () => {
    const f = await fixture();
    const permission = deferred<"granted">();
    vi.mocked(f.adapter.requestPermission).mockReturnValue(permission.promise);
    const client = f.create();
    await client.identify("A");
    await client.setConsent(true);
    const a = client.session();
    const oldListener = f.callbacks.at(-1)!;
    const prompt = a.requestPermission();
    const promptRejected = expect(prompt).rejects.toMatchObject({ code: "superseded" });
    const reset = client.reset();
    const identify = client.identify("B");
    expect(client.getSnapshot()).toMatchObject({ userId: "B", consent: false, installation: null });
    await Promise.all([reset, identify]);
    permission.resolve("granted");
    await promptRejected;
    await expect(a.track("late_a_event")).rejects.toMatchObject({ code: "superseded" });
    await expect(a.setConsent(true)).rejects.toMatchObject({ code: "superseded" });
    oldListener("late-a-token");
    await client.syncDevice();
    const [state] = await f.inspect();
    expect(state).toMatchObject({ userId: "B", consent: false, hasToken: false, bindingGeneration: 3, lastActiveAt: null });
    expect(f.requests.some(r => r.body?.token === "late-a-token")).toBe(false);
  });

  it("fences a delayed identify A response before binding B", async () => {
    const f = await fixture();
    const started = deferred<void>();
    const release = deferred<void>();
    let delay = true;
    const client = f.create({ fetch: async (input, init) => {
      const response = await f.transport(input, init);
      if (delay && String(input).endsWith("/identify")) { delay = false; started.resolve(); await release.promise; }
      return response;
    } });
    const a = client.identify("A");
    await started.promise;
    const reset = client.reset();
    const b = client.identify("B");
    release.resolve();
    await expect(a).rejects.toMatchObject({ code: "superseded" });
    await Promise.all([reset, b]);
    expect((await f.inspect())[0].userId).toBe("B");
    expect(f.requests.filter(r => r.path.endsWith("/binding")).some(r => r.body!.userId === "A")).toBe(false);
  });

  it("does not overwrite a token listener update with an older asynchronous token read", async () => {
    const f = await fixture();
    const started = deferred<void>();
    const token = deferred<string>();
    const client = f.create();
    await client.identify("A");
    vi.mocked(f.adapter.getToken).mockImplementationOnce(() => { started.resolve(); return token.promise; });
    const consent = client.setConsent(true);
    await started.promise;
    f.callbacks.at(-1)!("new-token");
    token.resolve("old-token");
    await consent;
    await client.track("barrier");
    expect(f.requests.filter(r => r.path.endsWith("/token")).map(r => r.body!.token)).toEqual(["new-token"]);
    expect((await f.inspect())[0].lastActiveAt).toBeNull();
  });

  it("persists reset intent before an offline failure and restores it on restart", async () => {
    const f = await fixture();
    let offline = false;
    const client = f.create({ fetch: async (input, init) => { if (offline) throw new Error("offline"); return f.transport(input, init); } });
    await client.identify("A");
    await client.setConsent(true);
    offline = true;
    await expect(client.reset()).rejects.toMatchObject({ code: "transport_uncertain" });
    expect(f.control.state()!.session).toEqual({ userId: null, consent: false });
    client.dispose();
    await f.journalReleased();
    const restarted = f.create();
    await restarted.start();
    expect((await f.inspect())[0]).toMatchObject({ userId: null, consent: false, hasToken: false });
  });

  it("freezes nested snapshots and copies queued input properties", async () => {
    const f = await fixture();
    const client = f.create();
    await client.identify("A");
    const snapshot = client.getSnapshot();
    expect(client.getSnapshot()).toBe(snapshot);
    expect(Object.isFrozen(snapshot.installation?.capabilities.actions)).toBe(true);
    expect(() => { (snapshot as any).userId = "B"; }).toThrow();
    const props = { nested: { value: 1 } };
    const tracked = client.track("sample", props);
    props.nested.value = 2;
    await tracked;
    await client.flush();
    expect((f.requests.find(r => r.path.endsWith("/observations"))!.body!.commands as any[])[0].props).toEqual({ nested: { value: 1 } });
    await client.reset();
    expect(snapshot.userId).toBe("A");
    const serialized = JSON.stringify(snapshot);
    const stored = JSON.parse(f.secrets.get(f.config.storageKey)!);
    expect(serialized).not.toContain(stored.capability);
    expect(serialized).not.toContain("native-test-token");
  });

  it("custom adapters preserve repeated business IDs after lost observation responses", async () => {
    const f = await fixture();let lose = true;
    const client = f.create({ fetch: async (input, init) => {
      const response = await f.transport(input, init);
      if (lose && String(input).endsWith("/observations")) throw new Error("lost");
      return response;
    } });
    await client.identify("A");
    const props = { nested: { value: [null, true, "data"] } };
    expect(await client.track("once", props, { eventId: "custom-job" })).toEqual({ eventId: "custom-job", state: "queued" });
    await expect(client.flush()).rejects.toMatchObject({ code: "transport_uncertain" });
    expect(await client.track("once", props, { eventId: "custom-job" })).toEqual({ eventId: "custom-job", state: "queued" });
    await expect(client.flush()).rejects.toMatchObject({ code: "transport_uncertain" });
    lose = false;await client.flush();
    expect(await client.track("once", props, { eventId: "custom-job" })).toEqual({ eventId: "custom-job", state: "acknowledged" });
    const sends = f.requests.filter(r => r.path.endsWith("/observations"));
    expect(sends.length).toBeGreaterThan(1);
    for (const send of sends) expect(send.body).toEqual(sends[0]!.body);
    expect(f.requests.some(r => r.path === "/api/v1/track")).toBe(false);
    const events = await (await fetch(f.config.apiBase + "/api/v1/events?name=once&externalUserId=A", { headers: { Authorization: "Bearer secret_test" } })).json();
    expect(events.total).toBe(1);expect(events.events[0].props).toEqual(props);
  });

  it("redacts transport and server errors and rejects unexpected response fields", async () => {
    const f = await fixture();
    const client = f.create({ fetch: async () => new Response(JSON.stringify({ error: "secret-capability-token" }), { status: 401 }) });
    await expect(client.start()).rejects.toMatchObject({ code: "http_error", status: 401 });
    expect(JSON.stringify(client.getSnapshot())).not.toContain("secret-capability-token");
    client.dispose();await f.journalReleased();
    const malformed = f.create({ fetch: async (input, init) => {
      const response = await f.transport(input, init);
      const body = await response.json();
      if (body.installation) body.installation.token = "secret-token";
      return Response.json(body);
    } });
    await expect(malformed.start()).rejects.toMatchObject({ code: "invalid_response" });
  });
});

it("same-user identification preserves consent written earlier in the queue", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  await Promise.all([client.setConsent(true), client.identify("A", { updated: true })]);
  expect((await f.inspect())[0]).toMatchObject({ userId: "A", consent: true, hasToken: true });
  expect(client.getSnapshot()).toMatchObject({ consent: true, installation: { consent: true } });
});

it("a passive permission read does not supersede a real prompt result", async () => {
  const f = await fixture();
  const pending = deferred<"granted">();
  vi.mocked(f.adapter.requestPermission).mockReturnValue(pending.promise);
  const client = f.create();
  await client.identify("A");
  const request = client.requestPermission();
  vi.mocked(f.adapter.getPermission).mockResolvedValue("denied");
  await client.syncDevice();
  pending.resolve("granted");
  await request;
  expect((await f.inspect())[0].permission).toBe("granted");
});

it("resumes one durable pending acknowledgement after a process restart", async () => {
  const f = await fixture();
  const client = f.create({ fetch: async (input, init) => {
    const response = await f.transport(input, init);
    if (String(input).endsWith("/activity")) throw new Error("lost");
    return response;
  } });
  await client.identify("A");
  await expect(client.recordForegroundActivity()).rejects.toMatchObject({ code: "transport_uncertain" });
  const before = (await f.inspect())[0];
  expect(f.control.state()!.pending!.route).toBe("activity");
  client.dispose();
  await f.journalReleased();
  const restarted = f.create();
  await restarted.start();
  const after = (await f.inspect())[0];
  expect(after.lastActiveAt).toBe(before.lastActiveAt);
  const activities = f.requests.filter(r => r.path.endsWith("/activity"));
  expect(activities).toHaveLength(3);
  expect(activities[0]!.body).toEqual(activities[2]!.body);
  expect(f.control.state()!.pending).toBeNull();
});

it("a rejected mutation does not permanently poison the queue", async () => {
  const f = await fixture();
  let reject = false;
  const client = f.create({ fetch: async (input, init) => {
    if (reject && String(input).endsWith("/facts")) { reject = false; return new Response("{}", { status: 400 }); }
    return f.transport(input, init);
  } });
  await client.identify("A");
  reject = true;
  await expect(client.setConsent(true)).rejects.toMatchObject({ status: 400 });
  await client.reset();
  await client.identify("B");
  expect((await f.inspect())[0]).toMatchObject({ userId: "B", consent: false });
});

it("bounds HTTP waits even when an injected transport ignores abort", async () => {
  const f = await fixture();
  const client = f.create({ requestTimeoutMs: 5, fetch: () => new Promise(() => {}) });
  await expect(client.start()).rejects.toMatchObject({ code: "transport_uncertain" });
  expect(client.getSnapshot().status).toBe("error");
});
