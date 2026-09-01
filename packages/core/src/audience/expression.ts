// Audience expression schema version 1: the canonical, strictly
// validated JSON rule an agent authors. One module owns the node/operator
// vocabulary, validation limits, canonicalization, and hashing so check,
// explain, campaign writes, and eligibility can never disagree about what an
// expression means.

import { createHash } from "node:crypto";

export const AUDIENCE_SCHEMA_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

// --- Validation limits (also published via capabilities) ---------------------

export const LIMITS = {
  maxDepth: 8, // nesting depth of all/any/not
  maxNodes: 64, // total nodes in one expression
  maxGroupChildren: 16, // children of one all/any
  maxInValues: 50, // values in an in/not_in list
  maxStringValueLength: 256, // any string literal
  maxKeyLength: 128, // trait/property key length
  maxEventNameLength: 80, // mirrors MAX_EVENT_NAME_LENGTH at write time
  maxEventPropertyConditions: 8, // where-conditions in one event node
  maxOccurrenceCount: 10_000, // count comparisons
  // Event conditions evaluate over each user's most recent occurrences of
  // the referenced event, up to this many. It exceeds maxOccurrenceCount, so
  // every count comparison stays decidable; only where-filtered conditions
  // on users with deeper single-event histories can be affected, and the
  // bound is published so agents can reason about it.
  maxEvaluatedEventOccurrences: 10_001,
  maxWindowDays: 3_650, // relative windows up to ten years
  maxExpressionBytes: 16_384, // serialized canonical form
} as const;

// --- Vocabulary ---------------------------------------------------------------

export const LIFECYCLE_FIELDS = ["firstSeenAt", "lastSeenAt"] as const;
export type LifecycleField = (typeof LIFECYCLE_FIELDS)[number];

export const STRING_OPERATORS = [
  "eq",
  "neq",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
] as const;
export const NUMBER_OPERATORS = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte"] as const;
export const BOOLEAN_OPERATORS = ["eq", "neq"] as const;
export const EXISTENCE_OPERATORS = ["exists", "not_exists"] as const;
// Date/time comparisons: absolute ISO instants or relative windows.
export const DATETIME_OPERATORS = ["before", "after", "within_last", "not_within_last"] as const;
export const COUNT_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;

export type CountOperator = (typeof COUNT_OPERATORS)[number];

export const WINDOW_UNITS = ["minutes", "hours", "days"] as const;
export type WindowUnit = (typeof WINDOW_UNITS)[number];

export const WINDOW_UNIT_MS: Record<WindowUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

// --- Node types ----------------------------------------------------------------

export type FieldRef =
  | { kind: "trait"; key: string }
  | { kind: "user"; field: LifecycleField }
  | { kind: "event_property"; key: string };

// A comparison condition against a field. `value` is typed per operator:
//   eq/neq            → string | number | boolean
//   in/not_in         → string[] | number[]
//   contains/starts_with/ends_with → string
//   gt/gte/lt/lte     → number
//   exists/not_exists → no value
//   before/after      → ISO-8601 instant string (explicit timezone)
//   within_last/not_within_last → { amount, unit } relative window
export type RelativeWindow = { amount: number; unit: WindowUnit };

export type FieldNode = {
  kind: "field";
  field: FieldRef;
  op: string;
  value?: unknown;
};

export type EventNode = {
  kind: "event";
  event: string; // literal event name
  count?: { op: CountOperator; value: number }; // default: gte 1
  window?: RelativeWindow; // only occurrences within the last N units
  where?: FieldNode[]; // event_property conditions, ANDed
};

export type GroupNode =
  | { kind: "all"; children: ExpressionNode[] }
  | { kind: "any"; children: ExpressionNode[] };

export type NotNode = { kind: "not"; child: ExpressionNode };

export type ExpressionNode = GroupNode | NotNode | FieldNode | EventNode;

export type AudienceExpression = {
  version: number;
  root: ExpressionNode;
};

// --- Diagnostics ---------------------------------------------------------------

export type DiagnosticSeverity = "error" | "warning" | "info";

export type Diagnostic = {
  severity: DiagnosticSeverity;
  code: string; // stable machine code
  path: string; // JSON Pointer into the expression document
  message: string;
  suggestions?: string[];
};

export type ValidationResult =
  | { ok: true; expression: AudienceExpression; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

// --- Helpers --------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON Pointer escaping per RFC 6901.
export function pointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

function err(path: string, code: string, message: string, suggestions?: string[]): Diagnostic {
  return { severity: "error", code, path, message, ...(suggestions ? { suggestions } : {}) };
}

// Full ISO-8601 instant with explicit timezone — same rationale as campaign
// delivery windows: no implicit-timezone dates.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

export function parseIsoInstant(value: string): number | null {
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (month < 1 || month > 12) return null;
  // Real calendar days only: Date.parse silently rolls Feb 31 into March.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  if (hour > 23 || minute > 59) return null;
  if (!Number.isNaN(second) && second > 59) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// --- Validation -------------------------------------------------------------------

type WalkState = { nodes: number; diagnostics: Diagnostic[] };

export function validateExpression(input: unknown): ValidationResult {
  const diagnostics: Diagnostic[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, diagnostics: [err("", "expression_not_object", "The expression must be a JSON object with version and root.")] };
  }
  const unknownKeys = Object.keys(input).filter((k) => k !== "version" && k !== "root");
  if (unknownKeys.length > 0) {
    diagnostics.push(
      err("", "unknown_key", `Unknown expression key "${unknownKeys[0]}". Allowed keys: version, root.`),
    );
  }
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(input.version as number)) {
    diagnostics.push(
      err(
        "/version",
        "unsupported_version",
        `Unsupported expression version. Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}.`,
      ),
    );
  }
  if (input.root === undefined) {
    diagnostics.push(err("/root", "missing_root", "The expression needs a root node."));
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const state: WalkState = { nodes: 0, diagnostics };
  const root = validateNode(input.root, "/root", 1, state);

  if (state.nodes > LIMITS.maxNodes) {
    diagnostics.push(
      err("/root", "too_many_nodes", `Expressions may contain at most ${LIMITS.maxNodes} nodes.`),
    );
  }

  if (diagnostics.some((d) => d.severity === "error") || root === null) {
    return { ok: false, diagnostics };
  }

  const expression: AudienceExpression = { version: AUDIENCE_SCHEMA_VERSION, root };
  const canonicalJson = canonicalizeExpression(expression);
  if (Buffer.byteLength(canonicalJson) > LIMITS.maxExpressionBytes) {
    return {
      ok: false,
      diagnostics: [
        ...diagnostics,
        err("", "expression_too_large", `Expressions must serialize to at most ${LIMITS.maxExpressionBytes} bytes.`),
      ],
    };
  }
  return { ok: true, expression, diagnostics };
}

function validateNode(
  value: unknown,
  path: string,
  depth: number,
  state: WalkState,
): ExpressionNode | null {
  state.nodes += 1;
  if (state.nodes > LIMITS.maxNodes) return null; // reported once at top level

  if (!isPlainObject(value)) {
    state.diagnostics.push(err(path, "node_not_object", "Every node must be a JSON object with a kind."));
    return null;
  }
  if (depth > LIMITS.maxDepth) {
    state.diagnostics.push(
      err(path, "too_deep", `Expressions may nest at most ${LIMITS.maxDepth} levels of all/any/not.`),
    );
    return null;
  }

  switch (value.kind) {
    case "all":
    case "any":
      return validateGroup(value, path, depth, state);
    case "not":
      return validateNot(value, path, depth, state);
    case "field":
      return validateField(value, path, state, { insideEvent: false });
    case "event":
      return validateEvent(value, path, depth, state);
    default:
      state.diagnostics.push(
        err(
          `${path}/kind`,
          "unknown_node_kind",
          `Unknown node kind ${JSON.stringify(value.kind)}. Supported kinds: all, any, not, field, event.`,
        ),
      );
      return null;
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
  state: WalkState,
): boolean {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    state.diagnostics.push(
      err(
        `${path}/${pointerSegment(unknown)}`,
        "unknown_key",
        `Unknown key "${unknown}". Allowed keys: ${allowed.join(", ")}.`,
      ),
    );
    return false;
  }
  return true;
}

function validateGroup(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  state: WalkState,
): GroupNode | null {
  const kind = value.kind as "all" | "any";
  if (!rejectUnknownKeys(value, ["kind", "children"], path, state)) return null;
  if (!Array.isArray(value.children) || value.children.length === 0) {
    state.diagnostics.push(
      err(`${path}/children`, "empty_group", `${kind} needs a non-empty children array.`),
    );
    return null;
  }
  if (value.children.length > LIMITS.maxGroupChildren) {
    state.diagnostics.push(
      err(
        `${path}/children`,
        "too_many_children",
        `A group may have at most ${LIMITS.maxGroupChildren} children.`,
      ),
    );
    return null;
  }
  const children: ExpressionNode[] = [];
  let failed = false;
  for (const [index, child] of value.children.entries()) {
    const node = validateNode(child, `${path}/children/${index}`, depth + 1, state);
    if (node === null) failed = true;
    else children.push(node);
  }
  return failed ? null : { kind, children };
}

function validateNot(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  state: WalkState,
): NotNode | null {
  if (!rejectUnknownKeys(value, ["kind", "child"], path, state)) return null;
  if (value.child === undefined) {
    state.diagnostics.push(err(`${path}/child`, "missing_child", "not needs a child condition."));
    return null;
  }
  const child = validateNode(value.child, `${path}/child`, depth + 1, state);
  return child === null ? null : { kind: "not", child };
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= LIMITS.maxKeyLength;
}

function validateField(
  value: Record<string, unknown>,
  path: string,
  state: WalkState,
  ctx: { insideEvent: boolean },
): FieldNode | null {
  if (!rejectUnknownKeys(value, ["kind", "field", "op", "value"], path, state)) return null;

  const ref = validateFieldRef(value.field, `${path}/field`, state, ctx);
  if (ref === null) return null;

  if (typeof value.op !== "string") {
    state.diagnostics.push(err(`${path}/op`, "missing_operator", "field needs an op."));
    return null;
  }
  const op = value.op;

  const allOps = new Set<string>([
    ...STRING_OPERATORS,
    ...NUMBER_OPERATORS,
    ...BOOLEAN_OPERATORS,
    ...EXISTENCE_OPERATORS,
    ...DATETIME_OPERATORS,
  ]);
  if (!allOps.has(op)) {
    state.diagnostics.push(
      err(`${path}/op`, "unknown_operator", `Unknown operator "${op}".`, nearest(op, [...allOps])),
    );
    return null;
  }

  // Lifecycle fields are timestamps: only datetime + existence semantics.
  if (ref.kind === "user" && !(DATETIME_OPERATORS as readonly string[]).includes(op) && !(EXISTENCE_OPERATORS as readonly string[]).includes(op)) {
    state.diagnostics.push(
      err(
        `${path}/op`,
        "incompatible_operator",
        `Lifecycle field ${ref.field} is a timestamp; use one of: ${[...DATETIME_OPERATORS, ...EXISTENCE_OPERATORS].join(", ")}.`,
      ),
    );
    return null;
  }

  const valuePath = `${path}/value`;
  if ((EXISTENCE_OPERATORS as readonly string[]).includes(op)) {
    if (value.value !== undefined) {
      state.diagnostics.push(
        err(valuePath, "unexpected_value", `${op} does not take a value.`),
      );
      return null;
    }
    return { kind: "field", field: ref, op };
  }

  const v = value.value;
  if (v === undefined) {
    state.diagnostics.push(err(valuePath, "missing_value", `${op} needs a value.`));
    return null;
  }

  if (op === "in" || op === "not_in") {
    if (!Array.isArray(v) || v.length === 0 || v.length > LIMITS.maxInValues) {
      state.diagnostics.push(
        err(
          valuePath,
          "invalid_value",
          `${op} needs a non-empty array of at most ${LIMITS.maxInValues} strings or numbers.`,
        ),
      );
      return null;
    }
    const allStrings = v.every((item) => typeof item === "string" && item.length <= LIMITS.maxStringValueLength);
    const allNumbers = v.every((item) => typeof item === "number" && Number.isFinite(item));
    if (!allStrings && !allNumbers) {
      state.diagnostics.push(
        err(valuePath, "invalid_value", `${op} values must be all strings or all numbers (no mixing, no coercion).`),
      );
      return null;
    }
    return { kind: "field", field: ref, op, value: v };
  }

  if (op === "contains" || op === "starts_with" || op === "ends_with") {
    if (typeof v !== "string" || v.length === 0 || v.length > LIMITS.maxStringValueLength) {
      state.diagnostics.push(
        err(valuePath, "invalid_value", `${op} needs a non-empty string of at most ${LIMITS.maxStringValueLength} characters.`),
      );
      return null;
    }
    return { kind: "field", field: ref, op, value: v };
  }

  if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      state.diagnostics.push(err(valuePath, "invalid_value", `${op} needs a finite number.`));
      return null;
    }
    return { kind: "field", field: ref, op, value: v };
  }

  if (op === "before" || op === "after") {
    if (typeof v !== "string" || parseIsoInstant(v) === null) {
      state.diagnostics.push(
        err(
          valuePath,
          "invalid_value",
          `${op} needs an ISO-8601 date-time with an explicit timezone (e.g. 2026-08-01T09:00:00Z).`,
        ),
      );
      return null;
    }
    return { kind: "field", field: ref, op, value: v };
  }

  if (op === "within_last" || op === "not_within_last") {
    const window = validateWindow(v, valuePath, state);
    if (window === null) return null;
    return { kind: "field", field: ref, op, value: window };
  }

  // eq / neq: string | number | boolean literal.
  if (typeof v === "string") {
    if (v.length > LIMITS.maxStringValueLength) {
      state.diagnostics.push(
        err(valuePath, "invalid_value", `String values must be at most ${LIMITS.maxStringValueLength} characters.`),
      );
      return null;
    }
    return { kind: "field", field: ref, op, value: v };
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      state.diagnostics.push(err(valuePath, "invalid_value", `${op} numbers must be finite.`));
      return null;
    }
    return { kind: "field", field: ref, op, value: v };
  }
  if (typeof v === "boolean") return { kind: "field", field: ref, op, value: v };

  state.diagnostics.push(
    err(valuePath, "invalid_value", `${op} needs a string, number, or boolean value (no null/objects).`),
  );
  return null;
}

function validateFieldRef(
  value: unknown,
  path: string,
  state: WalkState,
  ctx: { insideEvent: boolean },
): FieldRef | null {
  if (!isPlainObject(value)) {
    state.diagnostics.push(
      err(path, "invalid_field_ref", "field needs a structured reference: { kind: trait|user|event_property, … }."),
    );
    return null;
  }
  switch (value.kind) {
    case "trait": {
      if (!rejectUnknownKeys(value, ["kind", "key"], path, state)) return null;
      if (!validKey(value.key)) {
        state.diagnostics.push(
          err(`${path}/key`, "invalid_key", `trait needs a key of 1–${LIMITS.maxKeyLength} characters.`),
        );
        return null;
      }
      if (ctx.insideEvent) {
        state.diagnostics.push(
          err(path, "invalid_field_ref", "Event where-conditions compare event properties; use kind: event_property."),
        );
        return null;
      }
      return { kind: "trait", key: value.key };
    }
    case "user": {
      if (!rejectUnknownKeys(value, ["kind", "field"], path, state)) return null;
      if (!(LIFECYCLE_FIELDS as readonly string[]).includes(value.field as string)) {
        state.diagnostics.push(
          err(
            `${path}/field`,
            "unknown_lifecycle_field",
            `Unknown lifecycle field. Supported: ${LIFECYCLE_FIELDS.join(", ")}.`,
          ),
        );
        return null;
      }
      if (ctx.insideEvent) {
        state.diagnostics.push(
          err(path, "invalid_field_ref", "Event where-conditions compare event properties; use kind: event_property."),
        );
        return null;
      }
      return { kind: "user", field: value.field as LifecycleField };
    }
    case "event_property": {
      if (!rejectUnknownKeys(value, ["kind", "key"], path, state)) return null;
      if (!ctx.insideEvent) {
        state.diagnostics.push(
          err(path, "event_property_outside_event", "event_property references are only valid inside an event node's where conditions."),
        );
        return null;
      }
      if (!validKey(value.key)) {
        state.diagnostics.push(
          err(`${path}/key`, "invalid_key", `event_property needs a key of 1–${LIMITS.maxKeyLength} characters.`),
        );
        return null;
      }
      return { kind: "event_property", key: value.key };
    }
    default:
      state.diagnostics.push(
        err(
          `${path}/kind`,
          "unknown_field_kind",
          `Unknown field reference kind ${JSON.stringify(value.kind)}. Supported: trait, user, event_property.`,
        ),
      );
      return null;
  }
}

function validateWindow(value: unknown, path: string, state: WalkState): RelativeWindow | null {
  if (!isPlainObject(value)) {
    state.diagnostics.push(
      err(path, "invalid_window", "Relative windows are { amount: number, unit: minutes|hours|days }."),
    );
    return null;
  }
  const unknown = Object.keys(value).find((k) => k !== "amount" && k !== "unit");
  if (unknown) {
    state.diagnostics.push(err(`${path}/${pointerSegment(unknown)}`, "unknown_key", `Unknown window key "${unknown}".`));
    return null;
  }
  if (!(WINDOW_UNITS as readonly string[]).includes(value.unit as string)) {
    state.diagnostics.push(
      err(`${path}/unit`, "invalid_window", `Window unit must be one of: ${WINDOW_UNITS.join(", ")}.`),
    );
    return null;
  }
  const amount = value.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) {
    state.diagnostics.push(err(`${path}/amount`, "invalid_window", "Window amount must be a positive integer."));
    return null;
  }
  const unit = value.unit as WindowUnit;
  const days = (amount * WINDOW_UNIT_MS[unit]) / WINDOW_UNIT_MS.days;
  if (days > LIMITS.maxWindowDays) {
    state.diagnostics.push(
      err(path, "invalid_window", `Windows may cover at most ${LIMITS.maxWindowDays} days.`),
    );
    return null;
  }
  return { amount, unit };
}

function validateEvent(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  state: WalkState,
): EventNode | null {
  if (!rejectUnknownKeys(value, ["kind", "event", "count", "window", "where"], path, state)) {
    return null;
  }
  if (
    typeof value.event !== "string" ||
    value.event.length === 0 ||
    value.event.length > LIMITS.maxEventNameLength
  ) {
    state.diagnostics.push(
      err(
        `${path}/event`,
        "invalid_event_name",
        `event needs a name of 1–${LIMITS.maxEventNameLength} characters.`,
      ),
    );
    return null;
  }

  const node: EventNode = { kind: "event", event: value.event };

  if (value.count !== undefined) {
    if (!isPlainObject(value.count)) {
      state.diagnostics.push(
        err(`${path}/count`, "invalid_count", "count is { op: eq|neq|gt|gte|lt|lte, value: integer }."),
      );
      return null;
    }
    const unknown = Object.keys(value.count).find((k) => k !== "op" && k !== "value");
    if (unknown) {
      state.diagnostics.push(
        err(`${path}/count/${pointerSegment(unknown)}`, "unknown_key", `Unknown count key "${unknown}".`),
      );
      return null;
    }
    if (!(COUNT_OPERATORS as readonly string[]).includes(value.count.op as string)) {
      state.diagnostics.push(
        err(`${path}/count/op`, "invalid_count", `count.op must be one of: ${COUNT_OPERATORS.join(", ")}.`),
      );
      return null;
    }
    const n = value.count.value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > LIMITS.maxOccurrenceCount) {
      state.diagnostics.push(
        err(
          `${path}/count/value`,
          "invalid_count",
          `count.value must be an integer between 0 and ${LIMITS.maxOccurrenceCount}.`,
        ),
      );
      return null;
    }
    node.count = { op: value.count.op as CountOperator, value: n };
  }

  if (value.window !== undefined) {
    const window = validateWindow(value.window, `${path}/window`, state);
    if (window === null) return null;
    node.window = window;
  }

  if (value.where !== undefined) {
    if (!Array.isArray(value.where) || value.where.length === 0) {
      state.diagnostics.push(
        err(`${path}/where`, "invalid_where", "where must be a non-empty array of event_property field conditions."),
      );
      return null;
    }
    if (value.where.length > LIMITS.maxEventPropertyConditions) {
      state.diagnostics.push(
        err(
          `${path}/where`,
          "invalid_where",
          `An event may have at most ${LIMITS.maxEventPropertyConditions} where conditions.`,
        ),
      );
      return null;
    }
    const where: FieldNode[] = [];
    let failed = false;
    for (const [index, entry] of value.where.entries()) {
      state.nodes += 1;
      const wherePath = `${path}/where/${index}`;
      if (!isPlainObject(entry) || entry.kind !== "field") {
        state.diagnostics.push(
          err(wherePath, "invalid_where", "Each where entry is a field node comparing an event_property."),
        );
        failed = true;
        continue;
      }
      const condition = validateField(entry, wherePath, state, { insideEvent: true });
      if (condition === null) {
        failed = true;
        continue;
      }
      if (condition.field.kind !== "event_property") {
        state.diagnostics.push(
          err(`${wherePath}/field`, "invalid_where", "where conditions must reference kind: event_property."),
        );
        failed = true;
        continue;
      }
      // Relative-window ops on event properties are not supported: properties
      // are opaque values, the event's own timestamp uses `window`.
      if (condition.op === "within_last" || condition.op === "not_within_last") {
        state.diagnostics.push(
          err(
            `${wherePath}/op`,
            "incompatible_operator",
            "within_last applies to timestamps; use the event node's window for event recency.",
          ),
        );
        failed = true;
        continue;
      }
      where.push(condition);
    }
    if (failed) return null;
    node.where = where;
  }

  void depth;
  return node;
}

// Levenshtein-based nearest suggestions, bounded and cheap: used for typo
// hints on operators (validation) and observed names (check diagnostics).
export function nearest(input: string, candidates: string[], max = 3): string[] | undefined {
  const scored = candidates
    .map((candidate) => ({ candidate, distance: levenshtein(input.toLowerCase(), candidate.toLowerCase()) }))
    .filter(({ candidate, distance }) => distance > 0 && distance <= Math.max(2, Math.floor(candidate.length / 3)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, max)
    .map(({ candidate }) => candidate);
  return scored.length > 0 ? scored : undefined;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

// --- Canonicalization + hashing ---------------------------------------------------

// Canonical form: fixed key order per node kind, no undefined members, event
// count defaulted explicitly to { op: "gte", value: 1 }. Deterministic
// serialization is what makes the hash stable and comparable.
export function canonicalizeNode(node: ExpressionNode): ExpressionNode {
  switch (node.kind) {
    case "all":
    case "any":
      return { kind: node.kind, children: node.children.map(canonicalizeNode) };
    case "not":
      return { kind: "not", child: canonicalizeNode(node.child) };
    case "field": {
      const out: FieldNode = { kind: "field", field: canonicalRef(node.field), op: node.op };
      if (node.value !== undefined) out.value = canonicalValue(node.op, node.value);
      return out;
    }
    case "event": {
      const out: EventNode = {
        kind: "event",
        event: node.event,
        count: node.count ?? { op: "gte", value: 1 },
      };
      if (node.window) out.window = { amount: node.window.amount, unit: node.window.unit };
      if (node.where) {
        out.where = node.where.map((condition) => canonicalizeNode(condition) as FieldNode);
      }
      return out;
    }
  }
}

function canonicalRef(ref: FieldRef): FieldRef {
  switch (ref.kind) {
    case "trait":
      return { kind: "trait", key: ref.key };
    case "user":
      return { kind: "user", field: ref.field };
    case "event_property":
      return { kind: "event_property", key: ref.key };
  }
}

function canonicalValue(op: string, value: unknown): unknown {
  if (op === "within_last" || op === "not_within_last") {
    const w = value as RelativeWindow;
    return { amount: w.amount, unit: w.unit };
  }
  if ((op === "in" || op === "not_in") && Array.isArray(value)) {
    // Sorted + deduped: membership is a set, so order must not affect the hash.
    const unique = [...new Set(value as (string | number)[])];
    return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return value;
}

export function canonicalizeExpression(expression: AudienceExpression): string {
  return JSON.stringify({
    version: expression.version,
    root: canonicalizeNode(expression.root),
  });
}

export function expressionHash(canonicalJson: string): string {
  return createHash("sha256").update(canonicalJson).digest("hex");
}

// Referenced vocabulary — which trait keys, lifecycle fields, event names,
// and event properties an expression touches. Drives check diagnostics and
// context-efficient samples.
export type ReferencedVocabulary = {
  traits: Set<string>;
  lifecycleFields: Set<LifecycleField>;
  events: Set<string>;
  eventProperties: Map<string, Set<string>>; // event name → property keys
};

export function referencedVocabulary(node: ExpressionNode): ReferencedVocabulary {
  const out: ReferencedVocabulary = {
    traits: new Set(),
    lifecycleFields: new Set(),
    events: new Set(),
    eventProperties: new Map(),
  };
  walk(node);
  return out;

  function walk(current: ExpressionNode): void {
    switch (current.kind) {
      case "all":
      case "any":
        current.children.forEach(walk);
        return;
      case "not":
        walk(current.child);
        return;
      case "field":
        if (current.field.kind === "trait") out.traits.add(current.field.key);
        if (current.field.kind === "user") out.lifecycleFields.add(current.field.field);
        return;
      case "event": {
        out.events.add(current.event);
        if (current.where) {
          const keys = out.eventProperties.get(current.event) ?? new Set<string>();
          for (const condition of current.where) {
            if (condition.field.kind === "event_property") keys.add(condition.field.key);
          }
          out.eventProperties.set(current.event, keys);
        }
        return;
      }
    }
  }
}

// --- Readable summary ---------------------------------------------------------------

// Deterministic English rendering of the canonical expression. Used by check
// responses and campaign reads; agents treat it as display text, never as a
// parseable format.
export function summarizeExpression(expression: AudienceExpression): string {
  return summarizeNode(canonicalizeNode(expression.root));
}

function summarizeNode(node: ExpressionNode): string {
  switch (node.kind) {
    case "all":
      return node.children.map(wrapChild).join(" and ");
    case "any":
      return node.children.map(wrapChild).join(" or ");
    case "not":
      return `not (${summarizeNode(node.child)})`;
    case "field":
      return summarizeField(node);
    case "event":
      return summarizeEvent(node);
  }
}

function wrapChild(node: ExpressionNode): string {
  const text = summarizeNode(node);
  return node.kind === "all" || node.kind === "any" ? `(${text})` : text;
}

function refLabel(ref: FieldRef): string {
  switch (ref.kind) {
    case "trait":
      return `trait ${ref.key}`;
    case "user":
      return ref.field;
    case "event_property":
      return ref.key;
  }
}

const OP_LABEL: Record<string, string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  not_in: "is none of",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  exists: "exists",
  not_exists: "does not exist",
  before: "is before",
  after: "is after",
  within_last: "is within the last",
  not_within_last: "is not within the last",
};

function summarizeField(node: FieldNode): string {
  const label = refLabel(node.field);
  const op = OP_LABEL[node.op] ?? node.op;
  if (node.op === "exists" || node.op === "not_exists") return `${label} ${op}`;
  if (node.op === "within_last" || node.op === "not_within_last") {
    const w = node.value as RelativeWindow;
    return `${label} ${op} ${w.amount} ${w.unit}`;
  }
  if (Array.isArray(node.value)) return `${label} ${op} [${node.value.map(literal).join(", ")}]`;
  return `${label} ${op} ${literal(node.value)}`;
}

function literal(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function summarizeEvent(node: EventNode): string {
  const count = node.count ?? { op: "gte", value: 1 };
  let text: string;
  if (count.op === "gte" && count.value === 1) text = `performed ${node.event}`;
  else if ((count.op === "eq" && count.value === 0) || (count.op === "lt" && count.value === 1)) {
    text = `did not perform ${node.event}`;
  } else text = `performed ${node.event} ${OP_LABEL[count.op] ?? count.op} ${count.value} times`;
  if (node.window) text += ` in the last ${node.window.amount} ${node.window.unit}`;
  if (node.where && node.where.length > 0) {
    text += ` where ${node.where.map(summarizeField).join(" and ")}`;
  }
  return text;
}
