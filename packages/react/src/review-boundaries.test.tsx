import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GalinumProvider, useGalinum } from "./context.js";
import { InAppMessages, type MessageActions } from "./InAppMessages.js";
import { feedbackRequest } from "./client.js";
import { flushFeedback, locallyCompleted, queueFeedback, type FeedbackReceipt } from "./feedback.js";
import { __resetSchedulerForTests } from "./scheduler.js";
const config = { apiBase: "https://galinum.test", publishableKey: "pk_review" };
const message = { deliveryId: "delivery", campaignId: "campaign", variantId: "variant", content: { title: "Free plan", presentation: "toast" } };
const good = { userId: "A", deliveryId: "delivery", type: "shown", receiptId: "operation", acknowledgedAt: 1000 };
beforeEach(() => { history.pushState({}, "", "/screen"); localStorage.clear(); __resetSchedulerForTests(); });
afterEach(() => { cleanup(); __resetSchedulerForTests(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("review: pending same-user identify invalidates an older decision at invocation", async () => {
  let identify!: ReturnType<typeof useGalinum>["identify"];
  let decision!: () => void;
  let finishIdentify!: () => void;
  let identifies = 0; let reads = 0;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/identify") && ++identifies === 2) return new Promise<Response>((resolve) => { finishIdentify = () => resolve(Response.json({ ok: true })); });
    if (url.includes("/messages")) {
      reads++;
      return new Promise<Response>((resolve) => { decision = () => resolve(Response.json({ ...Object.fromEntries(new URL(url).searchParams), evaluatedAt: 1000, messages: [message] })); });
    }
    return Promise.resolve(Response.json({ ok: true }));
  }));
  function Probe() { identify = useGalinum().identify; return null; }
  render(<GalinumProvider {...config} userId="A"><Probe /><InAppMessages /></GalinumProvider>);
  await waitFor(() => expect(reads).toBe(1));
  let mutation!: Promise<void>;
  act(() => { mutation = identify("A", { plan: "paid" }); });
  try {
    await act(async () => decision());
    expect.soft(screen.queryByText("Free plan")).toBeNull();
  } finally { await act(async () => { finishIdentify(); await mutation; }); }
  expect(screen.queryByText("Free plan")).toBeNull();
  expect(reads).toBe(1);
});
it.each([
  ["empty", "{}"],
  ["malformed", "{broken"],
  ["wrong user", JSON.stringify({ ...good, userId: "B" })],
  ["wrong delivery", JSON.stringify({ ...good, deliveryId: "other" })],
  ["wrong type", JSON.stringify({ ...good, type: "clicked" })],
  ["wrong ID", JSON.stringify({ ...good, receiptId: "other" })],
  ["negative timestamp", JSON.stringify({ ...good, acknowledgedAt: -1 })],
  ["fractional timestamp", JSON.stringify({ ...good, acknowledgedAt: 1.5 })],
  ["null timestamp", JSON.stringify({ ...good, acknowledgedAt: null })],
  ["unsafe timestamp", JSON.stringify({ ...good, acknowledgedAt: Number.MAX_SAFE_INTEGER + 1 })],
])("review: invalid %s success receipt remains retryable", async (_name, body) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
  expect(await feedbackRequest(config, "delivery", "shown", "A", "operation")).toBe("transient");
});
it("review: invalid success never becomes a durable acknowledgement", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { calls++; return Response.json({}); }));
  const first = await queueFeedback(config, "A", "delivery", "shown", "entry");
  await flushFeedback(config);
  expect(first.status).toBe("queued");
  expect((await queueFeedback(config, "A", "delivery", "shown", "entry")).status).toBe("queued");
  expect(calls).toBeGreaterThan(1);
});
it("review: shown persistence failure cannot admit dismissal; recovery survives unmount", async () => {
  vi.useFakeTimers();
  const storage = localStorage;
  let failShown = true; let rejectTerminal = true;
  const calls: { userId: string; type: string; feedbackId: string }[] = [];
  const receipts = new Map<string, object>();
  vi.stubGlobal("localStorage", {
    get length() { return storage.length; },
    key: storage.key.bind(storage), getItem: storage.getItem.bind(storage),
    setItem(key: string, value: string) {
      if (failShown && value.startsWith("{") && JSON.parse(value).type === "shown") throw new Error("temporary quota");
      storage.setItem(key, value);
    },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/messages")) return Response.json({ ...Object.fromEntries(new URL(url).searchParams), evaluatedAt: 1000, messages: [message] });
    if (!url.includes("/event")) return Response.json({ ok: true });
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (body.type !== "shown" && rejectTerminal) return Response.json({ error: "retry" }, { status: 503 });
    const receipt = receipts.get(body.feedbackId) ?? { ...good, type: body.type, receiptId: body.feedbackId };
    receipts.set(body.feedbackId, receipt);
    return Response.json(receipt);
  }));
  let actions!: MessageActions;
  const view = render(<GalinumProvider {...config} userId="A"><InAppMessages render={(_message, value) => { actions = value; return <div>Rendered</div>; }} /></GalinumProvider>);
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(screen.getByText("Rendered")).toBeDefined(); expect(calls).toHaveLength(0);
  let rejected!: FeedbackReceipt;
  await act(async () => { rejected = await actions.onDismiss(); });
  expect.soft(rejected.status).toBe("failed");
  expect.soft(screen.queryByText("Rendered")).not.toBeNull();
  expect.soft(locallyCompleted(config, "A", "delivery")).toBe(false);
  expect.soft(calls).toHaveLength(0);
  failShown = false;
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect.soft(calls.some((call) => call.type === "shown")).toBe(true);
  let queued!: FeedbackReceipt;
  await act(async () => { queued = await actions.onDismiss(); });
  expect.soft(queued.status).toBe("queued");
  view.unmount(); rejectTerminal = false;
  await flushFeedback(config);
  const terminal = calls.filter((call) => call.type === "dismissed");
  expect.soft(terminal.length).toBeGreaterThan(0);
  expect.soft(new Set(terminal.map((call) => call.feedbackId)).size).toBe(1);
  expect.soft(receipts.has(queued.feedbackId)).toBe(true);
});
it("review: terminal record write failure does not persist local completion", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ ...good, type: body.type, receiptId: body.feedbackId });
  }));
  await queueFeedback(config, "A", "delivery", "shown", "entry");
  await flushFeedback(config);
  const storage = localStorage;
  vi.stubGlobal("localStorage", {
    getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
    setItem(key: string, value: string) {
      if (value.startsWith("{") && JSON.parse(value).type === "dismissed") throw new Error("quota");
      storage.setItem(key, value);
    },
  });
  expect((await queueFeedback(config, "A", "delivery", "dismissed", "entry")).status).toBe("failed");
  expect(locallyCompleted(config, "A", "delivery")).toBe(false);
});
it("review: settled but uncommitted authority cannot paint after same-user identify starts", async () => {
  const { refresh, getSnapshot } = await import("./scheduler.js");
  let session!: ReturnType<typeof useGalinum>;
  let finishIdentify!: () => void; let identifies = 0; let reads = 0;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/identify") && ++identifies === 2) return new Promise<Response>((resolve) => { finishIdentify = () => resolve(Response.json({ ok: true })); });
    if (url.includes("/messages")) { reads++; return Promise.resolve(Response.json({ ...Object.fromEntries(new URL(url).searchParams), evaluatedAt: 1000, messages: [message] })); }
    return Promise.resolve(Response.json({ ok: true }));
  }));
  function Probe() { session = useGalinum(); return null; }
  const tree = (widget: boolean) => <GalinumProvider {...config} userId="A"><Probe />{widget ? <InAppMessages /> : null}</GalinumProvider>;
  const view = render(tree(false));
  await waitFor(() => expect(identifies).toBe(1));
  await act(async () => {
    await refresh({ config, userId: "A", waitForIdentity: session.waitForIdentify, waitForTracks: session.waitForTracks, factsVersion: session.factsVersion });
  });
  expect(getSnapshot().visible?.deliveryId).toBe("delivery");
  expect(getSnapshot().rendererId).toBeNull();
  let mutation!: Promise<void>;
  act(() => { mutation = session.identify("A", { plan: "paid" }); });
  try {
    expect.soft(getSnapshot().visible).toBeNull();
    view.rerender(tree(true));
    await act(async () => {});
    expect.soft(screen.queryByText("Free plan")).toBeNull();
    expect(reads).toBe(1);
  } finally { await act(async () => { finishIdentify(); await mutation; }); }
  expect(screen.queryByText("Free plan")).toBeNull();
});
it("review: superseding an initial identify wait cannot fetch against a still-pending mutation", async () => {
  let session!: ReturnType<typeof useGalinum>;
  const identifies: (() => void)[] = []; let reads = 0;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/identify")) return new Promise<Response>((resolve) => identifies.push(() => resolve(Response.json({ ok: true }))));
    if (url.includes("/messages")) { reads++; return Promise.resolve(Response.json({ ...Object.fromEntries(new URL(url).searchParams), evaluatedAt: 1000, messages: [message] })); }
    return Promise.resolve(Response.json({ ok: true }));
  }));
  function Probe() { session = useGalinum(); return null; }
  render(<GalinumProvider {...config} userId="A"><Probe /><InAppMessages /></GalinumProvider>);
  await waitFor(() => expect(identifies).toHaveLength(1));
  let mutation!: Promise<void>;
  act(() => { mutation = session.identify("A", { plan: "paid" }); });
  try {
    await act(async () => identifies[0]!());
    expect.soft(reads).toBe(0);
    expect.soft(screen.queryByText("Free plan")).toBeNull();
  } finally { await act(async () => { identifies[1]!(); await mutation; }); }
});
it("review: a previously painted message is not retracted, but the next entry reads fresh facts", async () => {
  const { ackResponse } = await import("./receipts.test.fixture.js");
  let identify!: ReturnType<typeof useGalinum>["identify"];
  let finish!: () => void; let identifies = 0; let reads = 0; let paid = false; let shown = 0;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/identify") && ++identifies === 2) return new Promise<Response>((resolve) => { finish = () => { paid = true; resolve(Response.json({ ok: true })); }; });
    if (url.includes("/messages")) { reads++; return Promise.resolve(Response.json({ ...Object.fromEntries(new URL(url).searchParams), evaluatedAt: 1000, messages: paid ? [] : [message] })); }
    if (url.includes("/event")) shown++;
    return Promise.resolve(ackResponse(url, init));
  }));
  function Probe() { identify = useGalinum().identify; return null; }
  render(<GalinumProvider {...config} userId="A"><Probe /><InAppMessages /></GalinumProvider>);
  await screen.findByText("Free plan"); await waitFor(() => expect(shown).toBe(1));
  let mutation!: Promise<void>;
  act(() => { mutation = identify("A", { plan: "paid" }); });
  expect(screen.getByText("Free plan")).toBeDefined();
  await act(async () => { finish(); await mutation; });
  expect(screen.getByText("Free plan")).toBeDefined(); expect(reads).toBe(1);
  await act(async () => history.pushState({}, "", "/next"));
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.queryByText("Free plan")).toBeNull();
});
it("review: terminal feedback cannot borrow a shown receipt from another entry", async () => {
  const { ackResponse } = await import("./receipts.test.fixture.js");
  const fetch = vi.fn(async (url: string, init?: RequestInit) => ackResponse(url, init)); vi.stubGlobal("fetch", fetch);
  await queueFeedback(config, "A", "delivery", "shown", "first");
  await flushFeedback(config);
  expect((await queueFeedback(config, "A", "delivery", "dismissed", "second")).status).toBe("failed");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(locallyCompleted(config, "A", "delivery")).toBe(false);
});
it("review: orphaned queued terminals fail explicitly rather than draining without shown", async () => {
  const feedbackId = "entry:delivery:dismissed";
  const key = "galinum-feedback:" + JSON.stringify([config.apiBase, config.publishableKey, "A", "delivery", feedbackId]);
  localStorage.setItem(key, JSON.stringify({ config, userId: "A", deliveryId: "delivery", type: "dismissed", feedbackId, shownFeedbackId: "entry:delivery:shown", status: "queued" }));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await flushFeedback(config);
  expect((await queueFeedback(config, "A", "delivery", "dismissed", "entry")).status).toBe("failed");
  expect(fetch).not.toHaveBeenCalled();
});
it("review: unverified old acknowledgement markers are revalidated without a new ID", async () => {
  const feedbackId = "entry:delivery:shown";
  const key = "galinum-feedback:" + JSON.stringify([config.apiBase, config.publishableKey, "A", "delivery", feedbackId]);
  localStorage.setItem(key, JSON.stringify({ config, userId: "A", deliveryId: "delivery", type: "shown", feedbackId, shownFeedbackId: feedbackId, status: "queued" }));
  localStorage.setItem(key + ":ack", "1");
  let valid = false;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(valid ? { ...good, receiptId: feedbackId } : {})));
  expect((await queueFeedback(config, "A", "delivery", "shown", "entry")).status).toBe("queued");
  await flushFeedback(config); valid = true; await flushFeedback(config);
  expect((await queueFeedback(config, "A", "delivery", "shown", "entry")).status).toBe("acknowledged");
  expect(JSON.parse(localStorage.getItem(key + ":ack")!).receiptId).toBe(feedbackId);
});
it.each([201, 202, 204])("review: HTTP %i is not a canonical acknowledgement", async (status) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(good), { status })));
  expect(await feedbackRequest(config, "delivery", "shown", "A", "operation")).toBe("transient");
});
it("review: rejected shown cannot admit a terminal operation", async () => {
  const fetch = vi.fn(async () => Response.json({ error: "rejected" }, { status: 400 })); vi.stubGlobal("fetch", fetch);
  await queueFeedback(config, "A", "delivery", "shown", "entry");
  await flushFeedback(config);
  expect((await queueFeedback(config, "A", "delivery", "shown", "entry")).status).toBe("rejected");
  expect((await queueFeedback(config, "A", "delivery", "dismissed", "entry")).status).toBe("failed");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(locallyCompleted(config, "A", "delivery")).toBe(false);
});
it("review: completion-marker failure rolls back new terminal admission", async () => {
  const { ackResponse } = await import("./receipts.test.fixture.js");
  const fetch = vi.fn(async (url: string, init?: RequestInit) => ackResponse(url, init)); vi.stubGlobal("fetch", fetch);
  await queueFeedback(config, "A", "delivery", "shown", "entry"); await flushFeedback(config);
  const storage = localStorage;
  vi.stubGlobal("localStorage", {
    get length() { return storage.length; }, key: storage.key.bind(storage),
    getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
    setItem(key: string, value: string) {
      if (key.endsWith('"completed"]')) throw new Error("quota");
      storage.setItem(key, value);
    },
  });
  expect((await queueFeedback(config, "A", "delivery", "dismissed", "entry")).status).toBe("failed");
  await flushFeedback(config);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(locallyCompleted(config, "A", "delivery")).toBe(false);
});

it("review: initial identification still admits one message under StrictMode", async () => {
  const { ackResponse } = await import("./receipts.test.fixture.js");
  let reads = 0; let shown = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/messages")) { reads++; return Response.json({ ...Object.fromEntries(new URL(url).searchParams), evaluatedAt: 1000, messages: [message] }); }
    if (url.includes("/event")) shown++;
    return ackResponse(url, init);
  }));
  render(<StrictMode><GalinumProvider {...config} userId="A"><InAppMessages /></GalinumProvider></StrictMode>);
  await screen.findByText("Free plan");
  await waitFor(() => expect(shown).toBe(1));
  expect(reads).toBe(1);
});
