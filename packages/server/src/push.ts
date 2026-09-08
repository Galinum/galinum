import { MemoryMediaStore } from "./local-media-store.js";
import { installationSchemas, validateSchema } from "@galinum/contracts";
import { createEncryptedVault, createPushEngine, createPushProvider, PushError, validateCredential, type PushCommand } from "@galinum/push";
import type { LocalProductOptions, ProductStore } from "./local-product.js";
import { readJsonObject } from "./request-body.js";
import type { OperationHandler, OperationHandlers } from "./router.js";

import { pushTransaction } from "./communication-push.js";
export function createServerPush(store: ProductStore, options: LocalProductOptions & { projectId: string; secretKey: string; publishableKey: string; now: () => number }) {
  const provider = options.pushProvider ?? createPushProvider();
  const vault = options.pushEncryptionKey ? createEncryptedVault(options.pushEncryptionKey) : null;
  const configuration = { projectId: options.projectId, vault, media: options.media ?? new MemoryMediaStore() };
  const engine = createPushEngine({ projectId: options.projectId, store: { transaction: (work) => store.transaction((session) => work(pushTransaction(session, options.communicationEffects, configuration))) }, vault, provider, maySend: options.pushMaySend ?? (async () => true), recordAcceptance: options.pushRecordAcceptance ?? (async () => {}), now: options.now });
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
