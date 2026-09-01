import { describe, expect, it } from "vitest";
import {
  AUDIENCE_SCHEMA_VERSION,
  canonicalizeExpression,
  expressionHash,
  LIMITS,
  nearest,
  referencedVocabulary,
  summarizeExpression,
  validateExpression,
  type AudienceExpression,
  type ExpressionNode,
} from "./expression.js";

const expr = (root: unknown) => ({ version: 1, root });
const field = (key: string, op: string, value?: unknown) => ({
  kind: "field",
  field: { kind: "trait", key },
  op,
  ...(value !== undefined ? { value } : {}),
});

function valid(input: unknown): AudienceExpression {
  const result = validateExpression(input);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.expression;
}

function firstError(input: unknown): { code: string; path: string } {
  const result = validateExpression(input);
  if (result.ok) throw new Error("expected validation failure");
  const diagnostic = result.diagnostics.find((d) => d.severity === "error");
  if (!diagnostic) throw new Error("no error diagnostic");
  return { code: diagnostic.code, path: diagnostic.path };
}

describe("validateExpression", () => {
  it("accepts a full nested expression", () => {
    const expression = valid(
      expr({
        kind: "all",
        children: [
          field("plan", "eq", "free"),
          { kind: "any", children: [field("country", "in", ["AR", "UY"]), field("beta", "eq", true)] },
          {
            kind: "not",
            child: {
              kind: "event",
              event: "upgraded",
              count: { op: "gte", value: 2 },
              window: { amount: 30, unit: "days" },
              where: [
                { kind: "field", field: { kind: "event_property", key: "plan" }, op: "eq", value: "pro" },
              ],
            },
          },
          { kind: "field", field: { kind: "user", field: "firstSeenAt" }, op: "within_last", value: { amount: 7, unit: "days" } },
        ],
      }),
    );
    expect(expression.version).toBe(AUDIENCE_SCHEMA_VERSION);
  });

  it("rejects non-object documents and missing root", () => {
    expect(firstError("nope").code).toBe("expression_not_object");
    expect(firstError({ version: 1 }).code).toBe("missing_root");
  });

  it("rejects unsupported versions", () => {
    expect(firstError({ version: 2, root: field("a", "exists") }).code).toBe("unsupported_version");
  });

  it("rejects unknown node kinds with a path", () => {
    const error = firstError(expr({ kind: "xor", children: [] }));
    expect(error.code).toBe("unknown_node_kind");
    expect(error.path).toBe("/root/kind");
  });

  it("rejects empty groups", () => {
    expect(firstError(expr({ kind: "all", children: [] })).code).toBe("empty_group");
    expect(firstError(expr({ kind: "any", children: [] })).code).toBe("empty_group");
  });

  it("rejects unknown keys on any node", () => {
    expect(firstError(expr({ kind: "all", children: [field("a", "exists")], extra: 1 })).code).toBe(
      "unknown_key",
    );
  });

  it("enforces depth and node-count limits", () => {
    let node: unknown = field("a", "exists");
    for (let i = 0; i < LIMITS.maxDepth + 1; i++) node = { kind: "not", child: node };
    expect(firstError(expr(node)).code).toBe("too_deep");

    const wide = {
      kind: "all",
      children: Array.from({ length: LIMITS.maxGroupChildren + 1 }, () => field("a", "exists")),
    };
    expect(firstError(expr(wide)).code).toBe("too_many_children");
  });

  it("rejects unknown operators with suggestions", () => {
    const result = validateExpression(expr(field("plan", "equals", "x")));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = result.diagnostics[0];
      expect(diagnostic.code).toBe("unknown_operator");
      expect(diagnostic.path).toBe("/root/op");
    }
  });

  it("rejects value type mismatches per operator", () => {
    expect(firstError(expr(field("a", "gt", "10"))).code).toBe("invalid_value");
    expect(firstError(expr(field("a", "contains", 5))).code).toBe("invalid_value");
    expect(firstError(expr(field("a", "in", []))).code).toBe("invalid_value");
    expect(firstError(expr(field("a", "in", ["x", 1]))).code).toBe("invalid_value");
    expect(firstError(expr(field("a", "eq", null))).code).toBe("invalid_value");
    expect(firstError(expr(field("a", "eq"))).code).toBe("missing_value");
    expect(firstError(expr(field("a", "exists", true))).code).toBe("unexpected_value");
  });

  it("rejects offsetless or impossible date-times", () => {
    expect(firstError(expr(field("a", "before", "2026-01-01"))).code).toBe("invalid_value");
    expect(firstError(expr(field("a", "before", "2026-02-31T00:00:00Z"))).code).toBe("invalid_value");
    expect(valid(expr(field("a", "before", "2026-01-01T00:00:00-03:00")))).toBeTruthy();
  });

  it("restricts lifecycle fields to datetime/existence operators", () => {
    const node = { kind: "field", field: { kind: "user", field: "lastSeenAt" }, op: "eq", value: 5 };
    expect(firstError(expr(node)).code).toBe("incompatible_operator");
  });

  it("rejects unknown lifecycle fields", () => {
    const node = { kind: "field", field: { kind: "user", field: "createdAt" }, op: "exists" };
    expect(firstError(expr(node)).code).toBe("unknown_lifecycle_field");
  });

  it("rejects event_property references outside event nodes", () => {
    const node = { kind: "field", field: { kind: "event_property", key: "plan" }, op: "exists" };
    expect(firstError(expr(node)).code).toBe("event_property_outside_event");
  });

  it("requires event where-conditions to use event_property", () => {
    const node = {
      kind: "event",
      event: "signup",
      where: [{ kind: "field", field: { kind: "trait", key: "plan" }, op: "exists" }],
    };
    expect(firstError(expr(node)).code).toBe("invalid_field_ref");
  });

  it("validates windows and counts", () => {
    expect(firstError(expr({ kind: "event", event: "x", window: { amount: 0, unit: "days" } })).code).toBe("invalid_window");
    expect(firstError(expr({ kind: "event", event: "x", window: { amount: 1, unit: "weeks" } })).code).toBe("invalid_window");
    expect(
      firstError(expr({ kind: "event", event: "x", count: { op: "gte", value: -1 } })).code,
    ).toBe("invalid_count");
    expect(
      firstError(expr({ kind: "event", event: "x", count: { op: "between", value: 1 } })).code,
    ).toBe("invalid_count");
  });
});

describe("canonicalization and hashing", () => {
  it("is stable across key order and defaults event counts", () => {
    const a = valid({
      root: { kind: "event", event: "signup" },
      version: 1,
    });
    const b = valid(expr({ event: "signup", kind: "event", count: { value: 1, op: "gte" } }));
    expect(canonicalizeExpression(a)).toBe(canonicalizeExpression(b));
    expect(expressionHash(canonicalizeExpression(a))).toBe(expressionHash(canonicalizeExpression(b)));
  });

  it("sorts and dedupes in/not_in membership lists", () => {
    const a = valid(expr(field("country", "in", ["UY", "AR", "UY"])));
    const b = valid(expr(field("country", "in", ["AR", "UY"])));
    expect(canonicalizeExpression(a)).toBe(canonicalizeExpression(b));
  });

  it("produces different hashes for different rules", () => {
    const a = valid(expr(field("plan", "eq", "free")));
    const b = valid(expr(field("plan", "eq", "pro")));
    expect(expressionHash(canonicalizeExpression(a))).not.toBe(
      expressionHash(canonicalizeExpression(b)),
    );
  });
});

describe("expression byte limits", () => {
  it("counts canonical Unicode bytes", () => {
    const result = validateExpression(expr(field("plan", "in", Array.from({ length: 50 }, (_, index) => `${index}${"😀".repeat(120)}`))));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "expression_too_large" }));
  });
});

describe("summarizeExpression", () => {
  it("renders a readable deterministic summary", () => {
    const expression = valid(
      expr({
        kind: "all",
        children: [
          field("plan", "eq", "free"),
          { kind: "not", child: { kind: "event", event: "upgraded" } },
          {
            kind: "event",
            event: "export",
            count: { op: "gte", value: 3 },
            window: { amount: 7, unit: "days" },
          },
        ],
      }),
    );
    expect(summarizeExpression(expression)).toBe(
      'trait plan is "free" and not (performed upgraded) and performed export >= 3 times in the last 7 days',
    );
  });
});

describe("referencedVocabulary", () => {
  it("collects traits, lifecycle fields, events, and event properties", () => {
    const expression = valid(
      expr({
        kind: "all",
        children: [
          field("plan", "eq", "free"),
          { kind: "field", field: { kind: "user", field: "lastSeenAt" }, op: "within_last", value: { amount: 1, unit: "days" } },
          {
            kind: "event",
            event: "export",
            where: [{ kind: "field", field: { kind: "event_property", key: "format" }, op: "eq", value: "csv" }],
          },
        ],
      }),
    );
    const vocabulary = referencedVocabulary(expression.root as ExpressionNode);
    expect([...vocabulary.traits]).toEqual(["plan"]);
    expect([...vocabulary.lifecycleFields]).toEqual(["lastSeenAt"]);
    expect([...vocabulary.events]).toEqual(["export"]);
    expect([...(vocabulary.eventProperties.get("export") ?? [])]).toEqual(["format"]);
  });
});

describe("nearest", () => {
  it("suggests close names only", () => {
    expect(nearest("signup", ["sign_up", "purchase"])).toEqual(["sign_up"]);
    expect(nearest("zzz", ["sign_up", "purchase"])).toBeUndefined();
  });
});
