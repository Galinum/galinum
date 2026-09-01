// The server validates patterns; this file decides, in the browser, whether a
// message may render on the current path.
//
// A pattern starts with "/". "*" matches any characters, including "/".
// Everything else is literal and case-sensitive. A trailing slash is
// normalized away (except on the root path). Query strings and hashes are
// excluded from matching.

export function normalizePath(path: string): string {
  const withoutQuery = (path.split("?")[0] ?? "").split("#")[0] ?? "";
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
  const first = segments[0] ?? "";
  if (!target.startsWith(first)) return false;
  if (segments.length === 1) return target === first;

  let cursor = first.length;
  for (let i = 1; i < segments.length - 1; i++) {
    const segment = segments[i] ?? "";
    if (segment === "") continue;
    const found = target.indexOf(segment, cursor);
    if (found === -1) return false;
    cursor = found + segment.length;
  }

  const last = segments[segments.length - 1] ?? "";
  return target.length - cursor >= last.length && target.endsWith(last);
}

// Null/absent pages = every page. An empty array is the server's fail-closed
// value for an unreadable stored pattern list: it matches nothing.
export function matchesPages(pages: string[] | null | undefined, path: string): boolean {
  if (pages === null || pages === undefined) return true;
  return pages.some((pattern) => matchesPagePattern(pattern, path));
}

export function currentPath(): string {
  if (typeof window === "undefined" || !window.location) return "/";
  return normalizePath(window.location.pathname || "/");
}
