import { timingSafeEqual } from "node:crypto";
import { SECURITY_SCHEMES, type OperationId, type SecurityScheme } from "./operations.js";
import { finishOperationResponse, missingOperation, validOperation, type OperationHandlers, type ResolvedOperation } from "./router.js";

export interface CredentialProof {
  scheme: Exclude<SecurityScheme, "installationCapability">;
  scopes?: readonly string[];
  operations?: readonly OperationId[];
}
export interface ProjectPrincipal { projectId: string; credentials: readonly CredentialProof[]; identifyTraits?: Readonly<Record<string, unknown>> }
export type ProjectAuthenticator = (request: Request, operation: ResolvedOperation) => Promise<ProjectPrincipal | Response | null>;
export interface AuthorizedOperation { readonly projectId: string }
const grants = new WeakMap<AuthorizedOperation, { operation: ResolvedOperation; request: Request; principal: ProjectPrincipal }>();
const failure = (request: Request, status: number, error: string) => finishOperationResponse(request, Response.json({ error }, { status }));
function principalCopy(value: ProjectPrincipal): ProjectPrincipal | null {
  if (!value || typeof value.projectId !== "string" || !value.projectId || !Array.isArray(value.credentials)) return null;
  if (value.credentials.some((proof) => !proof || !Object.hasOwn(SECURITY_SCHEMES, proof.scheme) || String(proof.scheme) === "installationCapability" ||
    (proof.scopes !== undefined && (!Array.isArray(proof.scopes) || proof.scopes.some((scope: unknown) => typeof scope !== "string"))) ||
    (proof.operations !== undefined && (!Array.isArray(proof.operations) || proof.operations.some((id: unknown) => typeof id !== "string"))))) return null;
  if (value.identifyTraits !== undefined && (!value.identifyTraits || typeof value.identifyTraits !== "object" || Array.isArray(value.identifyTraits))) return null;
  return Object.freeze({ projectId: value.projectId, credentials: Object.freeze(value.credentials.map((proof) => Object.freeze({ scheme: proof.scheme,
    ...(proof.scopes ? { scopes: Object.freeze([...proof.scopes]) } : {}), ...(proof.operations ? { operations: Object.freeze([...proof.operations]) } : {}) }))),
    ...(value.identifyTraits ? { identifyTraits: structuredClone(value.identifyTraits) } : {}) });
}
export function permits(operation: ResolvedOperation, request: Request, principal: ProjectPrincipal, capability = true): boolean {
  return operation.security.length === 0 || operation.security.some((alternative) => Object.entries(alternative).every(([scheme, scopes]) => {
    if (scheme === "installationCapability") return !capability || !!request.headers.get(SECURITY_SCHEMES.installationCapability.name);
    return principal.credentials.some((proof) => proof.scheme === scheme && (scopes ?? []).every((scope) => proof.scopes?.includes(scope)) &&
      (proof.operations === undefined ? proof.scheme !== "hostedAgentKey" : proof.operations.includes(operation.operationId)));
  }));
}
export async function authorizeOperation(operation: ResolvedOperation, request: Request, authenticate: ProjectAuthenticator): Promise<AuthorizedOperation | Response> {
  if (!validOperation(operation, request)) return failure(request, 400, "Operation binding mismatch");
  try {
    const result = await authenticate(request, operation);
    if (!validOperation(operation, request)) return failure(request, 400, "Operation binding mismatch");
    if (result instanceof Response) return finishOperationResponse(request, result);
    if (!result) return failure(request, 401, "Unauthorized");
    const principal = principalCopy(result);
    if (!principal) return failure(request, 401, "Invalid principal");
    if (!permits(operation, request, principal)) return permits(operation, request, principal, false) ? failure(request, 401, "Unauthorized") : failure(request, 403, "Operation is not authorized");
    const grant: AuthorizedOperation = Object.freeze({ projectId: principal.projectId });
    grants.set(grant, { operation, request, principal });
    return grant;
  } catch { return failure(request, 500, "Authentication failed"); }
}
export async function invokeOperation(operation: ResolvedOperation, request: Request, grant: AuthorizedOperation, service: { readonly projectId: string; readonly handlers: OperationHandlers | (() => OperationHandlers) }): Promise<Response> {
  const authorized = grants.get(grant); grants.delete(grant);
  if (!authorized) return failure(request, 401, "Invalid or consumed authorization");
  if (!validOperation(operation, request) || authorized.operation !== operation || authorized.request !== request) return failure(request, 400, "Operation binding mismatch");
  if (authorized.principal.projectId !== service.projectId) return failure(request, 403, "Project binding mismatch");
  if (request.bodyUsed) return failure(request, 400, "Request body was already consumed");
  const handlers = typeof service.handlers === "function" ? service.handlers() : service.handlers;
  const handler = handlers[operation.operationId];
  return finishOperationResponse(request, handler ? await handler(request, { params: { ...operation.params }, ...(operation.operationId === "identifyUser" && authorized.principal.identifyTraits ? { identifyTraits: authorized.principal.identifyTraits } : {}) }) : missingOperation(operation));
}
export function keyAuthenticator(options: { projectId: string; secretKey: string; publishableKey: string }): ProjectAuthenticator {
  if (![options.projectId, options.secretKey, options.publishableKey].every((value) => typeof value === "string" && value.length > 0)) throw new Error("Real project and key configuration is required");
  if (options.secretKey === options.publishableKey) throw new Error("Secret and publishable keys must differ");
  const secret = Buffer.from(`Bearer ${options.secretKey}`); const publishable = Buffer.from(`Bearer ${options.publishableKey}`);
  return async (request, operation) => {
    const bearer = Buffer.from(request.headers.get("authorization") ?? "");
    const matches = (key: Buffer) => bearer.length === key.length && timingSafeEqual(bearer, key);
    const scheme = matches(secret) ? "secretKey" : matches(publishable) ? "publishableKey" : null;
    const anonymous = operation.security.length === 0 || operation.security.some((alternative) => Object.keys(alternative).length === 0);
    if (scheme && operation.security.some((alternative) => scheme in alternative)) return { projectId: options.projectId, credentials: [{ scheme }] };
    return anonymous ? { projectId: options.projectId, credentials: [] } : null;
  };
}
