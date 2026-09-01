import {
  BOOLEAN_OPERATORS,
  canonicalizeExpression,
  COUNT_OPERATORS,
  DATETIME_OPERATORS,
  evaluateExpression,
  EXISTENCE_OPERATORS,
  explainExpression,
  expressionHash,
  LIMITS,
  LIFECYCLE_FIELDS,
  nearest,
  NUMBER_OPERATORS,
  referencedVocabulary,
  STRING_OPERATORS,
  summarizeExpression,
  SUPPORTED_SCHEMA_VERSIONS,
  validateExpression,
  WINDOW_UNITS,
  type AudienceExpression,
  type Diagnostic,
  type EventOccurrence,
  type ExpressionNode,
  type UserAudienceFacts,
} from "@galinum/core";
import type { ProductEvent, ProductUser } from "./local-product.js";

export const MAX_CAPABILITY_TRAITS = 100;
export const MAX_CAPABILITY_EVENTS = 100;
export const MAX_EVENT_PROPERTIES = 50;
export const MAX_REPRESENTATIVE_VALUES = 20;

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function audienceCapabilities(users: Iterable<ProductUser>, events: Iterable<ProductEvent>) {
  const traits = new Map<string, {
    types: Record<string, number>;
    users: number;
    stringValues: Set<string>;
    representative: boolean;
  }>();
  for (const user of users) {
    for (const [key, value] of Object.entries(user.traits)) {
      const entry = traits.get(key) ?? {
        types: {},
        users: 0,
        stringValues: new Set<string>(),
        representative: true,
      };
      entry.users += 1;
      increment(entry.types, jsonType(value));
      if (typeof value === "string" && value.length <= LIMITS.maxStringValueLength) {
        if (entry.stringValues.size <= MAX_REPRESENTATIVE_VALUES) entry.stringValues.add(value);
      } else {
        entry.representative = false;
      }
      traits.set(key, entry);
    }
  }

  const orderedTraits = [...traits.entries()]
    .sort((left, right) => right[1].users - left[1].users || left[0].localeCompare(right[0]));
  const traitViews = orderedTraits.slice(0, MAX_CAPABILITY_TRAITS).map(([key, entry]) => ({
    key,
    types: entry.types,
    users: entry.users,
    ...(entry.representative && entry.stringValues.size <= MAX_REPRESENTATIVE_VALUES
      ? { values: [...entry.stringValues].sort() }
      : {}),
  }));

  const eventStats = new Map<string, {
    users: Set<string>;
    occurrences: number;
    lastSeenAt: number | null;
    properties: Map<string, Record<string, number>>;
  }>();
  for (const event of events) {
    const entry = eventStats.get(event.name) ?? {
      users: new Set<string>(),
      occurrences: 0,
      lastSeenAt: null,
      properties: new Map<string, Record<string, number>>(),
    };
    entry.users.add(event.userId);
    entry.occurrences += 1;
    entry.lastSeenAt = Math.max(entry.lastSeenAt ?? event.occurredAt, event.occurredAt);
    for (const [key, value] of Object.entries(event.props ?? {})) {
      const types = entry.properties.get(key) ?? {};
      increment(types, jsonType(value));
      entry.properties.set(key, types);
    }
    eventStats.set(event.name, entry);
  }

  const orderedEvents = [...eventStats.entries()]
    .sort((left, right) => right[1].users.size - left[1].users.size || left[0].localeCompare(right[0]));
  const eventViews = orderedEvents.slice(0, MAX_CAPABILITY_EVENTS).map(([name, entry]) => {
    const properties = [...entry.properties.entries()]
      .sort((left, right) => {
        const leftCount = Object.values(left[1]).reduce((sum, count) => sum + count, 0);
        const rightCount = Object.values(right[1]).reduce((sum, count) => sum + count, 0);
        return rightCount - leftCount || left[0].localeCompare(right[0]);
      });
    return {
      name,
      users: entry.users.size,
      occurrences: entry.occurrences,
      lastSeenAt: entry.lastSeenAt,
      properties: properties.slice(0, MAX_EVENT_PROPERTIES).map(([key, types]) => ({ key, types })),
      propertiesTruncated: properties.length > MAX_EVENT_PROPERTIES,
    };
  });

  return {
    expression: {
      versions: [...SUPPORTED_SCHEMA_VERSIONS],
      nodeKinds: ["all", "any", "not", "field", "event"],
      operators: {
        string: [...STRING_OPERATORS],
        number: [...NUMBER_OPERATORS],
        boolean: [...BOOLEAN_OPERATORS],
        existence: [...EXISTENCE_OPERATORS],
        datetime: [...DATETIME_OPERATORS],
        count: [...COUNT_OPERATORS],
      },
      windowUnits: [...WINDOW_UNITS],
      limits: LIMITS,
    },
    lifecycleFields: LIFECYCLE_FIELDS.map((field) => ({ field, type: "datetime" })),
    traits: traitViews,
    traitsTruncated: orderedTraits.length > MAX_CAPABILITY_TRAITS,
    events: eventViews,
    eventsTruncated: orderedEvents.length > MAX_CAPABILITY_EVENTS,
  };
}

export type AudienceCapabilities = ReturnType<typeof audienceCapabilities>;

export type PreparedAudience = {
  expression: AudienceExpression;
  hash: string;
  summary: string;
  diagnostics: Diagnostic[];
};

export function prepareAudience(input: unknown):
  | { ok: true; value: PreparedAudience }
  | { ok: false; diagnostics: Diagnostic[] } {
  const validation = validateExpression(input);
  if (!validation.ok) return validation;
  const canonicalJson = canonicalizeExpression(validation.expression);
  const expression = JSON.parse(canonicalJson) as AudienceExpression;
  return {
    ok: true,
    value: {
      expression,
      hash: expressionHash(canonicalJson),
      summary: summarizeExpression(expression),
      diagnostics: validation.diagnostics,
    },
  };
}

function eventPaths(root: ExpressionNode): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  walk(root, "/root");
  return paths;

  function add(name: string, path: string): void {
    const values = paths.get(name) ?? [];
    values.push(path);
    paths.set(name, values);
  }

  function walk(node: ExpressionNode, path: string): void {
    if (node.kind === "all" || node.kind === "any") {
      node.children.forEach((child, index) => walk(child, `${path}/children/${index}`));
    } else if (node.kind === "not") {
      walk(node.child, `${path}/child`);
    } else if (node.kind === "event") {
      add(node.event, path);
    }
  }
}

function traitPaths(root: ExpressionNode): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  walk(root, "/root");
  return paths;

  function add(name: string, path: string): void {
    const values = paths.get(name) ?? [];
    values.push(path);
    paths.set(name, values);
  }

  function walk(node: ExpressionNode, path: string): void {
    if (node.kind === "all" || node.kind === "any") {
      node.children.forEach((child, index) => walk(child, `${path}/children/${index}`));
    } else if (node.kind === "not") {
      walk(node.child, `${path}/child`);
    } else if (node.kind === "field" && node.field.kind === "trait") {
      add(node.field.key, path);
    }
  }
}

export function audienceDiagnostics(
  root: ExpressionNode,
  users: ProductUser[],
  events: ProductEvent[],
  matchedCount: number,
): Diagnostic[] {
  const observedTraits = new Set(users.flatMap((user) => Object.keys(user.traits)));
  const observedEvents = new Set(events.map((event) => event.name));
  const diagnostics: Diagnostic[] = [];
  for (const [key, paths] of traitPaths(root)) {
    if (observedTraits.has(key)) continue;
    const suggestions = nearest(key, [...observedTraits]);
    for (const path of paths) {
      diagnostics.push({
        severity: "warning",
        code: "unobserved_trait",
        path,
        message: `Trait "${key}" has not been observed in this project.`,
        ...(suggestions ? { suggestions } : {}),
      });
    }
  }
  for (const [name, paths] of eventPaths(root)) {
    if (observedEvents.has(name)) continue;
    const suggestions = nearest(name, [...observedEvents]);
    for (const path of paths) {
      diagnostics.push({
        severity: "warning",
        code: "unobserved_event",
        path,
        message: `Event "${name}" has not been observed in this project.`,
        ...(suggestions ? { suggestions } : {}),
      });
    }
  }
  if (matchedCount === 0) {
    diagnostics.push({
      severity: "warning",
      code: "zero_matches",
      path: "/root",
      message: "The expression currently matches no users.",
    });
  }
  return diagnostics;
}

export function audienceDiagnosticsFromPresence(
  root: ExpressionNode,
  presence: { traits: Set<string>; events: Set<string> },
  matchedCount: number,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [key, paths] of traitPaths(root)) {
    if (presence.traits.has(key)) continue;
    for (const path of paths) diagnostics.push({
      severity: "warning",
      code: "unobserved_trait",
      path,
      message: `Trait "${key}" has not been observed in this project.`,
    });
  }
  for (const [name, paths] of eventPaths(root)) {
    if (presence.events.has(name)) continue;
    for (const path of paths) diagnostics.push({
      severity: "warning",
      code: "unobserved_event",
      path,
      message: `Event "${name}" has not been observed in this project.`,
    });
  }
  if (matchedCount === 0) diagnostics.push({
    severity: "warning",
    code: "zero_matches",
    path: "/root",
    message: "The expression currently matches no users.",
  });
  return diagnostics;
}

export function factsForUser(
  user: ProductUser,
  allEvents: ProductEvent[],
  expression: AudienceExpression,
): UserAudienceFacts {
  const vocabulary = referencedVocabulary(expression.root);
  const counts = new Map<string, number>();
  const events: EventOccurrence[] = [];
  for (const event of allEvents) {
    if (event.userId !== user.id || !vocabulary.events.has(event.name)) continue;
    const count = counts.get(event.name) ?? 0;
    if (count >= LIMITS.maxEvaluatedEventOccurrences) continue;
    counts.set(event.name, count + 1);
    events.push({ name: event.name, ts: event.occurredAt, props: event.props });
  }
  return {
    traits: user.traits,
    firstSeenAt: user.firstSeenAt,
    lastSeenAt: user.lastSeenAt,
    events,
  };
}

export function checkPreparedAudience(
  prepared: PreparedAudience,
  users: ProductUser[],
  events: ProductEvent[],
  evaluatedAt: number,
  sampleLimit: number,
) {
  const vocabulary = referencedVocabulary(prepared.expression.root);
  const eventsByUser = new Map<string, ProductEvent[]>();
  for (const event of events) {
    const values = eventsByUser.get(event.userId) ?? [];
    values.push(event);
    eventsByUser.set(event.userId, values);
  }
  const matches = users.filter((user) => evaluateExpression(
    prepared.expression.root,
    factsForUser(user, eventsByUser.get(user.id) ?? [], prepared.expression),
    evaluatedAt,
  ));
  return {
    expression: prepared.expression,
    expressionHash: prepared.hash,
    summary: prepared.summary,
    diagnostics: [
      ...prepared.diagnostics,
      ...audienceDiagnostics(prepared.expression.root, users, events, matches.length),
    ],
    evaluatedAt,
    countType: "exact",
    matchedCount: matches.length,
    totalUsers: users.length,
    samples: matches.slice(0, sampleLimit).map((user) => {
      const facts = factsForUser(user, eventsByUser.get(user.id) ?? [], prepared.expression);
      return {
        externalUserId: user.externalId,
        firstSeenAt: user.firstSeenAt,
        lastSeenAt: user.lastSeenAt,
        traits: Object.fromEntries([...vocabulary.traits]
          .filter((key) => Object.hasOwn(user.traits, key))
          .map((key) => [key, user.traits[key]])),
        events: Object.fromEntries([...vocabulary.events]
          .map((name) => [name, facts.events.filter((event) => event.name === name).length])),
      };
    }),
  };
}

export function explainPreparedAudience(
  prepared: PreparedAudience,
  user: ProductUser,
  events: ProductEvent[],
  evaluatedAt: number,
) {
  const facts = factsForUser(user, events, prepared.expression);
  const trace = explainExpression(prepared.expression.root, facts, evaluatedAt);
  return {
    user: {
      externalUserId: user.externalId,
      firstSeenAt: user.firstSeenAt,
      lastSeenAt: user.lastSeenAt,
    },
    matched: trace.matched,
    evaluatedAt,
    expressionHash: prepared.hash,
    trace,
  };
}
