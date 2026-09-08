import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assessAutomaticActivation, planCampaignLifecycle, type ActivationAssessment, type CampaignActivationView,
  type LaunchMode, type LaunchPolicy, type LaunchReadiness, type CampaignLifecycleAction, type CampaignLifecycleCommand, type CampaignLifecyclePlan } from "@galinum/core";
import type { ActivationCampaign, ActivationLifecycle, ActivationMapping, ActivationRepository, ActivationSession, ActivationSettings, ActivationSource, ActivationState } from "./store.js";
import type { ShippingObservation, ShippingProvider, ShippingSnapshot } from "../github/types.js";
import { activationDigest, mappingMatchesSource, mergeShippingSnapshot, normalizeRequirements, projectCoverage, sourceCatalogBindings } from "./requirements.js";
import { launchEvidence, reduceShippingMonitor } from "./monitor.js";

export class ActivationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); this.name = "ActivationError"; }
}
export type ActivationServiceOptions = { provider?: ShippingProvider; now?: () => number; batchSize?: number; leaseMs?: number };
export type ActivationReconcileResult = { state: "complete" | "busy" | "stale"; launched: string[]; warnings: number; pending?: true };
export type CampaignReview = { campaignId: string; definition: Record<string, unknown>; requirements: CampaignActivationView["requirements"];
  sources: ActivationCampaign["requirements"]["sources"]; approval: CampaignActivationView["approval"]; revision: string };
const launchMode = z.enum(["automatic", "manual"]);
const identifier = z.string().min(1).max(128);
const revision = z.string().min(1).max(128);
const policyInput = z.object({ defaultMode: launchMode, expectedRevision: revision }).strict();
const modeInput = z.object({ mode: launchMode.nullable(), expectedRevision: revision }).strict();
const mappingInput = z.object({ id: identifier.nullable(), expectedVersion: revision.nullable(), repositoryId: z.string().regex(/^[1-9][0-9]*$/),
  environment: z.string().min(1).max(255).refine((value) => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value)),
  sourceIds: z.array(identifier).min(1).max(20), scopeDescription: z.string().trim().min(1).max(2000), confirmed: z.literal(true) }).strict();
export type ActivationMappingInput = z.input<typeof mappingInput>;
const readinessSchema = z.union([z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), error: z.string().min(1) }).strict()]);
const released = { leaseToken: null, leaseGeneration: null, leaseExpiresAt: null };
const defaults: ActivationSettings = { defaultMode: "automatic", policyVersion: 0, generation: 0, nextAttemptAt: 0,
  ...released, campaignCursor: "", lastError: null };
const emptyState: ActivationState = { modeOverride: null, version: 0, launch: null, monitor: null, readinessError: null };
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success) throw new ActivationError(400, "Invalid activation settings.");
  return value.data;
}
function policy(settings: ActivationSettings | null): LaunchPolicy { return { defaultMode: settings?.defaultMode ?? "automatic", revision: String(settings?.policyVersion ?? 0) }; }
function modeRevision(settings: ActivationSettings | null, state: ActivationState | null) { return `${settings?.policyVersion ?? 0}:${state?.version ?? 0}`; }
async function ready(session: ActivationSession, campaign: ActivationCampaign): Promise<LaunchReadiness> {
  try {
    const result = readinessSchema.safeParse(await session.readiness(campaign));
    if (result.success) return result.data;
  } catch {
    return { ok: false, error: "Launch readiness could not be verified." };
  }
  return { ok: false, error: "Launch readiness could not be verified." };
}

export async function markDue(session: ActivationSession): Promise<void> {
  const current = await session.settings() ?? defaults;
  await session.saveSettings({ ...current, generation: current.generation + 1, nextAttemptAt: 0 });
}

export async function applyObservation(session: ActivationSession, input: {
  installationId: number; repositoryId: number; environment: string; observation: ShippingObservation | null;
}): Promise<number> {
  const value = parse(z.object({ installationId: z.number().int().positive().safe(), repositoryId: z.number().int().positive().safe(),
    environment: z.string().min(1).max(255), observation: z.object({ deploymentId: z.number().int().positive().safe(),
      statusId: z.number().int().positive().safe(), statusAt: z.number().int().nonnegative().safe(), sha: z.string().regex(/^[a-f0-9]{40}$/),
      state: z.enum(["queued", "pending", "in_progress", "success", "failure", "error", "inactive"]) }).strict().nullable() }).strict(), input);
  let changed = 0;
  for (const mapping of await session.mappings()) {
    if (mapping.installationId !== value.installationId || mapping.repositoryId !== value.repositoryId || mapping.environment !== value.environment) continue;
    const old = mapping.observed; const next = value.observation;
    if (old && next && activationDigest(old) === activationDigest(next)) continue;
    const newer = next && (!old || next.statusAt > old.statusAt || (next.statusAt === old.statusAt && next.statusId > old.statusId));
    await session.saveMapping({ ...mapping, generation: mapping.generation + 1, observed: newer ? next : old });
    changed++;
  }
  if (changed) await markDue(session);
  return changed;
}

async function context(session: ActivationSession, id: string, mappings: ActivationMapping[], sourceCatalog?: ActivationSource[]) {
  const campaign = await session.campaign(id, mappings);
  if (!campaign || campaign.id !== id) throw new ActivationError(404, "Campaign not found.");
  const state = await session.state(id);
  const catalog = sourceCatalog ?? await session.sources();
  const frozen = campaign.startedAt !== null && state?.monitor?.phase === "launched" ? state.monitor.requirements : null;
  const input = frozen ? { ...frozen, sources: frozen.sources.map((source) =>
    campaign.requirements.sources.find((current) => current.id === source.id) ?? { id: source.id, state: "unavailable" as const }) } : campaign.requirements;
  const requirements = normalizeRequirements(input, mappings, catalog);
  return { campaign: { ...campaign, requirements }, state };
}
type Context = Awaited<ReturnType<typeof context>>;
function assess(current: Context, settings: ActivationSettings | null, mappings: ActivationMapping[], paused: boolean, readiness: LaunchReadiness, now: number): ActivationAssessment {
  return assessAutomaticActivation({ status: current.campaign.status, startedAt: current.campaign.startedAt,
    defaultMode: settings?.defaultMode ?? "automatic", override: current.state?.modeOverride ?? null,
    approved: current.campaign.approval === "approved", withdrawn: current.campaign.withdrawn, projectPaused: paused, readiness,
    sources: current.campaign.requirements.sources, requirements: current.campaign.requirements.requirements,
    coverage: projectCoverage(current.campaign.requirements, mappings), deliverUntil: current.campaign.deliverUntil, now });
}
async function view(session: ActivationSession, id: string, clock: () => number): Promise<CampaignActivationView> {
  const mappings = await session.mappings();
  const current = await context(session, id, mappings);
  const settings = await session.settings();
  const paused = await session.projectPaused();
  const readiness = await ready(session, current.campaign);
  const checked = mappings.filter((mapping) => current.campaign.requirements.requirements.some((requirement) => requirement.mappingIds.includes(mapping.id))).map((mapping) => mapping.checkedAt);
  return { campaignId: id, revision: modeRevision(settings, current.state), defaultMode: settings?.defaultMode ?? "automatic",
    override: current.state?.modeOverride ?? null, effectiveMode: current.state?.modeOverride ?? settings?.defaultMode ?? "automatic",
    approval: current.campaign.approval, assessment: assess(current, settings, mappings, paused, readiness, clock()),
    requirements: current.campaign.requirements.requirements, coverage: projectCoverage(current.campaign.requirements, mappings, current.campaign.startedAt === null),
    lastCheckedAt: checked.length && checked.every((value) => value !== null) ? Math.min(...checked.map(Number)) : null,
    launch: current.state?.launch ?? null, warnings: await session.warnings(id) };
}
function review(current: Context): CampaignReview {
  const { campaign } = current;
  return { campaignId: campaign.id, definition: structuredClone(campaign.definition), requirements: campaign.requirements.requirements,
    sources: campaign.requirements.sources, approval: campaign.approval,
    revision: activationDigest({ definition: campaign.definition, contentHash: campaign.contentHash,
      preparationRevision: campaign.preparationRevision, requirements: campaign.requirements }) };
}

export async function recordLaunch(session: ActivationSession, campaignId: string, mode: LaunchMode, previous: ActivationLifecycle, now = Date.now()): Promise<void> {
  if (previous.startedAt !== null) return;
  const mappings = await session.mappings();
  const current = await context(session, campaignId, mappings);
  if (current.campaign.startedAt === null || current.state?.launch || current.campaign.approval === "unavailable") return;
  const coverage = projectCoverage(current.campaign.requirements, mappings, false);
  const { monitor } = reduceShippingMonitor({ previous: current.state?.monitor ?? null, requirements: current.campaign.requirements,
    mappings, coverage, started: false, now });
  monitor.phase = "launched";
  const receipt = { mode, startedAt: current.campaign.startedAt, contentHash: current.campaign.contentHash,
    requirementsDigest: current.campaign.requirements.digest, evidence: launchEvidence(current.campaign.requirements, mappings, coverage, monitor) };
  await session.saveState(campaignId, { ...current.state ?? emptyState, launch: receipt, monitor, readinessError: null });
  if (mode === "automatic") await session.appendActivity({ id: `run_${randomUUID()}`, campaignId, kind: "automatic_launch",
    output: { ...receipt }, rationale: "Launched the approved communication after all required changes reached its confirmed production deployments.",
    idempotencyKey: `shipping:launch:${campaignId}`, createdAt: now });
}

export async function transitionCampaign(session: ActivationSession, campaignId: string, action: CampaignLifecycleAction,
  options: { now?: () => number; initialOnly?: boolean; mode?: LaunchMode } = {}): Promise<CampaignLifecyclePlan> {
  await session.lockCampaigns([campaignId]);
  const current = await session.campaign(campaignId, await session.mappings());
  if (!current) throw new ActivationError(404, "Campaign not found.");
  const clock = options.now ?? Date.now;
  let command: CampaignLifecycleCommand;
  if (action === "launch") {
    const readiness = await ready(session, current);
    if (!readiness.ok) return readiness;
    command = { action, readiness, initialOnly: options.initialOnly || options.mode === "automatic" };
    if (options.initialOnly || options.mode === "automatic") {
      const mappings = await session.mappings();
      const assessment = assess(await context(session, campaignId, mappings), await session.settings(), mappings,
        await session.projectPaused(), readiness, clock());
      if (assessment.state !== "eligible") return { ok: false, error: assessment.blockers[0]?.detail ?? "Campaign is not eligible for automatic activation." };
    }
  } else command = { action };
  const plan = planCampaignLifecycle(current, command, clock());
  if (!plan.ok) return plan;
  await session.saveLifecycle(campaignId, plan.lifecycle);
  if (plan.initial) await recordLaunch(session, campaignId, options.mode ?? "manual", current, clock());
  await markDue(session);
  return plan;
}

export function createActivationService(repository: ActivationRepository, options: ActivationServiceOptions = {}) {
  const clock = options.now ?? Date.now;
  const batchSize = options.batchSize ?? 25;
  const leaseMs = options.leaseMs ?? 180_000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100 || !Number.isFinite(leaseMs) || leaseMs < 1) throw new ActivationError(400, "Invalid activation work limits.");
  const getLaunchPolicy = (projectId: string) => repository.snapshot(projectId, async (session) => policy(await session.settings()));
  const getCampaignActivation = (projectId: string, id: string) => repository.snapshot(projectId, (session) => view(session, id, clock));
  const getCampaignReview = (projectId: string, id: string, expectedContentHash?: string) => repository.snapshot(projectId, async (session) => {
    const current = await context(session, id, await session.mappings());
    if (expectedContentHash !== undefined && current.campaign.contentHash !== expectedContentHash) {
      throw new ActivationError(409, "Campaign content changed. Refresh before reviewing.");
    }
    return review(current);
  });
  async function setLaunchPolicy(projectId: string, input: unknown, subject?: string): Promise<LaunchPolicy> {
    const value = parse(policyInput, input);
    return repository.transaction(projectId, async (session) => {
      if (subject !== undefined) await session.authorizeOperator(subject);
      const current = await session.settings() ?? defaults;
      if (String(current.policyVersion) !== value.expectedRevision) throw new ActivationError(409, "Launch settings changed. Refresh before saving.");
      await session.saveSettings({ ...current, defaultMode: value.defaultMode, policyVersion: current.policyVersion + 1 });
      await markDue(session);
      return policy(await session.settings());
    });
  }
  async function setCampaignActivation(projectId: string, id: string, input: unknown, subject?: string): Promise<CampaignActivationView> {
    const value = parse(modeInput, input);
    return repository.transaction(projectId, async (session) => {
      if (subject !== undefined) await session.authorizeOperator(subject);
      await session.lockCampaigns([id]);
      const current = await context(session, id, await session.mappings());
      if (current.campaign.status !== "draft" || current.campaign.startedAt !== null) throw new ActivationError(409, "Launch mode can change only before the first launch.");
      if (modeRevision(await session.settings(), current.state) !== value.expectedRevision) throw new ActivationError(409, "Launch settings changed. Refresh before saving.");
      await session.saveState(id, { ...current.state ?? emptyState, modeOverride: value.mode, version: (current.state?.version ?? 0) + 1 });
      await markDue(session);
      return view(session, id, clock);
    });
  }
  async function approveCampaign(projectId: string, id: string, subject: string, input: unknown): Promise<CampaignReview> {
    const value = parse(z.object({ expectedRevision: revision }).strict(), input);
    return repository.transaction(projectId, async (session) => {
      await session.authorizeOperator(subject);
      await session.lockCampaigns([id]);
      const current = await context(session, id, await session.mappings());
      if (current.campaign.status !== "draft" || current.campaign.startedAt !== null) throw new ActivationError(409, "Only an unlaunched draft can receive approval.");
      if (review(current).revision !== value.expectedRevision) throw new ActivationError(409, "Campaign content or sources changed. Refresh before approving.");
      if (current.campaign.approval !== "approved") await session.approveCampaign(id, { subject, approvedAt: clock(), contentHash: current.campaign.contentHash });
      await markDue(session);
      return review(await context(session, id, await session.mappings()));
    });
  }
  async function getShippingSettings(projectId: string) {
    return repository.snapshot(projectId, async (session) => ({ projectId, ...policy(await session.settings()),
      sources: (await session.sources()).map((source) => ({ id: source.id, repositoryId: String(source.repositoryId), repositoryName: `${source.owner}/${source.name}`,
        branch: source.branch, available: source.enabled && source.available })),
      mappings: (await session.mappings()).map((mapping) => ({ id: mapping.id, version: String(mapping.version), repositoryId: String(mapping.repositoryId),
        repositoryName: `${mapping.owner}/${mapping.name}`, environment: mapping.environment, sourceIds: mapping.sourceIds,
        scopeDescription: mapping.scopeDescription, confirmedAt: mapping.confirmedAt, lastCheckedAt: mapping.checkedAt, attention: mapping.snapshot?.reason ?? null })) }));
  }
  async function saveMapping(projectId: string, subject: string, input: unknown): Promise<string> {
    const value = parse(mappingInput, input);
    if (new Set(value.sourceIds).size !== value.sourceIds.length) throw new ActivationError(400, "Sources must be distinct.");
    return repository.transaction(projectId, async (session) => {
      await session.authorizeOperator(subject);
      const catalog = await session.sources();
      const sources = catalog.filter((source) => value.sourceIds.includes(source.id));
      const first = sources[0];
      if (sources.length !== value.sourceIds.length || !first || sources.some((source) => !source.enabled || !source.available ||
        String(source.repositoryId) !== value.repositoryId || source.installationId !== first.installationId || source.owner !== first.owner || source.name !== first.name)) {
        throw new ActivationError(409, "The selected sources must have current access to the same repository.");
      }
      const mappings = await session.mappings();
      const old = mappings.find((mapping) => mapping.id === value.id);
      if (value.id && (!old || String(old.version) !== value.expectedVersion)) throw new ActivationError(409, "Deployment settings changed. Refresh before saving.");
      if (!value.id && value.expectedVersion !== null) throw new ActivationError(400, "Invalid new deployment settings.");
      if (mappings.some((mapping) => mapping.id !== value.id && mapping.repositoryId === first.repositoryId && mapping.environment === value.environment)) throw new ActivationError(409, "This repository and environment already have deployment tracking.");
      const sameTarget = old && old.installationId === first.installationId && old.repositoryId === first.repositoryId && old.environment === value.environment;
      const mapping: ActivationMapping = { id: old?.id ?? `ghdep_${randomUUID()}`, installationId: first.installationId, repositoryId: first.repositoryId,
        owner: first.owner, name: first.name, environment: value.environment, sourceIds: [...value.sourceIds].sort(), scopeDescription: value.scopeDescription,
        confirmedBy: subject, confirmedAt: clock(), version: (old?.version ?? 0) + 1, generation: (old?.generation ?? -1) + 1,
        observed: sameTarget ? old.observed : null, snapshot: sameTarget ? old.snapshot : null, snapshotGeneration: null, checkedAt: null };
      await session.saveMapping(mapping); await markDue(session); return mapping.id;
    });
  }
  async function removeMapping(projectId: string, subject: string, input: unknown): Promise<void> {
    const value = parse(z.object({ id: identifier, expectedVersion: revision }).strict(), input);
    await repository.transaction(projectId, async (session) => {
      await session.authorizeOperator(subject);
      const mapping = (await session.mappings()).find((mapping) => mapping.id === value.id);
      if (!mapping || String(mapping.version) !== value.expectedVersion) throw new ActivationError(409, "Deployment settings changed. Refresh before removing.");
      await session.deleteMapping(value.id); await markDue(session);
    });
  }
  function fence(mappings: ActivationMapping[], contexts: Context[], bindings: ActivationSource[]) {
    return activationDigest({ bindings, mappings: mappings.map((mapping) => ({ id: mapping.id, version: mapping.version, generation: mapping.generation,
      installationId: mapping.installationId, repositoryId: mapping.repositoryId, owner: mapping.owner, name: mapping.name,
      environment: mapping.environment, sourceIds: mapping.sourceIds, observed: mapping.observed })),
      campaigns: contexts.map((current) => [current.campaign.id, current.campaign.preparationRevision, current.campaign.requirements]) });
  }
  class Expired extends Error {}
  async function reconcile(projectId: string, provider = options.provider): Promise<ActivationReconcileResult> {
    const claimed = await repository.transaction(projectId, async (session) => {
      const settings = await session.settings() ?? defaults;
      if (settings.leaseToken && settings.leaseExpiresAt !== null && settings.leaseExpiresAt > clock()) return null;
      const mappings = (await session.mappings()).sort((a, b) => a.id < b.id ? -1 : 1);
      const catalog = await session.sources();
      const bindings = sourceCatalogBindings(mappings.flatMap((mapping) => mapping.sourceIds), catalog);
      const candidates = await session.campaignIds(settings.campaignCursor, batchSize + 1);
      const ids = candidates.slice(0, batchSize);
      const contexts = [];
      for (const id of ids) contexts.push(await context(session, id, mappings, catalog));
      const token = randomUUID(); const expiresAt = clock() + leaseMs;
      await session.saveSettings({ ...settings, leaseToken: token, leaseGeneration: settings.generation, leaseExpiresAt: expiresAt, nextAttemptAt: expiresAt });
      return { settings, mappings, bindings, ids, contexts, token, expiresAt, hash: fence(mappings, contexts, bindings), more: candidates.length > batchSize };
    });
    if (!claimed) return { state: "busy", launched: [], warnings: 0 };
    const results = await Promise.all(claimed.mappings.map(async (mapping) => {
      const groups = claimed.contexts.map((current) => current.campaign.requirements.changes.filter((change) => mapping.sourceIds.includes(change.sourceId)));
      const ordered = new Map<string, ActivationCampaign["requirements"]["changes"][number]>();
      for (let index = 0; groups.some((group) => index < group.length); index++) for (const group of groups) if (group[index]) ordered.set(group[index].id, group[index]);
      const initial = claimed.contexts.filter((current) => current.campaign.status === "draft" && current.campaign.startedAt === null &&
        current.campaign.requirements.requirements.some((requirement) => requirement.mappingIds.includes(mapping.id))).map((current) => ({ id: current.campaign.id, preparationRevision: current.campaign.preparationRevision }));
      try {
        if (!provider) throw new Error("Provider unavailable");
        const bindings = claimed.bindings.filter((source) => mapping.sourceIds.includes(source.id));
        if (bindings.length !== mapping.sourceIds.length || new Set(bindings.map((source) => source.id)).size !== bindings.length ||
          bindings.some((source) => !source.enabled || !source.available || !source.branch || !mappingMatchesSource(mapping, source))) {
          throw new Error("Source binding unavailable");
        }
        const value = await provider.refresh({ scope: { installationId: mapping.installationId, repositoryId: mapping.repositoryId, owner: mapping.owner, name: mapping.name },
          environment: mapping.environment, sourceBranches: Object.fromEntries(bindings.map((source) => [source.id, source.branch])),
          scopeRevision: activationDigest({ version: mapping.version, sourceIds: mapping.sourceIds, bindings }), generation: mapping.generation,
          ...(initial.length ? { activationToken: activationDigest({ work: claimed.settings.generation, initial, bindings }) } : {}),
          changes: [...ordered.values()], previous: mapping.snapshot, observed: mapping.observed });
        return { id: mapping.id, value };
      } catch {
        const value: ShippingSnapshot = { state: "unknown", evidence: null, watermark: mapping.snapshot?.watermark ?? null, coverage: [], checkedAt: clock(), reason: "Deployment evidence could not be checked. It will be retried." };
        return { id: mapping.id, value };
      }
    }));
    try {
      return await repository.transaction(projectId, async (session): Promise<ActivationReconcileResult> => {
        const settings = await session.settings();
        if (!settings || settings.leaseToken !== claimed.token || settings.leaseGeneration !== claimed.settings.generation) return { state: "stale", launched: [], warnings: 0 };
        const mappings = (await session.mappings()).sort((a, b) => a.id < b.id ? -1 : 1);
        const catalog = await session.sources();
        const bindings = sourceCatalogBindings(mappings.flatMap((mapping) => mapping.sourceIds), catalog);
        await session.lockCampaigns([...claimed.ids].sort());
        const contexts = [];
        for (const id of claimed.ids) {
          const value = await session.campaign(id, mappings);
          if (!value) { await session.saveSettings({ ...settings, ...released, nextAttemptAt: 0 }); return { state: "stale", launched: [], warnings: 0 }; }
          contexts.push(await context(session, id, mappings, catalog));
        }
        if (clock() >= claimed.expiresAt || settings.leaseExpiresAt === null || clock() >= settings.leaseExpiresAt || fence(mappings, contexts, bindings) !== claimed.hash) {
          await session.saveSettings({ ...settings, ...released, nextAttemptAt: 0 }); return { state: "stale", launched: [], warnings: 0 };
        }
        for (const result of results) {
          const mapping = mappings.find((mapping) => mapping.id === result.id)!;
          mapping.snapshot = mergeShippingSnapshot(mapping.snapshot, result.value); mapping.snapshotGeneration = mapping.generation; mapping.checkedAt = result.value.checkedAt;
          await session.saveMapping(mapping);
        }
        const paused = await session.projectPaused();
        const launched: string[] = []; let warnings = 0;
        for (const current of contexts) {
          const readiness = await ready(session, current.campaign);
          if (clock() >= claimed.expiresAt) throw new Expired();
          const assessment = assess(current, settings, mappings, paused, readiness, clock());
          let state = { ...current.state ?? emptyState, readinessError: readiness.ok ? null : readiness.error };
          if (assessment.state === "eligible") {
            const plan = planCampaignLifecycle(current.campaign, { action: "launch", readiness, initialOnly: true }, clock());
            if (plan.ok) {
              await session.saveLifecycle(current.campaign.id, plan.lifecycle);
              await recordLaunch(session, current.campaign.id, "automatic", current.campaign, clock());
              launched.push(current.campaign.id);
              continue;
            }
          }
          const reduced = reduceShippingMonitor({ previous: state.monitor, requirements: current.campaign.requirements,
            mappings, coverage: projectCoverage(current.campaign.requirements, mappings, current.campaign.startedAt === null), started: current.campaign.startedAt !== null, now: clock() });
          state = { ...state, monitor: reduced.monitor };
          for (const warning of reduced.warnings) {
            await session.insertWarning(current.campaign.id, warning);
            await session.appendActivity({ id: `run_${randomUUID()}`, campaignId: current.campaign.id, kind: "shipping_rollback", output: { ...warning },
              rationale: `A ${warning.reason} removed changes associated with this communication from ${warning.mappingLabel}. Review the evidence and pause the communication if needed.`,
              idempotencyKey: `shipping:warning:${warning.id}:${current.campaign.id}`, createdAt: warning.createdAt });
            warnings++;
          }
          await session.saveState(current.campaign.id, state);
        }
        if (clock() >= claimed.expiresAt) throw new Expired();
        const failed = results.some((result) => result.value.state === "unknown");
        const pending = claimed.more || settings.generation !== claimed.settings.generation || results.some((result) => result.value.state === "pending" || result.value.pendingWork);
        const retryAfter = Math.max(60_000, ...results.map((result) => Number.isFinite(result.value.retryAfterMs) ? result.value.retryAfterMs ?? 0 : 0));
        await session.saveSettings({ ...settings, ...released, campaignCursor: claimed.more ? claimed.ids.at(-1)! : "",
          nextAttemptAt: settings.generation !== claimed.settings.generation ? 0 : clock() + (failed ? retryAfter : pending ? 1000 : 600_000),
          lastError: failed ? "Some deployment evidence remains unverified." : null });
        return { state: "complete", launched, warnings, ...(pending && !failed ? { pending: true as const } : {}) };
      });
    } catch (error) {
      if (!(error instanceof Expired)) throw error;
      await repository.transaction(projectId, async (session) => {
        const settings = await session.settings();
        if (settings?.leaseToken === claimed.token) await session.saveSettings({ ...settings, ...released, nextAttemptAt: 0 });
      });
      return { state: "stale", launched: [], warnings: 0 };
    }
  }
  return { getLaunchPolicy, setLaunchPolicy, getCampaignActivation, setCampaignActivation, getShippingSettings, saveMapping, removeMapping,
    getCampaignReview, approveCampaign, reconcile, markDue, applyObservation, recordLaunch: (session: ActivationSession, id: string, mode: LaunchMode, previous: ActivationLifecycle) => recordLaunch(session, id, mode, previous, clock()),
    transitionCampaign: (session: ActivationSession, id: string, action: CampaignLifecycleAction, input: { initialOnly?: boolean; mode?: LaunchMode } = {}) => transitionCampaign(session, id, action, { ...input, now: clock }) };
}
