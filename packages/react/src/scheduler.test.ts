import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSchedulerForTests, attach, detach, getSnapshot, markRendered, refresh, reset, resolveDelivery, skip, FETCH_TIMEOUT, visibleKey } from "./scheduler.js";
import type { InAppMessage } from "./types.js";
const config = { apiBase: "https://galinum.test", publishableKey: "pk_test" };
const message = (id: string, pages: string[] | null = null): InAppMessage => ({ deliveryId: id, campaignId: id, variantId: id, content: { title: id }, pages });
function reply(url: string, messages: InAppMessage[], extra = {}) { return new Response(JSON.stringify({ ...Object.fromEntries(new URL(url).searchParams), messages, ...extra })); }
function stub(messages: InAppMessage[]) { const mock = vi.fn(async (url: string) => reply(url, messages)); vi.stubGlobal("fetch", mock); return mock; }
const load = (userId = "A") => refresh({ config, userId, waitForTracks: async () => {} });
beforeEach(() => { history.pushState({}, "", "/screen"); localStorage.clear(); __resetSchedulerForTests(); });
afterEach(() => { __resetSchedulerForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("deduplicates hosts and chooses one renderer", async () => {
  const fetch = stub([message("first")]); const first = attach(); attach();
  await Promise.all([load(), load(), load()]);
  expect(fetch).toHaveBeenCalledTimes(1); expect(getSnapshot().rendererId).toBe(first);
  expect(getSnapshot().visible?.deliveryId).toBe("first");
});
it("requires fresh authority after navigation with warm content", async () => {
  const fetch = stub([message("first")]); attach(); await load(); const oldKey = visibleKey(getSnapshot());
  history.pushState({}, "", "/next"); expect(getSnapshot().visible).toBeNull();
  await load(); expect(fetch).toHaveBeenCalledTimes(2); expect(visibleKey(getSnapshot())).not.toBe(oldKey);
  expect(fetch.mock.calls[0]![0]).not.toBe(fetch.mock.calls[1]![0]);
});
it("skips null candidates without consuming an actual render", async () => {
  stub([message("off-path", ["/other"]), message("null"), message("real")]); attach(); await load();
  expect(getSnapshot().visible?.deliveryId).toBe("null"); skip("null");
  expect(getSnapshot().visible?.deliveryId).toBe("real"); expect(markRendered("real")).toBe(true);
  skip("real"); expect(getSnapshot().visible?.deliveryId).toBe("real");
});
it("keeps completion and consumed entry monotonic", async () => {
  const fetch = stub([message("first"), message("second")]); attach(); await load();
  markRendered("first"); resolveDelivery("first"); await load();
  expect(getSnapshot().visible).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
  history.pushState({}, "", "/next"); await load(); expect(getSnapshot().visible?.deliveryId).toBe("second");
});
it("does not paint again after the elected renderer unmounts", async () => {
  stub([message("first")]); const first = attach(); const second = attach(); await load(); markRendered("first");
  detach(second); expect(getSnapshot().visible?.deliveryId).toBe("first");
  detach(first); attach(); await load(); expect(getSnapshot().visible).toBeNull();
});
it("ignores prior-entry committed-render callbacks", async () => {
  stub([message("first")]); const renderer = attach(); await load(); const prior = getSnapshot().entryId;
  history.pushState({}, "", "/next"); await load();
  expect(markRendered("first", prior, renderer)).toBe(false);
  skip("first", prior); expect(getSnapshot().visible?.deliveryId).toBe("first");
});
it.each(["requestId", "entryId", "userId"])("rejects mismatched %s correlation", async (field) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => reply(url, [message("bad")], { [field]: "wrong" })));
  attach(); await load(); expect(getSnapshot().visible).toBeNull(); expect(getSnapshot().loaded).toBe(true);
});
it("settles failed entries empty, with later entries retryable", async () => {
  const fetch = vi.fn(async () => new Response("", { status: 503 })); vi.stubGlobal("fetch", fetch);
  attach(); await load(); await load(); expect(fetch).toHaveBeenCalledTimes(1); expect(getSnapshot().loaded).toBe(true);
  stub([message("later")]); history.pushState({}, "", "/later"); await load(); expect(getSnapshot().visible?.deliveryId).toBe("later");
});
it("rejects delayed old identity and entry responses", async () => {
  const pending: { url: string; resolve: (r: Response) => void }[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>((resolve) => pending.push({ url, resolve }))));
  attach(); const a = load("A"); await vi.waitFor(() => expect(pending).toHaveLength(1));
  const b = load("B"); await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1]!.resolve(reply(pending[1]!.url, [])); await b;
  pending[0]!.resolve(reply(pending[0]!.url, [message("old")])); await a;
  expect(getSnapshot().identity).toBe("B"); expect(getSnapshot().visible).toBeNull();
});
it("settles the entry deadline even when identity initialization never settles", async () => {
  vi.useFakeTimers(); stub([message("late")]); attach();
  const work = refresh({ config, userId: "A", waitForIdentity: () => new Promise(() => {}), waitForTracks: async () => {} });
  await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT); await work;
  expect(getSnapshot().loaded).toBe(true); expect(getSnapshot().visible).toBeNull();
});
it("never uses an outdated facts response or chains unbounded reads", async () => {
  let facts = 0; let resolve!: (r: Response) => void; let url = "";
  const fetch = vi.fn((value: string) => { url = value; return new Promise<Response>((r) => { resolve = r; }); }); vi.stubGlobal("fetch", fetch);
  attach(); const work = refresh({ config, userId: "A", waitForTracks: async () => {}, factsVersion: () => facts });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); facts++;
  resolve(reply(url, [message("stale")])); await work;
  expect(getSnapshot().visible).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("reconciles path changes while every host is detached", async () => {
  stub([message("first")]); const id = attach(); await load(); detach(id);
  history.pushState({}, "", "/elsewhere"); attach(); expect(getSnapshot().visible).toBeNull();
  await load(); expect(getSnapshot().path).toBe("/elsewhere");
});
it("reset closes identity and clears visibility", async () => {
  stub([message("first")]); attach(); await load(); reset(); expect(getSnapshot().identity).toBeNull(); expect(getSnapshot().visible).toBeNull();
});
it("elects only a renderer matching the captured project scope", async () => {
  const { configScope } = await import("./scheduler.js");
  const other = { ...config, publishableKey: "other_project" };
  const a = attach(configScope(config)); const b = attach(configScope(other));
  stub([message("scoped")]); await load();
  expect(getSnapshot().rendererId).toBe(a);
  await refresh({ config: other, userId: "A", waitForTracks: async () => {} });
  expect(getSnapshot().rendererId).toBe(b); expect(getSnapshot().scope).toBe(configScope(other));
});
it("rechecks retained facts at the render boundary after the request has settled", async () => {
  const { canRender } = await import("./scheduler.js");
  let facts = 0; stub([message("uncommitted")]); const renderer = attach();
  await refresh({ config, userId: "A", waitForTracks: async () => {}, factsVersion: () => facts });
  const entry = getSnapshot().entryId;
  expect(canRender("uncommitted", entry)).toBe(true);
  facts++;
  expect(canRender("uncommitted", entry)).toBe(false);
  expect(markRendered("uncommitted", entry, renderer)).toBe(false);
});
