// Where a campaign may render: URL path patterns matched against the SDK's
// current pathname. Audience answers "who", pages answers "where".
//
// This module is the spec. The SDK mirrors matchesPagePattern verbatim, so
// server validation and browser matching can never disagree.
//
// A pattern starts with "/". "*" matches any characters, including "/".
// Everything else is literal and case-sensitive. A trailing slash is
// normalized away (except on the root path). Query strings and hashes are
// excluded from matching.

export const MAX_PAGE_PATTERNS = 20;
export const MAX_PAGE_PATTERN_LENGTH = 256;

export function normalizePath(path: string): string {
  const withoutQuery = path.split("?")[0].split("#")[0];
  if (!withoutQuery) return "/";
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.replace(/\/+$/, "") || "/";
  }
  return withoutQuery;
}

// Greedy linear scan instead of a regex: `.*`-joined patterns backtrack
// exponentially on a near-miss, and patterns are customer-authored.
export function matchesPagePattern(pattern: string, path: string): boolean {
  const target = normalizePath(path);
  const segments = normalizePath(pattern).split("*");
  const first = segments[0];
  if (!target.startsWith(first)) return false;
  if (segments.length === 1) return target === first;

  let cursor = first.length;
  for (let i = 1; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (segment === "") continue;
    const found = target.indexOf(segment, cursor);
    if (found === -1) return false;
    cursor = found + segment.length;
  }

  const last = segments[segments.length - 1];
  return target.length - cursor >= last.length && target.endsWith(last);
}

// Null pages = eligible everywhere. Validation turns an empty list into null,
// so an empty array only ever comes from unreadable stored JSON: it matches
// nothing rather than everything.
export function matchesPages(pages: string[] | null, path: string): boolean {
  if (pages === null) return true;
  return pages.some((pattern) => matchesPagePattern(pattern, path));
}

export type PagesValidation =
  | { ok: true; pages: string[] | null }
  | { ok: false; error: string };

export function validatePages(value: unknown): PagesValidation {
  if (value === undefined || value === null) return { ok: true, pages: null };
  if (!Array.isArray(value)) {
    return { ok: false, error: "pages must be an array of path patterns" };
  }
  if (value.length > MAX_PAGE_PATTERNS) {
    return { ok: false, error: `pages accepts at most ${MAX_PAGE_PATTERNS} patterns` };
  }

  const pages: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { ok: false, error: "Each page pattern must be a string" };
    }
    const pattern = entry.trim();
    if (!pattern) continue;
    if (!pattern.startsWith("/")) {
      return { ok: false, error: `Page patterns must start with "/" ("${pattern}" does not)` };
    }
    if (pattern.length > MAX_PAGE_PATTERN_LENGTH) {
      return {
        ok: false,
        error: `Page patterns must be ${MAX_PAGE_PATTERN_LENGTH} characters or fewer`,
      };
    }
    const normalized = normalizePath(pattern);
    if (!pages.includes(normalized)) pages.push(normalized);
  }
  return { ok: true, pages: pages.length > 0 ? pages : null };
}

export function serializePages(pages: string[] | null): string | null {
  return pages && pages.length > 0 ? JSON.stringify(pages) : null;
}

// Only a NULL column means "every page". Anything else must parse and revalidate
// as the same patterns validatePages would accept; otherwise it fails closed to
// an empty list, which matches nothing.
export function parseStoredPages(json: string | null | undefined): string[] | null {
  if (json === null || json === undefined) return null;
  try {
    const validated = validatePages(JSON.parse(json));
    if (!validated.ok) return [];
    return validated.pages ?? [];
  } catch {
    return [];
  }
}
