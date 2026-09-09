import { installationSchemas, validateSchema } from "@galinum/contracts";
import { PushError, validateCredential, type PushCommand, type createPushEngine } from "@galinum/push";
import { readJsonObject } from "./request-body.js";
import type { OperationHandler, OperationHandlers } from "./router.js";
export function pushDomainHandlers(engine: ReturnType<typeof createPushEngine>): OperationHandlers {
  const route = (sdk: boolean, work: OperationHandler): OperationHandler => async (request, context) => {
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
  return handlers;
}
