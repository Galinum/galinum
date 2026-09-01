// Check, explain, and message
// eligibility all call `evaluateNode` on the same fact shape, so their
// semantics cannot drift. Pure and dependency-free; fact gathering lives in
// facts.ts.

import {
  parseIsoInstant,
  WINDOW_UNIT_MS,
  type CountOperator,
  type EventNode,
  type ExpressionNode,
  type FieldNode,
  type RelativeWindow,
} from "./expression.js";

// What evaluation needs to know about one user. `events` carries only
// occurrences of event names the expression references.
export type EventOccurrence = {
  name: string;
  ts: number;
  props: Record<string, unknown> | null;
};

export type UserAudienceFacts = {
  traits: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
  events: EventOccurrence[];
};

// --- Evaluation -----------------------------------------------------------------

export function evaluateExpression(
  root: ExpressionNode,
  facts: UserAudienceFacts,
  evaluatedAt: number,
): boolean {
  return evaluateNode(root, facts, evaluatedAt);
}

function evaluateNode(node: ExpressionNode, facts: UserAudienceFacts, evaluatedAt: number): boolean {
  switch (node.kind) {
    case "all":
      return node.children.every((child) => evaluateNode(child, facts, evaluatedAt));
    case "any":
      return node.children.some((child) => evaluateNode(child, facts, evaluatedAt));
    case "not":
      return !evaluateNode(node.child, facts, evaluatedAt);
    case "field":
      return evaluateField(node, fieldValue(node, facts), evaluatedAt).matched;
    case "event":
      return evaluateEvent(node, facts, evaluatedAt).matched;
  }
}

// Resolves the observed value a field node compares against. `undefined`
// means absent (traits) — lifecycle fields always exist.
function fieldValue(node: FieldNode, facts: UserAudienceFacts): unknown {
  switch (node.field.kind) {
    case "trait":
      return facts.traits[node.field.key];
    case "user":
      return node.field.field === "firstSeenAt" ? facts.firstSeenAt : facts.lastSeenAt;
    case "event_property":
      // Only reachable through evaluateEvent, which resolves props itself.
      return undefined;
  }
}

type FieldOutcome = {
  matched: boolean;
  // Compact evidence for explain traces.
  observed: unknown;
  observedType: string;
  note?: string;
};

function typeOf(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// Strict comparison semantics: no coercion; a value comparison on an absent
// or type-incompatible field simply does not match (exists/not_exists is the
// explicit way to talk about absence).
export function evaluateField(node: FieldNode, observed: unknown, evaluatedAt: number): FieldOutcome {
  const observedType = typeOf(observed);
  const base = { observed: boundedEvidence(observed), observedType };

  switch (node.op) {
    case "exists":
      return { ...base, matched: observed !== undefined && observed !== null };
    case "not_exists":
      return { ...base, matched: observed === undefined || observed === null };
  }

  if (observed === undefined || observed === null) {
    return { ...base, matched: false, note: "field is absent" };
  }

  switch (node.op) {
    case "eq":
    case "neq": {
      const want = node.value as string | number | boolean;
      if (typeof observed !== typeof want) {
        return { ...base, matched: node.op === "neq" ? false : false, note: `type mismatch: expected ${typeof want}` };
      }
      const equal = observed === want;
      return { ...base, matched: node.op === "eq" ? equal : !equal };
    }
    case "in":
    case "not_in": {
      const list = node.value as (string | number)[];
      if (typeof observed !== "string" && typeof observed !== "number") {
        return { ...base, matched: false, note: "type mismatch: expected string or number" };
      }
      if (typeof list[0] !== typeof observed) {
        return { ...base, matched: false, note: `type mismatch: expected ${typeof list[0]}` };
      }
      const member = list.includes(observed as string | number);
      return { ...base, matched: node.op === "in" ? member : !member };
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      if (typeof observed !== "string") {
        return { ...base, matched: false, note: "type mismatch: expected string" };
      }
      const want = node.value as string;
      const matched =
        node.op === "contains"
          ? observed.includes(want)
          : node.op === "starts_with"
            ? observed.startsWith(want)
            : observed.endsWith(want);
      return { ...base, matched };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof observed !== "number" || !Number.isFinite(observed)) {
        return { ...base, matched: false, note: "type mismatch: expected number" };
      }
      const want = node.value as number;
      const matched =
        node.op === "gt"
          ? observed > want
          : node.op === "gte"
            ? observed >= want
            : node.op === "lt"
              ? observed < want
              : observed <= want;
      return { ...base, matched };
    }
    case "before":
    case "after": {
      const observedTs = asInstant(observed);
      if (observedTs === null) {
        return { ...base, matched: false, note: "not a date-time: expected epoch milliseconds or an ISO-8601 string" };
      }
      const boundary = parseIsoInstant(node.value as string) as number;
      return { ...base, matched: node.op === "before" ? observedTs < boundary : observedTs > boundary };
    }
    case "within_last":
    case "not_within_last": {
      const observedTs = asInstant(observed);
      if (observedTs === null) {
        return { ...base, matched: false, note: "not a date-time: expected epoch milliseconds or an ISO-8601 string" };
      }
      const window = node.value as RelativeWindow;
      const cutoff = evaluatedAt - window.amount * WINDOW_UNIT_MS[window.unit];
      const within = observedTs >= cutoff && observedTs <= evaluatedAt;
      return { ...base, matched: node.op === "within_last" ? within : !within };
    }
    default:
      // Unknown operator on a persisted expression: fail closed.
      return { ...base, matched: false, note: `unsupported operator ${node.op}` };
  }
}

// Explicit date-time interpretation: epoch milliseconds (safe-integer range,
// above the epoch-seconds trap handled at authoring time for literals) or a
// full ISO-8601 instant string.
function asInstant(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") return parseIsoInstant(value);
  return null;
}

type EventOutcome = {
  matched: boolean;
  occurrences: number;
  required: { op: CountOperator; value: number };
  windowCutoff: number | null;
};

export function evaluateEvent(
  node: EventNode,
  facts: UserAudienceFacts,
  evaluatedAt: number,
): EventOutcome {
  const count = node.count ?? { op: "gte" as const, value: 1 };
  const cutoff = node.window
    ? evaluatedAt - node.window.amount * WINDOW_UNIT_MS[node.window.unit]
    : null;

  let occurrences = 0;
  for (const occurrence of facts.events) {
    if (occurrence.name !== node.event) continue;
    if (occurrence.ts > evaluatedAt) continue; // future rows never count
    if (cutoff !== null && occurrence.ts < cutoff) continue;
    if (node.where && !node.where.every((condition) => whereMatches(condition, occurrence, evaluatedAt))) {
      continue;
    }
    occurrences += 1;
  }

  return {
    matched: compareCount(occurrences, count.op, count.value),
    occurrences,
    required: count,
    windowCutoff: cutoff,
  };
}

function whereMatches(condition: FieldNode, occurrence: EventOccurrence, evaluatedAt: number): boolean {
  const key = condition.field.kind === "event_property" ? condition.field.key : null;
  const observed = key !== null && occurrence.props ? occurrence.props[key] : undefined;
  return evaluateField(condition, observed, evaluatedAt).matched;
}

function compareCount(actual: number, op: CountOperator, want: number): boolean {
  switch (op) {
    case "eq":
      return actual === want;
    case "neq":
      return actual !== want;
    case "gt":
      return actual > want;
    case "gte":
      return actual >= want;
    case "lt":
      return actual < want;
    case "lte":
      return actual <= want;
  }
}

// --- Explain trace -----------------------------------------------------------------

// Mirrors the expression tree with per-node matched state and compact
// evidence. Paths are JSON Pointers into the canonical expression document
// (starting at /root), matching check diagnostics.
export type TraceNode = {
  path: string;
  kind: ExpressionNode["kind"];
  matched: boolean;
  // field nodes
  field?: FieldNode["field"];
  op?: string;
  observed?: unknown;
  observedType?: string;
  note?: string;
  // event nodes
  event?: string;
  occurrences?: number;
  required?: { op: CountOperator; value: number };
  windowCutoff?: number | null;
  // group / not nodes
  children?: TraceNode[];
  child?: TraceNode;
};

export function explainExpression(
  root: ExpressionNode,
  facts: UserAudienceFacts,
  evaluatedAt: number,
): TraceNode {
  return trace(root, "/root", facts, evaluatedAt);
}

function trace(
  node: ExpressionNode,
  path: string,
  facts: UserAudienceFacts,
  evaluatedAt: number,
): TraceNode {
  switch (node.kind) {
    case "all":
    case "any": {
      const children = node.children.map((child, index) =>
        trace(child, `${path}/children/${index}`, facts, evaluatedAt),
      );
      const matched =
        node.kind === "all" ? children.every((c) => c.matched) : children.some((c) => c.matched);
      return { path, kind: node.kind, matched, children };
    }
    case "not": {
      const child = trace(node.child, `${path}/child`, facts, evaluatedAt);
      return { path, kind: "not", matched: !child.matched, child };
    }
    case "field": {
      const outcome = evaluateField(node, fieldValue(node, facts), evaluatedAt);
      return {
        path,
        kind: "field",
        matched: outcome.matched,
        field: node.field,
        op: node.op,
        observed: outcome.observed,
        observedType: outcome.observedType,
        ...(outcome.note ? { note: outcome.note } : {}),
      };
    }
    case "event": {
      const outcome = evaluateEvent(node, facts, evaluatedAt);
      return {
        path,
        kind: "event",
        matched: outcome.matched,
        event: node.event,
        occurrences: outcome.occurrences,
        required: outcome.required,
        windowCutoff: outcome.windowCutoff,
      };
    }
  }
}

// Evidence stays compact: long strings are truncated and objects/arrays are
// reported by type only, so traces and samples never dump raw payloads.
const MAX_EVIDENCE_STRING = 120;

function boundedEvidence(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_EVIDENCE_STRING) {
    return `${value.slice(0, MAX_EVIDENCE_STRING)}…`;
  }
  if (Array.isArray(value)) return "[array]";
  if (value !== null && typeof value === "object") return "[object]";
  return value;
}
