import { OPERATIONS, type OperationId } from "./operations.js";

export type OperationContext = { params: Record<string, string> };
export type OperationHandler = (
  request: Request,
  context: OperationContext,
) => Response | Promise<Response>;
export type OperationHandlers = Partial<Record<OperationId, OperationHandler>>;

// Browser SDK endpoints are called cross-origin from customer sites and are
// authenticated with the publishable key, never cookies. Management endpoints
// stay non-CORS so browsers cannot call them with a secret key.
export const BROWSER_SDK_OPERATIONS = new Set<OperationId>([
  "identifyUser",
  "trackEvent",
  "getMessages",
  "recordDeliveryEvent",
]);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const routes = OPERATIONS.map((operation) => {
  const names = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  const pattern = operation.path
    .split("/")
    .map((segment) => segment.startsWith("{") ? "([^/]+)" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("/");
  return {
    ...operation,
    names,
    regex: new RegExp(`^${pattern}$`),
    cors: BROWSER_SDK_OPERATIONS.has(operation.operationId),
  };
});

function corsMethods(pathname: string) {
  const methods = routes
    .filter((candidate) => candidate.cors && candidate.regex.test(pathname))
    .map((candidate) => candidate.method);
  return methods.length ? [...methods, "OPTIONS"].join(", ") : null;
}

function withCors(response: Response, methods: string) {
  for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value);
  response.headers.set("Access-Control-Allow-Methods", methods);
  return response;
}

function decodeParams(names: string[], match: RegExpExecArray) {
  const params: Record<string, string> = {};
  for (const [index, name] of names.entries()) {
    try {
      params[name] = decodeURIComponent(match[index + 1]);
    } catch {
      return null;
    }
  }
  return params;
}

export function createOperationRouter(handlers: OperationHandlers = {}) {
  return async function route(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === "OPTIONS") {
      const methods = corsMethods(pathname);
      if (!methods) return Response.json({ error: "Not found" }, { status: 404 });
      return withCors(new Response(null, { status: 204 }), methods);
    }
    for (const candidate of routes) {
      if (candidate.method !== request.method) continue;
      const match = candidate.regex.exec(pathname);
      if (!match) continue;
      const finish = (response: Response) =>
        candidate.cors ? withCors(response, corsMethods(pathname) ?? candidate.method) : response;
      const handler = handlers[candidate.operationId];
      if (!handler) {
        if (candidate.availability === "galinum_cloud") {
          return finish(Response.json(
            {
              error: "Available in Galinum Cloud",
              operationId: candidate.operationId,
              availability: "galinum_cloud",
            },
            { status: 501 },
          ));
        }
        return finish(Response.json(
          { error: "Not implemented", operationId: candidate.operationId },
          { status: 501 },
        ));
      }
      const params = decodeParams(candidate.names, match);
      if (!params) {
        return finish(Response.json({ error: "Invalid path parameter" }, { status: 400 }));
      }
      return finish(await handler(request, { params }));
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };
}
