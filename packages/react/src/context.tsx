"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { collectAutoContext, collectEventContext } from "./auto-context.js";
import {
  devWarn,
  feedbackRequest,
  identifyRequest,
  trackRequest,
} from "./client.js";
import type { PostResult } from "./client.js";
import type { DeliveryFeedback, EventProps, GalinumConfig, Traits } from "./types.js";

type GalinumContextValue = {
  config: GalinumConfig;
  userId: string | null;
  identify: (userId: string, traits?: Traits) => Promise<void>;
  track: (event: string, props?: EventProps) => Promise<void>;
  reset: () => void;
  // Resolves with the request outcome (never throws): "ok" accepted,
  // "transient" worth retrying, "permanent" not.
  sendFeedback: (deliveryId: string, type: DeliveryFeedback) => Promise<PostResult>;
  // Resolves once every track() request that was in flight at call time has
  // settled, or after `timeoutMs` — whichever comes first. Message polling
  // awaits this so event targeting never evaluates against facts that predate
  // an in-flight track; the timeout keeps it fail-open (a stalled track must
  // not block delivery). Tracks fired *after* the call don't extend the wait.
  waitForTracks: (timeoutMs?: number) => Promise<void>;
  // Counts the facts a message fetch depends on: track() calls started, plus
  // identify() requests that have SETTLED. Message delivery compares it across
  // a request to tell "another widget asked for the same refresh" (same count,
  // so they share it) from "the server learned something this in-flight
  // request cannot have seen" (higher count, so it must refetch).
  factsVersion: () => number;
  // Resolves once the identify request for the current user has settled (or
  // immediately when none is in flight). The first message fetch awaits it:
  // a first-time user does not exist server-side until identify lands.
  waitForIdentify: () => Promise<void>;
  // Increments on every identify() call, including re-identifying the same
  // user with new traits. Message delivery re-evaluates on a change.
  identifyVersion: number;
};

const GalinumContext = createContext<GalinumContextValue | null>(null);

export type GalinumProviderProps = {
  publishableKey: string;
  // Where the Galinum API is hosted. Defaults to the current origin so a
  // same-origin proxy works out of the box; set it to your Galinum host in prod.
  apiBase?: string;
  // If provided, the user is identified automatically whenever it changes.
  userId?: string;
  traits?: Traits;
  // Auto-collect device/browser/locale context ($-prefixed traits on identify,
  // $current_url/$pathname on track). Defaults to true; set false to opt out.
  autoContext?: boolean;
  children: ReactNode;
};

export function GalinumProvider({
  publishableKey,
  apiBase,
  userId: userIdProp,
  traits,
  autoContext = true,
  children,
}: GalinumProviderProps) {
  const [userId, setUserId] = useState<string | null>(userIdProp ?? null);
  const [identifyVersion, setIdentifyVersion] = useState(0);
  // Track requests currently in flight. trackRequest() never rejects, so
  // entries always remove themselves; the Set only grows while requests are
  // genuinely outstanding.
  const pendingTracks = useRef<Set<Promise<void>>>(new Set());
  const tracksStarted = useRef(0);
  // Bumped when an identify request settles, not when it is issued: a fetch
  // that started earlier may have asked about a user the server did not have.
  const identifySettled = useRef(0);
  // The identify request for the current user, while it is in flight.
  const pendingIdentify = useRef<Promise<void> | null>(null);

  const config = useMemo<GalinumConfig>(
    () => ({ publishableKey, apiBase: normalizeBase(apiBase) }),
    [publishableKey, apiBase],
  );

  const identify = useCallback(
    async (id: string, t?: Traits) => {
      setUserId(id);
      setIdentifyVersion((version) => version + 1);
      // Explicit traits win over auto-collected context on key collisions.
      const merged = autoContext ? { ...collectAutoContext(), ...t } : t;
      const request = identifyRequest(config, id, merged);
      pendingIdentify.current = request;
      try {
        await request;
      } finally {
        identifySettled.current += 1;
        if (pendingIdentify.current === request) pendingIdentify.current = null;
      }
    },
    [config, autoContext],
  );

  const waitForIdentify = useCallback(async () => {
    // identifyRequest never rejects by contract; stay fail-open regardless.
    await pendingIdentify.current?.catch(() => undefined);
  }, []);

  const track = useCallback(
    async (event: string, props?: EventProps) => {
      if (!userId) {
        devWarn(`track("${event}") ignored — call identify() first.`);
        return;
      }
      tracksStarted.current += 1;
      const merged = autoContext ? { ...collectEventContext(), ...props } : props;
      const request = trackRequest(config, userId, event, merged);
      pendingTracks.current.add(request);
      try {
        await request;
      } finally {
        pendingTracks.current.delete(request);
      }
    },
    [config, userId, autoContext],
  );

  const waitForTracks = useCallback(async (timeoutMs = 2000) => {
    // Snapshot at call time: only tracks already in flight gate this waiter,
    // so continuous tracking can't postpone a poll indefinitely.
    const snapshot = [...pendingTracks.current];
    if (snapshot.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const TIMED_OUT = Symbol("timeout");
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      const outcome = await Promise.race([Promise.allSettled(snapshot), timeout]);
      if (outcome === TIMED_OUT) {
        // A track that outlived the fail-open window is treated as abandoned
        // for gating purposes: evict it so later waiters neither wait on it
        // again nor accumulate allSettled reactions against a promise that
        // may never settle. (track() itself still deletes it if it ever
        // completes — double deletion is harmless.)
        for (const request of snapshot) pendingTracks.current.delete(request);
      }
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const factsVersion = useCallback(
    () => tracksStarted.current + identifySettled.current,
    [],
  );

  // Clears the identified user (e.g. on logout) so tracking/messages stop until
  // the next identify().
  const reset = useCallback(() => setUserId(null), []);

  const sendFeedback = useCallback(
    (deliveryId: string, type: DeliveryFeedback) => feedbackRequest(config, deliveryId, type),
    [config],
  );

  const identifyRef = useRef(identify);
  const traitsRef = useRef(traits);
  identifyRef.current = identify;
  traitsRef.current = traits;

  useEffect(() => {
    if (userIdProp) void identifyRef.current(userIdProp, traitsRef.current);
  }, [userIdProp]);

  const value = useMemo<GalinumContextValue>(
    () => ({
      config,
      userId,
      identify,
      track,
      reset,
      sendFeedback,
      waitForTracks,
      waitForIdentify,
      factsVersion,
      identifyVersion,
    }),
    [
      config,
      userId,
      identify,
      track,
      reset,
      sendFeedback,
      waitForTracks,
      waitForIdentify,
      factsVersion,
      identifyVersion,
    ],
  );

  return <GalinumContext.Provider value={value}>{children}</GalinumContext.Provider>;
}

export function useGalinum(): GalinumContextValue {
  const ctx = useContext(GalinumContext);
  if (!ctx) throw new Error("useGalinum must be used within a <GalinumProvider>");
  return ctx;
}

function normalizeBase(apiBase?: string): string {
  if (apiBase) return apiBase.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}
