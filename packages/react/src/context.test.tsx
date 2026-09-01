import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GalinumProvider, useGalinum } from "./context.js";

type RecordedCall = { url: string; body: Record<string, unknown> | null };

function stubApi(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
      });
      const body = String(url).includes("/messages") ? { messages: [] } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

function wrapper(props: { userId?: string; traits?: Record<string, unknown>; autoContext?: boolean } = {}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <GalinumProvider
        publishableKey="pk_pub_test"
        apiBase="https://galinum.test"
        {...props}
      >
        {children}
      </GalinumProvider>
    );
  };
}

function bodyOf(calls: RecordedCall[], path: string): Record<string, unknown> | null {
  return calls.find((c) => c.url.includes(path))?.body ?? null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useGalinum", () => {
  it("throws outside a GalinumProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useGalinum())).toThrow(/GalinumProvider/);
  });
});

describe("identify", () => {
  it("sets the user and sends auto-collected context under explicit traits", async () => {
    const calls = stubApi();
    const { result } = renderHook(() => useGalinum(), { wrapper: wrapper() });

    await act(() => result.current.identify("user_1", { plan: "pro", $language: "custom" }));

    expect(result.current.userId).toBe("user_1");
    const body = bodyOf(calls, "/api/v1/identify");
    const traits = body?.traits as Record<string, unknown>;
    expect(body?.userId).toBe("user_1");
    expect(traits.$lib).toBe("galinum-react");
    expect(traits.$device_type).toBeDefined();
    expect(traits.$timezone).toBeDefined();
    expect(traits.plan).toBe("pro");
    // Explicit traits win over auto-collected values on collision.
    expect(traits.$language).toBe("custom");
  });

  it("sends only explicit traits when autoContext is disabled", async () => {
    const calls = stubApi();
    const { result } = renderHook(() => useGalinum(), {
      wrapper: wrapper({ autoContext: false }),
    });

    await act(() => result.current.identify("user_1", { plan: "pro" }));

    expect(bodyOf(calls, "/api/v1/identify")?.traits).toEqual({ plan: "pro" });
  });

  it("auto-identifies from the userId prop", async () => {
    const calls = stubApi();
    renderHook(() => useGalinum(), {
      wrapper: wrapper({ userId: "prop_user", traits: { plan: "free" } }),
    });

    await waitFor(() => {
      const body = bodyOf(calls, "/api/v1/identify");
      expect(body?.userId).toBe("prop_user");
      expect((body?.traits as Record<string, unknown>).plan).toBe("free");
    });
  });
});

describe("track", () => {
  it("is ignored before identify", async () => {
    const calls = stubApi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useGalinum(), { wrapper: wrapper() });

    await act(() => result.current.track("orphan_event"));

    expect(calls.some((c) => c.url.includes("/api/v1/track"))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("orphan_event"));
  });

  it("sends the event with page context, explicit props winning", async () => {
    const calls = stubApi();
    const { result } = renderHook(() => useGalinum(), { wrapper: wrapper() });

    await act(() => result.current.identify("user_1"));
    await act(() => result.current.track("clicked_cta", { source: "hero", $pathname: "/custom" }));

    const body = bodyOf(calls, "/api/v1/track");
    expect(body?.event).toBe("clicked_cta");
    const props = body?.props as Record<string, unknown>;
    expect(props.$current_url).toBe("https://app.customer.test/dashboard");
    expect(props.$pathname).toBe("/custom");
    expect(props.source).toBe("hero");
  });

  it("omits page context when autoContext is disabled", async () => {
    const calls = stubApi();
    const { result } = renderHook(() => useGalinum(), {
      wrapper: wrapper({ autoContext: false }),
    });

    await act(() => result.current.identify("user_1"));
    await act(() => result.current.track("clicked_cta", { source: "hero" }));

    expect(bodyOf(calls, "/api/v1/track")?.props).toEqual({ source: "hero" });
  });
});

describe("reset", () => {
  it("clears the user so subsequent tracking is ignored", async () => {
    const calls = stubApi();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useGalinum(), { wrapper: wrapper() });

    await act(() => result.current.identify("user_1"));
    act(() => result.current.reset());

    expect(result.current.userId).toBeNull();
    await act(() => result.current.track("after_reset"));
    expect(calls.some((c) => c.url.includes("/api/v1/track"))).toBe(false);
  });
});

describe("waitForTracks", () => {
  type Deferred = { resolve: () => void; reject: (err: Error) => void };

  // fetch stub whose /track responses only settle when the test says so.
  function stubDeferredTracks(): Deferred[] {
    const deferreds: Deferred[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL) => {
        if (String(url).includes("/api/v1/track")) {
          return new Promise<Response>((resolve, reject) => {
            deferreds.push({
              resolve: () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
              reject: (err: Error) => reject(err),
            });
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }),
    );
    return deferreds;
  }

  async function identifiedHook() {
    stubApi(); // identify goes to a stub, never the real network
    const { result } = renderHook(() => useGalinum(), { wrapper: wrapper() });
    await act(() => result.current.identify("user_1"));
    return result;
  }

  function settled(promise: Promise<void>): { (): boolean } {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    return () => done;
  }

  // Yields to the microtask queue so pending .then callbacks run.
  const flush = () => act(async () => {});

  it("resolves immediately when no tracks are in flight", async () => {
    stubApi();
    const { result } = renderHook(() => useGalinum(), { wrapper: wrapper() });
    await expect(result.current.waitForTracks()).resolves.toBeUndefined();
  });

  it("waits for an in-flight track to settle before resolving", async () => {
    const result = await identifiedHook();
    const tracks = stubDeferredTracks();

    let trackDone: Promise<void>;
    act(() => {
      trackDone = result.current.track("page_view");
    });
    expect(tracks).toHaveLength(1);

    const isDone = settled(result.current.waitForTracks());
    await flush();
    expect(isDone()).toBe(false);

    tracks[0]!.resolve();
    await act(() => trackDone!);
    expect(isDone()).toBe(true);
  });

  it("waits for all concurrent in-flight tracks", async () => {
    const result = await identifiedHook();
    const tracks = stubDeferredTracks();

    let first: Promise<void>, second: Promise<void>;
    act(() => {
      first = result.current.track("event_a");
      second = result.current.track("event_b");
    });
    expect(tracks).toHaveLength(2);

    const isDone = settled(result.current.waitForTracks());
    tracks[0]!.resolve();
    await act(() => first!);
    expect(isDone()).toBe(false);

    tracks[1]!.resolve();
    await act(() => second!);
    expect(isDone()).toBe(true);
  });

  it("is not blocked by a failed track request", async () => {
    const result = await identifiedHook();
    const tracks = stubDeferredTracks();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let trackDone: Promise<void>;
    act(() => {
      trackDone = result.current.track("doomed_event");
    });

    const isDone = settled(result.current.waitForTracks());
    tracks[0]!.reject(new Error("network down"));
    await act(() => trackDone!);
    expect(isDone()).toBe(true);
  });

  it("fails open after the timeout when a track stalls", async () => {
    const result = await identifiedHook();
    stubDeferredTracks(); // never settled — a stalled request

    act(() => {
      void result.current.track("stalled_event");
    });

    vi.useFakeTimers();
    try {
      const isDone = settled(result.current.waitForTracks(2000));
      await vi.advanceTimersByTimeAsync(1999);
      expect(isDone()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(isDone()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts a timed-out track so later waiters don't wait on it again", async () => {
    const result = await identifiedHook();
    stubDeferredTracks(); // never settled — a stalled request

    act(() => {
      void result.current.track("stalled_event");
    });

    vi.useFakeTimers();
    try {
      const first = settled(result.current.waitForTracks(2000));
      await vi.advanceTimersByTimeAsync(2000);
      expect(first()).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // The stalled track was abandoned by the first timeout; a later waiter
    // must resolve immediately instead of re-waiting the full window.
    await expect(result.current.waitForTracks(2000)).resolves.toBeUndefined();
  });

  it("does not wait for tracks started after the call (snapshot semantics)", async () => {
    const result = await identifiedHook();
    const tracks = stubDeferredTracks();

    let first: Promise<void>;
    act(() => {
      first = result.current.track("before_wait");
    });
    const isDone = settled(result.current.waitForTracks());

    // A second track fired after the waiter must not extend the wait.
    act(() => {
      void result.current.track("after_wait");
    });
    expect(tracks).toHaveLength(2);

    tracks[0]!.resolve();
    await act(() => first!);
    expect(isDone()).toBe(true);
  });
});
