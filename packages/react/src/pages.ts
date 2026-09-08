import { normalizePath } from "@galinum/contracts/entry";
export { normalizePath, matchesPagePattern, matchesPages } from "@galinum/contracts/entry";
export function currentPath(): string {
  return typeof window === "undefined" ? "/" : normalizePath(window.location.pathname || "/");
}
