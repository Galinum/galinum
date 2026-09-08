import type { ActivationEvidence, ActivationInput, ActivationReceipt, CampaignActivationView, CampaignSourceChange, LaunchMode, LaunchReadiness, ShippingWarning } from "@galinum/core";
import type { ShippingChange, ShippingObservation, ShippingSnapshot } from "../github/types.js";

export type ActivationRequirements = {
  changes: ShippingChange[];
  requirements: ActivationInput["requirements"];
  sources: ActivationInput["sources"];
  digest: string;
};

export type ActivationSource = {
  id: string;
  installationId: number;
  repositoryId: number;
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
  paused: boolean;
  available: boolean;
};

export type ActivationSettings = {
  defaultMode: LaunchMode;
  policyVersion: number;
  generation: number;
  nextAttemptAt: number;
  leaseToken: string | null;
  leaseGeneration: number | null;
  leaseExpiresAt: number | null;
  campaignCursor: string;
  lastError: string | null;
};

export type ActivationMapping = {
  id: string;
  installationId: number;
  repositoryId: number;
  owner: string;
  name: string;
  environment: string;
  sourceIds: string[];
  scopeDescription: string;
  confirmedBy: string;
  confirmedAt: number;
  version: number;
  generation: number;
  observed: ShippingObservation | null;
  snapshot: ShippingSnapshot | null;
  snapshotGeneration: number | null;
  checkedAt: number | null;
};

export type ActivationMonitor = {
  phase: "prepared" | "launched";
  requirements: ActivationRequirements;
  present: Record<string, ActivationEvidence>;
  missing: string[];
};

export type ActivationState = {
  modeOverride: LaunchMode | null;
  version: number;
  launch: ActivationReceipt | null;
  monitor: ActivationMonitor | null;
  readinessError: string | null;
};

export type ActivationCampaign = {
  id: string;
  status: ActivationInput["status"];
  channel: string;
  startedAt: number | null;
  endedAt: number | null;
  deliverUntil: number | null;
  contentHash: string;
  definition: Record<string, unknown>;
  preparationRevision: string;
  approval: CampaignActivationView["approval"];
  withdrawn: boolean;
  requirements: ActivationRequirements;
};

export type ActivationLifecycle = {
  status: ActivationInput["status"];
  startedAt: number | null;
  endedAt: number | null;
};

export type ActivationActivity = {
  id: string;
  campaignId: string;
  kind: "automatic_launch" | "shipping_rollback";
  output: Record<string, unknown>;
  rationale: string;
  idempotencyKey: string;
  createdAt: number;
};

export interface ActivationSession {
  settings(): Promise<ActivationSettings | null>;
  saveSettings(value: ActivationSettings): Promise<void>;
  mappings(): Promise<ActivationMapping[]>;
  saveMapping(value: ActivationMapping): Promise<void>;
  deleteMapping(id: string): Promise<void>;
  state(campaignId: string): Promise<ActivationState | null>;
  saveState(campaignId: string, value: ActivationState): Promise<void>;
  warnings(campaignId: string): Promise<ShippingWarning[]>;
  insertWarning(campaignId: string, value: ShippingWarning): Promise<void>;
  campaignIds(after: string, limit: number): Promise<string[]>;
  lockCampaigns(ids: string[]): Promise<void>;
  campaign(id: string, mappings: ActivationMapping[]): Promise<ActivationCampaign | null>;
  sources(): Promise<ActivationSource[]>;
  projectPaused(): Promise<boolean>;
  readiness(campaign: ActivationCampaign): Promise<LaunchReadiness>;
  saveLifecycle(campaignId: string, value: ActivationLifecycle): Promise<void>;
  appendActivity(value: ActivationActivity): Promise<void>;
  authorizeOperator(subject: string): Promise<void>;
  approveCampaign(campaignId: string, receipt: { subject: string; approvedAt: number; contentHash: string }): Promise<void>;
}

export interface ActivationRepository {
  transaction<T>(projectId: string, work: (session: ActivationSession) => Promise<T>): Promise<T>;
  snapshot<T>(projectId: string, work: (session: ActivationSession) => Promise<T>): Promise<T>;
  dueProjects(now: number, limit: number): Promise<string[]>;
}

export type ActivationPersistence = Pick<ActivationSession,
  "settings" | "saveSettings" | "mappings" | "saveMapping" | "deleteMapping" |
  "state" | "saveState" | "warnings" | "insertWarning">;

export type PreparedSourceChange = CampaignSourceChange;

export type StockPreparation = {
  version: number;
  changes: PreparedSourceChange[];
  approvedBy: string | null;
  approvedAt: number | null;
  reviewedContentHash: string | null;
};

export type StockSource = Omit<ActivationSource, "available"> & { version: number };
export type StockProjectControls = { paused: boolean; version: number };

export interface PreparationPersistence {
  sources(): Promise<StockSource[]>;
  saveSource(source: StockSource): Promise<void>;
  controls(): Promise<StockProjectControls>;
  saveControls(value: StockProjectControls): Promise<void>;
  preparation(campaignId: string): Promise<StockPreparation | null>;
  savePreparation(campaignId: string, value: StockPreparation): Promise<void>;
  preparationCampaignIds(after: string, limit: number): Promise<string[]>;
}

export type ProductActivationData = ActivationPersistence & PreparationPersistence;
