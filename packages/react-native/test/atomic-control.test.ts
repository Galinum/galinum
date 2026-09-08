import { expect, it, vi } from "vitest";
import { deferred, fixture } from "./fixture.js";

it("opens display only from an acknowledged, consented, eligible state and closes it atomically with revocation", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  expect(f.control.display()).toBe("closed");
  await client.setConsent(true);
  expect(f.control.display()).toBe("open");
  expect(f.control.displayOpen()).toBe(true);
  const before = f.control.log().length;
  const revoke = client.setConsent(false);
  expect(f.control.displayOpen()).toBe(false);
  await revoke;
  expect(f.control.display()).toBe("closed");
  expect(f.control.state()!.session.consent).toBe(false);
  expect(f.control.log().slice(before).find(entry => entry.kind === "close")).toBeDefined();
  await client.setConsent(true);
  expect(f.control.display()).toBe("open");
  const reset = client.reset();
  expect(f.control.displayOpen()).toBe(false);
  await reset;
  expect(f.control.display()).toBe("closed");
  expect(f.control.state()!.session.userId).toBeNull();
});

it("does not open display for a denied permission and keeps analytics admission independent of consent", async () => {
  const f = await fixture();
  vi.mocked(f.adapter.getPermission).mockResolvedValue("denied");
  const client = f.create();
  await client.identify("A");
  await client.setConsent(true);
  expect(f.control.display()).toBe("closed");
  await client.setConsent(false);
  expect((await client.track("still_tracked", { value: 1 }, { eventId: "consentless" })).state).toBe("queued");
  await client.flush();
  expect(f.requests.find(r => r.path.endsWith("/observations"))!.body).toMatchObject({ commands: [{ eventId: "consentless" }] });
});

it("reports a caller timeout during an in-flight open as uncertainty, then closes at a newer revision", async () => {
  const f = await fixture();
  const client = f.create({ storageTimeoutMs: 25 });
  await client.identify("A");
  const entered = deferred<void>(), release = deferred<void>();
  let hold = true;
  f.hooks.publish = async perform => { if (hold) { hold = false; entered.resolve(); await release.promise; } return perform(); };
  await expect(client.setConsent(true)).rejects.toMatchObject({ code: "journal_storage_timeout" });
  await entered.promise;
  expect(f.control.display()).toBe("closed");
  const revoke = client.setConsent(false);
  release.resolve();
  await revoke;
  const log = f.control.log();
  const open = log.findIndex(entry => entry.kind === "open");
  const close = log.findIndex((entry, index) => entry.kind === "close" && index > open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  expect(f.control.display()).toBe("closed");
  expect(f.control.displayOpen()).toBe(false);
});

it("rejects a queued proposal after a newer restriction and after its deadline", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  await client.setConsent(true);
  const port = f.adapter.journal;
  const scope = "", owner = (client as unknown as { journal: { owner: string } }).journal.owner;
  const revision = f.control.revision()!;
  const operationId = f.control.log().at(-1)!.id;
  const stale = port.proposeDisplay(scope, owner, { operationId, controlRevision: revision, userId: "A", deadlineMs: 10000 });
  port.restrictDisplay(scope, owner);
  await expect(port.publishDisplay(scope, owner, stale)).rejects.toMatchObject({ code: "publication_stale" });
  const expired = port.proposeDisplay(scope, owner, { operationId, controlRevision: revision, userId: "A", deadlineMs: -1 });
  await expect(port.publishDisplay(scope, owner, expired)).rejects.toMatchObject({ code: "publication_expired" });
  expect(f.control.log().filter(entry => entry.kind === "open")).toHaveLength(1);
});

it("keeps an unsettled write tail owned after dispose and only then admits a new lease", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  await client.setConsent(true);
  const entered = deferred<void>(), release = deferred<void>();
  let hold = true;
  f.hooks.commit = async (perform, context) => { if (hold && context.restrict) { hold = false; entered.resolve(); await release.promise; } return perform(); };
  const revoke = client.setConsent(false);
  void revoke.catch(() => {});
  await entered.promise;
  expect(() => f.create()).toThrow("journal_writer_busy");
  client.dispose();
  expect(() => f.create()).toThrow("journal_writer_busy");
  release.resolve();
  await revoke.catch(() => {});
  await f.journalReleased();
  const next = f.create();
  await next.start();
  expect(f.control.state()!.session.consent).toBe(false);
  expect(f.control.display()).toBe("closed");
  expect(next.getSnapshot()).toMatchObject({ userId: "A", consent: false });
});

it("never reads or writes a JS key-value store for operational state", async () => {
  const f = await fixture();
  const client = f.create();
  await client.identify("A");
  await client.setConsent(true);
  expect([...f.secrets.keys()]).toEqual([f.config.storageKey]);
  expect(JSON.parse(f.secrets.get(f.config.storageKey)!)).not.toHaveProperty("session");
  expect(f.control.state()!.session).toEqual({ userId: "A", consent: true });
});
