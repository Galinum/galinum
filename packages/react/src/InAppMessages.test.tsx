import { ackBody, ackResponse } from "./receipts.test.fixture.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GalinumProvider, useGalinum } from "./context.js";
import {
  InAppMessages,
  MODAL_IMAGE_AREA_STYLE,
  TOAST_IMAGE_AREA_STYLE,
} from "./InAppMessages.js";
import { __resetSchedulerForTests } from "./scheduler.js";
import type { InAppMessage, MessageContent } from "./types.js";

type RecordedCall = { url: string; body: Record<string, unknown> | null };

function stubApi(messages: InAppMessage[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
      });
      const body = String(url).includes("/messages") ? { ...Object.fromEntries(new URL(String(url)).searchParams), messages } : ackBody(url, init);
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

function message(
  content: MessageContent,
  deliveryId = "del_1",
  pages: string[] | null = null,
): InAppMessage {
  return { deliveryId, campaignId: "cmp_1", variantId: "var_1", content, pages };
}

function renderWidget(ui: ReactNode, userId?: string) {
  return render(
    <GalinumProvider
      publishableKey="pk_pub_test"
      apiBase="https://galinum.test"
      userId={userId}
    >
      {ui}
    </GalinumProvider>,
  );
}

// The scheduler decides synchronously but defers its React notification by one
// microtask (a host router calls pushState inside the insertion-effect phase,
// where scheduling updates is illegal). Flush that microtask here.
async function navigateTo(path: string) {
  await act(async () => {
    history.pushState({}, "", path);
  });
}

const fetches = (calls: RecordedCall[]) =>
  calls.filter((c) => c.url.includes("/api/v1/messages")).length;

function shownCalls(calls: RecordedCall[], deliveryId: string): RecordedCall[] {
  return calls.filter(
    (c) => c.url.includes(`/api/v1/deliveries/${deliveryId}/event`) && c.body?.type === "shown",
  );
}

beforeEach(() => {
  history.pushState({}, "", "/dashboard");
  __resetSchedulerForTests();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("color-scheme");
  __resetSchedulerForTests();
});

describe("InAppMessages", () => {
  it("reset synchronously closes a captured feedback callback before effects run", async () => {
    const calls = stubApi([message({ title: "Owned" })]);
    let reset!: () => void;
    let action!: () => Promise<import("./feedback.js").FeedbackReceipt>;
    function Probe() { reset = useGalinum().reset; return null; }
    renderWidget(<><Probe /><InAppMessages render={(_message, actions) => { action = actions.onDismiss; return <div>Owned</div>; }} /></>, "user_1");
    await screen.findByText("Owned");
    await waitFor(() => expect(shownCalls(calls, "del_1")).toHaveLength(1));
    let result!: ReturnType<typeof action>;
    act(() => { reset(); result = action(); });
    expect((await result).status).toBe("failed");
    expect(calls.some((call) => call.body?.type === "dismissed")).toBe(false);
  });

  it("renders nothing and does not fetch without an identified user", async () => {
    const calls = stubApi([message({ title: "Hello" })]);
    renderWidget(<InAppMessages />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetches(calls)).toBe(0);
    expect(screen.queryByText("Hello")).toBeNull();
  });

  it("renders the default card with title, body, and CTA", async () => {
    stubApi([
      message({ title: "Hello", body: "World", cta: { label: "Go", destination: { kind: "website", url: "https://example.com" } } }),
    ]);
    renderWidget(<InAppMessages />, "user_1");

    expect(await screen.findByText("Hello")).toBeDefined();
    expect(screen.getByText("World")).toBeDefined();
    const cta = screen.getByText("Go") as HTMLAnchorElement;
    expect(cta.getAttribute("href")).toBe("https://example.com");
  });

  it("captures entry and request correlation on every fetch", async () => {
    const calls = stubApi([]);
    renderWidget(<InAppMessages />, "user_1");

    await waitFor(() => expect(fetches(calls)).toBe(1));
    expect(calls.find((c) => c.url.includes("/api/v1/messages"))?.url).toContain("entryId=");
  });

  it("reports dismissal and removes the card", async () => {
    const calls = stubApi([message({ title: "Hello" })]);
    renderWidget(<InAppMessages />, "user_1");

    fireEvent.click(await screen.findByLabelText("Dismiss"));

    await waitFor(() => {
      const feedback = calls.find(
        (c) => c.url.includes("/api/v1/deliveries/del_1/event") && c.body?.type === "dismissed",
      );
      expect(feedback?.body).toMatchObject({ userId: "user_1", type: "dismissed" });
    });
    expect(screen.queryByText("Hello")).toBeNull();
  });

  it("reports clicks on the CTA", async () => {
    const calls = stubApi([
      message({ title: "Hello", cta: { label: "Go", destination: { kind: "website", url: "https://example.com" } } }),
    ]);
    renderWidget(<InAppMessages />, "user_1");

    fireEvent.click(await screen.findByText("Go"));

    await waitFor(() => {
      const feedback = calls.find(
        (c) => c.url.includes("/api/v1/deliveries/del_1/event") && c.body?.type === "clicked",
      );
      expect(feedback?.body).toMatchObject({ userId: "user_1", type: "clicked" });
    });
  });

  it("skips a candidate whose required destination is unsupported without an impression", async () => {
    const calls = stubApi([
      message({ title: "Unsupported", cta: { label: "Open app", destination: { kind: "app", url: "unconfigured://screen" } } }, "unsupported"),
      message({ title: "Supported" }, "supported"),
    ]);
    renderWidget(<InAppMessages />, "user_1");
    expect(await screen.findByText("Supported")).toBeDefined();
    expect(screen.queryByText("Unsupported")).toBeNull();
    expect(shownCalls(calls, "unsupported")).toHaveLength(0);

  });

  it("uses a custom renderer instead of the default card", async () => {
    stubApi([message({ title: "Hello" })]);
    renderWidget(<InAppMessages render={(m) => <div>custom:{String(m.content.title)}</div>} />, "user_1");

    expect(await screen.findByText("custom:Hello")).toBeDefined();
    expect(screen.queryByLabelText("Dismiss")).toBeNull();
  });

  it("never polls on a timer", async () => {
    const calls = stubApi([]);
    renderWidget(<InAppMessages />, "user_1");

    await waitFor(() => expect(fetches(calls)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetches(calls)).toBe(1);
  });

  describe("one message per page view", () => {
    it("shows only the first eligible message, not every one", async () => {
      stubApi([
        message({ title: "First" }, "del_1"),
        message({ title: "Second" }, "del_2"),
      ]);
      renderWidget(<InAppMessages />, "user_1");

      await screen.findByText("First");
      expect(screen.queryByText("Second")).toBeNull();
    });

    it("does not render before the identify fetch resolves", async () => {
      let resolveFetch!: (messages: InAppMessage[]) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
          if (String(url).includes("/messages")) {
            return new Promise<Response>((resolve) => {
              resolveFetch = (messages) =>
                resolve(new Response(JSON.stringify({ ...Object.fromEntries(new URL(String(url)).searchParams), messages }), { status: 200 }));
            });
          }
          return Promise.resolve(new Response(JSON.stringify(ackBody(url, init)), { status: 200 }));
        }),
      );
      renderWidget(<InAppMessages />, "user_1");

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText("Cold")).toBeNull();

      await act(async () => {
        resolveFetch([message({ title: "Cold" })]);
      });
      expect(await screen.findByText("Cold")).toBeDefined();
    });

    it("dismissal does not unlock a second message on the same page view", async () => {
      stubApi([
        message({ title: "First" }, "del_1"),
        message({ title: "Second" }, "del_2"),
      ]);
      renderWidget(<InAppMessages />, "user_1");

      fireEvent.click(await screen.findByLabelText("Dismiss"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.queryByText("Second")).toBeNull();
    });

    it("navigation refuses cached content while the fresh decision is pending", async () => {
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
          if (String(url).includes("/messages")) {
            call += 1;
            if (call > 1) return new Promise<Response>(() => {});
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  ...Object.fromEntries(new URL(String(url)).searchParams),
                  messages: [
                    message({ title: "First" }, "del_1"),
                    message({ title: "Second" }, "del_2"),
                  ],
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(new Response(JSON.stringify(ackBody(url, init)), { status: 200 }));
        }),
      );
      renderWidget(<InAppMessages />, "user_1");

      fireEvent.click(await screen.findByLabelText("Dismiss"));
      await navigateTo("/settings");

      expect(screen.queryByText("Second")).toBeNull();
    });

    it("a visible message leaves the screen on navigation without dismissal feedback", async () => {
      const calls = stubApi([message({ title: "Only" }, "del_1", ["/dashboard"])]);
      renderWidget(<InAppMessages />, "user_1");

      await screen.findByText("Only");
      await navigateTo("/settings");

      expect(screen.queryByText("Only")).toBeNull();
      const dismissed = calls.filter(
        (c) => c.url.includes("/event") && c.body?.type === "dismissed",
      );
      expect(dismissed.length).toBe(0);
    });

    it("an interrupted message stays eligible on a later matching page view", async () => {
      const calls = stubApi([message({ title: "Only" }, "del_1", ["/dashboard", "/billing"])]);
      renderWidget(<InAppMessages />, "user_1");

      await screen.findByText("Only");
      await navigateTo("/settings");
      expect(screen.queryByText("Only")).toBeNull();

      await navigateTo("/billing");
      expect(screen.getByText("Only")).toBeDefined();
      await waitFor(() => expect(shownCalls(calls, "del_1")).toHaveLength(2));
      expect(shownCalls(calls, "del_1")[0]?.body?.feedbackId).not.toBe(shownCalls(calls, "del_1")[1]?.body?.feedbackId);
    });

    it("uses the fresh navigation response instead of the prior page candidate", async () => {
      let call = 0;
      const calls: RecordedCall[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
          calls.push({ url: String(url), body: null });
          if (String(url).includes("/messages")) {
            call += 1;
            const messages =
              call === 1
                ? [message({ title: "First" }, "del_1")]
                : [message({ title: "Newer" }, "del_9"), message({ title: "First" }, "del_1")];
            return new Response(JSON.stringify({ ...Object.fromEntries(new URL(String(url)).searchParams), messages }), { status: 200 });
          }
          return new Response(JSON.stringify(ackBody(url, init)), { status: 200 });
        }),
      );
      renderWidget(<InAppMessages />, "user_1");

      await screen.findByText("First");
      await navigateTo("/settings");
      await waitFor(() => expect(call).toBeGreaterThanOrEqual(2));
      expect(screen.queryByText("First")).toBeNull();
      expect(screen.getByText("Newer")).toBeDefined();
    });

    it("hash-only and query-only changes do not start a new page view", async () => {
      stubApi([
        message({ title: "First" }, "del_1"),
        message({ title: "Second" }, "del_2"),
      ]);
      renderWidget(<InAppMessages />, "user_1");

      fireEvent.click(await screen.findByLabelText("Dismiss"));
      await navigateTo("/dashboard?tab=2");
      await navigateTo("/dashboard#section");

      expect(screen.queryByText("Second")).toBeNull();
    });
  });

  describe("page targeting", () => {
    it("skips a message whose pages do not match the current path", async () => {
      stubApi([
        message({ title: "Settings only" }, "del_1", ["/settings"]),
        message({ title: "Everywhere" }, "del_2", null),
      ]);
      renderWidget(<InAppMessages />, "user_1");

      expect(await screen.findByText("Everywhere")).toBeDefined();
      expect(screen.queryByText("Settings only")).toBeNull();
    });

    it("renders a page-targeted message once the user reaches its screen", async () => {
      stubApi([message({ title: "Settings only" }, "del_1", ["/settings/*"])]);
      renderWidget(<InAppMessages />, "user_1");

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText("Settings only")).toBeNull();

      await navigateTo("/settings/billing");
      expect(screen.getByText("Settings only")).toBeDefined();
    });

    it("never reports an impression for a cached message that never renders", async () => {
      const calls = stubApi([message({ title: "Settings only" }, "del_1", ["/settings"])]);
      const view = renderWidget(<InAppMessages />, "user_1");

      await waitFor(() => expect(fetches(calls)).toBe(1));
      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shownCalls(calls, "del_1").length).toBe(0);
    });
  });

  describe("multiple mounted instances", () => {
    it("render exactly one message and share the consumed page view", async () => {
      stubApi([
        message({ title: "First" }, "del_1"),
        message({ title: "Second" }, "del_2"),
      ]);
      renderWidget(
        <>
          <InAppMessages />
          <InAppMessages />
        </>,
        "user_1",
      );

      await waitFor(() => expect(screen.getAllByText("First").length).toBe(1));
      expect(screen.queryByText("Second")).toBeNull();

      fireEvent.click(screen.getByLabelText("Dismiss"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.queryByText("Second")).toBeNull();
    });

    it("dedupe one fetch across instances", async () => {
      const calls = stubApi([message({ title: "First" })]);
      renderWidget(
        <>
          <InAppMessages />
          <InAppMessages />
        </>,
        "user_1",
      );

      await screen.findByText("First");
      expect(fetches(calls)).toBe(1);
    });

    it("does not repaint a consumed entry when the renderer unmounts", async () => {
      stubApi([message({ title: "First" })]);

      function Pair() {
        const [showFirst, setShowFirst] = useState(true);
        return (
          <>
            {showFirst ? <InAppMessages /> : null}
            <InAppMessages />
            <button onClick={() => setShowFirst(false)}>drop</button>
          </>
        );
      }
      renderWidget(<Pair />, "user_1");

      await waitFor(() => expect(screen.getAllByText("First").length).toBe(1));
      fireEvent.click(screen.getByText("drop"));
      await waitFor(() => expect(screen.queryByText("First")).toBeNull());
    });

    it("restores the host's history methods only after the last instance unmounts", async () => {
      stubApi([]);
      const original = history.pushState;

      function Pair() {
        const [showFirst, setShowFirst] = useState(true);
        return (
          <>
            {showFirst ? <InAppMessages /> : null}
            <InAppMessages />
            <button onClick={() => setShowFirst(false)}>drop</button>
          </>
        );
      }
      const view = renderWidget(<Pair />, "user_1");

      await waitFor(() => expect(history.pushState).not.toBe(original));
      fireEvent.click(screen.getByText("drop"));
      expect(history.pushState).not.toBe(original);

      view.unmount();
      await waitFor(() => expect(history.pushState).toBe(original));
    });
  });

  describe("custom rendering", () => {
    it("receives only the scheduled message", async () => {
      const seen: string[] = [];
      stubApi([
        message({ title: "First" }, "del_1"),
        message({ title: "Second" }, "del_2"),
      ]);
      renderWidget(
        <InAppMessages
          render={(m) => {
            seen.push(m.deliveryId);
            return <div>c:{String(m.content.title)}</div>;
          }}
        />,
        "user_1",
      );

      await screen.findByText("c:First");
      expect(new Set(seen)).toEqual(new Set(["del_1"]));
    });

    it("advances to the next candidate when the renderer returns null", async () => {
      stubApi([
        message({ title: "Skipped" }, "del_1"),
        message({ title: "Shown" }, "del_2"),
      ]);
      renderWidget(
        <InAppMessages
          render={(m) =>
            m.deliveryId === "del_1" ? null : <div>c:{String(m.content.title)}</div>
          }
        />,
        "user_1",
      );

      expect(await screen.findByText("c:Shown")).toBeDefined();
    });

    it("reports no impression for a skipped message", async () => {
      const calls = stubApi([message({ title: "Hidden" }, "del_1")]);
      renderWidget(<InAppMessages render={() => null} />, "user_1");

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(shownCalls(calls, "del_1").length).toBe(0);
    });

    it("re-offers a skipped message after navigation", async () => {
      const rendered: string[] = [];
      stubApi([message({ title: "Maybe" }, "del_1")]);
      let allow = false;
      renderWidget(
        <InAppMessages
          render={(m) => {
            rendered.push(m.deliveryId);
            return allow ? <div>c:{String(m.content.title)}</div> : null;
          }}
        />,
        "user_1",
      );

      await waitFor(() => expect(rendered.length).toBeGreaterThan(0));
      allow = true;
      await navigateTo("/settings");
      expect(await screen.findByText("c:Maybe")).toBeDefined();
    });
  });

  describe("fetch ordering behind in-flight tracks", () => {
    function TrackProbe({ onReady }: { onReady: (track: (event: string) => Promise<void>) => void }) {
      const { track } = useGalinum();
      onReady(track);
      return null;
    }

    function stubApiWithDeferredTrack(messages: InAppMessage[]) {
      const calls: RecordedCall[] = [];
      const trackDeferreds: Array<() => void> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
          calls.push({
            url: String(url),
            body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
          });
          if (String(url).includes("/api/v1/track")) {
            return new Promise<Response>((resolve) => {
              trackDeferreds.push(() =>
                resolve(new Response(JSON.stringify(ackBody(url, init)), { status: 200 })),
              );
            });
          }
          const body = String(url).includes("/messages") ? { ...Object.fromEntries(new URL(String(url)).searchParams), messages } : ackBody(url, init);
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }),
      );
      return { calls, trackDeferreds };
    }

    it("holds the fetch while a track is in flight and fetches after it settles", async () => {
      const { calls, trackDeferreds } = stubApiWithDeferredTrack([message({ title: "Hello" })]);
      let track!: (event: string) => Promise<void>;
      let showWidget!: () => void;

      function DeferredWidget() {
        const [show, setShow] = useState(false);
        showWidget = () => setShow(true);
        return show ? <InAppMessages /> : null;
      }

      render(
        <GalinumProvider
          publishableKey="pk_pub_test"
          apiBase="https://galinum.test"
          userId="user_1"
        >
          <TrackProbe onReady={(t) => (track = t)} />
          <DeferredWidget />
        </GalinumProvider>,
      );
      await waitFor(() => expect(calls.some((c) => c.url.includes("/identify"))).toBe(true));

      let trackDone: Promise<void>;
      act(() => {
        trackDone = track("page_view");
      });
      expect(trackDeferreds).toHaveLength(1);

      act(() => showWidget());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetches(calls)).toBe(0);

      trackDeferreds[0]!();
      await act(() => trackDone!);
      await waitFor(() => expect(fetches(calls)).toBe(1));
      expect(await screen.findByText("Hello")).toBeDefined();
    });

    it("settles empty when track facts exceed the entry wait", async () => {
      vi.useFakeTimers();
      try {
        const { calls, trackDeferreds } = stubApiWithDeferredTrack([]);
        let track!: (event: string) => Promise<void>;
        let showWidget!: () => void;

        function DeferredWidget() {
          const [show, setShow] = useState(false);
          showWidget = () => setShow(true);
          return show ? <InAppMessages /> : null;
        }

        render(
          <GalinumProvider
            publishableKey="pk_pub_test"
            apiBase="https://galinum.test"
            userId="user_1"
          >
            <TrackProbe onReady={(t) => (track = t)} />
            <DeferredWidget />
          </GalinumProvider>,
        );
        await act(async () => {});

        act(() => {
          void track("stalls_forever");
        });
        expect(trackDeferreds).toHaveLength(1);

        act(() => showWidget());
        await act(async () => {});
        expect(fetches(calls)).toBe(0);

        await act(() => vi.advanceTimersByTimeAsync(1999));
        expect(fetches(calls)).toBe(0);

        await act(() => vi.advanceTimersByTimeAsync(2));
        expect(fetches(calls)).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("announcement modal", () => {
    const MEDIA = { url: "https://media.galinum.test/p/x/a.png", alt: "New dashboard" };

    it("renders a centered modal with backdrop instead of the toast", async () => {
      stubApi([
        message({
          title: "Big news",
          body: "Details",
          media: MEDIA,
          cta: { label: "See it", destination: { kind: "website", url: "https://example.com" } },
        }),
      ]);
      renderWidget(<InAppMessages />, "user_1");

      const dialog = await screen.findByRole("dialog", { name: "Big news" });
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      const img = screen.getByAltText("New dashboard") as HTMLImageElement;
      expect(img.src).toBe(MEDIA.url);
      expect(screen.getByText("See it")).toBeDefined();
    });

    it("reserves the image area so text never waits for the image", async () => {
      stubApi([message({ title: "Big news", body: "Details", media: MEDIA })]);
      renderWidget(<InAppMessages />, "user_1");

      const img = await screen.findByAltText("New dashboard");
      const area = img.parentElement as HTMLElement;
      // Fixed height on the area, image fills it: no reflow when it arrives.
      expect(MODAL_IMAGE_AREA_STYLE.height).toBe("min(46vh, 320px)");
      expect(area.style.overflow).toBe("hidden");
      expect(img.style.height).toBe("100%");
      expect(screen.getByText("Details")).toBeDefined();
    });

    it("marks a decorative image with empty alt", async () => {
      stubApi([message({ title: "Hi", media: { url: MEDIA.url, decorative: true } })]);
      renderWidget(<InAppMessages />, "user_1");

      const dialog = await screen.findByRole("dialog", { name: "Hi" });
      expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("");
    });

    it("moves focus into the dialog and dismisses on Escape", async () => {
      const calls = stubApi([message({ title: "Big news", media: MEDIA })]);
      renderWidget(<InAppMessages />, "user_1");

      const dialog = await screen.findByRole("dialog", { name: "Big news" });
      await waitFor(() => expect(document.activeElement).toBe(dialog));

      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => {
        const feedback = calls.find(
          (c) => c.url.includes("/api/v1/deliveries/del_1/event") && c.body?.type === "dismissed",
        );
        expect(feedback?.body).toMatchObject({ userId: "user_1", type: "dismissed" });
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("reports a click and closes locally when the CTA is used", async () => {
      const calls = stubApi([
        message({
          title: "Big news",
          media: MEDIA,
          cta: { label: "See it", destination: { kind: "website", url: "https://example.com" } },
        }),
      ]);
      renderWidget(<InAppMessages />, "user_1");

      fireEvent.click(await screen.findByText("See it"));
      await waitFor(() => {
        const feedback = calls.find(
          (c) => c.url.includes("/api/v1/deliveries/del_1/event") && c.body?.type === "clicked",
        );
        expect(feedback?.body).toMatchObject({ userId: "user_1", type: "clicked" });
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      const dismissed = calls.filter(
        (c) => c.url.includes("/event") && c.body?.type === "dismissed",
      );
      expect(dismissed.length).toBe(0);
    });

    it("keeps text and dismissal usable when the image fails to load", async () => {
      stubApi([message({ title: "Big news", body: "Still here", media: MEDIA })]);
      renderWidget(<InAppMessages />, "user_1");

      fireEvent.error(await screen.findByAltText("New dashboard"));

      expect(screen.queryByAltText("New dashboard")).toBeNull();
      expect(screen.getByText("Still here")).toBeDefined();
      expect(screen.getByLabelText("Dismiss")).toBeDefined();
    });

    it("ignores unsafe media URLs and falls back to the toast", async () => {
      stubApi([message({ title: "Sneaky", media: { url: "javascript:alert(1)", alt: "x" } })]);
      renderWidget(<InAppMessages />, "user_1");

      const dialog = await screen.findByRole("dialog", { name: "Sneaky" });
      expect(dialog.getAttribute("aria-modal")).toBeNull();
      expect(dialog.querySelector("img")).toBeNull();
    });
  });

  describe("explicit presentation", () => {
    const MEDIA = { url: "https://media.galinum.test/p/x/a.png", alt: "New dashboard" };

    it("renders a toast with a thumbnail when media rides along", async () => {
      stubApi([
        message({ title: "Ship log", body: "Details", media: MEDIA, presentation: "toast" }),
      ]);
      renderWidget(<InAppMessages />, "user_1");

      const dialog = await screen.findByRole("dialog", { name: "Ship log" });
      expect(dialog.getAttribute("aria-modal")).toBeNull();
      const img = screen.getByAltText("New dashboard") as HTMLImageElement;
      expect(img.src).toBe(MEDIA.url);
      const area = img.parentElement as HTMLElement;
      expect(area.style.overflow).toBe("hidden");
      expect(TOAST_IMAGE_AREA_STYLE.width).toBe(48);
      expect(TOAST_IMAGE_AREA_STYLE.height).toBe(48);
    });

    it("renders a modal without media as a backdrop dialog and no image", async () => {
      stubApi([message({ title: "Flagship", body: "Big", presentation: "modal" })]);
      renderWidget(<InAppMessages />, "user_1");

      const dialog = await screen.findByRole("dialog", { name: "Flagship" });
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.querySelector("img")).toBeNull();
    });

    it("falls back to media presence when presentation is absent", async () => {
      stubApi([message({ title: "Legacy media", media: MEDIA }, "del_1")]);
      renderWidget(<InAppMessages />, "user_1");

      const modal = await screen.findByRole("dialog", { name: "Legacy media" });
      expect(modal.getAttribute("aria-modal")).toBe("true");
    });

    it("hands presentation to a custom renderer untouched", async () => {
      stubApi([message({ title: "Hello", media: MEDIA, presentation: "toast" })]);
      renderWidget(
        <InAppMessages render={(m) => <div>custom:{String(m.content.presentation)}</div>} />,
        "user_1",
      );

      expect(await screen.findByText("custom:toast")).toBeDefined();
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("impression reporting", () => {
    it("reports shown once when a toast mounts", async () => {
      const calls = stubApi([message({ title: "Hello" })]);
      renderWidget(<InAppMessages />, "user_1");

      await screen.findByText("Hello");
      await waitFor(() => expect(shownCalls(calls, "del_1").length).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(shownCalls(calls, "del_1").length).toBe(1);
    });

    it("reports shown when a custom renderer returns content", async () => {
      const calls = stubApi([message({ title: "Hello" })]);
      renderWidget(<InAppMessages render={(m) => <div>c:{String(m.content.title)}</div>} />, "user_1");

      await screen.findByText("c:Hello");
      await waitFor(() => expect(shownCalls(calls, "del_1").length).toBe(1));
    });

    // Fake timers freeze the clock testing-library's waitFor polls on, so
    // these drive the retry tick explicitly instead.
    function stubShownStatus(status: (attempt: number) => number) {
      const state = { attempts: 0 };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
          const body = init?.body
            ? (JSON.parse(init.body as string) as Record<string, unknown>)
            : null;
          if (String(url).includes("/messages")) {
            return new Response(JSON.stringify({ ...Object.fromEntries(new URL(String(url)).searchParams), messages: [message({ title: "Hello" })] }), {
              status: 200,
            });
          }
          if (body?.type === "shown") {
            state.attempts += 1;
            return ackResponse(url, init, status(state.attempts));
          }
          return new Response(JSON.stringify(ackBody(url, init)), { status: 200 });
        }),
      );
      return state;
    }

    it("retries a transiently rejected report on the retry tick, then stops", async () => {
      vi.useFakeTimers();
      try {
        const state = stubShownStatus((attempt) => (attempt === 1 ? 429 : 200));
        renderWidget(<InAppMessages />, "user_1");

        await act(() => vi.advanceTimersByTimeAsync(10));
        expect(state.attempts).toBe(1);

        await act(() => vi.advanceTimersByTimeAsync(30000));
        expect(state.attempts).toBe(2);

        await act(() => vi.advanceTimersByTimeAsync(90000));
        expect(state.attempts).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not retry a permanently rejected report", async () => {
      vi.useFakeTimers();
      try {
        const state = stubShownStatus(() => 400);
        renderWidget(<InAppMessages />, "user_1");

        await act(() => vi.advanceTimersByTimeAsync(10));
        expect(state.attempts).toBe(1);

        await act(() => vi.advanceTimersByTimeAsync(90000));
        expect(state.attempts).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("theme", () => {
    const MEDIA = { url: "https://media.galinum.test/p/x/a.png", alt: "New dashboard" };
    const DARK_SURFACE = "#1f1f23";
    const LIGHT_SURFACE = "#fff";

    function setHostScheme(scheme: string) {
      document.documentElement.style.colorScheme = scheme;
    }

    function stubPrefersDark(dark: boolean) {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches: query.includes("prefers-color-scheme: dark") ? dark : false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
          onchange: null,
        })),
      );
    }

    it("renders the light palette on a host that declares no scheme", async () => {
      stubApi([message({ title: "Hello", cta: { label: "Go", destination: { kind: "website", url: "https://example.com" } } })]);
      renderWidget(<InAppMessages />, "user_1");

      const toast = await screen.findByRole("dialog", { name: "Hello" });
      expect(toast.style.background).toBe(LIGHT_SURFACE);
      expect(toast.style.color).toBe("#111");
      expect((screen.getByText("Go") as HTMLAnchorElement).style.background).toBe("#111");
    });

    it("renders the dark palette when the host declares color-scheme: dark", async () => {
      setHostScheme("dark");
      stubApi([message({ title: "Hello", cta: { label: "Go", destination: { kind: "website", url: "https://example.com" } } })]);
      renderWidget(<InAppMessages />, "user_1");

      const toast = await screen.findByRole("dialog", { name: "Hello" });
      expect(toast.style.background).toBe(DARK_SURFACE);
      expect(toast.style.color).toBe("#f4f4f5");
    });

    it("renders the announcement modal in the dark palette too", async () => {
      setHostScheme("dark");
      stubApi([message({ title: "Big news", body: "Details", media: MEDIA })]);
      renderWidget(<InAppMessages />, "user_1");

      const dialog = await screen.findByRole("dialog", { name: "Big news" });
      expect(dialog.style.background).toBe(DARK_SURFACE);
      expect((screen.getByText("Details") as HTMLElement).style.color).toBe("#a1a1aa");
    });

    it("follows prefers-color-scheme when the host declares both schemes", async () => {
      stubPrefersDark(true);
      setHostScheme("light dark");
      stubApi([message({ title: "Hello" })]);
      renderWidget(<InAppMessages />, "user_1");

      expect((await screen.findByRole("dialog", { name: "Hello" })).style.background).toBe(
        DARK_SURFACE,
      );
    });

    it("an explicit theme overrides the host", async () => {
      setHostScheme("dark");
      stubApi([message({ title: "Hello" })]);
      renderWidget(<InAppMessages theme="light" />, "user_1");

      expect((await screen.findByRole("dialog", { name: "Hello" })).style.background).toBe(
        LIGHT_SURFACE,
      );
    });

    it("re-renders into the other palette when the host scheme changes after mount", async () => {
      stubApi([message({ title: "Hello" })]);
      renderWidget(<InAppMessages />, "user_1");
      expect((await screen.findByRole("dialog", { name: "Hello" })).style.background).toBe(
        LIGHT_SURFACE,
      );

      act(() => setHostScheme("dark"));

      await waitFor(() =>
        expect(screen.getByRole("dialog", { name: "Hello" }).style.background).toBe(DARK_SURFACE),
      );
    });

    it("does not style a custom renderer's output", async () => {
      setHostScheme("dark");
      stubApi([message({ title: "Hello" })]);
      renderWidget(<InAppMessages render={(m) => <div>custom:{m.content.title}</div>} />, "user_1");

      const custom = await screen.findByText("custom:Hello");
      expect(custom.getAttribute("style")).toBeNull();
    });
  });
});
