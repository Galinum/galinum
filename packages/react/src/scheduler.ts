import { fetchMessages } from "./client.js";
import { currentPath, matchesPages } from "./pages.js";
import { sameEntry, type EntryCapture } from "@galinum/contracts/entry";
import { locallyCompleted } from "./feedback.js";
import type { GalinumConfig, InAppMessage } from "./types.js";
export const FETCH_TIMEOUT = 10000;
export type SchedulerSnapshot = { visible: InAppMessage | null; path: string; rendererId: number | null; loaded: boolean; identity: string | null; entryId: string; scope: string | null };
export type RefreshOptions = { config: GalinumConfig; userId: string; waitForTracks: () => Promise<void>; waitForIdentity?: () => Promise<void>; hasPendingIdentity?: () => boolean; factsVersion?: () => number };
const listeners = new Set<() => void>();
const navigationListeners = new Set<() => void>();
const instances: number[] = [];
const scopes = new Map<number, string>();
const owner = globalThis.crypto.randomUUID();
const entryKey = () => owner + ":" + entry;
export const configScope = (value: GalinumConfig) => JSON.stringify([value.apiBase, value.publishableKey]);
let nextInstanceId = 1;
let generation = 0;
let entry = 0;
let request = 0;
let identity: string | null = null;
let path = currentPath();
let consumed = false;
let settled = false;
let candidates: InAppMessage[] = [];
let visible: InAppMessage | null = null;
let config: GalinumConfig | null = null;
const resolved = new Set<string>();
const skipped = new Set<string>();
let active: { capture: EntryCapture; controller: AbortController; promise: Promise<void>; factsCaptured: boolean } | null = null;
let authority: { capture: EntryCapture; factsVersion: () => number; hasPendingIdentity: () => boolean } | null = null;
const serverSnapshot: SchedulerSnapshot = { visible: null, path: "/", rendererId: null, loaded: false, identity: null, entryId: "server", scope: null };
let snapshot = serverSnapshot;
function emit() {
  snapshot = { visible, path, rendererId: instances.find((id) => !scopes.has(id) || !!config && scopes.get(id) === configScope(config)) ?? null, loaded: settled, identity, entryId: entryKey(), scope: config ? configScope(config) : null };
  queueMicrotask(() => { for (const listener of listeners) listener(); });
}
export const getSnapshot = () => snapshot;
export const getServerSnapshot = () => serverSnapshot;
export function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function visibleKey(value: SchedulerSnapshot) { return value.visible ? value.entryId + ":" + value.visible.deliveryId : null; }
export function attach(scope?: string) { const id = nextInstanceId++; instances.push(id); if (scope) scopes.set(id, scope); if (instances.length === 1) observeNavigation(); emit(); return id; }
export function detach(id: number) { const elected = snapshot.rendererId === id; const index = instances.indexOf(id); if (index >= 0) instances.splice(index, 1); scopes.delete(id); if (!instances.length) unobserveNavigation(); if (consumed && elected) visible = null; emit(); }
function decide() {
  if (consumed || visible || !settled) return;
  visible = candidates.find((m) => !resolved.has(m.deliveryId) && !skipped.has(m.deliveryId) && !!config && !!identity && !locallyCompleted(config, identity, m.deliveryId) && matchesPages(m.pages, path)) ?? null;
  emit();
}
export function canRender(deliveryId: string, entryId: string): boolean {
  return entryId === entryKey() && visible?.deliveryId === deliveryId
    && (consumed || !!authority && authority.capture.facts === authority.factsVersion() && !authority.hasPendingIdentity());
}
export function invalidateUncommitted(value: GalinumConfig, userId: string): void {
  if (identity !== userId || !config || configScope(config) !== configScope(value) || consumed || !authority && !active?.factsCaptured) return;
  active?.controller.abort(); active = null; authority = null;
  candidates = []; visible = null; settled = true; emit();
}
export function markRendered(deliveryId: string, entryId = entryKey(), rendererId = snapshot.rendererId): boolean {
  if (rendererId !== snapshot.rendererId || !canRender(deliveryId, entryId)) return false;
  consumed = true; return true;
}
export function skip(deliveryId: string, entryId = entryKey()) { if (entryId !== entryKey() || consumed || visible?.deliveryId !== deliveryId) return; skipped.add(deliveryId); visible = null; decide(); }
export function canComplete(deliveryId: string, entryId: string) { return consumed && entryId === entryKey() && visible?.deliveryId === deliveryId; }
export function resolveDelivery(deliveryId: string) { resolved.add(deliveryId); if (visible?.deliveryId === deliveryId) { consumed = true; visible = null; } emit(); }
function startPageView(next: string) {
  active?.controller.abort(); active = null; authority = null; entry++; path = next; consumed = false; settled = false; candidates = []; visible = null; skipped.clear(); emit();
}
function onNavigate() { const next = currentPath(); if (next === path) return; startPageView(next); for (const listener of navigationListeners) listener(); }
export function onNavigation(listener: () => void) { navigationListeners.add(listener); return () => { navigationListeners.delete(listener); }; }
export function reset() { generation++; identity = null; resolved.clear(); startPageView(currentPath()); }
export function refresh(options: RefreshOptions): Promise<void> {
  if (identity !== options.userId || config?.apiBase !== options.config.apiBase || config?.publishableKey !== options.config.publishableKey) {
    generation++; identity = options.userId; config = options.config; resolved.clear(); startPageView(currentPath());
  }
  if (settled || consumed) return Promise.resolve();
  if (active) return active.promise;
  const capture: EntryCapture = { identity: generation + ":" + options.userId, entryId: entryKey(), requestId: owner + ":" + generation + ":" + (++request), facts: options.factsVersion?.() ?? 0 };
  const controller = new AbortController();
  const isCurrent = (checkFacts = true) => active?.capture === capture && (!checkFacts || !options.hasPendingIdentity?.()) && sameEntry(capture, { identity: generation + ":" + identity, entryId: entryKey(), requestId: capture.requestId, facts: checkFacts ? options.factsVersion?.() ?? 0 : capture.facts });
  const work = { capture, controller, promise: Promise.resolve(), factsCaptured: false };
  active = work;
  work.promise = new Promise<void>((resolve) => {
    const finish = (messages: InAppMessage[] = []) => {
      if (active?.capture === capture) {
        const current = isCurrent();
        candidates = current ? messages : [];
        authority = current ? { capture, factsVersion: options.factsVersion ?? (() => 0), hasPendingIdentity: options.hasPendingIdentity ?? (() => false) } : null;
        settled = true; active = null; decide();
      }
      resolve();
    };
    const timer = setTimeout(() => { controller.abort(); finish(); }, FETCH_TIMEOUT);
    void (async () => {
      try {
        await options.waitForIdentity?.();
        if (!isCurrent(false) || controller.signal.aborted) return finish();
        capture.facts = options.factsVersion?.() ?? 0;
        work.factsCaptured = true;
        await options.waitForTracks();
        if (!isCurrent() || controller.signal.aborted) return finish();
        const result = await fetchMessages(options.config, options.userId, controller.signal, { entryId: capture.entryId, requestId: capture.requestId, path });
        if (controller.signal.aborted || !isCurrent()) return finish();
        finish(result.ok && result.userId === options.userId && result.entryId === capture.entryId && result.requestId === capture.requestId ? result.messages : []);
      } catch { finish(); } finally { clearTimeout(timer); }
    })();
  });
  return work.promise;
}
type HistoryMethod = "pushState" | "replaceState";

const originals: Partial<Record<HistoryMethod, History[HistoryMethod]>> = {};

const patched: Partial<Record<HistoryMethod, History[HistoryMethod]>> = {};

function observeNavigation(): void {
  if (typeof window === "undefined" || typeof history === "undefined") return;
  const nextPath = currentPath();
  if (nextPath !== path) startPageView(nextPath);
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
    if (history[method] === patched[method]) history[method] = original;
    delete originals[method];
    delete patched[method];
  }
  window.removeEventListener("popstate", onNavigate);
  window.removeEventListener("hashchange", onNavigate);
}

export function __resetSchedulerForTests() {
  unobserveNavigation(); instances.length = 0; scopes.clear(); listeners.clear(); navigationListeners.clear(); nextInstanceId = 1; config = null; reset();
}
