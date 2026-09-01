import { createServer } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { nodeAdapter, type FetchApp } from "./node-adapter.js";
import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.clear();
});

async function start(app: FetchApp) {
  const server = createServer(nodeAdapter(app));
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

describe("node adapter error handling", () => {
  it("completes with 500 when the app throws", async () => {
    const origin = await start(() => { throw new Error("boom"); });
    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("completes with 500 when the app rejects", async () => {
    const origin = await start(async () => { throw new Error("boom"); });
    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("completes with 500 when the response body fails to read", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("boom")); } });
    const origin = await start(() => new Response(body, { status: 200 }));
    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(500);
  });

  it("still passes a successful response through", async () => {
    const origin = await start(() => Response.json({ status: "ok" }, { headers: { "x-test": "1" } }));
    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-test")).toBe("1");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("closes a socket after rejecting a declared oversized body", async () => {
    const product = createLocalProduct();
    const origin = new URL(await start(createApp(product.handlers)));
    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(origin.port), "127.0.0.1");
      let data = "";
      const timer = setTimeout(() => reject(new Error("Socket stayed open after 413")), 2_000);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write([
          "POST /api/v1/identify HTTP/1.1",
          `Host: 127.0.0.1:${origin.port}`,
          `Authorization: Bearer ${product.publishableKey}`,
          "Content-Type: application/json",
          "Content-Length: 999999",
          "Connection: keep-alive",
          "",
          "",
        ].join("\r\n"));
      });
      socket.on("data", (chunk) => { data += chunk; });
      socket.on("error", reject);
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(data);
      });
    });
    expect(received).toMatch(/^HTTP\/1\.1 413/);
    expect(received.toLowerCase()).toContain("connection: close");
    await product.close();
  });
});
