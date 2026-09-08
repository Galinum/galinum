import type { InstallationState } from "@galinum/contracts";

export type InstallationRecord = Omit<InstallationState, "hasToken"> & { capabilityVerifier: string; token: string | null; tokenScope: string | null };
export type InstallationReplay = { digest: string; state: InstallationState };
export interface InstallationAccess {
  getInstallation(id: string): Promise<InstallationRecord | null>;
  listInstallations(userId: string | null, offset: number, limit: number): Promise<{ values: InstallationRecord[]; total: number }>;
}
export interface InstallationSession extends InstallationAccess {
  lockInstallations(): Promise<void>;
  saveInstallation(installation: InstallationRecord): Promise<void>;
  getTokenOwner(scope: string): Promise<InstallationRecord | null>;
  getInstallationReplay(id: string, requestId: string): Promise<InstallationReplay | null>;
  saveInstallationReplay(id: string, requestId: string, replay: InstallationReplay): Promise<void>;
}
export interface InstallationStore {
  transaction<T>(work: (session: InstallationSession & { getUserByExternalId(id: string): Promise<{ id: string } | null> }) => Promise<T>): Promise<T>;
  withReadSnapshot<T>(work: (session: InstallationAccess) => Promise<T>): Promise<T>;
}

export async function retireInstallationToken(session: Pick<InstallationSession, "getInstallation" | "saveInstallation">, captured: { installationId: string; tokenRevision: number; tokenScope: string }): Promise<boolean> {
  const record = await session.getInstallation(captured.installationId);
  if (!record || record.tokenRevision !== captured.tokenRevision || record.tokenScope !== captured.tokenScope) return false;
  record.token = null;
  record.tokenScope = null;
  record.tokenRevision++;
  record.revision++;
  await session.saveInstallation(record);
  return true;
}
