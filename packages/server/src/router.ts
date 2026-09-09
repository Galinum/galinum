import { OPERATIONS, type OperationId, type SecurityScheme } from "./operations.js";

export type OperationContext = { params: Record<string, string>; identifyTraits?: Readonly<Record<string, unknown>> };
export type OperationHandler = (request: Request, context: OperationContext) => Response | Promise<Response>;
export type OperationHandlers = Partial<Record<OperationId, OperationHandler>>;
export type SecurityRequirements = readonly Readonly<Partial<Record<SecurityScheme, readonly string[]>>>[];
export interface ResolvedOperation {
  readonly operationId: OperationId;
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly security: SecurityRequirements;
  readonly availability: "product" | "galinum_cloud";
}
export const BROWSER_SDK_OPERATIONS = new Set<OperationId>(OPERATIONS.filter((op) => op.security.some((alternative) => "publishableKey" in alternative)).map((op) => op.operationId));
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Galinum-Installation-Capability", "Access-Control-Max-Age": "86400" };
const routes = OPERATIONS.map((operation) => ({ ...operation,
  security: Object.freeze(operation.security.map((alternative) => Object.freeze(Object.fromEntries(Object.entries(alternative).map(([name, scopes]) => [name, Object.freeze([...scopes])]))))),
  names: [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
  regex: new RegExp("^" + operation.path.split("/").map((segment) => segment.startsWith("{") ? "([^/]+)" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") + "$"),
  cors: BROWSER_SDK_OPERATIONS.has(operation.operationId),
}));
const resolutions = new WeakMap<ResolvedOperation, { request: Request; url: string; method: string; headers: string }>();
const headersKey = (request: Request) => JSON.stringify([...request.headers.entries()]);
function corsMethods(pathname: string) {
  const methods = routes.filter((route) => route.cors && route.regex.test(pathname)).map((route) => route.method);
  return methods.length ? [...methods, "OPTIONS"].join(", ") : null;
}
function withCors(response: Response, methods: string) {
  for (const [name, value] of Object.entries(corsHeaders)) response.headers.set(name, value);
  response.headers.set("Access-Control-Allow-Methods", methods);
  return response;
}
export function finishOperationResponse(request: Request, response: Response): Response {
  const pathname = new URL(request.url).pathname;
  const candidate = routes.find((route) => route.method === request.method && route.regex.test(pathname));
  const methods = candidate?.cors ? corsMethods(pathname) : null;
  const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
  if (methods) { result.headers.set("Cache-Control", "no-store"); return withCors(result, methods); }
  return result;
}
export function validOperation(operation: ResolvedOperation, request: Request): boolean {
  const bound = resolutions.get(operation);
  return !!bound && bound.request === request && bound.url === request.url && bound.method === request.method && bound.headers === headersKey(request);
}
export function resolveOperation(request: Request): ResolvedOperation | Response {
  const pathname = new URL(request.url).pathname;
  if (request.method === "OPTIONS") {
    const methods = corsMethods(pathname);
    return methods ? withCors(new Response(null, { status: 204 }), methods) : Response.json({ error: "Not found" }, { status: 404 });
  }
  for (const route of routes) {
    if (route.method !== request.method) continue;
    const match = route.regex.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    try { route.names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); }); }
    catch { return finishOperationResponse(request, Response.json({ error: "Invalid path parameter" }, { status: 400 })); }
    const operation: ResolvedOperation = Object.freeze({ operationId: route.operationId, method: route.method, path: route.path, params: Object.freeze(params), security: route.security, availability: route.availability });
    resolutions.set(operation, { request, url: request.url, method: request.method, headers: headersKey(request) });
    return operation;
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}
export function missingOperation(operation: ResolvedOperation): Response {
  return operation.availability === "galinum_cloud"
    ? Response.json({ error: "Available in Galinum Cloud", operationId: operation.operationId, availability: "galinum_cloud" }, { status: 501 })
    : Response.json({ error: "Not implemented", operationId: operation.operationId }, { status: 501 });
}
export function createOperationRouter(handlers: OperationHandlers = {}) {
  return async (request: Request): Promise<Response> => {
    const operation = resolveOperation(request);
    if (operation instanceof Response) return operation;
    const handler = handlers[operation.operationId];
    return finishOperationResponse(request, handler ? await handler(request, { params: { ...operation.params } }) : missingOperation(operation));
  };
}
