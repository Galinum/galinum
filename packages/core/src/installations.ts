import type { InstallationState } from "@galinum/contracts";

export type InstallationSelection = { kind: "last_active" } | { kind: "all" } | { kind: "specific"; installationId: string };

export function eligibleInstallation(installation: InstallationState, userId: string): boolean {
  return installation.userId === userId && installation.hasToken && installation.consent
    && (installation.permission === "granted" || installation.permission === "provisional");
}

export function selectInstallations(installations: readonly InstallationState[], userId: string, selection: InstallationSelection): InstallationState[] {
  const eligible = installations.filter((installation) => eligibleInstallation(installation, userId))
    .sort((a, b) => (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (selection.kind === "specific") return eligible.filter((installation) => installation.id === selection.installationId);
  return selection.kind === "all" ? eligible : eligible.slice(0, 1);
}
