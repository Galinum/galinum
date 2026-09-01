import { describe, it, expect } from "vitest";
import {
  MAX_PAGE_PATTERNS,
  matchesPagePattern,
  matchesPages,
  normalizePath,
  parseStoredPages,
  serializePages,
  validatePages,
} from "./pages.js";

describe("normalizePath", () => {
  it("drops query strings and hashes", () => {
    expect(normalizePath("/pricing?ref=x")).toBe("/pricing");
    expect(normalizePath("/pricing#plans")).toBe("/pricing");
  });

  it("removes a trailing slash except on the root", () => {
    expect(normalizePath("/settings/")).toBe("/settings");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("matchesPagePattern", () => {
  it("matches literal paths exactly", () => {
    expect(matchesPagePattern("/dashboard", "/dashboard")).toBe(true);
    expect(matchesPagePattern("/dashboard", "/dashboard/settings")).toBe(false);
  });

  it("treats * as any characters, including slashes", () => {
    expect(matchesPagePattern("/settings/*", "/settings/billing")).toBe(true);
    expect(matchesPagePattern("/settings/*", "/settings/team/members")).toBe(true);
    expect(matchesPagePattern("/settings/*", "/settings")).toBe(false);
    expect(matchesPagePattern("/*", "/anything/at/all")).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(matchesPagePattern("/Dashboard", "/dashboard")).toBe(false);
  });

  it("ignores trailing slashes, queries, and hashes on both sides", () => {
    expect(matchesPagePattern("/dashboard/", "/dashboard")).toBe(true);
    expect(matchesPagePattern("/dashboard", "/dashboard/?tab=1")).toBe(true);
    expect(matchesPagePattern("/dashboard", "/dashboard#top")).toBe(true);
  });

  it("escapes regex metacharacters in the pattern", () => {
    expect(matchesPagePattern("/a.b", "/axb")).toBe(false);
    expect(matchesPagePattern("/a.b", "/a.b")).toBe(true);
  });

  it("matches adversarial wildcard patterns in linear time", () => {
    const pattern = `/${"a*".repeat(20)}b`;
    const path = `/${"a".repeat(200)}`;
    const startedAt = Date.now();
    expect(matchesPagePattern(pattern, path)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it("handles consecutive and trailing wildcards", () => {
    expect(matchesPagePattern("/a**b", "/axyzb")).toBe(true);
    expect(matchesPagePattern("/a*", "/ab")).toBe(true);
    // `*` matches zero or more characters, so a bare trailing `*` also
    // matches the prefix itself. `/settings/*` still misses `/settings`
    // because of the literal slash.
    expect(matchesPagePattern("/a*", "/a")).toBe(true);
    expect(matchesPagePattern("/*a", "/xa")).toBe(true);
    expect(matchesPagePattern("/*", "/a")).toBe(true);
  });

  it("never lets overlapping segments match the same characters twice", () => {
    expect(matchesPagePattern("/aa*aa", "/aaa")).toBe(false);
    expect(matchesPagePattern("/aa*aa", "/aaaa")).toBe(true);
  });
});

describe("matchesPages", () => {
  it("matches everywhere when pages is null", () => {
    expect(matchesPages(null, "/anything")).toBe(true);
  });

  it("matches nowhere for an unreadable stored value (empty list)", () => {
    expect(matchesPages([], "/anything")).toBe(false);
  });

  it("matches when any pattern matches", () => {
    expect(matchesPages(["/a", "/b/*"], "/b/c")).toBe(true);
    expect(matchesPages(["/a", "/b/*"], "/c")).toBe(false);
  });
});

describe("validatePages", () => {
  it("treats absent, null, and empty input as every page", () => {
    expect(validatePages(undefined)).toEqual({ ok: true, pages: null });
    expect(validatePages(null)).toEqual({ ok: true, pages: null });
    expect(validatePages([])).toEqual({ ok: true, pages: null });
    expect(validatePages(["  "])).toEqual({ ok: true, pages: null });
  });

  it("normalizes and de-duplicates patterns", () => {
    expect(validatePages([" /a/ ", "/a", "/b"])).toEqual({ ok: true, pages: ["/a", "/b"] });
  });

  it("rejects non-arrays, non-strings, and patterns without a leading slash", () => {
    expect(validatePages("/a").ok).toBe(false);
    expect(validatePages([1]).ok).toBe(false);
    expect(validatePages(["dashboard"]).ok).toBe(false);
  });

  it("caps the pattern count and length", () => {
    expect(validatePages(Array.from({ length: MAX_PAGE_PATTERNS + 1 }, (_, i) => `/p${i}`)).ok).toBe(
      false,
    );
    expect(validatePages([`/${"x".repeat(300)}`]).ok).toBe(false);
  });
});

describe("pages storage", () => {
  it("round-trips through JSON", () => {
    expect(parseStoredPages(serializePages(["/a", "/b"]))).toEqual(["/a", "/b"]);
    expect(serializePages(null)).toBeNull();
    expect(parseStoredPages(null)).toBeNull();
  });

  it("fails closed on unreadable stored json", () => {
    expect(parseStoredPages("not json")).toEqual([]);
    expect(parseStoredPages('{"a":1}')).toEqual([]);
  });

  // Only a NULL column may widen to "every page".
  it("never widens a non-null stored value to everywhere", () => {
    expect(parseStoredPages("")).toEqual([]);
    expect(parseStoredPages("[]")).toEqual([]);
    expect(parseStoredPages("null")).toEqual([]);
    expect(parseStoredPages('["  "]')).toEqual([]);
  });

  it("revalidates stored patterns instead of trusting the strings", () => {
    expect(parseStoredPages('["*"]')).toEqual([]);
    expect(parseStoredPages('["/ok", "no-slash"]')).toEqual([]);
    expect(parseStoredPages('["/ok", 5]')).toEqual([]);
  });
});
