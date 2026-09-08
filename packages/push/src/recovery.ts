import { randomUUID, createHash } from "node:crypto";
import { pickVariant, selectInstallations, retireInstallationToken, type InstallationRecord } from "@galinum/core";
import { personalize, supportsPushContent } from "./content.js";
import { compilePayload } from "./providers.js";
import { digest, nextOrder, PushError } from "./identity.js";
import type { PushHost, PushTransaction, PushCampaign, Recipient, RecipientWork, SlotWork, WaitReason, CredentialRecord, DeviceTarget, PushAttempt, ProviderOutcome, AttemptOutcome, PushEnvelope, PushContent } from "./types.js";

type Transaction<Tx extends PushTransaction> = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;
function definition(campaign: PushCampaign, variantId: string) {
  const variant = campaign.variants.find((entry) => entry.id === variantId);
  return digest({ variant: variant ? { id: variant.id, content: variant.content } : null, goalId: campaign.goalId, goalEvent: campaign.goalEvent, appId: campaign.settings.appId, selection: campaign.settings.selection, replacementKey: campaign.settings.replacementKey ?? null });
}
function wait(work: RecipientWork, reason: WaitReason, at: number, fingerprint: string) {
  const delayMs = work.state.kind === "waiting" && work.state.reason === reason && work.inputFingerprint === fingerprint ? Math.min(30000, work.state.delayMs * 2) : 1000;
  work.state = { kind: "waiting", reason, checkedAt: at, recheckAt: at + delayMs, delayMs };
  work.inputFingerprint = fingerprint;
}
function retryDelay(attempt: PushAttempt, result: ProviderOutcome) {
  return Math.max(1000 * 2 ** Math.min(attempt.ordinal - 1, 5) + parseInt(digest(attempt.id).slice(0, 4), 16) % 250, result.kind === "rejected" ? result.retryAfterMs ?? 0 : 0);
}
export function createRecovery<Tx extends PushTransaction>(host: PushHost<Tx>, transaction: Transaction<Tx>) {
  const now = host.now ?? Date.now;
  const scope = (id: string) => `${host.projectId}:${id}`;
  async function credential(tx: Tx, installation: InstallationRecord) {
    const record = await tx.getPushRecord("credential", digest([installation.appId, installation.platform, installation.environment]));
    if (!record) return { record: null, reason: "credential_missing" as const };
    try { host.vault?.open(record.encrypted, scope(record.id)); if (!host.vault) throw new Error(); }
    catch { return { record, reason: "credential_repair" as const }; }
    return { record, reason: null };
  }
  async function installations(tx: Tx, externalId: string, visit: (installation: InstallationRecord) => Promise<void>) {
    for (let offset = 0; ; offset += 100) {
      const page = await tx.listInstallations(externalId, offset, 100);
      for (const installation of page.values) await visit(installation);
      if (offset + page.values.length >= page.total) break;
    }
  }
  async function slots(tx: Tx, recipientId: string, visit: (slot: SlotWork) => Promise<void>) {
    let afterId: string | undefined;
    for (;;) {
      const page = await tx.queryPushRecords("queue", { recipientId, afterId, limit: 100 });
      for (const slot of page) await visit(slot);
      if (page.length < 100) break;
      afterId = page.at(-1)!.id;
    }
  }
  async function hold(tx: Tx, work: RecipientWork, reason: WaitReason, at: number) {
    await slots(tx, work.id, async (slot) => {
      if (["accepted", "closed", "reserved"].includes(slot.state.kind)) return;
      slot.state = { kind: "waiting", reason, recheckAt: at + 1000 }; slot.revision++;
      await tx.savePushControl("queue", slot);
    });
  }
  async function close(tx: Tx, work: RecipientWork, reason: string) {
    work.state = { kind: "closed", reason };
    await slots(tx, work.id, async (slot) => {
      if (["accepted", "closed", "reserved"].includes(slot.state.kind)) return;
      slot.state = { kind: "closed", reason }; slot.revision++; await tx.savePushControl("queue", slot);
    });
    await tx.savePushControl("work", work);
  }
  function makeReady(slot: SlotWork) {
    slot.state = { kind: "ready", at: Math.min(slot.expiresAt, Math.max(now(), slot.submissionNotBefore)) };
  }
  async function snapshot(tx: Tx, work: RecipientWork, slot: SlotWork, installation: InstallationRecord, auth: CredentialRecord) {
    const old = slot.targetId ? await tx.getPushRecord("target", slot.targetId) : null;
    const changedIdentity = !!old && (old.bindingGeneration !== installation.bindingGeneration || old.tokenRevision !== installation.tokenRevision || old.tokenScope !== installation.tokenScope);
    const changedContent = !!old && old.campaignFingerprint !== work.admission!.definition;
    if (slot.uncertain && (changedIdentity || changedContent)) { slot.state = { kind: "closed", reason: "uncertain_snapshot_changed" }; return; }
    if (!old || changedIdentity || changedContent || old.credentialRevision !== auth.revision) {
      const target: DeviceTarget = { id: randomUUID(), slotId: slot.id, generation: slot.generation + 1, replacesTargetId: slot.targetId, campaignId: work.campaignId, deliveryId: work.deliveryId!, userId: work.userId, externalId: work.externalId, installationId: installation.id, bindingGeneration: installation.bindingGeneration, tokenRevision: installation.tokenRevision, tokenScope: installation.tokenScope!, credentialId: auth.id, credentialRevision: auth.revision, campaignFingerprint: work.admission!.definition, content: work.admission!.content, expiresAt: slot.expiresAt, replacementKey: (await tx.campaign(work.campaignId, now()))!.settings.replacementKey ?? null, createdAt: now(), createdOrder: work.admission!.order, test: work.test };
      await tx.insertPushRecord("target", target);
      slot.targetId = target.id; slot.generation = target.generation; slot.revision++;
    }
    makeReady(slot);
  }
  async function reconcile(tx: Tx, campaign: PushCampaign, user: Recipient, test?: { installationId: string; requestId: string }) {
    const at = now(); const id = test ? digest(["test-work", campaign.id, test.requestId]) : digest(["recipient", campaign.id, user.id]);
    let work = await tx.getPushRecord("work", id);
    if (work?.state.kind === "closed") return [];
    if (!work) {
      if (campaign.readiness?.ok !== true) return [];
      const chosen = pickVariant(user.id, campaign.id, campaign.variants.map((entry) => ({ ...entry, campaign_id: campaign.id, content_json: JSON.stringify(entry.content) })));
      if (!chosen) throw new PushError(409, "No assignable variant");
      work = { id, campaignId: campaign.id, userId: user.id, externalId: user.externalId, variantId: chosen.id, deliveryId: null, inputFingerprint: "", admission: null, state: { kind: "active" }, test: !!test };
    }
    const current = work;
    const variant = campaign.variants.find((entry) => entry.id === current.variantId);
    const stamp = createHash("sha256").update(digest({ traits: user.traits, campaign, serving: await host.maySend(tx, user.id, at) }));
    await installations(tx, user.externalId, async (installation) => {
      const auth = await credential(tx, installation);
      stamp.update(digest({ id: installation.id, revision: installation.revision, credentialRevision: auth.record?.revision, credentialIssue: auth.reason }));
    });
    const fingerprint = stamp.digest("hex");
    if (current.state.kind === "waiting" && current.inputFingerprint === fingerprint && current.state.recheckAt > at) return [];
    const fail = async (reason: WaitReason) => {
      if (test) throw new PushError(409, reason);
      wait(current, reason, at, fingerprint); await hold(tx, current, reason, at); await tx.savePushControl("work", current); return [] as string[];
    };
    if (campaign.ended) { await close(tx, current, "campaign_ended"); return []; }
    if (current.admission) {
      current.admission.expiresAt = Math.min(current.admission.expiresAt, campaign.until ?? Infinity);
      if (at >= current.admission.expiresAt) { await close(tx, current, "delivery_expired"); return []; }
    }
    if (!test && !campaign.active) return fail(campaign.from !== null && campaign.from > at ? "not_started" : "campaign_paused");
    if (!await host.maySend(tx, user.id, at)) return fail("serving_gate_closed");
    if (!test && !(await tx.recipients(campaign, at, user.id)).length) return fail("audience");
    if (!variant) return fail("assigned_variant_unavailable");
    const currentDefinition = definition(campaign, current.variantId);
    const accepted = (await tx.queryPushRecords("queue", { recipientId: current.id, stateKind: "accepted", limit: 1 })).length > 0;
    if (current.admission && currentDefinition !== current.admission.definition) {
      if (accepted) { await close(tx, current, "content_changed_after_acceptance"); return []; }
      if ((await tx.queryPushRecords("queue", { recipientId: current.id, uncertain: true, limit: 1 })).length) { await close(tx, current, "uncertain_snapshot_changed"); return []; }
      if ((await tx.queryPushRecords("queue", { recipientId: current.id, stateKind: "reserved", limit: 1 })).length) return fail("reservation_pending");
      try { current.admission.content = personalize(variant.content, user.traits); } catch { return fail("personalization"); }
      current.admission.definition = currentDefinition;
      const delivery = await tx.getPushRecord("delivery", current.deliveryId!);
      if (!delivery) throw new Error("Push delivery is missing");
      if (delivery.goalEvent !== campaign.goalEvent) await tx.savePushControl("delivery", { ...delivery, goalEvent: campaign.goalEvent });
    }
    const created: string[] = [];
    if (!current.admission) {
      let content: PushContent;
      try { content = personalize(variant.content, user.traits); } catch { return fail("personalization"); }
      const mode = test ? { kind: "specific" as const, installationId: test.installationId } : campaign.settings.selection;
      let best: InstallationRecord | null = null;
      let hasEligible = false; let hasReady = false; let issue: WaitReason = "credential_missing";
      const eligible = (row: InstallationRecord) => row.appId === campaign.settings.appId && selectInstallations([{ ...row, hasToken: row.token !== null }], user.externalId, { kind: "all" }).length > 0 && supportsPushContent(row, content);
      const ready = async (row: InstallationRecord) => {
        const auth = await credential(tx, row);
        if (auth.reason) { issue = auth.reason; return false; }
        try { compilePayload({ version: 1, targetId: "00000000-0000-4000-8000-000000000000", attemptId: "00000000-0000-4000-8000-000000000000", installationId: row.id, bindingGeneration: row.bindingGeneration, content, test: !!test }, row.platform === "ios" ? "apns" : "fcm", Math.min(at + (campaign.settings.ttlSeconds ?? 86400) * 1000, campaign.until ?? Infinity), campaign.settings.replacementKey ?? null, at); }
        catch { issue = "payload_invalid"; return false; }
        return true;
      };
      await installations(tx, user.externalId, async (row) => {
        if (!eligible(row) || mode.kind === "specific" && row.id !== mode.installationId) return;
        hasEligible = true;
        if (mode.kind === "all") { if (await ready(row)) hasReady = true; }
        else if (!best || (row.lastActiveAt ?? -1) > (best.lastActiveAt ?? -1) || row.lastActiveAt === best.lastActiveAt && row.id < best.id) best = row;
      });
      if (best) hasReady = await ready(best);
      if (!hasEligible) return fail("no_eligible_installation");
      if (!hasReady) return fail(issue);
      const assignment = test ? { id: `test_${randomUUID()}`, variantId: current.variantId } : await tx.userDelivery(campaign.id, user.id, current.variantId, at);
      if (assignment.variantId !== current.variantId) throw new Error("Stored push assignment mismatch");
      current.deliveryId = assignment.id;
      current.admission = { content, definition: currentDefinition, expiresAt: Math.min(at + (campaign.settings.ttlSeconds ?? 86400) * 1000, campaign.until ?? Infinity), order: await nextOrder(tx) };
      await tx.insertPushRecord("delivery", { id: assignment.id, campaignId: campaign.id, userId: user.id, externalId: user.externalId, variantId: current.variantId, goalEvent: campaign.goalEvent, test: !!test });
      await installations(tx, user.externalId, async (row) => {
        if (!eligible(row) || mode.kind !== "all" && row.id !== best?.id) return;
        const slot: SlotWork = { id: digest([current.id, row.id]), recipientId: current.id, campaignId: campaign.id, userId: user.id, installationId: row.id, targetId: null, generation: 0, revision: 0, sequence: 0, submissionsUsed: 0, submissionNotBefore: 0, repair: null, uncertain: false, authRefreshRevision: null, expiresAt: current.admission!.expiresAt, state: { kind: "waiting", reason: "credential_missing", recheckAt: at }, test: !!test };
        await tx.savePushControl("queue", slot);
      });
    }
    let pending = false; let waiting: WaitReason | null = null;
    await slots(tx, current.id, async (slot) => {
      if (["accepted", "closed"].includes(slot.state.kind)) return;
      pending = true;
      if (slot.state.kind === "reserved") return;
      slot.expiresAt = Math.min(slot.expiresAt, current.admission!.expiresAt);
      const defer = (reason: WaitReason) => { slot.state = { kind: "waiting", reason, recheckAt: at + 1000 }; waiting = reason; };
      if (at >= slot.expiresAt) slot.state = { kind: "closed", reason: "delivery_expired" };
      else if (slot.submissionsUsed >= (slot.test ? 1 : 3)) slot.state = { kind: "closed", reason: "budget_exhausted" };
      else {
        const installation = await tx.getInstallation(slot.installationId);
        const old = slot.targetId ? await tx.getPushRecord("target", slot.targetId) : null;
        if (slot.uncertain && (!installation || old?.bindingGeneration !== installation.bindingGeneration || old.tokenRevision !== installation.tokenRevision || old.tokenScope !== installation.tokenScope)) slot.state = { kind: "closed", reason: "uncertain_snapshot_changed" };
        else if (installation && installation.appId !== campaign.settings.appId) slot.state = { kind: "closed", reason: "app_changed" };
        else if (!installation || installation.userId !== user.externalId) defer("installation_changed");
        else if (!installation.token || !installation.consent || !["granted", "provisional"].includes(installation.permission)) defer("consent");
        else if (!supportsPushContent(installation, current.admission!.content)) defer("capability_mismatch");
        else {
          const auth = await credential(tx, installation);
          if (auth.reason) defer(auth.reason);
          else if (campaign.readiness?.ok !== true) defer("campaign_not_ready");
          else if (slot.repair?.kind === "payload" && slot.repair.campaignFingerprint === current.admission!.definition && slot.repair.credentialRevision === auth.record!.revision) defer("payload_invalid");
          else if (slot.repair?.kind === "credential" && slot.repair.credentialRevision === auth.record!.revision) defer("credential_repair");
          else {
            slot.repair = null;
            const previousTarget = slot.targetId;
            await snapshot(tx, current, slot, installation, auth.record!);
            if (slot.targetId !== previousTarget && slot.targetId) created.push(slot.targetId);
          }
        }
      }
      slot.revision++; await tx.savePushControl("queue", slot);
    });
    if (waiting) wait(current, waiting, at, fingerprint);
    else current.state = pending ? { kind: "active" } : { kind: "closed", reason: "complete" };
    current.inputFingerprint = fingerprint;
    await tx.savePushControl("work", current);
    return created;
  }
  async function plan(campaignId: string, testInstallationId?: string, requestId?: string) {
    if (testInstallationId) return transaction(async (tx) => {
      if (!requestId) throw new PushError(400, "Test requestId required");
      const prior = await tx.getPushRecord("test", digest([campaignId, requestId]));
      if (prior) { if (prior.installationId !== testInstallationId) throw new PushError(409, "Test replay conflict"); return prior.targetIds; }
      const campaign = await tx.campaign(campaignId, now()); if (!campaign) throw new PushError(404, "Push campaign not found");
      if (campaign.readiness?.ok !== true) throw new PushError(409, "Push campaign is not ready");
      const installation = await tx.getInstallation(testInstallationId); const user = installation?.userId ? await tx.recipient(installation.userId) : null;
      if (!user) throw new PushError(409, "Selected installation is not bound");
      if (!await host.maySend(tx, user.id, now())) throw new PushError(409, "serving_gate_closed");
      const ids = await reconcile(tx, campaign, user, { installationId: testInstallationId, requestId });
      if (ids.length !== 1) throw new PushError(409, "Test target unavailable");
      await tx.insertPushRecord("test", { id: digest([campaignId, requestId]), campaignId, installationId: testInstallationId, requestId, targetIds: ids }); return ids;
    });
    const batch = await transaction(async (tx) => {
      const campaign = await tx.campaign(campaignId, now()); if (!campaign) throw new PushError(404, "Push campaign not found");
      if (!campaign.active) return null;
      const scan = await tx.getPushRecord("scan", `recipients:${campaignId}`) ?? { id: `recipients:${campaignId}`, afterId: null, revision: 0 };
      return { campaign, scan, page: await tx.recipientPage(campaign, now(), scan.afterId, 100) };
    });
    if (!batch) return [];
    const created: string[] = []; let revision = batch.scan.revision;
    for (const user of batch.page.recipients) {
      const result = await transaction(async (tx) => {
        const cursor = await tx.getPushRecord("scan", batch.scan.id) ?? batch.scan;
        if (cursor.revision !== revision) return null;
        const campaign = await tx.campaign(campaignId, now()); if (!campaign?.active) return null;
        const current = await tx.recipient(user.externalId);
        const ids = current ? await reconcile(tx, campaign, current) : [];
        await tx.savePushControl("scan", { id: cursor.id, afterId: user.id, revision: cursor.revision + 1 }); return ids;
      });
      if (result === null) break;
      revision++; created.push(...result);
    }
    await transaction(async (tx) => {
      const cursor = await tx.getPushRecord("scan", batch.scan.id) ?? batch.scan;
      if (cursor.revision === revision) await tx.savePushControl("scan", { id: cursor.id, afterId: batch.page.nextCursor, revision: cursor.revision + 1 });
    });
    const waiting = await transaction((tx) => tx.queryPushRecords("work", { campaignId, dueAt: now(), limit: 100 }));
    for (const row of waiting) created.push(...await transaction(async (tx) => {
      const campaign = await tx.campaign(campaignId, now()); const user = await tx.recipient(row.externalId);
      return campaign?.active && user ? reconcile(tx, campaign, user) : [];
    }));
    return created;
  }
  async function reconcileDue(campaignId?: string) {
    const waiting = await transaction((tx) => tx.queryPushRecords("work", { campaignId, dueAt: now(), limit: 100 }));
    for (const row of waiting) await transaction(async (tx) => {
      const campaign = await tx.campaign(row.campaignId, now()); const user = await tx.recipient(row.externalId);
      if (campaign && user) await reconcile(tx, campaign, user);
      else await close(tx, row, "recipient_or_campaign_removed");
    });
  }
  async function finish(tx: Tx, slot: SlotWork, target: DeviceTarget, attempt: PushAttempt, result: ProviderOutcome, submission: AttemptOutcome["submission"]) {
    const outcome: AttemptOutcome = { id: attempt.id, slotId: slot.id, campaignId: target.campaignId, attemptId: attempt.id, targetId: target.id, observedAt: now(), result: (({ messageAttempted, ...value }) => value)(result), submission };
    await tx.insertPushRecord("outcome", outcome);
    if (submission !== "none") slot.submissionsUsed++;
    if (submission === "possible") slot.uncertain = true;
    slot.revision++;
    const work = await tx.getPushRecord("work", slot.recipientId);
    if (result.kind === "accepted") {
      slot.repair = null;
      slot.state = { kind: "accepted", acceptanceId: outcome.id };
      if (!target.test) { await tx.accepted(target.deliveryId, outcome.observedAt); await host.recordAcceptance(tx, { id: attempt.id, projectId: host.projectId, userId: target.userId, deliveryId: target.deliveryId, attemptId: attempt.id, acceptedAt: outcome.observedAt }); }
    } else if (result.kind === "blocked" && ["expired", "app_changed", "campaign_ended", "superseded", "content_changed_after_acceptance", "uncertain_snapshot_changed"].includes(result.code)) slot.state = { kind: "closed", reason: result.code };
    else if (target.test) slot.state = { kind: "closed", reason: "test_attempt_complete" };
    else if (slot.submissionsUsed >= (slot.test ? 1 : 3)) slot.state = { kind: "closed", reason: "budget_exhausted" };
    else if (result.kind === "unknown" || result.kind === "rejected" && result.code === "transient" || result.kind === "blocked" && result.code === "reservation_expired") {
      if (result.kind !== "blocked") slot.submissionNotBefore = Math.max(slot.submissionNotBefore, outcome.observedAt + retryDelay(attempt, result));
      makeReady(slot);
    }
    else if (result.kind === "rejected" && result.code === "auth_refresh" && slot.authRefreshRevision !== target.credentialRevision) { slot.authRefreshRevision = target.credentialRevision; makeReady(slot); }
    else {
      const reason: WaitReason = result.kind === "blocked" && result.code === "readiness_failed" ? "campaign_not_ready" : result.kind === "rejected" ? result.code === "invalid_token" ? "consent" : result.code === "payload" ? "payload_invalid" : "credential_repair" : result.kind === "blocked" && result.code === "campaign_changed" ? "campaign_paused" : result.kind === "blocked" && result.code === "billing_gate" ? "serving_gate_closed" : result.kind === "blocked" && result.code === "audience_changed" ? "audience" : result.kind === "blocked" && result.code === "capabilities_changed" ? "capability_mismatch" : result.kind === "blocked" && result.code === "credential_changed" ? "credential_repair" : "installation_changed";
      if (result.kind === "rejected" && ["credential", "auth_refresh"].includes(result.code)) {
        slot.authRefreshRevision = target.credentialRevision;
        slot.repair = { kind: "credential", credentialRevision: target.credentialRevision };
      }
      if (result.kind === "rejected" && result.code === "payload") slot.repair = { kind: "payload", credentialRevision: target.credentialRevision, campaignFingerprint: target.campaignFingerprint };
      slot.state = { kind: "waiting", reason, recheckAt: now() + 1000 };
      if (work && work.state.kind !== "closed") { wait(work, reason, now(), ""); await tx.savePushControl("work", work); }
    }
    if (result.kind === "rejected" && result.code === "invalid_token") await retireInstallationToken(tx, { installationId: target.installationId, tokenRevision: target.tokenRevision, tokenScope: target.tokenScope });
    await tx.savePushControl("queue", slot);
    if (work && work.state.kind !== "closed") {
      let pending = false;
      for (const stateKind of ["ready", "waiting", "reserved"]) if ((await tx.queryPushRecords("queue", { recipientId: work.id, stateKind, limit: 1 })).length) pending = true;
      if (!pending) { work.state = { kind: "closed", reason: "settled" }; await tx.savePushControl("work", work); }
    }
    return outcome;
  }
  async function dispatch(targetId: string) {
    const reserved = await transaction(async (tx) => {
      const target = await tx.getPushRecord("target", targetId); if (!target) throw new PushError(404, "Push target not found");
      const slot = await tx.getPushRecord("queue", target.slotId);
      if (!slot || slot.targetId !== targetId || ["accepted", "closed", "waiting"].includes(slot.state.kind)) return null;
      if (slot.state.kind === "reserved") {
        if (now() < slot.state.until) return null;
        const attempt = await tx.getPushRecord("attempt", slot.state.attemptId);
        if (!attempt) throw new Error("Reservation is missing");
        if (!await tx.getPushRecord("outcome", attempt.id)) await finish(tx, slot, target, attempt, { kind: "unknown", code: "interrupted" }, "possible");
        return null;
      }
      if (slot.state.kind !== "ready" || Math.max(slot.state.at, slot.submissionNotBefore) > now() && now() < slot.expiresAt) return null;
      if (slot.submissionsUsed >= (slot.test ? 1 : 3)) { slot.state = { kind: "closed", reason: "budget_exhausted" }; await tx.savePushControl("queue", slot); return null; }
      slot.sequence++; slot.revision++;
      const attempt: PushAttempt = { id: randomUUID(), slotId: slot.id, slotRevision: slot.revision, validUntil: now() + 30000, targetId, campaignId: target.campaignId, ordinal: slot.sequence, startedAt: now(), fence: randomUUID() };
      slot.state = { kind: "reserved", attemptId: attempt.id, until: attempt.validUntil };
      await tx.insertPushRecord("attempt", attempt); await tx.savePushControl("queue", slot); return { attempt, target };
    });
    if (!reserved) return null;
    return transaction(async (tx) => {
      const { attempt, target } = reserved;
      const slot = await tx.getPushRecord("queue", target.slotId);
      if (!slot || slot.targetId !== targetId || slot.revision !== attempt.slotRevision || slot.state.kind !== "reserved" || slot.state.attemptId !== attempt.id || await tx.getPushRecord("outcome", attempt.id)) return null;
      const at = now(); const work = await tx.getPushRecord("work", slot.recipientId); const campaign = await tx.campaign(target.campaignId, at);
      const installation = await tx.getInstallation(target.installationId); const auth = await tx.getPushRecord("credential", target.credentialId);
      let blocked: string | null = null;
      if (at >= Math.min(slot.expiresAt, campaign?.until ?? Infinity)) blocked = "expired";
      else if (at >= attempt.validUntil) blocked = "reservation_expired";
      else if (!campaign || campaign.ended) blocked = "campaign_ended";
      else if (!target.test && !campaign.active) blocked = "campaign_changed";
      else if (!work?.admission) throw new Error("Admitted recipient is missing");
      else if (installation && installation.appId !== campaign.settings.appId) blocked = "app_changed";
      else if (definition(campaign, work.variantId) !== target.campaignFingerprint) blocked = (await tx.queryPushRecords("queue", { recipientId: work.id, stateKind: "accepted", limit: 1 })).length ? "content_changed_after_acceptance" : slot.uncertain ? "uncertain_snapshot_changed" : "campaign_changed";
      else if (!installation || installation.userId !== target.externalId || installation.bindingGeneration !== target.bindingGeneration || installation.tokenRevision !== target.tokenRevision || installation.tokenScope !== target.tokenScope) blocked = slot.uncertain ? "uncertain_snapshot_changed" : "installation_changed";
      else if (!installation.consent || !["granted", "provisional"].includes(installation.permission)) blocked = "consent";
      else if (!supportsPushContent(installation, target.content)) blocked = "capabilities_changed";
      else if (!auth || auth.revision !== target.credentialRevision) blocked = "credential_changed";
      else if (!await host.maySend(tx, target.userId, at)) blocked = "billing_gate";
      else if (!target.test && !(await tx.recipients(campaign, at, target.userId)).length) blocked = "audience_changed";
      else if (target.replacementKey && (await tx.queryPushRecords("target", { installationId: target.installationId, credentialId: target.credentialId, replacementKey: target.replacementKey, createdAfter: target.createdOrder, isTest: false, limit: 1 })).length) blocked = "superseded";
      if (!blocked && campaign?.readiness?.ok !== true) blocked = "readiness_failed";
      if (blocked) return finish(tx, slot, target, attempt, { kind: "blocked", code: blocked, messageAttempted: false }, "none");
      let secret;
      try { secret = host.vault!.open(auth!.encrypted, scope(auth!.id)); } catch { return finish(tx, slot, target, attempt, { kind: "rejected", code: "credential", messageAttempted: false }, "none"); }
      const envelope: PushEnvelope = { version: 1, targetId, attemptId: attempt.id, installationId: target.installationId, bindingGeneration: target.bindingGeneration, content: target.content, test: target.test };
      let result: ProviderOutcome;
      try { result = await host.provider.send(secret, installation!, envelope, Math.min(target.expiresAt, slot.expiresAt, campaign!.until ?? Infinity), target.replacementKey, at); }
      catch { result = { kind: "unknown", code: "transport" }; }
      const submission = result.messageAttempted === false ? "none" : result.kind === "unknown" ? "possible" : result.kind === "blocked" ? "none" : "confirmed";
      return finish(tx, slot, target, attempt, result, submission);
    });
  }
  return { plan, dispatch, reconcileDue };
}
