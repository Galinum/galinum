// Pure audience matcher. A campaign's targeting_json decides whether a given
// end-user is eligible. Null/empty targeting matches everyone. Kept pure and
// dependency-free so it is trivially unit-testable — this is the one piece the
// delivery loop must get provably right.

export type TraitValue = string | number | boolean;

export type Targeting = {
  // All trait entries must match by strict equality.
  traits?: Record<string, TraitValue>;
  events?: {
    seen?: string[]; // user must have fired each of these at least once
    not_seen?: string[]; // user must NOT have fired any of these
  };
};

export type UserFacts = {
  traits: Record<string, unknown>;
  eventNames: Set<string>;
};

export function matches(user: UserFacts, targeting: Targeting | null): boolean {
  if (!targeting) return true;

  if (targeting.traits) {
    for (const [key, want] of Object.entries(targeting.traits)) {
      if (user.traits[key] !== want) return false;
    }
  }

  const seen = targeting.events?.seen ?? [];
  if (seen.some((name) => !user.eventNames.has(name))) return false;

  const notSeen = targeting.events?.not_seen ?? [];
  if (notSeen.some((name) => user.eventNames.has(name))) return false;

  return true;
}

export type TargetingValidation =
  | { ok: true; targeting: Targeting | null }
  | { ok: false; error: string };

// Strict validation for author-supplied targeting on the write path.
// parseTargeting stays lenient for the delivery path; this one rejects
// anything matches() wouldn't act on, so bad rules fail at save time.
export function validateTargeting(json: string): TargetingValidation {
  const trimmed = json.trim();
  if (!trimmed) return { ok: true, targeting: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Targeting must be valid JSON." };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: "Targeting must be a JSON object." };
  }

  const unknownKeys = Object.keys(parsed).filter(
    (key) => key !== "traits" && key !== "events",
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `Unknown targeting key "${unknownKeys[0]}". Allowed keys: traits, events.`,
    };
  }

  const targeting: Targeting = {};
  if (parsed.traits !== undefined) {
    if (!isPlainObject(parsed.traits)) {
      return { ok: false, error: "traits must be an object of trait values." };
    }
    for (const [key, value] of Object.entries(parsed.traits)) {
      if (!isTraitValue(value)) {
        return {
          ok: false,
          error: `traits.${key} must be a string, number, or boolean.`,
        };
      }
    }
    targeting.traits = parsed.traits as Record<string, TraitValue>;
  }

  if (parsed.events !== undefined) {
    if (!isPlainObject(parsed.events)) {
      return { ok: false, error: "events must be an object." };
    }
    const badEventKey = Object.keys(parsed.events).find(
      (key) => key !== "seen" && key !== "not_seen",
    );
    if (badEventKey) {
      return {
        ok: false,
        error: `Unknown events key "${badEventKey}". Allowed keys: seen, not_seen.`,
      };
    }
    for (const key of ["seen", "not_seen"] as const) {
      const list = parsed.events[key];
      if (list === undefined) continue;
      if (!isStringArray(list)) {
        return { ok: false, error: `events.${key} must be an array of event names.` };
      }
    }
    targeting.events = parsed.events as Targeting["events"];
  }

  if (!targeting.traits && !targeting.events) {
    return { ok: true, targeting: null };
  }
  return { ok: true, targeting };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTraitValue(value: unknown): value is TraitValue {
  return (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim() !== "")
  );
}

export function parseTargeting(json: string | null): Targeting | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Targeting) : null;
  } catch {
    return null;
  }
}
