import { describe, it, expect } from "vitest";
import {
  matches,
  parseTargeting,
  validateTargeting,
  type UserFacts,
} from "./targeting.js";

const user = (
  traits: Record<string, unknown> = {},
  events: string[] = [],
): UserFacts => ({ traits, eventNames: new Set(events) });

describe("matches", () => {
  it("null targeting matches everyone", () => {
    expect(matches(user(), null)).toBe(true);
  });

  it("empty targeting matches everyone", () => {
    expect(matches(user(), {})).toBe(true);
  });

  it("matches on trait equality", () => {
    expect(matches(user({ plan: "free" }), { traits: { plan: "free" } })).toBe(true);
    expect(matches(user({ plan: "pro" }), { traits: { plan: "free" } })).toBe(false);
  });

  it("requires all traits to match", () => {
    const t = { traits: { plan: "free", country: "US" } };
    expect(matches(user({ plan: "free", country: "US" }), t)).toBe(true);
    expect(matches(user({ plan: "free", country: "CA" }), t)).toBe(false);
  });

  it("distinguishes types (number vs string)", () => {
    expect(matches(user({ n: 3 }), { traits: { n: 3 } })).toBe(true);
    expect(matches(user({ n: "3" }), { traits: { n: 3 } })).toBe(false);
  });

  it("requires all 'seen' events", () => {
    const t = { events: { seen: ["signup", "activated"] } };
    expect(matches(user({}, ["signup", "activated"]), t)).toBe(true);
    expect(matches(user({}, ["signup"]), t)).toBe(false);
  });

  it("excludes users who fired a 'not_seen' event", () => {
    const t = { events: { not_seen: ["purchased"] } };
    expect(matches(user({}, ["signup"]), t)).toBe(true);
    expect(matches(user({}, ["purchased"]), t)).toBe(false);
  });

  it("combines traits and events", () => {
    const t = { traits: { plan: "free" }, events: { seen: ["signup"], not_seen: ["upgraded"] } };
    expect(matches(user({ plan: "free" }, ["signup"]), t)).toBe(true);
    expect(matches(user({ plan: "free" }, ["signup", "upgraded"]), t)).toBe(false);
    expect(matches(user({ plan: "pro" }, ["signup"]), t)).toBe(false);
  });
});

describe("parseTargeting", () => {
  it("returns null for null/invalid json", () => {
    expect(parseTargeting(null)).toBeNull();
    expect(parseTargeting("not json")).toBeNull();
  });

  it("parses a valid object", () => {
    expect(parseTargeting('{"traits":{"plan":"free"}}')).toEqual({ traits: { plan: "free" } });
  });
});

describe("validateTargeting", () => {
  it("treats empty input as match-everyone", () => {
    expect(validateTargeting("")).toEqual({ ok: true, targeting: null });
    expect(validateTargeting("  \n")).toEqual({ ok: true, targeting: null });
    expect(validateTargeting("{}")).toEqual({ ok: true, targeting: null });
  });

  it("accepts valid traits and events", () => {
    const result = validateTargeting(
      '{"traits":{"plan":"free","n":3,"beta":true},"events":{"seen":["signup"],"not_seen":["upgraded"]}}',
    );
    expect(result).toEqual({
      ok: true,
      targeting: {
        traits: { plan: "free", n: 3, beta: true },
        events: { seen: ["signup"], not_seen: ["upgraded"] },
      },
    });
  });

  it("rejects invalid json and non-objects", () => {
    expect(validateTargeting("not json").ok).toBe(false);
    expect(validateTargeting("[1,2]").ok).toBe(false);
    expect(validateTargeting('"hi"').ok).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(validateTargeting('{"segments":["a"]}').ok).toBe(false);
    expect(validateTargeting('{"events":{"fired":["x"]}}').ok).toBe(false);
  });

  it("rejects malformed traits and event lists", () => {
    expect(validateTargeting('{"traits":{"plan":{"deep":1}}}').ok).toBe(false);
    expect(validateTargeting('{"traits":["plan"]}').ok).toBe(false);
    expect(validateTargeting('{"events":{"seen":"signup"}}').ok).toBe(false);
    expect(validateTargeting('{"events":{"seen":[""]}}').ok).toBe(false);
    expect(validateTargeting('{"events":{"seen":[42]}}').ok).toBe(false);
  });
});
