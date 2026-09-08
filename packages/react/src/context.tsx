"use client";

import { reset as closeEntry, invalidateUncommitted } from "./scheduler.js";
import { queueFeedback, flushFeedback, type FeedbackReceipt } from "./feedback.js";

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
  sendFeedback: (deliveryId: string, type: DeliveryFeedback, entryId?: string) => Promise<FeedbackReceipt>;
  waitForTracks: (timeoutMs?: number) => Promise<void>;
  factsVersion: () => number;
  waitForIdentify: () => Promise<void>;
  hasPendingIdentity: () => boolean;
  identifyVersion: number;
  flushFeedback: () => Promise<void>;
};

const GalinumContext = createContext<GalinumContextValue | null>(null);

export type GalinumProviderProps = {
  publishableKey: string;
  apiBase?: string;
  userId?: string;
  traits?: Traits;
  autoContext?: boolean;
  appSchemes?: string[];
  children: ReactNode;
};

export function GalinumProvider({
  publishableKey,
  apiBase,
  userId: userIdProp,
  traits,
  autoContext = true,
  appSchemes,
  children,
}: GalinumProviderProps) {
  const [userId, setUserId] = useState<string | null>(userIdProp ?? null);
  const [identifyVersion, setIdentifyVersion] = useState(0);
  const [lastUserProp, setLastUserProp] = useState(userIdProp);
  if (lastUserProp !== userIdProp) { closeEntry(); setLastUserProp(userIdProp); setUserId(userIdProp ?? null); }
  const pendingTracks = useRef<Set<Promise<void>>>(new Set());
  const tracksStarted = useRef(0);
  const identifySettled = useRef(0);
  const identifyInvoked = useRef(0);
  const pendingIdentify = useRef<Set<Promise<void>>>(new Set());

  const config = useMemo<GalinumConfig>(
    () => ({ publishableKey, apiBase: normalizeBase(apiBase), appSchemes }),
    [publishableKey, apiBase, appSchemes],
  );

  const identify = useCallback(
    async (id: string, t?: Traits) => {
      identifyInvoked.current += 1;
      if (id !== userId) closeEntry();
      else invalidateUncommitted(config, id);
      setUserId(id);
      setIdentifyVersion((version) => version + 1);
      const merged = autoContext ? { ...collectAutoContext(), ...t } : t;
      const request = identifyRequest(config, id, merged);
      pendingIdentify.current.add(request);
      try {
        await request;
      } finally {
        identifySettled.current += 1;
        invalidateUncommitted(config, id);
        pendingIdentify.current.delete(request);
      }
    },
    [config, autoContext, userId],
  );

  const waitForIdentify = useCallback(async () => {
    await Promise.resolve();
    while (pendingIdentify.current.size) await Promise.allSettled([...pendingIdentify.current]);
  }, []);

  const hasPendingIdentity = useCallback(() => pendingIdentify.current.size > 0, []);

  const track = useCallback(
    async (event: string, props?: EventProps) => {
      if (!userId) {
        devWarn(`track("${event}") ignored — call identify() first.`);
        return;
      }
      tracksStarted.current += 1;
      invalidateUncommitted(config, userId);
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
        throw new Error("Track facts deadline exceeded");
      }
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const factsVersion = useCallback(
    () => tracksStarted.current + identifyInvoked.current + identifySettled.current,
    [],
  );

  const reset = useCallback(() => { closeEntry(); setUserId(null); }, []);

  const sendFeedback = useCallback(
    (deliveryId: string, type: DeliveryFeedback, entryId?: string) => userId ? queueFeedback(config, userId, deliveryId, type, entryId) : Promise.resolve({ status: "failed" as const, userId: "", deliveryId, type, feedbackId: (entryId ?? "manual") + ":" + deliveryId + ":" + type }),
    [config, userId],
  );

  useEffect(() => {
    void flushFeedback(config);
    const timer = setInterval(() => void flushFeedback(config), 5000);
    return () => clearInterval(timer);
  }, [config]);

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
      hasPendingIdentity,
      factsVersion,
      identifyVersion,
      flushFeedback: () => flushFeedback(config),
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
      hasPendingIdentity,
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
