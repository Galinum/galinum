// Helpers for end_users.traits_json: customer-set traits mixed with
// auto-collected `$`-prefixed ones (SDK device context + server-side geo).

export type Traits = Record<string, unknown>;

export function parseTraits(json: string | null): Traits {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Traits;
    }
  } catch {
    // fall through
  }
  return {};
}

export function splitTraits(traits: Traits): { custom: Traits; auto: Traits } {
  const custom: Traits = {};
  const auto: Traits = {};
  for (const [key, value] of Object.entries(traits)) {
    (key.startsWith("$") ? auto : custom)[key] = value;
  }
  return { custom, auto };
}

export function traitString(traits: Traits, key: string): string | null {
  const value = traits[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Best human-readable secondary label for a user (email, else name). */
export function userLabel(traits: Traits): string | null {
  return traitString(traits, "email") ?? traitString(traits, "name");
}

export function locationLabel(traits: Traits): string | null {
  const city = traitString(traits, "$city");
  const country = traitString(traits, "$country");
  if (city && country) return `${city}, ${country}`;
  return country ?? city;
}

export function deviceLabel(traits: Traits): string | null {
  const browser = traitString(traits, "$browser");
  const os = traitString(traits, "$os");
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os;
}
