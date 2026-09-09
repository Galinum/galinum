import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ProductStore } from "../local-product.js";
import { isGitHubBranchName, isGitHubRepositorySegment, type GitHubProvider } from "../github/index.js";
import { readJsonObject } from "../request-body.js";
import { ActivationError, markDue, type createActivationService } from "./service.js";
import { createStockSession, type StockSessionOptions } from "./stock.js";

const identifier = z.string().min(1).max(128);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sourceInput = z.object({ expectedRevision: z.string(), installationId: positive, repositoryId: positive,
  owner: z.string().refine(isGitHubRepositorySegment), name: z.string().refine(isGitHubRepositorySegment),
  branch: z.string().refine(isGitHubBranchName), enabled: z.boolean(), paused: z.boolean() }).strict();
export function operatorKeyMatches(request: Request, expected: string | undefined) {
  const authorization = request.headers.get("authorization");
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice(7)); const configured = Buffer.from(expected);
  return actual.length === configured.length && timingSafeEqual(actual, configured);
}
export function validateOperatorKey(operatorKey: string | undefined, secretKey: string, publishableKey: string) {
  if (operatorKey !== undefined && (!operatorKey.trim() || operatorKey === secretKey || operatorKey === publishableKey)) {
    throw new Error("GALINUM_OPERATOR_KEY must be nonempty and distinct from management and publishable keys.");
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ActivationError(400, "Invalid operator settings.");
  return parsed.data;
}
export function createOperatorHandler(store: ProductStore, service: ReturnType<typeof createActivationService>, options: StockSessionOptions & {
  projectId: string; operatorKey?: string; secretKey: string; github?: GitHubProvider;
}) {
  return async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/operator/")) return null;
    const inspection = request.method === "GET" && path === "/operator/shipping";
    if (!operatorKeyMatches(request, options.operatorKey) && !(inspection && operatorKeyMatches(request, options.secretKey))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      if (inspection) {
        const settings = await service.getShippingSettings(options.projectId);
        const controls = await store.activation.controls();
        const sources = await store.activation.sources();
        return Response.json({ ...settings, controls: { paused: controls.paused, revision: String(controls.version) },
          sources: sources.map((source) => ({ ...source, revision: String(source.version), available: options.providerConfigured })) });
      }
      const body = async () => {
        const result = await readJsonObject(request, 64 * 1024);
        if (!result.ok) throw new ActivationError(400, "Invalid operator request body.");
        return result.value;
      };
      if (path === "/operator/shipping" && request.method === "PATCH") {
        const value = parse(z.object({ expectedRevision: z.string(), paused: z.boolean() }).strict(), await body());
        return Response.json(await store.transaction(async (transaction) => {
          const current = await transaction.activation.controls();
          if (String(current.version) !== value.expectedRevision) throw new ActivationError(409, "Project controls changed.");
          await transaction.activation.saveControls({ paused: value.paused, version: current.version + 1 });
          await markDue(createStockSession(transaction, options));
          return { paused: value.paused, revision: String(current.version + 1) };
        }));
      }
      const sourceMatch = /^\/operator\/sources\/([^/]+)$/.exec(path);
      if (sourceMatch && request.method === "PUT") {
        const id = parse(identifier, decodeURIComponent(sourceMatch[1]));
        const value = parse(sourceInput, await body());
        const prior = (await store.activation.sources()).find((source) => source.id === id);
        const bindingChanged = !prior || ["installationId", "repositoryId", "owner", "name", "branch"].some((key) => prior[key as keyof typeof prior] !== value[key as keyof typeof value]);
        if (value.enabled && (bindingChanged || !prior?.enabled)) {
          if (!options.github) throw new ActivationError(409, "Configure GitHub App credentials before enabling sources.");
          const result = await options.github.readRepositoryBranch(value, value.branch);
          if (result.repository.archived || result.repository.disabled) throw new ActivationError(409, "Repository is unavailable.");
        }
        return Response.json(await store.transaction(async (transaction) => {
          const current = (await transaction.activation.sources()).find((source) => source.id === id);
          if (String(current?.version ?? 0) !== value.expectedRevision) throw new ActivationError(409, "Source changed. Refresh before saving.");
          const { expectedRevision: _, ...fields } = value;
          const source = { id, ...fields, version: (current?.version ?? 0) + 1 };
          await transaction.activation.saveSource(source);
          for (const mapping of await transaction.activation.mappings()) {
            if (mapping.sourceIds.includes(id)) await transaction.activation.saveMapping({ ...mapping, generation: mapping.generation + 1 });
          }
          await markDue(createStockSession(transaction, options));
          return { ...source, revision: String(source.version) };
        }));
      }
      if (path === "/operator/mappings" && request.method === "POST") {
        return Response.json(await service.saveMapping(options.projectId, options.operatorSubject, await body()));
      }
      const mappingMatch = /^\/operator\/mappings\/([^/]+)$/.exec(path);
      if (mappingMatch && request.method === "DELETE") {
        const value = parse(z.object({ expectedVersion: z.string() }).strict(), await body());
        await service.removeMapping(options.projectId, options.operatorSubject, { id: decodeURIComponent(mappingMatch[1]), ...value });
        return new Response(null, { status: 204 });
      }
      const campaignMatch = /^\/operator\/campaigns\/([^/]+)\/(review|approve)$/.exec(path);
      if (campaignMatch) {
        const id = decodeURIComponent(campaignMatch[1]);
        if (campaignMatch[2] === "review" && request.method === "GET") return Response.json(await service.getCampaignReview(options.projectId, id));
        if (campaignMatch[2] === "approve" && request.method === "POST") return Response.json(await service.approveCampaign(options.projectId, id, options.operatorSubject, await body()));
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      if (error instanceof ActivationError) return Response.json({ error: error.message }, { status: error.status });
      return Response.json({ error: "Operator operation could not be completed." }, { status: 503 });
    }
  };
}
