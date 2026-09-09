import { installationSchemas, validateSchema } from "@galinum/contracts";
import { InAppError, type createInAppService, type DeliveryFeedback, type InstallationStore } from "@galinum/core";
import { PushError, type createPushEngine } from "@galinum/push";
import { randomUUID } from "node:crypto";
import { authorizeOperation, invokeOperation, type AuthorizedOperation, type ProjectAuthenticator } from "./authorization.js";
import type { CommunicationData, CommunicationEffects } from "./communication-data.js";
import { TraitsCapacityError } from "./communication-data.js";
import { recordServerEvent } from "./communication-push.js";
import { installationDomainHandlers } from "./installation-domain.js";
import type { JsonObject } from "./local-product.js";
import { pushDomainHandlers } from "./push-handlers.js";
import { readJsonObject } from "./request-body.js";
import { finishOperationResponse, resolveOperation, type OperationHandlers, type ResolvedOperation } from "./router.js";

export interface CommunicationServices<Tx extends CommunicationData = CommunicationData> {
  readonly projectId: string;
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  readonly installations: InstallationStore;
  readonly push: ReturnType<typeof createPushEngine>;
  readonly inapp: ReturnType<typeof createInAppService>;
  readonly effects?: CommunicationEffects<Tx>;
  now(): number;
}
export function communicationDomainHandlers<Tx extends CommunicationData>(services: CommunicationServices<Tx>): OperationHandlers {
  const store = services;
  const now = () => services.now();
  const inapp = services.inapp;
  const options = { communicationEffects: services.effects };
  const SDK_BODY_BYTES = 8 * 1024;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const body = readJsonObject;
  const bodyError = (status: 400 | 413) => json({ error: status === 413 ? "Request body is too large" : "Invalid body" }, status);
  const inappResponse = async (work: () => Promise<unknown>) => {
    try { return Response.json(await work(), { headers: { "Cache-Control": "no-store" } }); }
    catch (error) { return Response.json({ error: error instanceof InAppError ? error.message : "In-app operation failed" }, { status: error instanceof InAppError ? error.status : 500, headers: { "Cache-Control": "no-store" } }); }
  };

  return {
    ...installationDomainHandlers(services.installations, { now }),
    ...pushDomainHandlers(services.push),
    async identifyUser(request, context) {
      const parsed = await body(request, SDK_BODY_BYTES);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if (typeof input.userId !== "string" || !input.userId || input.userId.length > 256) return json({ error: "userId is required" }, 400);
      const userId = input.userId;
      if (input.traits !== undefined && (!input.traits || typeof input.traits !== "object" || Array.isArray(input.traits))) return json({ error: "Invalid traits" }, 400);
      const clientTraits = input.traits === undefined ? {} : input.traits as JsonObject;
      if (Buffer.byteLength(JSON.stringify(clientTraits)) > 4096) return json({ error: "Invalid traits" }, 400);
      const traits = { ...clientTraits, ...context.identifyTraits };
      if (Buffer.byteLength(JSON.stringify(traits)) > 4096) return json({ error: "Invalid traits" }, 400);
      try {
        await store.transaction(async (transaction) => { await transaction.lockInstallations(); const at = now(); const user = await transaction.identifyUser(userId, traits, at); await options.communicationEffects?.recordActivity?.(transaction, { kind: "identify", userId: user.id, occurredAt: at }); });
      } catch (error) {
        if (error instanceof TraitsCapacityError) return json({ error: "Merged traits are too large" }, 413);
        throw error;
      }
      return json({ ok: true });
    },

    async trackEvent(request) {
      const parsed = await body(request, SDK_BODY_BYTES);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if (typeof input.userId !== "string" || !input.userId || input.userId.length > 256 || typeof input.event !== "string" || !input.event || input.event.length > 80) return json({ error: "userId and event are required" }, 400);
      const userId = input.userId;
      const eventName = input.event;
      const props = input.props && typeof input.props === "object" && !Array.isArray(input.props) ? input.props as JsonObject : null;
      if (input.props !== undefined && (props === null || !validateSchema(installationSchemas.PushEventProps, input.props, installationSchemas))) return json({ error: "Invalid props" }, 400);
      if (Buffer.byteLength(JSON.stringify(props)) > 4096) return json({ error: "Invalid props" }, 400);
      if (input.eventId !== undefined && (typeof input.eventId !== "string" || !input.eventId || input.eventId.length > 128)) return json({ error: "Invalid eventId" }, 400);
      const occurredAt = now();
      try {
        await store.transaction(async (transaction) => {
          await transaction.lockInstallations();
          let user = await transaction.getUserByExternalId(userId);
          if (!user && typeof input.eventId === "string" && await transaction.getPushRecord("event", input.eventId)) throw new PushError(409, "Event replay conflict");
          user ??= await transaction.identifyUser(userId, {}, occurredAt);
          await recordServerEvent(transaction, user, eventName, typeof input.eventId === "string" ? input.eventId : `evt_${randomUUID()}`, occurredAt, props, options.communicationEffects);
        });
      } catch (error) {
        if (error instanceof PushError) return json({ error: error.message }, error.status);
        throw error;
      }
      return json({ ok: true });
    },

    async getMessages(request) {
      const query = new URL(request.url).searchParams;
      const input = { userId: query.get("userId"), entryId: query.get("entryId"), requestId: query.get("requestId"), path: query.get("path") };
      if (!validateSchema(installationSchemas.InAppDecisionInput, input, installationSchemas)) return json({ error: "Invalid decision correlation or path" }, 400);
      return inappResponse(() => inapp.decide(input as { userId: string; entryId: string; requestId: string; path: string }));
    },

    async recordDeliveryEvent(request, { params }) {
      const parsed = await body(request, SDK_BODY_BYTES);
      if (!parsed.ok) return bodyError(parsed.status);
      if (!validateSchema(installationSchemas.InAppFeedbackInput, parsed.value, installationSchemas)) return json({ error: "Invalid feedback identity" }, 400);
      return inappResponse(() => inapp.feedback(params.id, parsed.value.userId as string, parsed.value.type as DeliveryFeedback, parsed.value.feedbackId as string));
    },

  };
}
export async function invokeCommunication<Tx extends CommunicationData>(operation: ResolvedOperation, request: Request, grant: AuthorizedOperation, services: CommunicationServices<Tx>): Promise<Response> {
  try { return await invokeOperation(operation, request, grant, { projectId: services.projectId, handlers: () => communicationDomainHandlers(services) }); }
  catch { return finishOperationResponse(request, Response.json({ error: "Internal server error" }, { status: 500 })); }
}
export function createCommunicationHandler<Tx extends CommunicationData>(services: CommunicationServices<Tx>, authenticate: ProjectAuthenticator) {
  return async (request: Request): Promise<Response> => {
    const operation = resolveOperation(request);
    if (operation instanceof Response) return operation;
    const grant = await authorizeOperation(operation, request, authenticate);
    return grant instanceof Response ? grant : invokeCommunication(operation, request, grant, services);
  };
}
