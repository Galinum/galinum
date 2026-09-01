import { fetchMessages } from "./client.js";
import { currentPath, matchesPages, normalizePath } from "./pages.js";
import type { GalinumConfig, InAppMessage } from "./types.js";

// Module-level scheduler shared by every mounted <InAppMessages/>: one cache,
// one visible-message slot, one per-page-view consumed flag, and one set of
// navigation listeners. Instances coordinate through it so a host app with
// several widgets still shows a single communication per page view.
//
// Messages are prefetched. A page view decides synchronously from the cache,
// so no network request ever sits on the navigation render path.

// Upper bound for a single /messages request: long enough for a slow but
// healthy response, short enough that a hung request can't wedge a refresh.
export const FETCH_TIMEOUT = 10000;

const MAX_WARMING = 2;

// How many times one page view may refetch to chase facts that changed while
// a request was in flight. A continuously-tracking app keeps every response
// slightly stale, so this must be bounded: after the last attempt the page
// view decides on what it has. A cache at most one navigation
// old, so a marginally stale decision is by design.
const MAX_STALE_RETRIES = 2;

export type SchedulerSnapshot = {
  visible: InAppMessage | null;
  path: string;
  rendererId: number | null;
  loaded: boolean;
  // Bumped on every identity change so a render can never pair one user's
  // message with another user's session.
  identity: string | null;
};

type State = {
  userId: string | null;
  cache: InAppMessage[];
  loaded: boolean;
  path: string;
  // The page view already displayed its one communication.
  consumed: boolean;
  // This page view already had its one decision, so later responses feed
  // future page views only and nothing can pop into a screen the user is
  // already reading. A page view that began with a loaded cache is settled
  // from the start: it decided synchronously. Only a page view that began
  // WITHOUT a cache (cold start) waits for a response to decide it.
  settled: boolean;
  // Refetches this page view has already spent chasing newer facts. Bounded:
  // an app that tracks continuously would otherwise keep every response stale
  // and chain requests forever.
  staleRetries: number;
  visible: InAppMessage | null;
  // Distinguishes consecutive page views that schedule the same delivery, so
  // React remounts it instead of keeping it on screen across a navigation.
  pageView: number;
  // Locally resolved deliveries (dismissed/clicked/converted) never come back.
  resolved: Set<string>;
  // Custom renderers that returned nothing for a message on this page view.
  skipped: Set<string>;
};

const state: State = {
  userId: null,
  cache: [],
  loaded: false,
  path: currentPath(),
  consumed: false,
  settled: false,
  staleRetries: 0,
  visible: null,
  pageView: 1,
  resolved: new Set(),
  skipped: new Set(),
};

const listeners = new Set<() => void>();
const instances: number[] = [];
let nextInstanceId = 1;
let snapshot: SchedulerSnapshot = buildSnapshot();
let notifyQueued = false;

function buildSnapshot(): SchedulerSnapshot {
  return {
    visible: state.visible,
    path: state.path,
    rendererId: instances[0] ?? null,
    loaded: state.loaded,
    identity: state.userId,
  };
}

// Identifies the mounted message uniquely per page view (see State.pageView).
export function visibleKey(snapshot: SchedulerSnapshot): string | null {
  return snapshot.visible ? `${state.pageView}:${snapshot.visible.deliveryId}` : null;
}

// The snapshot updates synchronously so a page-view decision is already made
// when the navigation returns; the React notification is deferred by one
// microtask. A host router calls history.pushState from inside React's
// insertion-effect phase, where scheduling an update directly is illegal
// ("useInsertionEffect must not schedule updates").
function emit(): void {
  snapshot = buildSnapshot();
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const listener of [...listeners]) listener();
  });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): SchedulerSnapshot {
  return snapshot;
}

export function getServerSnapshot(): SchedulerSnapshot {
  return SERVER_SNAPSHOT;
}

const SERVER_SNAPSHOT: SchedulerSnapshot = {
  visible: null,
  path: "/",
  rendererId: null,
  loaded: false,
  identity: null,
};

// --- Instance registration ---------------------------------------------------

export function attach(): number {
  const id = nextInstanceId++;
  instances.push(id);
  if (instances.length === 1) observeNavigation();
  emit();
  // Reattaching after the path moved starts a new page view (see
  // observeNavigation), so decide from the cache we already have.
  decide();
  return id;
}

export function detach(id: number): void {
  const index = instances.indexOf(id);
  if (index >= 0) instances.splice(index, 1);
  if (instances.length === 0) unobserveNavigation();
  emit();
}

// --- Page-view decisions ------------------------------------------------------

// The whole scheduling rule: on a page view that hasn't shown anything yet,
// take the first cached message that matches this path and isn't resolved or
// skipped. Synchronous by construction — the cache is already in memory.
function decide(): void {
  if (!state.loaded || state.consumed || state.visible) return;
  const candidate =
    state.cache.find(
      (message) =>
        !state.resolved.has(message.deliveryId) &&
        !state.skipped.has(message.deliveryId) &&
        matchesPages(message.pages, state.path),
    ) ?? null;
  if (candidate === state.visible) return;
  state.visible = candidate;
  emit();
}

// A message that actually rendered consumes the page view. Skipped candidates
// (custom renderer returned nothing) never reach this.
export function markRendered(deliveryId: string): void {
  if (state.consumed || state.visible?.deliveryId !== deliveryId) return;
  state.consumed = true;
}

// A custom renderer produced nothing for this message: no impression, and the
// next matching candidate takes its place on this same page view.
export function skip(deliveryId: string): void {
  if (state.skipped.has(deliveryId)) return;
  state.skipped.add(deliveryId);
  if (state.visible?.deliveryId === deliveryId) {
    state.visible = null;
    emit();
  }
  decide();
}

// Dismiss / click / convert: the delivery is resolved server-side, so it never
// returns. The page view stays consumed — only navigation unlocks another.
export function resolveDelivery(deliveryId: string): void {
  state.resolved.add(deliveryId);
  state.cache = state.cache.filter((message) => message.deliveryId !== deliveryId);
  if (state.visible?.deliveryId === deliveryId) {
    state.visible = null;
    emit();
  }
}

// Navigation is the only unlock. A still-visible message unmounts WITHOUT
// dismissal feedback: its delivery stays open server-side, so it can render
// again on a later matching page view. It never follows the user to the next
// screen, and it never consumes the new screen's slot.
function onNavigate(): void {
  const next = currentPath();
  if (next === state.path) return;
  startPageView(next);
  emit();
  decide();
  for (const notify of [...navigationListeners]) notify();
}

function startPageView(path: string): void {
  state.path = path;
  state.pageView += 1;
  state.consumed = false;
  // Decided synchronously from the warm cache below, even when the answer is
  // "nothing matches here": a later response must not revisit it.
  state.settled = state.loaded;
  state.staleRetries = 0;
  state.visible = null;
  state.skipped.clear();
}

const navigationListeners = new Set<() => void>();

// Instances use this to fire a background refresh for FUTURE page views.
export function onNavigation(listener: () => void): () => void {
  navigationListeners.add(listener);
  return () => navigationListeners.delete(listener);
}

// --- Fetching -----------------------------------------------------------------

// The one request the scheduler currently owns. Everything about it — the
// identity it belongs to, whether a later trigger must rerun it — lives on the
// record, so a superseded request can never touch its successor's state.
type ActiveRequest = {
  generation: number;
  promise: Promise<void>;
  // A trigger that arrived after this request snapshotted its in-flight
  // tracks: it may carry newer event facts, so rerun once this one settles.
  rerun: RefreshOptions | null;
  // Set synchronously before awaiting waitForTracks: the snapshot of pending
  // tracks is taken at call time, so a track fired after that call is not
  // covered by this request.
  snapshotTaken: boolean;
  // factsVersion at the moment of that snapshot.
  factsVersion: number;
};

let active: ActiveRequest | null = null;
// Incremented on every identity change; a response from an older generation is
// discarded.
let generation = 0;

export type RefreshOptions = {
  config: GalinumConfig;
  userId: string;
  waitForTracks: () => Promise<void>;
  // Monotonic count of the server-side facts a fetch depends on: tracks fired
  // and identifies settled. A trigger arriving while a request runs forces a
  // rerun only when this grew, meaning the running request cannot have seen
  // the new fact; otherwise the callers simply share it.
  factsVersion?: () => number;
};

// Deduped across instances: concurrent callers share one request. The first
// load after identify (or after a reset) may decide the current page view;
// later refreshes only feed future ones.
//
// A caller's abort signal only detaches that caller — one widget unmounting
// must not cancel the request the others are waiting on. The request is bounded
// by FETCH_TIMEOUT regardless.
export function refresh(options: RefreshOptions): Promise<void> {
  if (state.userId !== options.userId) {
    generation += 1;
    resetFor(options.userId);
    // A request for the previous identity can no longer satisfy this one, and
    // must not carry its queued rerun into the new identity.
    active = null;
  }
  if (active) {
    const facts = options.factsVersion?.() ?? 0;
    if (active.snapshotTaken && facts > active.factsVersion) active.rerun = options;
    return active.promise;
  }
  return run(options);
}

function run(options: RefreshOptions): Promise<void> {
  const record: ActiveRequest = {
    generation,
    promise: Promise.resolve(),
    rerun: null,
    snapshotTaken: false,
    factsVersion: 0,
  };
  record.promise = (async () => {
    // Sequence behind in-flight track() requests (bounded, fail-open) so
    // event targeting never evaluates against facts that predate an event the
    // app just fired. waitForTracks snapshots synchronously, so a
    // trigger from here on is no longer covered by this request.
    const waiting = options.waitForTracks();
    record.factsVersion = options.factsVersion?.() ?? 0;
    record.snapshotTaken = true;
    await waiting.catch(() => undefined);
    if (record.generation !== generation) return;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const result = await fetchMessages(options.config, options.userId, controller.signal);
      if (controller.signal.aborted || record.generation !== generation) return;
      // Facts learned after this request's snapshot mean this answer is
      // already out of date. Queue the rerun HERE rather than relying on a
      // caller to trigger one: a track() fired with no further refresh call
      // would otherwise leave the page view waiting forever. Bounded, so a
      // continuously-tracking app cannot chain requests indefinitely.
      const outdated = (options.factsVersion?.() ?? 0) !== record.factsVersion;
      const retry = outdated && state.staleRetries < MAX_STALE_RETRIES;
      if (retry) {
        state.staleRetries += 1;
        if (!record.rerun) record.rerun = options;
      }
      // Only a retry defers the decision; the final attempt settles on what
      // it got.
      applyCache(result.messages, result.ok, retry);
    } finally {
      clearTimeout(deadline);
    }
  })().finally(() => {
    // A superseded request must not clear or restart its successor.
    if (active !== record) return;
    active = null;
    const next = record.rerun;
    record.rerun = null;
    if (next && record.generation === generation) void run(next);
  });
  active = record;
  return record.promise;
}

// A failed fetch tells us nothing: it must neither complete a cold start (which
// would leave the page view permanently empty) nor discard an already-warm
// cache (which would strand later page views with nothing to show).
//
// `stale` marks a response built on facts that have since changed (an identify
// settled, or an event was tracked, after this request snapshotted them). It
// still fills the cache — a stale answer beats no answer — but it must not
// settle the page view, because the rerun it queues is the real answer.
function applyCache(messages: InAppMessage[], ok: boolean, stale: boolean): void {
  if (!ok) return;
  state.cache = messages.filter((message) => !state.resolved.has(message.deliveryId));
  state.loaded = true;
  // Only a page view still waiting for its first cache may be decided by a
  // response. Once settled, responses feed future page views only.
  if (!state.settled && !state.consumed && !state.visible) {
    if (!stale) state.settled = true;
    emit();
    decide();
  }
  warmMedia();
}

function resetFor(userId: string | null): void {
  state.userId = userId;
  state.cache = [];
  state.loaded = false;
  state.consumed = false;
  state.settled = false;
  state.staleRetries = 0;
  state.visible = null;
  state.pageView += 1;
  state.resolved.clear();
  state.skipped.clear();
  state.path = currentPath();
  emit();
}

// reset() / an identity change clears every shared decision.
export function reset(): void {
  resetFor(null);
}

// --- Media warming -------------------------------------------------------------

// Warming never gates a page-view decision: the scheduled message renders its
// text immediately with the image area reserved. This only makes a later
// image arrive sooner. Candidates for the current path go first.
const warmed = new Set<string>();
let warming = 0;
const warmQueue: string[] = [];

function warmMedia(): void {
  if (typeof window === "undefined" || typeof Image !== "function") return;
  const here: string[] = [];
  const later: string[] = [];
  for (const message of state.cache) {
    const url = mediaUrl(message);
    if (!url || warmed.has(url) || warmQueue.includes(url)) continue;
    if (matchesPages(message.pages, state.path)) here.push(url);
    else later.push(url);
  }
  warmQueue.push(...here, ...later);
  pumpWarming();
}

function pumpWarming(): void {
  while (warming < MAX_WARMING && warmQueue.length > 0) {
    const url = warmQueue.shift() as string;
    if (warmed.has(url)) continue;
    warmed.add(url);
    warming += 1;
    const image = new Image();
    const done = () => {
      warming -= 1;
      pumpWarming();
    };
    image.onload = done;
    image.onerror = done;
    image.src = url;
  }
}

function mediaUrl(message: InAppMessage): string | null {
  const url = message.content?.media?.url;
  return typeof url === "string" && url ? url : null;
}

// --- Navigation observation -----------------------------------------------------

// History methods are patched once for all instances and restored when the
// last one unmounts. Page-view identity is the normalized pathname, so
// hash-only and query-only changes never start a new page view.
type HistoryMethod = "pushState" | "replaceState";

const originals: Partial<Record<HistoryMethod, History[HistoryMethod]>> = {};

const patched: Partial<Record<HistoryMethod, History[HistoryMethod]>> = {};

function observeNavigation(): void {
  if (typeof window === "undefined" || typeof history === "undefined") return;
  // No navigation was observed while every instance was detached, so the path
  // may have moved on. Treat a changed path as a new page view.
  const path = currentPath();
  if (path !== state.path) startPageView(path);
  for (const method of ["pushState", "replaceState"] as HistoryMethod[]) {
    if (originals[method]) continue;
    const original = history[method];
    originals[method] = original;
    const wrapper = function patchedMethod(
      this: History,
      ...args: Parameters<History[HistoryMethod]>
    ) {
      const result = original.apply(this, args);
      onNavigate();
      return result;
    } as History[HistoryMethod];
    patched[method] = wrapper;
    history[method] = wrapper;
  }
  window.addEventListener("popstate", onNavigate);
  window.addEventListener("hashchange", onNavigate);
}

function unobserveNavigation(): void {
  if (typeof window === "undefined" || typeof history === "undefined") return;
  for (const method of ["pushState", "replaceState"] as HistoryMethod[]) {
    const original = originals[method];
    if (!original) continue;
    // Restore only if nothing else patched history on top of us; blindly
    // reinstalling would drop the host router's own wrapper.
    if (history[method] === patched[method]) history[method] = original;
    delete originals[method];
    delete patched[method];
  }
  window.removeEventListener("popstate", onNavigate);
  window.removeEventListener("hashchange", onNavigate);
}

// Exported for tests only — the module holds process-wide state.
export function __resetSchedulerForTests(): void {
  unobserveNavigation();
  instances.length = 0;
  listeners.clear();
  navigationListeners.clear();
  warmed.clear();
  warmQueue.length = 0;
  warming = 0;
  active = null;
  generation += 1;
  nextInstanceId = 1;
  resetFor(null);
}
