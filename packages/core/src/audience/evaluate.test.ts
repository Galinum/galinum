import { describe, expect, it } from "vitest";
import {
  evaluateExpression,
  explainExpression,
  type UserAudienceFacts,
} from "./evaluate.js";
import { validateExpression, type ExpressionNode } from "./expression.js";
import { matches, type Targeting, type UserFacts } from "../targeting.js";
import { legacyTargetingToExpression } from "./legacy.js";

const NOW = 1785800000000; // 2026-08-04T04:53:20Z
const DAY = 86_400_000;

function root(input: unknown): ExpressionNode {
  const result = validateExpression({ version: 1, root: input });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.expression.root;
}

const facts = (overrides: Partial<UserAudienceFacts> = {}): UserAudienceFacts => ({
  traits: {},
  firstSeenAt: NOW - 30 * DAY,
  lastSeenAt: NOW - DAY,
  events: [],
  ...overrides,
});

const field = (key: string, op: string, value?: unknown) => ({
  kind: "field",
  field: { kind: "trait", key },
  op,
  ...(value !== undefined ? { value } : {}),
});

describe("evaluateExpression: field semantics", () => {
  it("strict equality without coercion", () => {
    const node = root(field("plan", "eq", "free"));
    expect(evaluateExpression(node, facts({ traits: { plan: "free" } }), NOW)).toBe(true);
    expect(evaluateExpression(node, facts({ traits: { plan: "pro" } }), NOW)).toBe(false);
    expect(evaluateExpression(node, facts({ traits: {} }), NOW)).toBe(false);
    // "1" !== 1: no coercion.
    expect(evaluateExpression(root(field("n", "eq", 1)), facts({ traits: { n: "1" } }), NOW)).toBe(false);
  });

  it("neq requires presence and compatible type", () => {
    const node = root(field("plan", "neq", "free"));
    expect(evaluateExpression(node, facts({ traits: { plan: "pro" } }), NOW)).toBe(true);
    // Absent field: value comparisons never match, even neq.
    expect(evaluateExpression(node, facts(), NOW)).toBe(false);
    // Type mismatch: fails, not "technically not equal".
    expect(evaluateExpression(node, facts({ traits: { plan: 5 } }), NOW)).toBe(false);
  });

  it("exists / not_exists handle absence explicitly (null counts as absent)", () => {
    expect(evaluateExpression(root(field("a", "exists")), facts({ traits: { a: 0 } }), NOW)).toBe(true);
    expect(evaluateExpression(root(field("a", "exists")), facts({ traits: { a: null } }), NOW)).toBe(false);
    expect(evaluateExpression(root(field("a", "not_exists")), facts(), NOW)).toBe(true);
  });

  it("in / not_in are typed set membership", () => {
    expect(evaluateExpression(root(field("c", "in", ["AR", "UY"])), facts({ traits: { c: "AR" } }), NOW)).toBe(true);
    expect(evaluateExpression(root(field("c", "not_in", ["AR"])), facts({ traits: { c: "BR" } }), NOW)).toBe(true);
    // Absent → no match either way; type mismatch → no match.
    expect(evaluateExpression(root(field("c", "not_in", ["AR"])), facts(), NOW)).toBe(false);
    expect(evaluateExpression(root(field("c", "in", [1, 2])), facts({ traits: { c: "1" } }), NOW)).toBe(false);
  });

  it("string operators", () => {
    expect(evaluateExpression(root(field("e", "contains", "@acme")), facts({ traits: { e: "a@acme.io" } }), NOW)).toBe(true);
    expect(evaluateExpression(root(field("e", "starts_with", "a@")), facts({ traits: { e: "a@acme.io" } }), NOW)).toBe(true);
    expect(evaluateExpression(root(field("e", "ends_with", ".io")), facts({ traits: { e: "a@acme.io" } }), NOW)).toBe(true);
    expect(evaluateExpression(root(field("e", "contains", "x")), facts({ traits: { e: 42 } }), NOW)).toBe(false);
  });

  it("numeric comparisons", () => {
    expect(evaluateExpression(root(field("n", "gte", 5)), facts({ traits: { n: 5 } }), NOW)).toBe(true);
    expect(evaluateExpression(root(field("n", "lt", 5)), facts({ traits: { n: 4.5 } }), NOW)).toBe(true);
    expect(evaluateExpression(root(field("n", "gt", 5)), facts({ traits: { n: "6" } }), NOW)).toBe(false);
  });

  it("boolean comparison", () => {
    expect(evaluateExpression(root(field("beta", "eq", true)), facts({ traits: { beta: true } }), NOW)).toBe(true);
    expect(evaluateExpression(root(field("beta", "eq", true)), facts({ traits: { beta: "true" } }), NOW)).toBe(false);
  });

  it("datetime: before/after on lifecycle fields and trait timestamps", () => {
    const lastSeen = { kind: "field", field: { kind: "user", field: "lastSeenAt" }, op: "after", value: "2026-01-01T00:00:00Z" };
    expect(evaluateExpression(root(lastSeen), facts(), NOW)).toBe(true);
    // Trait holding an ISO string is interpreted explicitly.
    const trial = field("trialEndsAt", "before", "2026-08-10T00:00:00Z");
    expect(evaluateExpression(root(trial), facts({ traits: { trialEndsAt: "2026-08-01T00:00:00Z" } }), NOW)).toBe(true);
    // Non-datetime observed value fails closed.
    expect(evaluateExpression(root(trial), facts({ traits: { trialEndsAt: "soon" } }), NOW)).toBe(false);
  });

  it("within_last uses the shared evaluatedAt", () => {
    const node = root({
      kind: "field",
      field: { kind: "user", field: "lastSeenAt" },
      op: "within_last",
      value: { amount: 2, unit: "days" },
    });
    expect(evaluateExpression(node, facts({ lastSeenAt: NOW - DAY }), NOW)).toBe(true);
    expect(evaluateExpression(node, facts({ lastSeenAt: NOW - 3 * DAY }), NOW)).toBe(false);
    // not_within_last is the complement.
    const inverse = root({
      kind: "field",
      field: { kind: "user", field: "firstSeenAt" },
      op: "not_within_last",
      value: { amount: 7, unit: "days" },
    });
    expect(evaluateExpression(inverse, facts({ firstSeenAt: NOW - 30 * DAY }), NOW)).toBe(true);
  });
});

describe("evaluateExpression: event semantics", () => {
  const event = (name: string, ts: number, props: Record<string, unknown> | null = null) => ({ name, ts, props });

  it("defaults to at-least-once", () => {
    const node = root({ kind: "event", event: "signup" });
    expect(evaluateExpression(node, facts({ events: [event("signup", NOW - DAY)] }), NOW)).toBe(true);
    expect(evaluateExpression(node, facts(), NOW)).toBe(false);
  });

  it("occurrence counts", () => {
    const node = root({ kind: "event", event: "export", count: { op: "gte", value: 3 } });
    const three = [event("export", NOW - 1), event("export", NOW - 2), event("export", NOW - 3)];
    expect(evaluateExpression(node, facts({ events: three }), NOW)).toBe(true);
    expect(evaluateExpression(node, facts({ events: three.slice(0, 2) }), NOW)).toBe(false);
    const zero = root({ kind: "event", event: "export", count: { op: "eq", value: 0 } });
    expect(evaluateExpression(zero, facts(), NOW)).toBe(true);
  });

  it("relative windows exclude older occurrences and future rows", () => {
    const node = root({ kind: "event", event: "visit", window: { amount: 7, unit: "days" } });
    expect(evaluateExpression(node, facts({ events: [event("visit", NOW - 8 * DAY)] }), NOW)).toBe(false);
    expect(evaluateExpression(node, facts({ events: [event("visit", NOW - 6 * DAY)] }), NOW)).toBe(true);
    expect(evaluateExpression(node, facts({ events: [event("visit", NOW + DAY)] }), NOW)).toBe(false);
  });

  it("event-property where conditions filter occurrences", () => {
    const node = root({
      kind: "event",
      event: "export",
      count: { op: "gte", value: 2 },
      where: [{ kind: "field", field: { kind: "event_property", key: "format" }, op: "eq", value: "csv" }],
    });
    const events = [
      event("export", NOW - 1, { format: "csv" }),
      event("export", NOW - 2, { format: "pdf" }),
      event("export", NOW - 3, { format: "csv" }),
      event("export", NOW - 4, null),
    ];
    expect(evaluateExpression(node, facts({ events }), NOW)).toBe(true);
    expect(evaluateExpression(node, facts({ events: events.slice(1) }), NOW)).toBe(false);
  });
});

describe("evaluateExpression: composition", () => {
  it("all / any / not nest arbitrarily", () => {
    const node = root({
      kind: "all",
      children: [
        field("plan", "eq", "free"),
        {
          kind: "any",
          children: [
            { kind: "event", event: "export" },
            { kind: "not", child: { kind: "event", event: "onboarded" } },
          ],
        },
      ],
    });
    expect(evaluateExpression(node, facts({ traits: { plan: "free" } }), NOW)).toBe(true); // via not(onboarded)
    expect(
      evaluateExpression(node, facts({ traits: { plan: "free" }, events: [{ name: "onboarded", ts: NOW - 1, props: null }] }), NOW),
    ).toBe(false);
  });
});

describe("legacy targeting equivalence", () => {
  // The translated expression must match exactly what matches() decides for
  // the same user facts, for every legacy shape.
  const cases: { targeting: Targeting; users: { traits: Record<string, unknown>; eventNames: string[] }[] }[] = [
    {
      targeting: { traits: { plan: "free", beta: true } },
      users: [
        { traits: { plan: "free", beta: true }, eventNames: [] },
        { traits: { plan: "free" }, eventNames: [] },
        { traits: { plan: "free", beta: "true" }, eventNames: [] },
      ],
    },
    {
      targeting: { events: { seen: ["signup"], not_seen: ["churned"] } },
      users: [
        { traits: {}, eventNames: ["signup"] },
        { traits: {}, eventNames: ["signup", "churned"] },
        { traits: {}, eventNames: [] },
      ],
    },
    {
      targeting: { traits: { n: 5 }, events: { seen: ["a", "b"] } },
      users: [
        { traits: { n: 5 }, eventNames: ["a", "b"] },
        { traits: { n: "5" }, eventNames: ["a", "b"] },
        { traits: { n: 5 }, eventNames: ["a"] },
      ],
    },
  ];

  it("matches() and the translated expression agree", () => {
    for (const { targeting, users } of cases) {
      const expression = legacyTargetingToExpression(targeting);
      expect(expression).not.toBeNull();
      const validated = validateExpression(expression);
      expect(validated.ok).toBe(true);
      if (!validated.ok) continue;
      for (const user of users) {
        const legacyFacts: UserFacts = { traits: user.traits, eventNames: new Set(user.eventNames) };
        const audienceFacts = facts({
          traits: user.traits,
          events: user.eventNames.map((name) => ({ name, ts: NOW - 1, props: null })),
        });
        expect(evaluateExpression(validated.expression.root, audienceFacts, NOW)).toBe(
          matches(legacyFacts, targeting),
        );
      }
    }
  });

  it("empty targeting translates to null (everyone)", () => {
    expect(legacyTargetingToExpression(null)).toBeNull();
    expect(legacyTargetingToExpression({})).toBeNull();
    expect(legacyTargetingToExpression({ traits: {}, events: {} })).toBeNull();
  });

  it("legacy rules wider than the group limit chunk into nested all-groups", () => {
    // Legacy stored rules had no width cap, so the
    // translation must stay valid however wide the stored rule is.
    const traits = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t${i}`, `v${i}`]));
    const seen = Array.from({ length: 20 }, (_, i) => `e${i}`);
    const expression = legacyTargetingToExpression({ traits, events: { seen } });
    expect(expression).not.toBeNull();
    const validated = validateExpression(expression);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    // Semantics preserved: all conditions AND together.
    const matchingFacts = facts({
      traits,
      events: seen.map((name) => ({ name, ts: NOW - 1, props: null })),
    });
    expect(evaluateExpression(validated.expression.root, matchingFacts, NOW)).toBe(true);
    const missingOne = facts({
      traits,
      events: seen.slice(1).map((name) => ({ name, ts: NOW - 1, props: null })),
    });
    expect(evaluateExpression(validated.expression.root, missingOne, NOW)).toBe(false);
  });
});

describe("explainExpression", () => {
  it("returns a trace mirroring the tree with evidence", () => {
    const node = root({
      kind: "all",
      children: [
        field("plan", "eq", "free"),
        { kind: "event", event: "export", window: { amount: 7, unit: "days" } },
      ],
    });
    const trace = explainExpression(
      node,
      facts({ traits: { plan: "pro" }, events: [{ name: "export", ts: NOW - DAY, props: null }] }),
      NOW,
    );
    expect(trace.matched).toBe(false);
    expect(trace.path).toBe("/root");
    expect(trace.children).toHaveLength(2);

    const [fieldTrace, eventTrace] = trace.children ?? [];
    expect(fieldTrace.path).toBe("/root/children/0");
    expect(fieldTrace.matched).toBe(false);
    expect(fieldTrace.observed).toBe("pro");
    expect(fieldTrace.observedType).toBe("string");

    expect(eventTrace.path).toBe("/root/children/1");
    expect(eventTrace.matched).toBe(true);
    expect(eventTrace.occurrences).toBe(1);
    expect(eventTrace.required).toEqual({ op: "gte", value: 1 });
    expect(eventTrace.windowCutoff).toBe(NOW - 7 * DAY);
  });

  it("notes absence and type mismatches", () => {
    const absent = explainExpression(root(field("plan", "eq", "free")), facts(), NOW);
    expect(absent.matched).toBe(false);
    expect(absent.note).toBe("field is absent");
    expect(absent.observedType).toBe("absent");

    const mismatch = explainExpression(root(field("n", "gt", 5)), facts({ traits: { n: "6" } }), NOW);
    expect(mismatch.note).toBe("type mismatch: expected number");
  });

  it("bounds evidence for long strings and objects", () => {
    const long = "x".repeat(500);
    const trace = explainExpression(root(field("bio", "eq", "short")), facts({ traits: { bio: long } }), NOW);
    expect((trace.observed as string).length).toBeLessThan(130);
    const objectTrace = explainExpression(root(field("meta", "exists")), facts({ traits: { meta: { a: 1 } } }), NOW);
    expect(objectTrace.observed).toBe("[object]");
  });
});
