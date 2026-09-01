import { describe, expect, it } from "vitest";
import { collectAutoContext, collectEventContext, parseUserAgent } from "./auto-context.js";
import { SDK_VERSION } from "./version.js";

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ2A.230505.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
  chromeAndroidReduced:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 12; SM-X906C Build/QP1A.190711.020) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.119 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/119.0",
  samsungInternet:
    "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  operaMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
};

describe("parseUserAgent", () => {
  it("parses Chrome on Windows", () => {
    expect(parseUserAgent(UA.chromeWindows)).toEqual({
      browser: "Chrome",
      browserVersion: "120.0.0.0",
      os: "Windows",
      osVersion: "10.0",
      deviceType: "Desktop",
    });
  });

  it("parses Safari on macOS with underscore version", () => {
    expect(parseUserAgent(UA.safariMac)).toEqual({
      browser: "Safari",
      browserVersion: "17.1",
      os: "Mac OS X",
      osVersion: "10.15.7",
      deviceType: "Desktop",
    });
  });

  it("parses Safari on iPhone as iOS mobile", () => {
    expect(parseUserAgent(UA.safariIphone)).toEqual({
      browser: "Safari",
      browserVersion: "16.5",
      os: "iOS",
      osVersion: "16.5",
      device: "iPhone",
      deviceType: "Mobile",
    });
  });

  it("parses iPad as a tablet", () => {
    const parsed = parseUserAgent(UA.safariIpad);
    expect(parsed.deviceType).toBe("Tablet");
    expect(parsed.device).toBe("iPad");
    expect(parsed.os).toBe("iOS");
    expect(parsed.osVersion).toBe("15.0");
  });

  it("parses Chrome on Android with device model", () => {
    expect(parseUserAgent(UA.chromeAndroid)).toEqual({
      browser: "Chrome",
      browserVersion: "119.0.0.0",
      os: "Android",
      osVersion: "13",
      device: "Pixel 7",
      deviceType: "Mobile",
    });
  });

  it("handles Android reduced UA (model 'K')", () => {
    const parsed = parseUserAgent(UA.chromeAndroidReduced);
    expect(parsed.os).toBe("Android");
    expect(parsed.device).toBe("K");
    expect(parsed.deviceType).toBe("Mobile");
  });

  it("treats Android without Mobile token as a tablet", () => {
    const parsed = parseUserAgent(UA.androidTablet);
    expect(parsed.deviceType).toBe("Tablet");
    expect(parsed.device).toBe("SM-X906C");
  });

  it("detects Edge before Chrome", () => {
    const parsed = parseUserAgent(UA.edgeWindows);
    expect(parsed.browser).toBe("Edge");
    expect(parsed.browserVersion).toBe("120.0.2210.91");
  });

  it("detects Opera before Chrome", () => {
    const parsed = parseUserAgent(UA.operaMac);
    expect(parsed.browser).toBe("Opera");
    expect(parsed.browserVersion).toBe("106.0.0.0");
  });

  it("detects Samsung Internet before Chrome", () => {
    const parsed = parseUserAgent(UA.samsungInternet);
    expect(parsed.browser).toBe("Samsung Internet");
    expect(parsed.browserVersion).toBe("23.0");
  });

  it("parses Firefox on Linux", () => {
    expect(parseUserAgent(UA.firefoxLinux)).toEqual({
      browser: "Firefox",
      browserVersion: "119.0",
      os: "Linux",
      deviceType: "Desktop",
    });
  });

  it("returns only a device type for an empty UA", () => {
    expect(parseUserAgent("")).toEqual({ deviceType: "Desktop" });
  });
});

describe("collectAutoContext", () => {
  it("includes lib metadata and environment context", () => {
    const context = collectAutoContext();
    expect(context.$lib).toBe("galinum-react");
    expect(context.$lib_version).toBe(SDK_VERSION);
    expect(context.$device_type).toBeDefined();
    expect(typeof context.$timezone).toBe("string");
    expect(typeof context.$language).toBe("string");
  });

  it("only emits $-prefixed keys", () => {
    for (const key of Object.keys(collectAutoContext())) {
      expect(key.startsWith("$")).toBe(true);
    }
  });
});

describe("collectEventContext", () => {
  it("captures the current page", () => {
    expect(collectEventContext()).toEqual({
      $current_url: "https://app.customer.test/dashboard",
      $pathname: "/dashboard",
    });
  });
});
