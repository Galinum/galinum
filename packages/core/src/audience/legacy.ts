// Deterministic translation of the legacy targeting shape (strict trait
// equality + events.seen/not_seen, all ANDed) into an audience expression.
// Matching behavior is preserved exactly: trait equality is strict-equality,
// seen = at least one occurrence ever, not_seen = zero occurrences ever.
// Legacy shapes remain accepted as deprecated shorthand on campaign writes
// and are normalized through this translation.

import type { Targeting } from "../targeting.js";
import {
  AUDIENCE_SCHEMA_VERSION,
  LIMITS,
  type AudienceExpression,
  type ExpressionNode,
} from "./expression.js";

// Null targeting means everyone → null expression (no audience version).
export function legacyTargetingToExpression(targeting: Targeting | null): AudienceExpression | null {
  if (!targeting) return null;
  const children: ExpressionNode[] = [];

  for (const [key, value] of Object.entries(targeting.traits ?? {})) {
    children.push({ kind: "field", field: { kind: "trait", key }, op: "eq", value });
  }
  for (const name of targeting.events?.seen ?? []) {
    children.push({ kind: "event", event: name });
  }
  for (const name of targeting.events?.not_seen ?? []) {
    children.push({ kind: "not", child: { kind: "event", event: name } });
  }

  if (children.length === 0) return null;
  return { version: AUDIENCE_SCHEMA_VERSION, root: allOf(children) };
}

// The legacy shape never bounded its condition count, but expression groups
// cap their width. `all` is associative, so wide legacy rules chunk into
// nested all-groups with identical semantics instead of failing validation.
function allOf(children: ExpressionNode[]): ExpressionNode {
  if (children.length === 1) return children[0];
  if (children.length <= LIMITS.maxGroupChildren) return { kind: "all", children };
  const chunks: ExpressionNode[] = [];
  for (let i = 0; i < children.length; i += LIMITS.maxGroupChildren) {
    chunks.push({ kind: "all", children: children.slice(i, i + LIMITS.maxGroupChildren) });
  }
  return allOf(chunks);
}
