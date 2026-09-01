import { describe, expect, it } from "vitest";
import { currentPath, matchesPagePattern, matchesPages, normalizePath } from "./pages.js";

describe("normalizePath", () => {
  it("drops query strings and hashes", () => {
    expect(normalizePath("/pricing?ref=x")).toBe("/pricing");
    expect(normalizePath("/pricing#plans")).toBe("/pricing");
  });

  it("removes a trailing slash except on the root", () => {
    expect(normalizePath("/settings/")).toBe("/settings");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
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
  it("matches everywhere when pages is null or absent", () => {
    expect(matchesPages(null, "/anything")).toBe(true);
    expect(matchesPages(undefined, "/anything")).toBe(true);
  });

  it("matches nowhere for the server's fail-closed empty list", () => {
    expect(matchesPages([], "/anything")).toBe(false);
  });

  it("matches when any pattern matches", () => {
    expect(matchesPages(["/a", "/b/*"], "/b/c")).toBe(true);
    expect(matchesPages(["/a", "/b/*"], "/c")).toBe(false);
  });
});

describe("currentPath", () => {
  it("reads the normalized pathname of the host page", () => {
    expect(currentPath()).toBe("/dashboard");
  });
});
