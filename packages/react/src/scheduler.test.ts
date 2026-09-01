import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSchedulerForTests,
  attach,
  detach,
  getSnapshot,
  markRendered,
  refresh,
  reset,
  resolveDelivery,
  skip,
  subscribe,
  visibleKey,
} from "./scheduler.js";
import type { GalinumConfig, InAppMessage } from "./types.js";

const config: GalinumConfig = {
  publishableKey: "pk_pub_test",
  apiBase: "https://galinum.test",
};

function message(deliveryId: string, pages: string[] | null = null): InAppMessage {
  return {
    deliveryId,
    campaignId: `cmp_${deliveryId}`,
    variantId: `var_${deliveryId}`,
    content: { title: deliveryId, presentation: "toast" },
    pages,
  };
}

function stubMessages(batches: InAppMessage[][]) {
  let call = 0;
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      const messages = batches[Math.min(call, batches.length - 1)] ?? [];
      call += 1;
      return new Response(JSON.stringify({ messages }), { status: 200 });
    }),
  );
  return { urls, calls: () => call };
}

const load = (userId = "user_1") =>
  refresh({ config, userId, waitForTracks: () => Promise.resolve() });

beforeEach(() => {
  history.pushState({}, "", "/dashboard");
  __resetSchedulerForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSchedulerForTests();
});

describe("scheduler", () => {
  it("schedules the first matching message after the cold-start load", async () => {
    stubMessages([[message("del_1"), message("del_2")]]);
    attach();
    await load();

    expect(getSnapshot().visible?.deliveryId).toBe("del_1");
  });

  it("dedupes concurrent refreshes into one request", async () => {
    const stub = stubMessages([[message("del_1")]]);
    attach();
    await Promise.all([load(), load(), load()]);

    expect(stub.calls()).toBe(1);
  });

  it("skips a message whose pages do not match the current path", async () => {
    stubMessages([[message("del_1", ["/settings"]), message("del_2", null)]]);
    attach();
    await load();

    expect(getSnapshot().visible?.deliveryId).toBe("del_2");
  });

  it("keeps the page view consumed after a rendered message resolves", async () => {
    stubMessages([[message("del_1"), message("del_2")]]);
    attach();
    await load();

    markRendered("del_1");
    resolveDelivery("del_1");
    expect(getSnapshot().visible).toBeNull();
  });

  it("advances to the next candidate when a renderer skips one", async () => {
    stubMessages([[message("del_1"), message("del_2")]]);
    attach();
    await load();

    skip("del_1");
    expect(getSnapshot().visible?.deliveryId).toBe("del_2");
  });

  it("a later refresh never changes the current page view", async () => {
    stubMessages([[message("del_1")], [message("del_0"), message("del_1")]]);
    attach();
    await load();
    markRendered("del_1");

    await load();
    expect(getSnapshot().visible?.deliveryId).toBe("del_1");
  });

  it("bounds the refetch chain when facts keep changing", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return new Response(JSON.stringify({ messages: [message("del_1")] }), { status: 200 });
      }),
    );
    attach();

    // Every response looks stale: facts advance on each read, as a
    // continuously-tracking app would cause.
    let facts = 0;
    await refresh({
      config,
      userId: "user_1",
      waitForTracks: () => Promise.resolve(),
      factsVersion: () => (facts += 1),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The initial fetch plus at most MAX_STALE_RETRIES follow-ups.
    expect(call).toBeLessThanOrEqual(3);
    expect(getSnapshot().visible?.deliveryId).toBe("del_1");
  });

  // A background refresh must never pop a message into a screen the user is
  // already reading, even when nothing was showing there.
  it("does not decide a page view that already settled with an empty cache", async () => {
    stubMessages([[], [message("del_1")]]);
    attach();
    await load();
    expect(getSnapshot().visible).toBeNull();

    await load();
    expect(getSnapshot().visible).toBeNull();

    history.pushState({}, "", "/settings");
    expect(getSnapshot().visible?.deliveryId).toBe("del_1");
  });

  // Navigating to a screen where nothing matches is still a decision: the
  // refresh that navigation kicks off must not drop a message in afterwards.
  it("does not pop a message into a navigated screen with no matching candidate", async () => {
    stubMessages([
      [message("del_1", ["/dashboard"])],
      [message("del_1", ["/dashboard"]), message("del_2", ["/settings"])],
    ]);
    attach();
    await load();
    markRendered("del_1");

    history.pushState({}, "", "/settings");
    // Nothing in the warm cache matches /settings, so this page view decided
    // "nothing" and is settled.
    expect(getSnapshot().visible).toBeNull();

    await load();
    expect(getSnapshot().visible).toBeNull();

    history.pushState({}, "", "/settings/billing");
    history.pushState({}, "", "/settings");
    expect(getSnapshot().visible?.deliveryId).toBe("del_2");
  });

  // A response built on stale facts must queue its own rerun: nothing else
  // may trigger one, and the page view would otherwise wait forever.
  it("reruns itself when facts changed while the request was in flight", async () => {
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) await gate;
        const messages = call === 1 ? [] : [message("del_1")];
        return new Response(JSON.stringify({ messages }), { status: 200 });
      }),
    );
    attach();

    let facts = 0;
    const only = refresh({
      config,
      userId: "user_1",
      waitForTracks: () => Promise.resolve(),
      factsVersion: () => facts,
    });
    // A track lands while the request is in flight, with NO further refresh
    // call from any widget.
    facts = 1;
    releaseFetch();
    await only;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(call).toBe(2);
    expect(getSnapshot().visible?.deliveryId).toBe("del_1");
  });

  it("notifies subscribers when the scheduled message changes", async () => {
    stubMessages([[message("del_1")]]);
    attach();
    const seen: Array<string | null> = [];
    subscribe(() => seen.push(getSnapshot().visible?.deliveryId ?? null));
    await load();

    expect(seen).toContain("del_1");
  });

  it("clears every shared decision on reset", async () => {
    stubMessages([[message("del_1")]]);
    attach();
    await load();
    expect(getSnapshot().visible?.deliveryId).toBe("del_1");

    reset();
    expect(getSnapshot().visible).toBeNull();
    expect(getSnapshot().loaded).toBe(false);
  });

  it("clears the cache when the identified user changes", async () => {
    stubMessages([[message("del_1")], [message("del_2")]]);
    attach();
    await load("user_1");
    await refresh({ config, userId: "user_2", waitForTracks: () => Promise.resolve() });

    expect(getSnapshot().visible?.deliveryId).toBe("del_2");
  });

  it("starts a fresh request when the identity changes mid-flight", async () => {
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const userId = new URL(String(url)).searchParams.get("userId") as string;
        seen.push(userId);
        if (userId === "user_1") await firstSettled;
        return new Response(JSON.stringify({ messages: [message(`del_${userId}`)] }), {
          status: 200,
        });
      }),
    );
    attach();

    const first = load("user_1");
    const second = refresh({
      config,
      userId: "user_2",
      waitForTracks: () => Promise.resolve(),
    });
    releaseFirst();
    await Promise.all([first, second]);

    expect(seen).toContain("user_2");
    expect(getSnapshot().visible?.deliveryId).toBe("del_user_2");
  });

  it("keeps the cold start pending when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    attach();
    await load();

    expect(getSnapshot().loaded).toBe(false);
    expect(getSnapshot().visible).toBeNull();

    stubMessages([[message("del_1")]]);
    await load();
    expect(getSnapshot().visible?.deliveryId).toBe("del_1");
  });

  it("reruns a trigger that arrived after the running request snapshotted its tracks", async () => {
    let releaseTracks!: () => void;
    const tracks = new Promise<void>((resolve) => {
      releaseTracks = resolve;
    });
    const stub = stubMessages([[message("del_1")]]);
    attach();

    let tracked = 0;
    const first = refresh({
      config,
      userId: "user_1",
      waitForTracks: () => tracks,
      factsVersion: () => tracked,
    });
    releaseTracks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // An event fired after the snapshot: the running request cannot have
    // evaluated it, so this trigger must produce a second fetch.
    tracked = 1;
    const second = refresh({
      config,
      userId: "user_1",
      waitForTracks: () => Promise.resolve(),
      factsVersion: () => tracked,
    });
    await Promise.all([first, second]);

    expect(stub.calls()).toBe(2);
  });

  it("does not rerun when no event was fired while the request ran", async () => {
    let releaseTracks!: () => void;
    const tracks = new Promise<void>((resolve) => {
      releaseTracks = resolve;
    });
    const stub = stubMessages([[message("del_1")]]);
    attach();

    const options = {
      config,
      userId: "user_1",
      waitForTracks: () => tracks,
      factsVersion: () => 0,
    };
    const first = refresh(options);
    // Trigger while the first request is still running, with no new event.
    const second = refresh({ ...options, waitForTracks: () => Promise.resolve() });
    releaseTracks();
    await Promise.all([first, second]);

    expect(stub.calls()).toBe(1);
  });

  // A fetch that raced ahead of identify asked about a user the server did not
  // have yet. Its empty answer must not become the loaded cache.
  it("refetches when identify settles while a request is already running", async () => {
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) await gate;
        const messages = call === 1 ? [] : [message("del_1")];
        return new Response(JSON.stringify({ messages }), { status: 200 });
      }),
    );
    attach();

    // Pre-identify facts, then identify settles while the fetch is in flight.
    let facts = 0;
    const first = refresh({
      config,
      userId: "user_1",
      waitForTracks: () => Promise.resolve(),
      factsVersion: () => facts,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    facts = 1;
    const second = refresh({
      config,
      userId: "user_1",
      waitForTracks: () => Promise.resolve(),
      factsVersion: () => facts,
    });
    releaseFetch();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(call).toBe(2);
    expect(getSnapshot().visible?.deliveryId).toBe("del_1");
  });

  it("never runs a superseded identity's queued rerun", async () => {
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const userId = new URL(String(url)).searchParams.get("userId") as string;
        seen.push(userId);
        if (userId === "user_1") await firstSettled;
        return new Response(JSON.stringify({ messages: [message(`del_${userId}`)] }), {
          status: 200,
        });
      }),
    );
    attach();

    let tracked = 0;
    const first = refresh({
      config,
      userId: "user_1",
      waitForTracks: () => Promise.resolve(),
      factsVersion: () => tracked,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Queue a rerun for user_1, then switch identity before it can run.
    tracked = 1;
    void refresh({
      config,
      userId: "user_1",
      waitForTracks: () => Promise.resolve(),
      factsVersion: () => tracked,
    });
    const second = refresh({
      config,
      userId: "user_2",
      waitForTracks: () => Promise.resolve(),
      factsVersion: () => tracked,
    });
    releaseFirst();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(getSnapshot().identity).toBe("user_2");
    expect(getSnapshot().visible?.deliveryId).toBe("del_user_2");
    expect(seen.filter((id) => id === "user_1").length).toBe(1);
  });

  it("a superseded request does not clear its successor's slot", async () => {
    const seen: string[] = [];
    const gates = new Map<string, () => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const userId = new URL(String(url)).searchParams.get("userId") as string;
        seen.push(userId);
        await new Promise<void>((resolve) => gates.set(userId, resolve));
        return new Response(JSON.stringify({ messages: [message(`del_${userId}`)] }), {
          status: 200,
        });
      }),
    );
    attach();

    const first = load("user_1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = refresh({
      config,
      userId: "user_2",
      waitForTracks: () => Promise.resolve(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // user_1 settles while user_2's request is still running: its finalizer
    // must not free the slot user_2 owns, or this trigger would duplicate it.
    gates.get("user_1")?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = refresh({
      config,
      userId: "user_2",
      waitForTracks: () => Promise.resolve(),
    });
    gates.get("user_2")?.();
    await Promise.all([first, second, third]);

    expect(seen.filter((id) => id === "user_2").length).toBe(1);
  });

  it("keeps a warm cache when a background refresh fails", async () => {
    stubMessages([[message("del_1"), message("del_2")]]);
    attach();
    await load();
    markRendered("del_1");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await load();

    history.pushState({}, "", "/settings");
    expect(getSnapshot().visible?.deliveryId).toBe("del_1");
  });

  it("remounts a message that stays scheduled across consecutive page views", async () => {
    stubMessages([[message("del_1")]]);
    attach();
    await load();
    const before = visibleKey(getSnapshot());

    history.pushState({}, "", "/settings");
    const after = visibleKey(getSnapshot());

    expect(getSnapshot().visible?.deliveryId).toBe("del_1");
    expect(after).not.toBe(before);
  });

  it("treats a path change during detachment as a new page view", async () => {
    stubMessages([[message("del_1")]]);
    const id = attach();
    await load();
    markRendered("del_1");
    detach(id);

    history.pushState({}, "", "/settings");
    attach();

    expect(getSnapshot().path).toBe("/settings");
    expect(getSnapshot().visible?.deliveryId).toBe("del_1");
  });

  it("leaves a history wrapper installed after it alone", async () => {
    stubMessages([]);
    const id = attach();
    const foreign = history.pushState;
    const hostWrapper = function hostPatched(
      this: History,
      ...args: Parameters<History["pushState"]>
    ) {
      return foreign.apply(this, args);
    } as History["pushState"];
    history.pushState = hostWrapper;

    detach(id);
    expect(history.pushState).toBe(hostWrapper);
    history.pushState = foreign;
  });

  describe("media warming", () => {
    class FakeImage {
      static created: string[] = [];
      static pending: FakeImage[] = [];
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      #src = "";
      set src(value: string) {
        this.#src = value;
        FakeImage.created.push(value);
        FakeImage.pending.push(this);
      }
      get src(): string {
        return this.#src;
      }
      settle() {
        this.onload?.();
      }
    }

    function withMedia(deliveryId: string, url: string, pages: string[] | null): InAppMessage {
      return {
        ...message(deliveryId, pages),
        content: { title: deliveryId, presentation: "toast", media: { url, alt: "x" } },
      };
    }

    beforeEach(() => {
      FakeImage.created = [];
      FakeImage.pending = [];
      vi.stubGlobal("Image", FakeImage);
    });

    it("warms at most two images at a time, current page first", async () => {
      stubMessages([
        [
          withMedia("del_1", "https://cdn.test/elsewhere-a.png", ["/other"]),
          withMedia("del_2", "https://cdn.test/here.png", ["/dashboard"]),
          withMedia("del_3", "https://cdn.test/elsewhere-b.png", ["/other"]),
        ],
      ]);
      attach();
      await load();

      expect(FakeImage.created).toEqual([
        "https://cdn.test/here.png",
        "https://cdn.test/elsewhere-a.png",
      ]);

      FakeImage.pending[0]!.settle();
      expect(FakeImage.created).toHaveLength(3);
      expect(FakeImage.created[2]).toBe("https://cdn.test/elsewhere-b.png");
    });

    it("warms each url once per session", async () => {
      stubMessages([
        [withMedia("del_1", "https://cdn.test/a.png", null)],
        [withMedia("del_1", "https://cdn.test/a.png", null)],
      ]);
      attach();
      await load();
      await load();

      expect(FakeImage.created).toEqual(["https://cdn.test/a.png"]);
    });
  });
});
