import { beforeEach, describe, expect, it } from "vitest";
import type { LaunchReadiness, ShippingWarning } from "@galinum/core";
import { ActivationError, createActivationService, markDue, transitionCampaign } from "./service.js";
import { activationDigest } from "./requirements.js";
import type { ActivationActivity, ActivationCampaign, ActivationMapping, ActivationRepository, ActivationSession, ActivationSettings, ActivationSource, ActivationState } from "./store.js";
import type { ShippingProvider, ShippingProviderInput, ShippingSnapshot } from "../github/types.js";

const source: ActivationSource = { id: "source", installationId: 1, repositoryId: 2, owner: "example", name: "app", branch: "main", enabled: true, paused: false, available: true };
const sha = "a".repeat(40);
type FixtureData = { settings: ActivationSettings | null; mappings: Map<string, ActivationMapping>; states: Map<string, ActivationState>;
  campaigns: Map<string, ActivationCampaign>; sources: ActivationSource[]; warnings: Map<string, ShippingWarning[]>;
  activities: Map<string, ActivationActivity>; approvals: Map<string, { subject: string; approvedAt: number; contentHash: string }>;
  paused: boolean; operator: string; channels: Set<string> };
type FixtureSession = ActivationSession & { data: FixtureData };
const freshData = (): FixtureData => ({ settings: null, mappings: new Map(), states: new Map(), campaigns: new Map(), sources: [structuredClone(source)],
  warnings: new Map(), activities: new Map(), approvals: new Map(), paused: false, operator: "operator", channels: new Set(["web_inapp"]) });

class FixtureRepository implements ActivationRepository {
  projects = new Map<string, FixtureData>([["project", freshData()], ["other", freshData()]]);
  private queue: Promise<unknown> = Promise.resolve();
  transactions = 0;
  fault: "lifecycle" | "state" | "activity" | null = null;
  readiness: ((campaign: ActivationCampaign, session: ActivationSession) => Promise<unknown>) | null = null;
  read(project = "project") { return structuredClone(this.projects.get(project)!); }
  private session(data: FixtureData): FixtureSession {
    const fail = (at: typeof this.fault) => { if (this.fault === at) { this.fault = null; throw new Error(`Injected ${at} failure`); } };
    const session: FixtureSession = {
      data, settings: async () => structuredClone(data.settings), saveSettings: async (value) => { data.settings = structuredClone(value); },
      mappings: async () => structuredClone([...data.mappings.values()].sort((a, b) => a.id.localeCompare(b.id))),
      saveMapping: async (value) => { data.mappings.set(value.id, structuredClone(value)); }, deleteMapping: async (id) => { data.mappings.delete(id); },
      state: async (id) => structuredClone(data.states.get(id) ?? null), saveState: async (id, value) => { data.states.set(id, structuredClone(value)); fail("state"); },
      warnings: async (id) => structuredClone(data.warnings.get(id) ?? []), insertWarning: async (id, warning) => {
        const values = data.warnings.get(id) ?? []; if (!values.some((value) => value.id === warning.id)) values.push(structuredClone(warning)); data.warnings.set(id, values);
      },
      campaignIds: async (after, limit) => [...data.campaigns.values()].filter((campaign) => campaign.id > after && (campaign.status === "draft" || campaign.startedAt !== null))
        .map((campaign) => campaign.id).sort().slice(0, limit),
      lockCampaigns: async (ids) => { expect(ids).toEqual([...ids].sort()); },
      campaign: async (id) => structuredClone(data.campaigns.get(id) ?? null), sources: async () => structuredClone(data.sources), projectPaused: async () => data.paused,
      readiness: async (campaign) => this.readiness ? await this.readiness(campaign, session) as LaunchReadiness
        : data.channels.has(campaign.channel) && campaign.definition.name ? { ok: true } : { ok: false, error: "Channel or content is not ready." },
      saveLifecycle: async (id, lifecycle) => { Object.assign(data.campaigns.get(id)!, lifecycle); fail("lifecycle"); },
      appendActivity: async (activity) => { if (!data.activities.has(activity.idempotencyKey)) data.activities.set(activity.idempotencyKey, structuredClone(activity)); fail("activity"); },
      authorizeOperator: async (subject) => { if (subject !== data.operator) throw new ActivationError(403, "Operator access required."); },
      approveCampaign: async (id, receipt) => { data.approvals.set(id, receipt); data.campaigns.get(id)!.approval = "approved"; },
    };
    return session;
  }
  transaction<T>(project: string, work: (session: ActivationSession) => Promise<T>): Promise<T> {
    this.transactions++;
    const operation = this.queue.then(async () => {
      const data = this.read(project);
      const result = await work(this.session(data));
      this.projects.set(project, data);
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async snapshot<T>(project: string, work: (session: ActivationSession) => Promise<T>): Promise<T> { return work(this.session(this.read(project))); }
  async dueProjects(now: number, limit: number) { return [...this.projects].filter(([, data]) => (data.settings?.nextAttemptAt ?? 0) <= now).map(([id]) => id).slice(0, limit); }
  edit(work: (data: FixtureData) => void, project = "project") { return this.transaction(project, async (session) => { work((session as FixtureSession).data); }); }
}
function campaign(id = "campaign", commit = sha): ActivationCampaign {
  const definition = { name: `Feature ${id}`, variants: [{ id: "variant", name: "A", content: { body: "Feature announcement" }, weight: 100, isControl: true }] };
  return { id, status: "draft", startedAt: null, endedAt: null, deliverUntil: null, channel: "web_inapp", definition,
    contentHash: activationDigest(definition), preparationRevision: "1", approval: "pending", withdrawn: false,
    requirements: { changes: [{ id: "declared-change", kind: "commit", sourceId: source.id, sha: commit }],
      requirements: [{ id: "declared-change", sourceId: source.id, label: "Feature", mappingIds: [] }], sources: [{ id: source.id, state: "ready" }], digest: "untrusted-input-digest" } };
}
function snapshot(input: ShippingProviderInput, state: "present" | "absent" | "reverted" | "unknown" = "present", head = "1"): ShippingSnapshot {
  return { state: "current", evidence: { id: `deployment-${head}`, provider: "fixture", label: "Production", url: `https://example.test/deployments/${head}`,
    revision: head.repeat(40), reportedAt: Number(head) * 100 }, watermark: { statusAt: Number(head) * 100, statusId: Number(head) }, checkedAt: 100,
    coverage: input.changes.map((change) => ({ changeId: change.id, state, source: { state: "verified" as const } })) };
}
function gate() {
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { release, started, provider: { async refresh(input: ShippingProviderInput) { entered(); await waiting; return snapshot(input); } } };
}
let repository: FixtureRepository;
let service: ReturnType<typeof createActivationService>;
let now: number;
let mappingId: string;
const mapping = () => ({ id: null, expectedVersion: null, repositoryId: "2", environment: "Production", sourceIds: [source.id], scopeDescription: "The selected deployment ships the product.", confirmed: true });
const provider: ShippingProvider = { refresh: async (input) => snapshot(input) };
async function approve(id = "campaign") {
  const review = await service.getCampaignReview("project", id);
  return service.approveCampaign("project", id, "operator", { expectedRevision: review.revision });
}
async function manual(id = "campaign", action: "launch" | "pause" | "end" = "launch") {
  return repository.transaction("project", (session) => service.transitionCampaign(session, id, action));
}

describe("public activation transactions", () => {
  beforeEach(async () => {
    repository = new FixtureRepository(); now = 1000;
    service = createActivationService(repository, { provider, now: () => now });
    await repository.edit((data) => { data.campaigns.set("campaign", campaign()); });
    mappingId = await service.saveMapping("project", "operator", mapping());
  });
  it("records authoritative approval then atomically launches with current evidence and one receipt", async () => {
    const reviewed = await approve();
    expect(reviewed.approval).toBe("approved");
    expect(repository.read().approvals.get("campaign")).toEqual({ subject: "operator", approvedAt: 1000, contentHash: campaign().contentHash });
    expect(await service.reconcile("project")).toMatchObject({ state: "complete", launched: ["campaign"], warnings: 0 });
    const first = await service.getCampaignActivation("project", "campaign");
    expect(first.launch).toMatchObject({ mode: "automatic", startedAt: 1000, contentHash: campaign().contentHash,
      evidence: [expect.objectContaining({ id: "deployment-1" })] });
    expect(first.launch?.requirementsDigest).not.toBe("untrusted-input-digest");
    now++;
    expect((await service.reconcile("project")).launched).toEqual([]);
    expect((await service.getCampaignActivation("project", "campaign")).launch).toEqual(first.launch);
    expect(repository.read().activities.size).toBe(1);
  });
  it("keeps unapproved work pending and accepts approval during unlocked provider IO", async () => {
    await service.reconcile("project");
    expect((await service.getCampaignActivation("project", "campaign")).assessment.blockers).toContainEqual({ code: "approval" });
    const blocked = gate(); const operation = service.reconcile("project", blocked.provider);
    try { await blocked.started; await approve(); await repository.transaction("project", markDue); }
    finally { blocked.release(); }
    expect(await operation).toMatchObject({ state: "complete", launched: ["campaign"] });
  });
  it("rejects stale or forged review input and preserves the original approval after edits", async () => {
    const original = await service.getCampaignReview("project", "campaign");
    await expect(service.approveCampaign("project", "campaign", "intruder", { expectedRevision: original.revision })).rejects.toMatchObject({ status: 403 });
    await expect(service.approveCampaign("project", "campaign", "operator", { expectedRevision: original.revision, subject: "intruder" })).rejects.toMatchObject({ status: 400 });
    await repository.edit((data) => { data.campaigns.get("campaign")!.definition.name = "New content"; });
    await expect(service.approveCampaign("project", "campaign", "operator", { expectedRevision: original.revision })).rejects.toMatchObject({ status: 409 });
    await approve(); const receipt = repository.read().approvals.get("campaign");
    await repository.edit((data) => { const value = data.campaigns.get("campaign")!; value.definition.name = "Latest copy"; value.contentHash = activationDigest(value.definition); });
    await service.reconcile("project");
    expect(repository.read().approvals.get("campaign")).toEqual(receipt);
    expect((await service.getCampaignActivation("project", "campaign")).launch?.contentHash).toBe(repository.read().campaigns.get("campaign")!.contentHash);
  });
  it("does not issue an approval revision for a stale content preview", async () => {
    const shownHash = repository.read().campaigns.get("campaign")!.contentHash;
    await repository.edit(data => {
      const current = data.campaigns.get("campaign")!;
      current.definition.name = "Changed after preview";
      current.contentHash = activationDigest(current.definition);
    });
    await expect(service.getCampaignReview("project", "campaign", shownHash)).rejects.toMatchObject({ status: 409 });
    expect(repository.read().approvals.size).toBe(0);
    const current = repository.read().campaigns.get("campaign")!;
    const review = await service.getCampaignReview("project", "campaign", current.contentHash);
    await service.approveCampaign("project", "campaign", "operator", { expectedRevision: review.revision });
    expect(repository.read().approvals.get("campaign")?.contentHash).toBe(current.contentHash);
  });
  it("uses current defaults, explicit overrides and nullable inheritance with strict revisions", async () => {
    await approve(); const original = await service.getCampaignActivation("project", "campaign");
    await service.setLaunchPolicy("project", { defaultMode: "manual", expectedRevision: "0" });
    await expect(service.setCampaignActivation("project", "campaign", { mode: "automatic", expectedRevision: original.revision })).rejects.toMatchObject({ status: 409 });
    await service.reconcile("project");
    let view = await service.getCampaignActivation("project", "campaign");
    expect(view.assessment.blockers).toContainEqual({ code: "manual" });
    view = await service.setCampaignActivation("project", "campaign", { mode: "manual", expectedRevision: view.revision });
    await service.setLaunchPolicy("project", { defaultMode: "automatic", expectedRevision: "1" });
    expect((await service.reconcile("project")).launched).toEqual([]);
    view = await service.getCampaignActivation("project", "campaign");
    await service.setCampaignActivation("project", "campaign", { mode: null, expectedRevision: view.revision });
    expect((await service.reconcile("project")).launched).toEqual(["campaign"]);
  });
  it.each(["paused", "pending", "unavailable", "project", "withdrawn", "unmapped", "empty"])("honors current %s safety", async (kind) => {
    await approve();
    await repository.edit((data) => {
      const value = data.campaigns.get("campaign")!;
      if (kind === "project") data.paused = true;
      else if (kind === "withdrawn") value.withdrawn = true;
      else if (kind === "unmapped") data.mappings.clear();
      else if (kind === "empty") value.requirements = { changes: [], requirements: [], sources: [], digest: "" };
      else value.requirements.sources[0].state = kind as "paused" | "pending" | "unavailable";
    });
    expect((await service.reconcile("project")).launched).toEqual([]);
    expect(repository.read().campaigns.get("campaign")!.startedAt).toBeNull();
    expect((await service.getCampaignActivation("project", "campaign")).assessment.state).toBe("waiting");
  });
  it.each([undefined, null, { ok: false, error: "Not verified" }, { ok: "true" }, { ok: true, unexpected: true }])("never launches on missing or malformed readiness %j", async (readiness) => {
    await approve(); repository.readiness = async () => readiness;
    expect((await service.reconcile("project")).launched).toEqual([]);
    expect((await service.getCampaignActivation("project", "campaign")).assessment.blockers).toContainEqual(expect.objectContaining({ code: "readiness" }));
    expect(repository.read().campaigns.get("campaign")!.status).toBe("draft");
  });
  it("obtains actual readiness under the final transaction and recovers without changing deployment", async () => {
    await approve(); await repository.edit((data) => { data.channels.clear(); });
    await service.reconcile("project"); const first = await service.getCampaignActivation("project", "campaign");
    expect(first.assessment.state).toBe("waiting");
    await repository.edit((data) => { data.channels.add("web_inapp"); });
    expect((await service.reconcile("project")).launched).toEqual(["campaign"]);
    expect(repository.read().states.get("campaign")!.version).toBe(0);
  });
  it("contains throwing readiness and rechecks expiry after readiness waits", async () => {
    await approve(); repository.readiness = async () => { throw new Error("Provider secret"); };
    await service.reconcile("project");
    expect((await service.getCampaignActivation("project", "campaign")).assessment.blockers).toContainEqual({ code: "readiness", detail: "Launch readiness could not be verified." });
    await repository.edit((data) => { data.campaigns.get("campaign")!.deliverUntil = 2000; });
    repository.readiness = async () => { now = 2000; return { ok: true }; };
    expect((await service.reconcile("project")).launched).toEqual([]);
    expect(repository.read().campaigns.get("campaign")!.startedAt).toBeNull();
  });
  it.each(["lifecycle", "state", "activity"] as const)("rolls back after a %s write failure and retries exactly once", async (fault) => {
    await approve(); repository.fault = fault;
    await expect(service.reconcile("project")).rejects.toThrow(`Injected ${fault} failure`);
    expect(repository.read().campaigns.get("campaign")!.status).toBe("draft");
    expect(repository.read().states.get("campaign")?.launch ?? null).toBeNull();
    expect(repository.read().activities.size).toBe(0);
    now += 180_001;
    expect((await service.reconcile("project")).launched).toEqual(["campaign"]);
    expect(repository.read().activities.size).toBe(1);
  });
  it.each(["source", "mapping", "lease"])("fences changed %s while provider reads are in flight", async (kind) => {
    await approve(); const blocked = gate(); const operation = service.reconcile("project", blocked.provider);
    try {
      await blocked.started;
      expect((await service.reconcile("project")).state).toBe("busy");
      await repository.edit((data) => {
        if (kind === "source") { const change = data.campaigns.get("campaign")!.requirements.changes[0]; if (change.kind === "commit") change.sha = "b".repeat(40); }
        if (kind === "mapping") data.mappings.get(mappingId)!.generation++;
        if (kind === "lease") data.settings!.leaseToken = "new-worker";
      });
    } finally { blocked.release(); }
    expect(await operation).toMatchObject({ state: "stale", launched: [] });
    expect(repository.read().campaigns.get("campaign")!.status).toBe("draft");
  });
  it("captures source branches and rejects a branch-only rebind until fresh provider proof", async () => {
    await approve();
    const before = repository.read().campaigns.get("campaign")!;
    const blocked = gate(); const requests: ShippingProviderInput[] = [];
    const capturing: ShippingProvider = { refresh: async (input) => { requests.push(structuredClone(input)); return blocked.provider.refresh(input); } };
    const operation = service.reconcile("project", capturing);
    try {
      await blocked.started;
      expect(requests[0].sourceBranches).toEqual({ source: "main" });
      await repository.edit((data) => { data.sources[0].branch = "release/next"; });
    } finally { blocked.release(); }
    expect(await operation).toMatchObject({ state: "stale", launched: [] });
    const after = repository.read().campaigns.get("campaign")!;
    expect(after.requirements).toEqual(before.requirements);
    expect(after.preparationRevision).toBe(before.preparationRevision);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.startedAt).toBeNull();
    expect(repository.read().states.get("campaign")?.launch ?? null).toBeNull();
    expect(repository.read().mappings.get(mappingId)!.snapshot).toBeNull();
    expect(await service.reconcile("project", { refresh: async (input) => { requests.push(structuredClone(input)); return snapshot(input); } })).toMatchObject({ launched: ["campaign"] });
    expect(requests[1].sourceBranches).toEqual({ source: "release/next" });
    expect(requests[1].scope).toEqual(requests[0].scope);
    expect(requests[1].changes).toEqual(requests[0].changes);
    expect(requests[1].scopeRevision).not.toBe(requests[0].scopeRevision);
    expect(requests[1].activationToken).not.toBe(requests[0].activationToken);
    expect(repository.read().activities.size).toBe(1);
  });

  it.each<Partial<ActivationSource>>([
    { installationId: 99 }, { repositoryId: 99 }, { owner: "another" }, { name: "other" }, { available: false }, { enabled: false },
  ])("fences changed catalog identity or access %j and refuses an incompatible fresh scope", async (patch) => {
    await approve(); const blocked = gate();
    let calls = 0;
    const tracking: ShippingProvider = { refresh: async (input) => { calls++; return blocked.provider.refresh(input); } };
    const operation = service.reconcile("project", tracking);
    try { await blocked.started; await repository.edit((data) => { Object.assign(data.sources[0], patch); }); }
    finally { blocked.release(); }
    expect(await operation).toMatchObject({ state: "stale", launched: [] });
    expect((await service.reconcile("project", tracking)).launched).toEqual([]);
    expect(calls).toBe(1);
    expect(repository.read().campaigns.get("campaign")!.startedAt).toBeNull();
  });

  it("fences every selected mapping source even when only one contributes current campaign requirements", async () => {
    await repository.edit((data) => { data.sources.push({ ...source, id: "secondary", branch: "support" }); });
    const configured = (await service.getShippingSettings("project")).mappings[0];
    await service.saveMapping("project", "operator", { ...mapping(), id: configured.id, expectedVersion: configured.version, sourceIds: [source.id, "secondary"] });
    await approve(); const blocked = gate();
    let captured: ShippingProviderInput | undefined;
    const operation = service.reconcile("project", { refresh: async (input) => { captured = input; return blocked.provider.refresh(input); } });
    try { await blocked.started; await repository.edit((data) => { data.sources.find((value) => value.id === "secondary")!.branch = "support-next"; }); }
    finally { blocked.release(); }
    expect(captured?.sourceBranches).toEqual({ source: "main", secondary: "support" });
    expect(await operation).toMatchObject({ state: "stale", launched: [] });
  });

  it("fences replacement preparation revisions even when content and requirements are identical", async () => {
    await approve();
    const before = repository.read().campaigns.get("campaign")!;
    const blocked = gate(); const operation = service.reconcile("project", blocked.provider);
    try {
      await blocked.started;
      await repository.edit((data) => { data.campaigns.get("campaign")!.preparationRevision = "2"; });
    } finally { blocked.release(); }
    expect(await operation).toMatchObject({ state: "stale", launched: [] });
    const after = repository.read().campaigns.get("campaign")!;
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.requirements).toEqual(before.requirements);
    expect(after.startedAt).toBeNull();
    expect(repository.read().states.get("campaign")?.launch ?? null).toBeNull();
    expect((await service.reconcile("project")).launched).toEqual(["campaign"]);
    expect(repository.read().activities.size).toBe(1);
  });
  it("rejects automatic helper use without approval while allowing an authorized manual launch", async () => {
    expect(await repository.transaction("project", (session) => transitionCampaign(session, "campaign", "launch", { initialOnly: true, now: () => now }))).toMatchObject({ ok: false });
    expect(await manual()).toMatchObject({ ok: true, initial: true });
    expect((await service.getCampaignActivation("project", "campaign")).launch?.mode).toBe("manual");
  });
  it("lets manual launch win during provider IO without duplicating the initial receipt", async () => {
    await approve(); const blocked = gate(); const operation = service.reconcile("project", blocked.provider);
    try { await blocked.started; expect(await manual()).toMatchObject({ ok: true }); }
    finally { blocked.release(); }
    expect((await operation).launched).toEqual([]);
    expect((await service.getCampaignActivation("project", "campaign")).launch?.mode).toBe("manual");
    expect(repository.read().activities.size).toBe(0);
  });
  it.each(["pause", "end"] as const)("monitors a manually launched campaign after %s without changing lifecycle", async (action) => {
    await service.reconcile("project"); await manual(); await manual("campaign", action);
    const before = repository.read().campaigns.get("campaign");
    const loss: ShippingProvider = { refresh: async (input) => snapshot(input, "absent", "2") };
    expect((await service.reconcile("project", loss)).warnings).toBe(1);
    expect((await service.reconcile("project", loss)).warnings).toBe(0);
    expect(repository.read().campaigns.get("campaign")).toEqual(before);
    expect(repository.read().warnings.get("campaign")).toHaveLength(1);
  });
  it.each(["absent", "reverted"] as const)("warns on deployed %s after the source branch moves, while the same unlaunched change remains blocked", async (loss) => {
    await approve(); await service.reconcile("project");
    const before = repository.read().campaigns.get("campaign");
    await repository.edit((data) => {
      const draft = campaign("unlaunched"); draft.approval = "approved"; data.campaigns.set(draft.id, draft);
      data.sources[0].branch = "release/new";
    });
    const changed: ShippingProvider = { refresh: async (input) => {
      expect(input.sourceBranches).toEqual({ source: "release/new" });
      const value = snapshot(input, loss, "2");
      value.coverage = value.coverage.map((coverage) => ({ ...coverage, source: { state: "unknown", reason: "Configured branch no longer contains this change." } }));
      return value;
    } };
    expect(await service.reconcile("project", changed)).toMatchObject({ launched: [], warnings: 1 });
    expect(repository.read().campaigns.get("campaign")).toEqual(before);
    const launched = await service.getCampaignActivation("project", "campaign");
    expect(launched.coverage[0].state).toBe(loss);
    expect(launched.warnings).toEqual([expect.objectContaining({ reason: loss === "absent" ? "rollback" : "revert", evidence: expect.objectContaining({ id: "deployment-2" }) })]);
    const draft = await service.getCampaignActivation("project", "unlaunched");
    expect(draft.coverage[0]).toMatchObject({ state: "unknown", reason: "Configured branch no longer contains this change." });
    expect(draft.assessment.blockers).toContainEqual(expect.objectContaining({ code: "evidence_unknown" }));
    expect(repository.read().campaigns.get("unlaunched")!.startedAt).toBeNull();
    expect((await service.reconcile("project", changed)).warnings).toBe(0);
  });

  it.each(["missing", "unknown"] as const)("requires %s source qualification initially without granting prepared presence", async (qualification) => {
    await approve();
    const unqualified: ShippingProvider = { refresh: async (input) => {
      const value = snapshot(input);
      value.coverage = value.coverage.map((coverage) => {
        if (qualification === "unknown") return { ...coverage, source: { state: "unknown", reason: "Source membership is not established." } };
        const missing = { ...coverage } as Partial<typeof coverage>;
        delete missing.source;
        return missing as typeof coverage;
      });
      return value;
    } };
    expect((await service.reconcile("project", unqualified)).launched).toEqual([]);
    expect((await service.getCampaignActivation("project", "campaign")).assessment.blockers).toContainEqual(expect.objectContaining({ code: "evidence_unknown" }));
    expect(repository.read().states.get("campaign")!.monitor!.present).toEqual({});
  });

  it("records actual deployed presence at manual launch even when source qualification is unknown", async () => {
    const unqualified: ShippingProvider = { refresh: async (input) => {
      const value = snapshot(input);
      value.coverage = value.coverage.map((coverage) => ({ ...coverage, source: { state: "unknown", reason: "Source branch cannot verify this change." } }));
      return value;
    } };
    await service.reconcile("project", unqualified);
    expect(repository.read().states.get("campaign")!.monitor!.present).toEqual({});
    expect(await manual()).toMatchObject({ ok: true });
    const launched = await service.getCampaignActivation("project", "campaign");
    expect(launched.coverage[0].state).toBe("present");
    expect(launched.launch?.evidence).toEqual([expect.objectContaining({ id: "deployment-1" })]);
    expect(Object.keys(repository.read().states.get("campaign")!.monitor!.present)).toHaveLength(1);
    expect((await service.reconcile("project", { refresh: async (input) => ({ ...snapshot(input, "unknown", "2"), state: "unknown" }) })).warnings).toBe(0);
    expect((await service.getCampaignActivation("project", "campaign")).warnings).toEqual([]);
  });

  it("does not invent a historical receipt for previously started campaigns", async () => {
    await repository.edit((data) => { Object.assign(data.campaigns.get("campaign")!, { status: "running", startedAt: 50 }); });
    await service.reconcile("project");
    expect((await service.getCampaignActivation("project", "campaign")).launch).toBeNull();
    expect(repository.read().states.get("campaign")!.monitor!.phase).toBe("launched");
  });
  it("keeps monitor requirements frozen only after the actual first launch", async () => {
    await service.reconcile("project");
    await repository.edit((data) => { data.campaigns.set("campaign", campaign("campaign", "b".repeat(40))); });
    await service.reconcile("project"); await manual();
    const frozen = repository.read().states.get("campaign")!.monitor!.requirements;
    await repository.edit((data) => { data.campaigns.get("campaign")!.requirements = campaign("campaign", "c".repeat(40)).requirements; });
    await service.reconcile("project");
    expect(repository.read().states.get("campaign")!.monitor!.requirements.changes).toEqual(frozen.changes);
  });
  it("checks every required mapping and treats contradictory duplicate coverage as unknown", async () => {
    await approve(); await service.saveMapping("project", "operator", { ...mapping(), environment: "Worker" });
    expect((await service.reconcile("project", { refresh: async (input) => snapshot(input, input.environment === "Worker" ? "absent" : "present") })).launched).toEqual([]);
    expect((await service.reconcile("project", { refresh: async (input) => { const value = snapshot(input); value.coverage.push({ ...value.coverage[0], state: "reverted" }); return value; } })).launched).toEqual([]);
    expect((await service.getCampaignActivation("project", "campaign")).assessment.blockers).toContainEqual(expect.objectContaining({ code: "evidence_unknown" }));
  });
  it("retains 26 distinct requirements through pending page evidence and permits later manual rollback monitoring", async () => {
    await repository.edit((data) => {
      data.campaigns.clear();
      for (let index = 0; index < 26; index++) { const id = `campaign-${String(index).padStart(2, "0")}`; data.campaigns.set(id, campaign(id, (index + 1).toString(16).padStart(40, "0"))); }
    });
    await service.reconcile("project");
    let second: ShippingSnapshot["coverage"] = [];
    await service.reconcile("project", { refresh: async (input) => { second = snapshot(input).coverage; return { state: "pending", evidence: null, watermark: input.previous?.watermark ?? null, coverage: [], checkedAt: now }; } });
    expect((await service.getCampaignActivation("project", "campaign-00")).coverage[0].state).toBe("pending");
    await service.reconcile("project", { refresh: async (input) => ({ ...snapshot(input), coverage: second }) });
    expect((await service.getCampaignActivation("project", "campaign-00")).coverage[0].state).toBe("present");
    await manual("campaign-00");
    const loss: ShippingProvider = { refresh: async (input) => snapshot(input, "absent", "2") };
    const rounds = [await service.reconcile("project", loss), await service.reconcile("project", loss)];
    expect(rounds.reduce((total, result) => total + result.warnings, 0)).toBe(1);
  });
  it("advances beyond 25 campaigns despite repeated due marks", async () => {
    await repository.edit((data) => {
      data.campaigns.clear();
      for (let index = 0; index < 51; index++) { const value = campaign(String(index).padStart(3, "0")); value.approval = "approved"; data.campaigns.set(value.id, value); }
    });
    for (const size of [25, 25, 1]) { await repository.transaction("project", markDue); expect((await service.reconcile("project")).launched).toHaveLength(size); }
    expect([...repository.read().campaigns.values()].every((campaign) => campaign.startedAt === now)).toBe(true);
    expect(repository.read().activities.size).toBe(51);
  });
  it("rechecks operator authority and current sources on mapping writes", async () => {
    await expect(service.saveMapping("other", "wrong", mapping())).rejects.toMatchObject({ status: 403 });
    await expect(service.saveMapping("project", "operator", { ...mapping(), sourceIds: ["foreign"] })).rejects.toMatchObject({ status: 409 });
    await expect(service.saveMapping("project", "operator", { ...mapping(), confirmedBy: "operator" })).rejects.toMatchObject({ status: 400 });
    const before = (await service.getShippingSettings("project")).mappings[0];
    await service.saveMapping("project", "operator", { ...mapping(), id: before.id, expectedVersion: before.version, scopeDescription: "Updated description" });
    await expect(service.removeMapping("project", "operator", { id: before.id, expectedVersion: before.version })).rejects.toMatchObject({ status: 409 });
    expect((await service.getShippingSettings("other")).mappings).toEqual([]);
  });
  it("keeps observation watermarks monotonic and exact current replays idempotent", async () => {
    const observation = { deploymentId: 3, statusId: 3, statusAt: 300, sha, state: "success" as const };
    const input = { installationId: source.installationId, repositoryId: source.repositoryId, environment: "Production", observation };
    expect(await repository.transaction("project", (session) => service.applyObservation(session, input))).toBe(1);
    const settings = repository.read().settings;
    expect(await repository.transaction("project", (session) => service.applyObservation(session, input))).toBe(0);
    expect(repository.read().settings).toEqual(settings);
    expect(await repository.transaction("project", (session) => service.applyObservation(session, { ...input, observation: { ...observation, deploymentId: 2, statusId: 2, statusAt: 200 } }))).toBe(1);
    expect(repository.read().mappings.get(mappingId)!.observed).toEqual(observation);
    expect(repository.read().settings!.generation).toBe(settings!.generation + 1);
    expect(await repository.transaction("other", (session) => service.applyObservation(session, input))).toBe(0);
  });
  it("rolls back all prior launches when the lease expires during a later readiness check", async () => {
    await approve(); await repository.edit((data) => { const next = campaign("second"); next.approval = "approved"; data.campaigns.set(next.id, next); });
    repository.readiness = async (value) => { if (value.id === "second") now += 180_000; return { ok: true }; };
    expect(await service.reconcile("project")).toMatchObject({ state: "stale", launched: [] });
    expect([...repository.read().campaigns.values()].every((value) => value.startedAt === null)).toBe(true);
    expect(repository.read().activities.size).toBe(0);
    expect(repository.read().states.size).toBe(0);
  });
  it("rechecks operator authority after a queued revocation commits", async () => {
    let release!: () => void; let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const enteredTransaction = new Promise<void>((resolve) => { entered = resolve; });
    const revoke = repository.transaction("project", async (session) => {
      (session as FixtureSession).data.operator = "replacement"; entered(); await hold;
    });
    await enteredTransaction;
    const command = service.setLaunchPolicy("project", { defaultMode: "manual", expectedRevision: "0" }, "operator");
    const result = command.then((value) => ({ value }), (error: unknown) => ({ error }));
    release(); await revoke;
    expect(await result).toMatchObject({ error: { status: 403 } });
    expect(await service.getLaunchPolicy("project")).toEqual({ defaultMode: "automatic", revision: "0" });
  });
  it("rolls back warning and monitor changes when activity persistence fails", async () => {
    await service.reconcile("project"); await manual();
    const before = repository.read().states.get("campaign");
    repository.fault = "activity";
    const loss: ShippingProvider = { refresh: async (input) => snapshot(input, "absent", "2") };
    await expect(service.reconcile("project", loss)).rejects.toThrow("Injected activity failure");
    expect(repository.read().warnings.get("campaign") ?? []).toEqual([]);
    expect(repository.read().states.get("campaign")).toEqual(before);
    now += 180_001;
    expect((await service.reconcile("project", loss)).warnings).toBe(1);
    expect((await service.reconcile("project", loss)).warnings).toBe(0);
  });
  it("uses the caller's real readiness for manual launches without requiring shipping approval", async () => {
    await repository.edit((data) => { data.channels.clear(); data.campaigns.get("campaign")!.approval = "unavailable"; });
    expect(await manual()).toMatchObject({ ok: false });
    expect(repository.read().campaigns.get("campaign")!.startedAt).toBeNull();
    await repository.edit((data) => { data.channels.add("web_inapp"); });
    expect(await manual()).toMatchObject({ ok: true });
    expect((await service.getCampaignActivation("project", "campaign")).launch).toBeNull();
  });
  it("retains immutable history on mapping removal without inventing a rollback or restoring old tracking", async () => {
    await approve(); await service.reconcile("project");
    await service.reconcile("project", { refresh: async (input) => snapshot(input, "absent", "2") });
    const before = await service.getCampaignActivation("project", "campaign");
    expect(before.warnings).toHaveLength(1);
    const remembered = repository.read().states.get("campaign")!.monitor!.present;
    await repository.edit((data) => { const draft = campaign("later"); draft.approval = "approved"; data.campaigns.set(draft.id, draft); });
    const configured = (await service.getShippingSettings("project")).mappings[0];
    await service.removeMapping("project", "operator", { id: configured.id, expectedVersion: configured.version });
    expect(await service.reconcile("project")).toMatchObject({ launched: [], warnings: 0 });
    const after = await service.getCampaignActivation("project", "campaign");
    expect(after.launch).toEqual(before.launch); expect(after.warnings).toEqual(before.warnings);
    expect(repository.read().states.get("campaign")!.monitor!.present).toEqual(remembered);
    expect((await service.getCampaignActivation("project", "later")).assessment.blockers).toContainEqual(expect.objectContaining({ code: "mapping" }));
    const replacement = await service.saveMapping("project", "operator", mapping());
    expect(replacement).not.toBe(configured.id);
    expect((await service.reconcile("project", { refresh: async (input) => snapshot(input, "absent", "3") })).warnings).toBe(0);
    expect((await service.getCampaignActivation("project", "campaign")).warnings).toEqual(before.warnings);
  });
  it("enlists borrowed helpers without opening another root transaction", async () => {
    const before = repository.transactions;
    await repository.transaction("project", async (session) => { await service.markDue(session); await service.transitionCampaign(session, "campaign", "launch"); });
    expect(repository.transactions).toBe(before + 1);
    expect(repository.read().states.get("campaign")!.launch?.mode).toBe("manual");
  });
});
