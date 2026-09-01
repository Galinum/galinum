import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

export type FetchApp = (request: Request) => Response | Promise<Response>;

export function nodeAdapter(app: FetchApp) {
  return async function handle(request: IncomingMessage, response: ServerResponse) {
    const host = request.headers.host ?? "127.0.0.1";
    const method = request.method ?? "GET";
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: request.headers as HeadersInit,
    };
    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(request) as ReadableStream;
      init.duplex = "half";
    }
    let status = 500;
    let headers: [string, string][] = [["content-type", "application/json"]];
    let body: Buffer = Buffer.from(JSON.stringify({ error: "Internal server error" }));
    try {
      const result = await app(new Request(`http://${host}${request.url ?? "/"}`, init));
      const bytes = Buffer.from(await result.arrayBuffer());
      status = result.status;
      headers = [...result.headers].map(([name, value]) => [name, value]);
      body = bytes;
    } catch {
      // Fall through to the prepared 500 so the socket always completes.
    }
    if (response.writableEnded || response.headersSent) return;
    response.statusCode = status;
    for (const [name, value] of headers) response.setHeader(name, value);
    if (status === 413) {
      response.setHeader("Connection", "close");
      response.shouldKeepAlive = false;
      response.once("finish", () => request.destroy());
    }
    response.end(body);
  };
}
