import type { EventProps, Traits } from "./types.js";
import { SDK_VERSION } from "./version.js";

// Auto-collected device/demographic context, PostHog-style: `$`-prefixed keys
// so customer traits never collide with ours. Country/city are enriched
// server-side from the request IP; only what the browser knows is here.

export type DeviceType = "Desktop" | "Mobile" | "Tablet";

export type ParsedUserAgent = {
  browser?: string;
  browserVersion?: string;
  os?: string;
  osVersion?: string;
  device?: string;
  deviceType: DeviceType;
};

// Order matters: Chromium UAs contain several browser tokens (e.g. Edge ships
// "Chrome/… Safari/… Edg/…"), so the most specific patterns come first.
const BROWSERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Edge", /Edg(?:e|iOS|A)?\/([\d.]+)/],
  ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
  ["Opera", /(?:OPR|Opera)[/ ]([\d.]+)/],
  ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
  ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
  ["Safari", /Version\/([\d.]+).*Safari/],
  ["Internet Explorer", /(?:MSIE |Trident.*rv:)([\d.]+)/],
];

// iOS before Mac OS X: iPhone/iPad UAs contain "like Mac OS X".
// Android before Linux: Android UAs contain "Linux".
const OSES: ReadonlyArray<readonly [string, RegExp]> = [
  ["Windows", /Windows NT ([\d._]+)/],
  ["iOS", /iP(?:hone|ad|od).*? OS ([\d._]+)/],
  ["Mac OS X", /Mac OS X ([\d._]+)/],
  ["Chrome OS", /CrOS/],
  ["Android", /Android ([\d._]+)/],
  ["Linux", /Linux/],
];

export function parseUserAgent(ua: string): ParsedUserAgent {
  const result: ParsedUserAgent = { deviceType: deviceType(ua) };

  for (const [name, pattern] of BROWSERS) {
    const match = ua.match(pattern);
    if (match) {
      result.browser = name;
      result.browserVersion = match[1];
      break;
    }
  }

  for (const [name, pattern] of OSES) {
    const match = ua.match(pattern);
    if (match) {
      result.os = name;
      if (match[1]) result.osVersion = match[1].replace(/_/g, ".");
      break;
    }
  }

  const device = deviceModel(ua);
  if (device) result.device = device;
  return result;
}

function deviceType(ua: string): DeviceType {
  if (/iPad/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "Tablet";
  if (/Mobi|iPhone|iPod|Android/.test(ua)) return "Mobile";
  return "Desktop";
}

function deviceModel(ua: string): string | undefined {
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPod/.test(ua)) return "iPod";
  // Android UAs embed the model as "; <model> Build/" or "; <model>)".
  const android = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build\/|\))/);
  return android?.[1]?.trim() || undefined;
}

// Person-level context sent with identify(). Explicit customer traits are
// merged on top, so anything here can be overridden per call.
export function collectAutoContext(): Traits {
  if (typeof window === "undefined" || typeof navigator === "undefined") return {};

  const parsed = parseUserAgent(navigator.userAgent ?? "");
  const context: Traits = {
    $lib: "galinum-react",
    $lib_version: SDK_VERSION,
    $device_type: parsed.deviceType,
  };
  if (parsed.browser) context.$browser = parsed.browser;
  if (parsed.browserVersion) context.$browser_version = parsed.browserVersion;
  if (parsed.os) context.$os = parsed.os;
  if (parsed.osVersion) context.$os_version = parsed.osVersion;
  if (parsed.device) context.$device = parsed.device;

  const timezone = resolveTimezone();
  if (timezone) context.$timezone = timezone;
  if (navigator.language) context.$language = navigator.language;
  if (window.screen?.width) {
    context.$screen_width = window.screen.width;
    context.$screen_height = window.screen.height;
  }

  const referrer = typeof document !== "undefined" ? document.referrer : "";
  if (referrer) {
    context.$referrer = referrer;
    const domain = referringDomain(referrer);
    if (domain) context.$referring_domain = domain;
  }
  return context;
}

// Page-level context attached to every track() call.
export function collectEventContext(): EventProps {
  if (typeof window === "undefined") return {};
  return {
    $current_url: window.location.href,
    $pathname: window.location.pathname,
  };
}

function resolveTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function referringDomain(referrer: string): string | undefined {
  try {
    return new URL(referrer).hostname || undefined;
  } catch {
    return undefined;
  }
}
