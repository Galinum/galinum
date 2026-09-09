import { INSTALLATION_BODY_BYTES, installationSchemas, validateSchema, type InstallationBindingInput, type InstallationBootstrap, type InstallationFactsInput, type InstallationMutation, type InstallationState, type InstallationTokenInput } from "@galinum/contracts";
import type { InstallationRecord, InstallationStore } from "@galinum/core";
import { retireInstallationToken } from "@galinum/core";
import { createHash, timingSafeEqual } from "node:crypto";
import { readJsonObject } from "./request-body.js";
import type { OperationHandlers } from "./router.js";
export type { InstallationAccess, InstallationRecord, InstallationReplay, InstallationSession } from "@galinum/core";

export const INSTALLATION_REPLAY_LIMIT = 128;

export const INSTALLATION_SDK_OPERATIONS = ["bootstrapInstallation", "getInstallation", "setInstallationBinding", "setInstallationFacts", "setInstallationToken", "recordInstallationActivity"] as const;
export function installationState(record: InstallationRecord): InstallationState {
  return {
    id: record.id, appId: record.appId, platform: record.platform, environment: record.environment,
    userId: record.userId, bindingGeneration: record.bindingGeneration, revision: record.revision,
    tokenRevision: record.tokenRevision, hasToken: record.token !== null, permission: record.permission,
    consent: record.consent, capabilities: record.capabilities, lastActiveAt: record.lastActiveAt, createdAt: record.createdAt,
  };
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function authenticated(record: InstallationRecord, capability: string): boolean {
  return timingSafeEqual(Buffer.from(record.capabilityVerifier, "hex"), Buffer.from(hash(capability), "hex"));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
const failure = (status: number, error: string) => Response.json({ error }, { status });
export function installationDomainHandlers(store: InstallationStore, options: { now: () => number }): OperationHandlers {
  const mutations = {
    setInstallationBinding: "InstallationBindingInput",
    setInstallationFacts: "InstallationFactsInput",
    setInstallationToken: "InstallationTokenInput",
    recordInstallationActivity: "InstallationMutation",
  } as const;
  const handlers: OperationHandlers = {
    async bootstrapInstallation(request) {
      const body = await readJsonObject(request, INSTALLATION_BODY_BYTES);
      if (!body.ok) return failure(body.status, "Invalid body");
      if (!validateSchema(installationSchemas.InstallationBootstrap, body.value, installationSchemas)) return failure(400, "Invalid installation");
      const input = body.value as InstallationBootstrap;
      return store.transaction(async (session) => {
        await session.lockInstallations();
        const existing = await session.getInstallation(input.installationId);
        if (existing) {
          if (!authenticated(existing, input.capability) || existing.appId !== input.appId || existing.platform !== input.platform || existing.environment !== input.environment) return failure(409, "Installation conflict");
          return Response.json({ installation: installationState(existing) });
        }
        const installation: InstallationRecord = { id: input.installationId, appId: input.appId, platform: input.platform, environment: input.environment, capabilityVerifier: hash(input.capability), userId: null, bindingGeneration: 0, revision: 0, tokenRevision: 0, token: null, tokenScope: null, permission: "unknown", consent: false, capabilities: { actions: [], channels: [], richImages: false }, lastActiveAt: null, createdAt: options.now() };
        await session.saveInstallation(installation);
        return Response.json({ installation: installationState(installation) });
      });
    },
    async getInstallation(request, { params }) {
      const record = await store.withReadSnapshot((session) => session.getInstallation(params.installationId));
      if (!record || !authenticated(record, request.headers.get("X-Galinum-Installation-Capability") ?? "")) return failure(401, "Unauthorized");
      return Response.json({ installation: installationState(record) });
    },
    async listInstallations(request) {
      const query = new URL(request.url).searchParams;
      const page = Number(query.get("page") ?? 1);
      const perPage = Number(query.get("perPage") ?? 25);
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100 || !Number.isSafeInteger((page - 1) * perPage)) return failure(400, "Invalid pagination");
      const userId = query.get("userId");
      if (userId !== null && (userId.length === 0 || userId.length > 256)) return failure(400, "Invalid userId");
      const result = await store.withReadSnapshot((session) => session.listInstallations(userId, (page - 1) * perPage, perPage));
      return Response.json({ installations: result.values.map(installationState), page, perPage, total: result.total });
    },
  };
  for (const [operation, schemaName] of Object.entries(mutations) as [keyof typeof mutations, typeof mutations[keyof typeof mutations]][]) {
    handlers[operation] = async (request, { params }) => {
      const body = await readJsonObject(request, INSTALLATION_BODY_BYTES);
      if (!body.ok) return failure(body.status, "Invalid body");
      if (!validateSchema(installationSchemas[schemaName], body.value, installationSchemas)) return failure(400, "Invalid installation mutation");
      const input = body.value as InstallationMutation;
      const digest = hash(canonical({ operation, input }));
      return store.transaction(async (session) => {
        await session.lockInstallations();
        const record = await session.getInstallation(params.installationId);
        if (!record || !authenticated(record, request.headers.get("X-Galinum-Installation-Capability") ?? "")) return failure(401, "Unauthorized");
        const replay = await session.getInstallationReplay(record.id, input.requestId);
        if (replay) return replay.digest === digest ? Response.json({ installation: replay.state }) : failure(409, "Request replay conflict");
        if (record.bindingGeneration !== input.bindingGeneration || record.revision !== input.revision) return failure(409, "Installation revision conflict");
        if (operation === "setInstallationBinding") {
          const binding = body.value as InstallationBindingInput;
          if (binding.userId !== null && !(await session.getUserByExternalId(binding.userId))) return failure(404, "Identify user before binding");
          if (record.userId !== binding.userId) {
            record.userId = binding.userId;
            record.bindingGeneration++;
            record.consent = false;
            record.lastActiveAt = null;
          }
        } else if (operation === "setInstallationFacts") {
          const facts = body.value as InstallationFactsInput;
          const categories = facts.capabilities.categories ?? [];
          if (new Set(categories.map((category) => category.id)).size !== categories.length || categories.some((category) => new Set(category.actions.map((action) => action.id)).size !== category.actions.length)) return failure(400, "Duplicate category or action identifier");
          record.permission = facts.permission;
          record.consent = facts.consent;
          record.capabilities = facts.capabilities;
        } else if (operation === "setInstallationToken") {
          const token = body.value as InstallationTokenInput;
          if (record.tokenRevision !== token.tokenRevision) return failure(409, "Token revision conflict");
          const scope = token.token === null ? null : canonical([record.appId, record.environment, record.platform === "ios" ? "apns" : "fcm", hash(token.token)]);
          if (scope !== null) {
            const owner = await session.getTokenOwner(scope);
            if (owner && owner.id !== record.id) {
              owner.token = null;
              owner.tokenScope = null;
              owner.tokenRevision++;
              owner.revision++;
              await session.saveInstallation(owner);
            }
          }
          record.token = token.token;
          record.tokenScope = scope;
          record.tokenRevision++;
        } else {
          record.lastActiveAt = Math.max(record.lastActiveAt ?? 0, options.now());
        }
        record.revision++;
        const state = installationState(record);
        await session.saveInstallation(record);
        await session.saveInstallationReplay(record.id, input.requestId, { digest, state });
        return Response.json({ installation: state });
      });
    };
  }
  return handlers;
}
export async function invalidateInstallationToken(store: InstallationStore, captured: { installationId: string; tokenRevision: number; tokenScope: string }): Promise<boolean> {
  return store.transaction(async (session) => {
    await session.lockInstallations();
    return retireInstallationToken(session, captured);
  });
}
