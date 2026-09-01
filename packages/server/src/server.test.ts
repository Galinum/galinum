import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { nodeAdapter } from "./node-adapter.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.clear();
});

async function start() {
  const server = createServer(nodeAdapter(createApp()));
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

describe("self-host server", () => {
  it("starts and serves health", async () => {
    const origin = await start();
    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("maps every known operation to an explicit handler state", async () => {
    const origin = await start();
    const response = await fetch(`${origin}/api/v1/goals`);
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ operationId: "listGoals" });
  });

  it("returns 404 for unknown paths", async () => {
    const origin = await start();
    expect((await fetch(`${origin}/unknown`)).status).toBe(404);
  });
});
