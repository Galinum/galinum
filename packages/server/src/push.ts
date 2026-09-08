import { LIMITS, referencedVocabulary, type AudienceExpression } from "@galinum/core";
import { validateSchema, installationSchemas } from "@galinum/contracts";
import { randomUUID } from "node:crypto";
import { createPushEngine, createEncryptedVault, createPushProvider, digest, recordPushEvent, validateCredential, PushError, type PushTransaction, type Recipient, type PushCommand, type PushContent } from "@galinum/push";
import type { ProductStore, ProductStoreSession, LocalProductOptions, JsonObject } from "./local-product.js";
import { campaignMatches } from "./audience.js";
import { readJsonObject } from "./request-body.js";
import type { OperationHandlers, OperationHandler } from "./router.js";

export function pushTransaction(session: ProductStoreSession): PushTransaction {
  const adapter: PushTransaction = {
    lockInstallations: () => session.lockInstallations(),
    getInstallation: (id) => session.getInstallation(id),
    listInstallations: (...args) => session.listInstallations(...args),
    saveInstallation: (record) => session.saveInstallation(record),
    getPushRecord: (...args) => session.getPushRecord(...args),
    queryPushRecords: (...args) => session.queryPushRecords(...args),
    pushTotals: (campaignId) => session.pushTotals(campaignId),
    insertPushRecord: (...args) => session.insertPushRecord(...args),
    savePushControl: (...args) => session.savePushControl(...args),
    recipient: (externalId) => session.getUserByExternalId(externalId),
    event: (user, name, id, now, props) => recordServerEvent(session, user, name, id, now, props),
    async campaign(id, now) {
      const campaign = await session.getCampaign(id);
      if (campaign?.channel !== "push" || !campaign.push) return null;
      const goal = campaign.goalId ? await session.getGoal(campaign.goalId) : null;
      return { id, ended: campaign.status === "ended", goalId: campaign.goalId, active: campaign.status === "running" && (campaign.deliverFrom === null || campaign.deliverFrom <= now) && (campaign.deliverUntil === null || campaign.deliverUntil > now), from: campaign.deliverFrom, until: campaign.deliverUntil, fingerprint: digest({ variants: campaign.variants, push: campaign.push, audience: campaign.audience, goal: campaign.goalId, from: campaign.deliverFrom, until: campaign.deliverUntil }), settings: campaign.push, goalEvent: goal?.targetEvent ?? null, variants: campaign.variants.map((variant) => ({ id: variant.id, weight: variant.weight, content: JSON.parse(variant.content_json) as PushContent })) };
    },
    async recipients(campaign, now, userId) {
      const source = await session.getCampaign(campaign.id);
      const user = await session.getUserById(userId);
      if (!source || !user) return [];
      if (source.audience.kind === "all") return [user];
      if (source.audience.kind === "invalid") return [];
      const vocabulary = referencedVocabulary((JSON.parse(source.audience.expressionJson) as AudienceExpression).root);
      if (vocabulary.events.size === 0) return campaignMatches(source, user, [], now) ? [user] : [];
      const facts = await session.loadAudienceFacts({ userId: user.id, afterUserId: null, limit: 1, traitKeys: [...vocabulary.traits], eventNames: [...vocabulary.events], evaluatedAt: now, maxOccurrences: LIMITS.maxEvaluatedEventOccurrences, eventRowBudget: vocabulary.events.size * LIMITS.maxEvaluatedEventOccurrences });
      if (facts.overflow) throw new Error("Audience fact bound exceeded");
      return campaignMatches(source, user, facts.eventsByUser.get(user.id) ?? [], now) ? [user] : [];
    },
    async recipientPage(campaign, now, afterId, limit) {
      const users = await session.queryPushUsers(afterId, limit + 1);
      const recipients: Recipient[] = users.slice(0, limit);
      return { recipients, nextCursor: users.length > limit ? users[limit - 1].id : null };
    },
    async userDelivery(campaignId, userId, variantId, now) {
      const delivery = await session.getOrCreateDelivery({ id: `del_${randomUUID()}`, campaignId, userId, variantId, state: "queued", queuedAt: now, sentAt: null, deliveredAt: null, shownAt: null, openedAt: null, clickedAt: null, dismissedAt: null, bouncedAt: null, complainedAt: null, unsubscribedAt: null, convertedAt: null });
      return { id: delivery.id, variantId: delivery.variantId };
    },
    async accepted(id, now) {
      const delivery = await session.getDeliveryForUpdate(id);
      if (!delivery) throw new Error("Push delivery is missing");
      delivery.sentAt = delivery.sentAt === null ? now : Math.min(delivery.sentAt, now);
      if (["queued", "sending", "retryable"].includes(delivery.state)) delivery.state = "sent";
      await session.saveDelivery(delivery);
    },
    async converted(id, now) {
      const delivery = await session.getDeliveryForUpdate(id);
      if (delivery && delivery.convertedAt === null) { delivery.convertedAt = now; delivery.state = "converted"; await session.saveDelivery(delivery); }
    },
  };
  return adapter;
}
export async function recordServerEvent(session: ProductStoreSession, user: Pick<Recipient, "id" | "externalId">, name: string, id: string, now: number, props: JsonObject | null) {
  const productEventId = `evt_${randomUUID()}`;
  if (!await recordPushEvent(pushTransaction(session), user.id, name, id, now, productEventId, digest({ userId: user.id, name, props }))) return;
  await session.identifyUser(user.externalId, {}, now);
  await session.insertEvent({ id: productEventId, userId: user.id, externalUserId: user.externalId, name, props, occurredAt: now });
  const candidates = await session.listConversionCandidatesForUpdate(user.id, name, now);
  for (const delivery of candidates) {
    if ((await session.getCampaign(delivery.campaignId))?.channel === "push") continue;
    delivery.state = "converted"; delivery.convertedAt = now; await session.saveDelivery(delivery);
  }
}
export function createServerPush(store: ProductStore, options: LocalProductOptions & { projectId: string; secretKey: string; publishableKey: string; now: () => number }) {
  const provider = options.pushProvider ?? createPushProvider();
  const engine = createPushEngine({ projectId: options.projectId, store: { transaction: (work) => store.transaction((session) => work(pushTransaction(session))) }, vault: options.pushEncryptionKey ? createEncryptedVault(options.pushEncryptionKey) : null, provider, maySend: options.pushMaySend ?? (async () => true), recordAcceptance: options.pushRecordAcceptance ?? (async () => {}), now: options.now });
  const route = (sdk: boolean, work: OperationHandler): OperationHandler => async (request, context) => {
    if (request.headers.get("authorization") !== `Bearer ${sdk ? options.publishableKey : options.secretKey}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
    try { return await work(request, context); }
    catch (error) { return error instanceof PushError ? Response.json({ error: error.message }, { status: error.status }) : Response.json({ error: "Push operation failed" }, { status: 500 }); }
  };
  const body = async (request: Request) => { const parsed = await readJsonObject(request, 65536); if (!parsed.ok) throw new PushError(parsed.status, "Invalid body"); return parsed.value; };
  const handlers: OperationHandlers = {
    configurePushCredential: route(false, async (request) => {
      const input = await body(request);
      if (!validateSchema(installationSchemas.PushCredentialInput, input, installationSchemas)) throw new PushError(400, "Invalid credential configuration");
      return Response.json({ credential: await engine.configure(input as unknown as Parameters<typeof engine.configure>[0]) });
    }),
    listPushCredentials: route(false, async (request) => Response.json(await engine.credentials(new URL(request.url).searchParams.get("afterId") ?? undefined))),
    validatePushCredential: route(false, async (request) => {
      try { const credential = validateCredential((await body(request)).credential); return Response.json({ provider: credential.provider, validation: "local_valid", externalAuthentication: "not_checked" }); }
      catch (error) { if (error instanceof PushError) throw error; throw new PushError(400, "Invalid push credential"); }
    }),
    dispatchPushCampaign: route(false, async (_request, { params }) => Response.json(await engine.runCampaign(params.id))),
    testPushCampaign: route(false, async (request, { params }) => {
      const input = await body(request);
      if (!validateSchema(installationSchemas.PushTestInput, input, installationSchemas)) throw new PushError(400, "Invalid selected-device test request");
      return Response.json(await engine.test(params.id, input.installationId as string, input.requestId as string));
    }),
    getPushTest: route(false, async (_request, { params }) => Response.json(await engine.getTest(params.id, params.requestId))),
    inspectPushCampaign: route(false, async (request, { params }) => { const query = new URL(request.url).searchParams; return Response.json(await engine.inspect(params.id, Number(query.get("page") ?? 1), Number(query.get("perPage") ?? 25))); }),
    observeInstallationPush: route(true, async (request, { params }) => {
      const input = await body(request);
      if (!validateSchema(installationSchemas.PushObservationBatch, input, installationSchemas)) throw new PushError(400, "Invalid observation batch");
      for (const command of input.commands as PushCommand[]) {
        if (command.kind === "event" && Buffer.byteLength(JSON.stringify(command.props ?? null)) > 4096) throw new PushError(413, "Event properties exceed 4096 bytes");
      }
      return Response.json(await engine.observe(params.installationId, request.headers.get("x-galinum-installation-capability") ?? "", Number(input.bindingGeneration), input.commands as PushCommand[]));
    }),
  };
  const runDue = async () => {
    const errors: { campaignId: string; error: string }[] = [];
    const campaigns = await store.transaction(async (session) => {
      await session.lockInstallations();
      const scan = await session.getPushRecord("scan", "campaign-planning");
      const page = await session.queryCampaigns({ channel: "push", effectiveStatus: "running", query: null, evaluatedAt: options.now(), offset: 0, limit: 100, afterId: scan?.afterId ?? null });
      await session.savePushControl("scan", { id: "campaign-planning", afterId: page.values.length === 100 ? page.values.at(-1)!.id : null, revision: (scan?.revision ?? 0) + 1 });
      return page.values;
    });
    for (const campaign of campaigns) {
      try { await engine.plan(campaign.id); } catch { errors.push({ campaignId: campaign.id, error: "Push campaign planning failed" }); }
    }
    try { return { ...await engine.processDue(), errors }; }
    catch { errors.push({ campaignId: "", error: "Push queue processing failed" }); return { processed: 0, errors }; }
  };
  return { engine: { ...engine, runDue }, handlers, close() { provider.close?.(); } };
}
