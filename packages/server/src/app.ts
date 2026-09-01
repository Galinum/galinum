import { createOperationRouter, type OperationHandlers } from "./router.js";
import type { MediaStore } from "@galinum/core";

export function createApp(handlers: OperationHandlers = {}, media?: MediaStore) {
  const route = createOperationRouter(handlers);
  return async function app(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json({ status: "ok" });
    }
    if (request.method === "GET" && url.pathname.startsWith("/media/") && media) {
      let key: string;
      try {
        key = decodeURIComponent(url.pathname.slice("/media/".length));
      } catch {
        return Response.json({ error: "Invalid media path" }, { status: 400 });
      }
      const object = await media.get(key);
      if (!object) return Response.json({ error: "Not found" }, { status: 404 });
      return new Response(object.bytes as BodyInit, {
        headers: {
          "Content-Type": object.contentType,
          "Content-Length": String(object.sizeBytes),
          "Cache-Control": "public, max-age=31536000, immutable",
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
        },
      });
    }
    return route(request);
  };
}
