import { z } from "zod";
import type { LaunchReadiness } from "@galinum/core";
import type { ProductCampaign, ProductStore, ProductStoreAccess, ProductStoreSession } from "../local-product.js";
import type { ActivationRepository, ActivationSession, StockPreparation, PreparationPersistence } from "./store.js";
import { activationDigest } from "./requirements.js";
import { ActivationError, markDue } from "./service.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const change = z.discriminatedUnion("kind", [
  z.object({ sourceId: z.string().min(1).max(128), kind: z.literal("commit"), sha }).strict(),
  z.object({ sourceId: z.string().min(1).max(128), kind: z.literal("pull_request"), number: z.number().int().positive(), shas: z.array(sha).min(1).max(250) }).strict(),
]);
const sourceChanges = z.object({ expectedRevision: z.string().min(1).optional(), changes: z.array(change).max(100) }).strict();
const emptyPreparation: StockPreparation = { version: 0, changes: [], approvedBy: null, approvedAt: null, reviewedContentHash: null };
export async function preparedSources(data: PreparationPersistence, campaignId: string) {
  const value = await data.preparation(campaignId) ?? emptyPreparation;
  return { revision: String(value.version), changes: value.changes };
}
export function parseSourceChanges(input: unknown) {
  const parsed = sourceChanges.safeParse(input);
  if (!parsed.success) throw new ActivationError(400, "Invalid sourceChanges.");
  const changes = parsed.data.changes.map((value) => value.kind === "pull_request" ? { ...value, shas: [...new Set(value.shas)].sort() } : value);
  if (new Set(changes.map(activationDigest)).size !== changes.length) throw new ActivationError(400, "Duplicate source change.");
  return { ...parsed.data, changes };
}
export async function saveSourceChanges(data: PreparationPersistence, campaignId: string, input: unknown,
  options: { create: boolean; owner: "stock" | "source" }): Promise<void> {
  if (input === undefined) return;
  if (options.owner !== "stock") throw new ActivationError(409, "This campaign's sources are managed by its preparation owner.");
  const parsed = parseSourceChanges(input);
  const current = await data.preparation(campaignId) ?? emptyPreparation;
  if (options.create ? parsed.expectedRevision !== undefined : parsed.expectedRevision !== String(current.version)) {
    throw new ActivationError(409, "Source preparation changed. Refresh before saving.");
  }
  const sources = await data.sources();
  if (parsed.changes.some((value) => !sources.some((source) => source.id === value.sourceId))) throw new ActivationError(400, "Source not found.");
  await data.savePreparation(campaignId, { ...current, version: current.version + 1, changes: parsed.changes });
}
export type StockSessionOptions = {
  operatorSubject: string;
  providerConfigured: boolean;
  definition: (campaign: ProductCampaign) => Record<string, unknown>;
  readiness: (store: ProductStoreAccess, campaign: ProductCampaign) => Promise<LaunchReadiness>;
};
export function createStockSession(store: ProductStoreAccess, options: StockSessionOptions): ActivationSession {
  const data = store.activation;
  const writable = () => {
    if (!("saveCampaignLifecycle" in store)) throw new Error("A writable product session is required.");
    return store as ProductStoreSession;
  };
  const sources = async () => (await data.sources()).map((source) => ({ ...source, available: options.providerConfigured }));
  const session: ActivationSession = {
    settings: () => data.settings(), saveSettings: (value) => data.saveSettings(value),
    mappings: () => data.mappings(), saveMapping: (value) => data.saveMapping(value), deleteMapping: (id) => data.deleteMapping(id),
    state: (id) => data.state(id), saveState: (id, value) => data.saveState(id, value),
    warnings: (id) => data.warnings(id), insertWarning: (id, value) => data.insertWarning(id, value),
    campaignIds: (after, limit) => store.listActivationCampaignIds(after, limit),
    async lockCampaigns(ids) { for (const id of [...ids].sort()) await writable().getCampaignForUpdate(id); },
    sources,
    projectPaused: async () => (await data.controls()).paused,
    async campaign(id) {
      const campaign = await store.getCampaign(id);
      if (!campaign) return null;
      const preparation = await data.preparation(id) ?? emptyPreparation;
      const definition = options.definition(campaign);
      const catalog = await sources();
      const changes = preparation.changes.map((value) => ({ ...value, id: activationDigest({ campaignId: id, version: preparation.version, change: value }) }));
      const requirements = changes.map((value) => ({ id: value.id, sourceId: value.sourceId, label: value.kind === "commit" ? value.sha.slice(0, 12) : `PR #${value.number}`, mappingIds: [] as string[] }));
      const sourceFacts = [...new Set(changes.map((value) => value.sourceId))].map((id) => {
        const source = catalog.find((value) => value.id === id);
        return { id, state: !source || !source.enabled || !source.available ? "unavailable" as const : source.paused ? "paused" as const : "ready" as const };
      });
      return { id, status: campaign.status, channel: campaign.channel, startedAt: campaign.startedAt, endedAt: campaign.endedAt,
        deliverUntil: campaign.deliverUntil, contentHash: activationDigest(definition), definition,
        preparationRevision: String(preparation.version), approval: preparation.approvedAt !== null && preparation.approvedBy !== null && preparation.reviewedContentHash !== null ? "approved" : "pending", withdrawn: false,
        requirements: { changes, requirements, sources: sourceFacts, digest: activationDigest({ changes, requirements, sources: sourceFacts }) } };
    },
    async readiness(campaign) {
      const current = await store.getCampaign(campaign.id);
      return current ? options.readiness(store, current) : { ok: false, error: "Campaign not found." };
    },
    async saveLifecycle(id, value) {
      const current = await writable().getCampaignForUpdate(id);
      if (!current) throw new ActivationError(404, "Campaign not found.");
      await writable().saveCampaignLifecycle({ ...current, ...value });
    },
    async appendActivity(value) { await writable().getOrCreateAgentRun({ ...value, goalId: null, input: null }); },
    async authorizeOperator(subject) { if (subject !== options.operatorSubject) throw new ActivationError(403, "Operator authority is required."); },
    async approveCampaign(id, receipt) {
      const current = await data.preparation(id) ?? emptyPreparation;
      await data.savePreparation(id, { ...current, approvedBy: receipt.subject, approvedAt: receipt.approvedAt, reviewedContentHash: receipt.contentHash });
    },
  };
  return session;
}
export function createStockRepository(store: ProductStore, projectId: string, options: StockSessionOptions): ActivationRepository {
  const checkProject = (id: string) => { if (id !== projectId) throw new ActivationError(404, "Project not found."); };
  return {
    transaction(id, work) { checkProject(id); return store.transaction(async (transaction) => { await transaction.lockInstallations(); return work(createStockSession(transaction, options)); }); },
    snapshot(id, work) { checkProject(id); return store.withReadSnapshot((snapshot) => work(createStockSession(snapshot, options))); },
    async dueProjects(now, limit) {
      if (limit < 1) return [];
      const settings = await store.activation.settings();
      return !settings || (settings.nextAttemptAt <= now && (!settings.leaseExpiresAt || settings.leaseExpiresAt <= now)) ? [projectId] : [];
    },
  };
}
export async function invalidateStockDefinition(store: ProductStoreSession, options: StockSessionOptions) {
  await markDue(createStockSession(store, options));
}
