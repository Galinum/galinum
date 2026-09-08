import type { InstallationRecord, InstallationSession } from "@galinum/core";
import type { PushContent, PushSettings, PushCredential, PushCommand, PushEnvelope } from "@galinum/contracts";
export type { PushContent, PushSettings, PushCredential, PushCommand, PushEnvelope } from "@galinum/contracts";
export interface CredentialRecord { id: string; appId: string; platform: "ios" | "android"; environment: "development" | "production"; revision: number; encrypted: string; validation: "local_valid" }
export interface PushCampaign { id: string; active: boolean; ended: boolean; goalId: string | null; from: number | null; until: number | null; fingerprint: string; settings: PushSettings; goalEvent: string | null; variants: { id: string; weight: number; content: PushContent }[] }
export interface Recipient { id: string; externalId: string; traits: Record<string, unknown> }
export interface UserPush { id: string; campaignId: string; userId: string; externalId: string; variantId: string; goalEvent: string | null; test: boolean }
export interface DeviceTarget {
  id: string; slotId: string; generation: number; replacesTargetId: string | null; campaignId: string; deliveryId: string; userId: string; externalId: string; installationId: string;
  bindingGeneration: number; tokenRevision: number; tokenScope: string; credentialId: string; credentialRevision: number;
  campaignFingerprint: string; content: PushContent; expiresAt: number; replacementKey: string | null; createdAt: number; createdOrder: number; test: boolean;
}
export interface PushAttempt { slotId: string; slotRevision: number; validUntil: number; id: string; campaignId: string; targetId: string; ordinal: number; startedAt: number; fence: string }
export type ProviderOutcome = ( { kind: "accepted"; providerId: string } | { kind: "rejected"; code: "invalid_token" | "payload" | "credential" | "transient" | "auth_refresh"; retryAfterMs?: number } | { kind: "unknown"; code: "transport" | "interrupted" } | { kind: "blocked"; code: string }) & { messageAttempted?: boolean };
export interface AttemptOutcome { slotId: string; submission: "none" | "confirmed" | "possible"; id: string; campaignId: string; attemptId: string; targetId: string; observedAt: number; result: ProviderOutcome }
export interface Observation { slotId: string | null; id: string; campaignId: string; installationId: string; bindingGeneration: number; sequence: number; command: PushCommand; digest: string; userId: string; order: number; receivedAt: number }
export interface PushConversion { id: string; campaignId: string; deliveryId: string; userId: string; eventId: string; engagementId: string; order: number; convertedAt: number }
export interface PushEvent { productEventId: string; fingerprint: string; id: string; campaignId: string; userId: string; name: string; order: number; receivedAt: number }
export type WaitReason = "campaign_paused" | "not_started" | "audience" | "consent" | "no_eligible_installation" | "personalization" | "credential_missing" | "credential_repair" | "capability_mismatch" | "assigned_variant_unavailable" | "payload_invalid" | "reservation_pending" | "installation_changed" | "serving_gate_closed";
export type WorkState = { kind: "waiting"; reason: WaitReason; checkedAt: number; recheckAt: number; delayMs: number } | { kind: "active" } | { kind: "closed"; reason: string };
export interface RecipientWork {
  id: string; campaignId: string; userId: string; externalId: string; variantId: string;
  deliveryId: string | null; inputFingerprint: string; state: WorkState; test: boolean;
  admission: { content: PushContent; definition: string; expiresAt: number; order: number } | null;
}
export type SlotState = { kind: "ready"; at: number } | { kind: "waiting"; reason: WaitReason; recheckAt: number } | { kind: "reserved"; attemptId: string; until: number } | { kind: "accepted"; acceptanceId: string } | { kind: "closed"; reason: string };
export type SlotRepair = { kind: "credential"; credentialRevision: number } | { kind: "payload"; credentialRevision: number; campaignFingerprint: string };
export interface SlotWork {
  id: string; recipientId: string; campaignId: string; userId: string; installationId: string;
  targetId: string | null; generation: number; revision: number; sequence: number; submissionsUsed: number;
  submissionNotBefore: number; repair: SlotRepair | null; uncertain: boolean; authRefreshRevision: number | null; expiresAt: number; state: SlotState; test: boolean;
}
export interface PushRecords {
  work: RecipientWork;
  queue: SlotWork;
  scan: { id: string; afterId: string | null; revision: number };
  test: { id: string; campaignId: string; requestId: string; installationId: string; targetIds: string[] };
  credential: CredentialRecord;
  delivery: UserPush;
  target: DeviceTarget;
  attempt: PushAttempt;
  outcome: AttemptOutcome;
  observation: Observation;
  conversion: PushConversion;
  event: PushEvent;
  clock: { id: string; value: number };
  cursor: { id: string; sequence: number };
}
export type RecordKind = keyof PushRecords;
export interface PushQuery {
  recipientId?: string; slotId?: string; stateKind?: string; uncertain?: boolean;
  campaignId?: string; userId?: string; targetId?: string; installationId?: string;
  replacementKey?: string; credentialId?: string; createdAfter?: number;
  goalEvent?: string; isTest?: boolean; unconverted?: boolean; engagedBefore?: number;
  afterId?: string; dueAt?: number; limit: number; offset?: number;
}
export interface PushTotals {
  users: { targeted: number; accepted: number; engaged: number; converted: number };
  devices: { targeted: number; attempts: number; accepted: number; receiptObserved: number; receiptUnknown: number; confirmedSubmissions: number; possibleSubmissions: number; preSendBlocks: number; pendingOutcomes: number; waiting: number };
  planning: { waiting: number; active: number; closed: number };
  testTargets: number;
  records: { recipients: number; slots: number; targets: number; attempts: number; outcomes: number; observations: number; conversions: number };
}
export interface PushPersistence {
  getPushRecord<K extends RecordKind>(kind: K, id: string): Promise<PushRecords[K] | null>;
  queryPushRecords<K extends RecordKind>(kind: K, query: PushQuery): Promise<PushRecords[K][]>;
  pushTotals(campaignId: string): Promise<PushTotals>;
  insertPushRecord<K extends RecordKind>(kind: K, record: PushRecords[K]): Promise<void>;
  savePushControl<K extends "credential" | "clock" | "cursor" | "queue" | "scan" | "work" | "delivery">(kind: K, record: PushRecords[K]): Promise<void>;
}
export interface PushTransaction extends Pick<InstallationSession, "lockInstallations" | "getInstallation" | "listInstallations" | "saveInstallation">, PushPersistence {
  recipient(externalId: string): Promise<Recipient | null>;
  event(user: Recipient, name: string, eventId: string, now: number, props: Record<string, unknown> | null): Promise<void>;
  campaign(id: string, now: number): Promise<PushCampaign | null>;
  recipients(campaign: PushCampaign, now: number, userId: string): Promise<Recipient[]>;
  recipientPage(campaign: PushCampaign, now: number, afterId: string | null, limit: number): Promise<{ recipients: Recipient[]; nextCursor: string | null }>;
  userDelivery(campaignId: string, userId: string, variantId: string, now: number): Promise<{ id: string; variantId: string }>;
  accepted(deliveryId: string, now: number): Promise<void>;
  converted(deliveryId: string, now: number): Promise<void>;
}
export interface PushStore { transaction<T>(work: (session: PushTransaction) => Promise<T>): Promise<T> }
export interface AcceptanceFact { id: string; projectId: string; userId: string; deliveryId: string; attemptId: string; acceptedAt: number }
export interface PushHost {
  projectId: string;
  store: PushStore;
  vault: CredentialVault | null;
  provider: PushProvider;
  maySend(transaction: PushTransaction, userId: string, now: number): Promise<boolean>;
  recordAcceptance(transaction: PushTransaction, fact: AcceptanceFact): Promise<void>;
  now?: () => number;
}
export interface CredentialVault { seal(credential: PushCredential, scope: string): string; open(encrypted: string, scope: string): PushCredential }
export interface PushProvider { send(credential: PushCredential, installation: InstallationRecord, envelope: PushEnvelope, expiresAt: number, replacementKey: string | null, now: number): Promise<ProviderOutcome>; close?(): void }
export interface ProtocolRequest { url: string; protocol: "http2" | "https"; headers: Record<string, string>; body: string; signal?: AbortSignal }
export interface ProtocolResponse { status: number; headers: Record<string, string>; body: string }
export type ProtocolTransport = (request: ProtocolRequest) => Promise<ProtocolResponse>;
