"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useGalinum } from "./context.js";
import {
  attach,
  detach,
  getServerSnapshot,
  getSnapshot,
  markRendered,
  onNavigation,
  refresh,
  reset as resetScheduler,
  resolveDelivery,
  skip,
  subscribe,
  visibleKey,
} from "./scheduler.js";
import type { InAppMessage, MessagePresentation } from "./types.js";

export type InAppMessagesProps = {
  // Palette of the default renderer. "auto" follows the host page.
  theme?: MessageTheme;
  // Custom renderer for the scheduled message. Return null to render nothing
  // (no impression); the next matching message takes its place.
  render?: (message: InAppMessage, actions: MessageActions) => ReactNode;
};

export type MessageTheme = "light" | "dark" | "auto";

export type MessageActions = {
  onClick: () => void;
  onDismiss: () => void;
  onConvert: () => void;
};

// A transient impression failure retries on this cadence while the message
// stays mounted.
const IMPRESSION_RETRY_INTERVAL = 30000;

// Renders at most one message per page view. Eligible messages are prefetched
// at identify and cached in memory with their page patterns, so each page view
// decides synchronously — no request sits on the navigation render path and no
// message pops in mid-screen.
//
// Fetching alone does NOT count as an impression: the SDK reports `shown`
// through the delivery feedback API when a message actually mounts.
// A cached message that never renders stays queued and is never billed.
//
// Every mounted instance shares one scheduler, so a host app with several
// widgets still shows a single communication. Navigation is the only unlock:
// dismissing a message does not release the page view.
export function InAppMessages({ theme = "auto", render }: InAppMessagesProps) {
  const {
    config,
    userId,
    sendFeedback,
    waitForTracks,
    waitForIdentify,
    factsVersion,
    identifyVersion,
  } = useGalinum();
  const styles = THEME_STYLES[useResolvedTheme(theme)];
  const scheduled = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const instanceId = useInstanceId();
  // Bumped on a timer so a still-mounted message re-attempts a failed
  // impression report (see reportShown) without re-mounting.
  const [retryKey, setRetryKey] = useState(0);
  // Impressions already reported by this widget instance. Reporting is
  // idempotent server-side (`shown` only promotes a queued delivery), so a
  // remount after navigation may re-send it harmlessly; this set only
  // prevents duplicate requests within the instance.
  // A delivery is marked reported when the server accepts the request, and
  // also on a permanent rejection (retrying a 400/404 forever would only spam
  // the API). After a transient failure (network hiccup, 429, 5xx) the
  // still-mounted message retries on the next tick, so the impression isn't
  // silently lost.
  const reportedShown = useRef<Set<string>>(new Set());
  const inFlightShown = useRef<Set<string>>(new Set());
  const reportShown = useCallback(
    (deliveryId: string) => {
      markRendered(deliveryId);
      if (reportedShown.current.has(deliveryId) || inFlightShown.current.has(deliveryId)) return;
      inFlightShown.current.add(deliveryId);
      void sendFeedback(deliveryId, "shown")
        .then((outcome) => {
          if (outcome !== "transient") reportedShown.current.add(deliveryId);
        })
        .finally(() => inFlightShown.current.delete(deliveryId));
    },
    [sendFeedback],
  );

  // Fetch points, all deduped by the scheduler and bounded by its timeout:
  // at identify (the only fetch that may decide the current page view),
  // on navigation (feeds future page views), and after a resolved message.
  const reload = useCallback(() => {
    if (!userId) return Promise.resolve();
    return refresh({ config, userId, waitForTracks, factsVersion });
  }, [config, userId, waitForTracks, factsVersion]);

  useEffect(() => {
    if (!userId) {
      resetScheduler();
      return;
    }
    // Wait for identify to land first: a first-time user does not exist
    // server-side yet, and with no polling an empty first response would
    // leave this page view blank. identifyVersion re-runs this when the same
    // user is re-identified with new traits.
    let active = true;
    void waitForIdentify().then(() => {
      if (active) void reload();
    });
    const stopWatching = onNavigation(() => void reload());
    return () => {
      active = false;
      stopWatching();
    };
  }, [userId, identifyVersion, reload, waitForIdentify]);

  useEffect(() => {
    const timer = setInterval(() => setRetryKey((key) => key + 1), IMPRESSION_RETRY_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  const message = scheduled.visible;
  // The scheduler's identity must match the provider's: during an A→B switch
  // React renders before the reset effect runs, and A's message must never
  // appear in B's session.
  const sameIdentity = scheduled.identity === userId;
  const mountKey = visibleKey(scheduled);

  // Exactly one instance renders: the first one still mounted.
  if (
    !userId ||
    !message ||
    !sameIdentity ||
    instanceId === null ||
    scheduled.rendererId !== instanceId
  ) {
    return null;
  }

  const actions: MessageActions = {
    onClick: () => {
      void sendFeedback(message.deliveryId, "clicked");
      resolveDelivery(message.deliveryId);
      void reload();
    },
    onDismiss: () => {
      void sendFeedback(message.deliveryId, "dismissed");
      resolveDelivery(message.deliveryId);
      void reload();
    },
    onConvert: () => {
      void sendFeedback(message.deliveryId, "converted");
      resolveDelivery(message.deliveryId);
      void reload();
    },
  };

  if (render) {
    return (
      <CustomRendered
        key={mountKey}
        node={render(message, actions)}
        onShown={() => reportShown(message.deliveryId)}
        onSkip={() => skip(message.deliveryId)}
        retryKey={retryKey}
      />
    );
  }

  if (isModal(message)) {
    return (
      <AnnouncementModal
        key={mountKey}
        message={message}
        actions={actions}
        styles={styles}
        onShown={() => reportShown(message.deliveryId)}
        retryKey={retryKey}
        // CTA click reports `clicked`, then closes locally without sending
        // `dismissed` — the delivery is already resolved.
        onClose={() => resolveDelivery(message.deliveryId)}
      />
    );
  }

  return (
    <div style={TOAST_STACK_STYLE}>
      <DefaultToast
        key={mountKey}
        message={message}
        actions={actions}
        styles={styles}
        onShown={() => reportShown(message.deliveryId)}
        retryKey={retryKey}
      />
    </div>
  );
}

// Registers this widget with the shared scheduler for its whole lifetime.
function useInstanceId(): number | null {
  const [id, setId] = useState<number | null>(null);
  useEffect(() => {
    const registered = attach();
    setId(registered);
    return () => detach(registered);
  }, []);
  return id;
}

// Resolves the palette. An explicit "light"/"dark" bypasses host detection
// entirely; "auto" tracks the host page and re-renders when it changes.
function useResolvedTheme(theme: MessageTheme): ResolvedTheme {
  const explicit = theme === "auto" ? null : theme;
  const subscribe = useCallback(
    (onChange: () => void) => (explicit ? () => {} : subscribeHostTheme(onChange)),
    [explicit],
  );
  const getSnapshot = useCallback(() => explicit ?? resolveHostTheme(), [explicit]);
  const getServerSnapshot = useCallback((): ResolvedTheme => explicit ?? "light", [explicit]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// The host declares its scheme with CSS `color-scheme` on the root element —
// the web standard for it, so no host-specific integration is needed. A host
// that theme-switches without `color-scheme` must pass `theme` explicitly.
function resolveHostTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof document === "undefined") return "light";
  const declared = window
    .getComputedStyle(document.documentElement)
    .colorScheme.toLowerCase()
    .split(/\s+/);
  const dark = declared.includes("dark");
  const light = declared.includes("light");
  if (dark && light) return prefersDarkScheme() ? "dark" : "light";
  return dark ? "dark" : "light";
}

function subscribeHostTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const observer =
    typeof MutationObserver === "function" ? new MutationObserver(onChange) : null;
  observer?.observe(document.documentElement, { attributes: true });
  const media = matchColorScheme();
  media?.addEventListener("change", onChange);
  return () => {
    observer?.disconnect();
    media?.removeEventListener("change", onChange);
  };
}

function matchColorScheme(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-color-scheme: dark)");
}

function prefersDarkScheme(): boolean {
  return matchColorScheme()?.matches ?? false;
}

// Custom-renderer wrapper: the impression is reported only when the renderer
// actually produced content. Returning null/undefined/false means "render
// nothing for this message" — no impression, and the scheduler advances to
// the next matching candidate on this same page view. `retryKey` re-runs the
// effect on the retry tick so a transiently failed report is retried while
// mounted (reportShown itself dedupes accepted/in-flight reports).
function CustomRendered({
  node,
  onShown,
  onSkip,
  retryKey,
}: {
  node: ReactNode;
  onShown: () => void;
  onSkip: () => void;
  retryKey: number;
}) {
  const rendered = node !== null && node !== undefined && node !== false;
  useEffect(() => {
    if (rendered) onShown();
    else onSkip();
  }, [rendered, retryKey, onShown, onSkip]);
  return <>{node}</>;
}

// Delivered messages always state their presentation. Cached or legacy
// payloads may not, so fall back to the server's rule: renderable media means
// modal, anything else is a toast.
function resolvePresentation(message: InAppMessage): MessagePresentation {
  const stated = message.content.presentation;
  if (stated === "toast" || stated === "modal") return stated;
  return hasRenderableMedia(message) ? "modal" : "toast";
}

function isModal(message: InAppMessage): boolean {
  return resolvePresentation(message) === "modal";
}

function hasRenderableMedia(message: InAppMessage): boolean {
  const media = message.content.media;
  return Boolean(media && typeof media.url === "string" && safeImageUrl(media.url));
}

// --- Compact toast -----------------------------------------------------------

function DefaultToast({
  message,
  actions,
  styles,
  onShown,
  retryKey,
}: {
  message: InAppMessage;
  actions: MessageActions;
  styles: ThemeStyles;
  onShown: () => void;
  retryKey: number;
}) {
  const { title, body, cta, media } = message.content;
  const href = cta ? safeUrl(cta.url) : null;
  const imageUrl = media ? safeImageUrl(media.url) : null;
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = imageUrl !== null && !imageFailed;
  // Mounting the toast is the impression; retryKey re-attempts a failed
  // report on each poll while the toast stays mounted.
  useEffect(() => {
    onShown();
  }, [retryKey, onShown]);
  return (
    <div role="dialog" aria-label={title ?? "Message"} style={styles.card}>
      <button aria-label="Dismiss" onClick={actions.onDismiss} style={styles.close}>
        ×
      </button>
      {showImage ? (
        // Fixed thumbnail box: the text never waits for or shifts with the
        // image.
        <div style={TOAST_IMAGE_AREA_STYLE}>
          <img
            src={imageUrl}
            alt={media?.decorative ? "" : (media?.alt ?? "")}
            onError={() => setImageFailed(true)}
            style={TOAST_IMAGE_STYLE}
          />
        </div>
      ) : null}
      {title ? <strong style={{ display: "block", marginBottom: 4 }}>{title}</strong> : null}
      {body ? <p style={{ margin: "0 0 12px" }}>{body}</p> : null}
      {cta ? (
        <a
          href={href ?? "#"}
          onClick={actions.onClick}
          style={styles.cta}
          target={href ? "_blank" : undefined}
          rel="noreferrer"
        >
          {cta.label}
        </a>
      ) : null}
    </div>
  );
}

// --- Announcement modal ------------------------------------------------------

function AnnouncementModal({
  message,
  actions,
  styles,
  onShown,
  retryKey,
  onClose,
}: {
  message: InAppMessage;
  actions: MessageActions;
  styles: ThemeStyles;
  onShown: () => void;
  retryKey: number;
  onClose: () => void;
}) {
  const { title, body, cta, media } = message.content;
  const href = cta ? safeUrl(cta.url) : null;
  const imageUrl = media ? safeImageUrl(media.url) : null;
  const [imageFailed, setImageFailed] = useState(false);
  // Reduced motion: mount fully visible with transitions disabled entirely.
  const [reduceMotion] = useState(prefersReducedMotion);
  const [entered, setEntered] = useState(reduceMotion);
  const dialogRef = useRef<HTMLDivElement>(null);

  const dismiss = () => {
    actions.onDismiss();
  };

  // The modal claimed its turn and mounted — that's the impression. A media
  // message still waiting behind another modal never reaches this effect.
  // retryKey re-attempts a failed report on each poll while mounted.
  useEffect(() => {
    onShown();
  }, [retryKey, onShown]);

  // Focus management: remember the host page's focus, move it into the
  // dialog, keep Tab cycling inside, and hand focus back on close.
  useEffect(() => {
    const previous =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  // Enter animation, skipped when the user prefers reduced motion.
  useEffect(() => {
    if (reduceMotion) return;
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [reduceMotion]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("button, a[href]"),
    ).filter((el) => !el.hasAttribute("disabled"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const showImage = imageUrl !== null && !imageFailed;
  const accessibleName = title ?? (media?.decorative ? undefined : media?.alt) ?? "Announcement";

  // Portaled to <body> so a transformed/filtered/overflow-clipped host
  // ancestor can't clip the fixed backdrop or trap it in a stacking context.
  return createPortal(
    <div
      style={{
        ...BACKDROP_STYLE,
        opacity: entered ? 1 : 0,
        ...(reduceMotion ? { transition: "none" } : {}),
      }}
      onMouseDown={(event) => {
        // Backdrop click dismisses; clicks inside the card don't bubble here.
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={accessibleName}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          ...styles.modal,
          opacity: entered ? 1 : 0,
          transform: entered ? "translateY(0) scale(1)" : "translateY(10px) scale(0.97)",
          ...(reduceMotion ? { transition: "none" } : {}),
        }}
      >
        <button aria-label="Dismiss" onClick={dismiss} style={MODAL_CLOSE_STYLE}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M1.5 1.5l9 9m0-9l-9 9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {showImage ? (
          // Fixed image area: the text renders immediately and a slow image
          // drops into reserved space instead of shifting the card.
          <div style={MODAL_IMAGE_AREA_STYLE}>
            <img
              src={imageUrl}
              alt={media?.decorative ? "" : (media?.alt ?? "")}
              onError={() => setImageFailed(true)}
              style={MODAL_IMAGE_STYLE}
            />
          </div>
        ) : null}
        <div style={{ ...MODAL_BODY_STYLE, paddingTop: showImage ? 20 : 44 }}>
          {title ? <strong style={MODAL_TITLE_STYLE}>{title}</strong> : null}
          {body ? <p style={styles.modalText}>{body}</p> : null}
          {cta ? (
            <a
              href={href ?? "#"}
              onClick={() => {
                actions.onClick();
                onClose();
              }}
              style={styles.modalCta}
              target={href ? "_blank" : undefined}
              rel="noreferrer"
            >
              {cta.label}
            </a>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Campaign content is server-controlled; only allow safe schemes into href so a
// malicious campaign can't inject a `javascript:`/`data:` URI (XSS) on the host
// page. Returns null for missing or disallowed URLs.
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  const base = typeof window !== "undefined" ? window.location.origin : "https://localhost";
  try {
    const parsed = new URL(url, base);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

// Images are stricter than links: http(s) only — never data:/blob:/javascript:.
const SAFE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

function safeImageUrl(url: string | undefined): string | null {
  if (!url) return null;
  const base = typeof window !== "undefined" ? window.location.origin : "https://localhost";
  try {
    const parsed = new URL(url, base);
    return SAFE_IMAGE_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

// All presentation is inline styles on purpose: the SDK must not inject
// stylesheets into the host page or depend on its CSS.

type ResolvedTheme = "light" | "dark";

type Palette = {
  surface: string;
  surfaceBorder: string | undefined;
  text: string;
  mutedText: string;
  toastClose: string;
  ctaBackground: string;
  ctaText: string;
  toastShadow: string;
  modalShadow: string;
};

const PALETTES: Record<ResolvedTheme, Palette> = {
  light: {
    surface: "#fff",
    surfaceBorder: undefined,
    text: "#111",
    mutedText: "#4b4b4f",
    toastClose: "#888",
    ctaBackground: "#111",
    ctaText: "#fff",
    toastShadow: "0 10px 30px rgba(0,0,0,0.18)",
    modalShadow: "0 24px 80px rgba(0,0,0,0.35)",
  },
  dark: {
    surface: "#1f1f23",
    surfaceBorder: "1px solid rgba(255,255,255,0.1)",
    text: "#f4f4f5",
    mutedText: "#a1a1aa",
    toastClose: "#9ca3af",
    ctaBackground: "#fafafa",
    ctaText: "#111",
    toastShadow: "0 10px 30px rgba(0,0,0,0.5)",
    modalShadow: "0 24px 80px rgba(0,0,0,0.6)",
  },
};

type ThemeStyles = {
  card: CSSProperties;
  close: CSSProperties;
  cta: CSSProperties;
  modal: CSSProperties;
  modalText: CSSProperties;
  modalCta: CSSProperties;
};

function themeStyles(palette: Palette): ThemeStyles {
  return {
    card: {
      position: "relative",
      pointerEvents: "auto",
      width: "100%",
      padding: 16,
      borderRadius: 12,
      background: palette.surface,
      color: palette.text,
      border: palette.surfaceBorder,
      boxShadow: palette.toastShadow,
    },
    close: {
      position: "absolute",
      top: 8,
      right: 10,
      border: "none",
      background: "transparent",
      fontSize: 18,
      cursor: "pointer",
      color: palette.toastClose,
    },
    cta: {
      display: "inline-block",
      padding: "8px 14px",
      borderRadius: 8,
      background: palette.ctaBackground,
      color: palette.ctaText,
      textDecoration: "none",
      fontWeight: 600,
    },
    modal: {
      position: "relative",
      width: "min(30rem, 100%)",
      maxHeight: "min(85vh, 100%)",
      overflowY: "auto",
      borderRadius: 16,
      background: palette.surface,
      color: palette.text,
      border: palette.surfaceBorder,
      boxShadow: palette.modalShadow,
      outline: "none",
      transition: "opacity 180ms ease-out, transform 180ms ease-out",
    },
    modalText: {
      margin: 0,
      fontSize: 14,
      lineHeight: 1.55,
      color: palette.mutedText,
    },
    modalCta: {
      display: "block",
      marginTop: 8,
      padding: "10px 16px",
      borderRadius: 10,
      background: palette.ctaBackground,
      color: palette.ctaText,
      textAlign: "center",
      textDecoration: "none",
      fontWeight: 600,
      fontSize: 14,
    },
  };
}

const THEME_STYLES: Record<ResolvedTheme, ThemeStyles> = {
  light: themeStyles(PALETTES.light),
  dark: themeStyles(PALETTES.dark),
};

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "rgba(10, 10, 12, 0.55)",
  backdropFilter: "blur(3px)",
  WebkitBackdropFilter: "blur(3px)",
  zIndex: 2147483001,
  transition: "opacity 180ms ease-out",
};

const MODAL_CLOSE_STYLE: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  padding: 0,
  border: "none",
  borderRadius: 9999,
  background: "rgba(17, 17, 17, 0.55)",
  color: "#fff",
  cursor: "pointer",
  zIndex: 1,
};

// The image AREA has fixed dimensions and the image fills it, so text renders
// at once and a slow or late image never shifts the layout. Exported for tests.
export const MODAL_IMAGE_AREA_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  height: "min(46vh, 320px)",
  borderRadius: "16px 16px 0 0",
  overflow: "hidden",
};

const MODAL_IMAGE_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "cover",
};

export const TOAST_IMAGE_AREA_STYLE: CSSProperties = {
  display: "block",
  width: 48,
  height: 48,
  marginBottom: 10,
  borderRadius: 8,
  overflow: "hidden",
};

const TOAST_IMAGE_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "cover",
};

// Toasts stack upward from the bottom-right instead of sharing one fixed
// position. The container ignores pointer events so it never blocks the host
// page beside the cards themselves.
const TOAST_STACK_STYLE: CSSProperties = {
  position: "fixed",
  bottom: 24,
  right: 24,
  display: "flex",
  flexDirection: "column-reverse",
  gap: 12,
  width: "min(320px, calc(100vw - 48px))",
  maxHeight: "calc(100vh - 48px)",
  overflowY: "auto",
  pointerEvents: "none",
  zIndex: 2147483000,
};

const MODAL_BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "20px 24px 24px",
};

const MODAL_TITLE_STYLE: CSSProperties = {
  fontSize: 18,
  lineHeight: 1.35,
  fontWeight: 650,
  letterSpacing: "-0.01em",
};
