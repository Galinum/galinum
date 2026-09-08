
export function normalizePath(path: string): string {
  const withoutQuery = (path.split("?")[0] ?? "").split("#")[0] ?? "";
  if (!withoutQuery) return "/";
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.replace(/\/+$/, "") || "/";
  }
  return withoutQuery;
}

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

export function matchesPages(pages: string[] | null | undefined, path: string): boolean {
  if (pages === null || pages === undefined) return true;
  return pages.some((pattern) => matchesPagePattern(pattern, path));
}

export interface EntryCapture { identity: string; entryId: string; requestId: string; facts: number }
export function sameEntry(a: EntryCapture, b: EntryCapture): boolean {
  return a.identity === b.identity && a.entryId === b.entryId && a.requestId === b.requestId && a.facts === b.facts;
}
export function destinationUrl(destination: { kind: "website" | "app"; url: string }, appSchemes: readonly string[] = []): string | null {
  const value = destination.url;
  if (/[\s\\\u0000-\u001f]/.test(value)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1].toLowerCase();
  if (destination.kind === "website") return /^https:\/\/[^/?#@]+(?:[/?#].*)?$/.test(value) ? value : null;
  return scheme && !["javascript", "data", "file", "http", "https"].includes(scheme) && appSchemes.includes(scheme) ? value : null;
}
