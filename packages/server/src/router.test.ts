import { describe, expect, it } from "vitest";
import { createOperationRouter } from "./router.js";

const ok = () => Response.json({ ok: true });

describe("browser SDK CORS", () => {
  it("answers preflight for every SDK endpoint", async () => {
    const route = createOperationRouter();
    const paths = [
      "/api/v1/identify",
      "/api/v1/track",
      "/api/v1/messages",
      "/api/v1/deliveries/dlv_1/event",
    ];
    for (const path of paths) {
      const response = await route(new Request(`http://local${path}`, { method: "OPTIONS" }));
      expect(response.status, path).toBe(204);
      expect(response.headers.get("access-control-allow-origin"), path).toBe("*");
      expect(response.headers.get("access-control-allow-headers"), path).toContain("Authorization");
      expect(response.headers.get("access-control-allow-methods"), path).toContain("OPTIONS");
      expect(response.headers.get("access-control-max-age"), path).toBe("86400");
    }
  });

  it("advertises the concrete method of each SDK endpoint", async () => {
    const route = createOperationRouter();
    const identify = await route(new Request("http://local/api/v1/identify", { method: "OPTIONS" }));
    expect(identify.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    const messages = await route(new Request("http://local/api/v1/messages", { method: "OPTIONS" }));
    expect(messages.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });

  it("adds CORS headers to SDK responses", async () => {
    const route = createOperationRouter({ trackEvent: ok });
    const response = await route(new Request("http://local/api/v1/track", { method: "POST" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("adds CORS headers to unimplemented SDK responses", async () => {
    const route = createOperationRouter();
    const response = await route(new Request("http://local/api/v1/track", { method: "POST" }));
    expect(response.status).toBe(501);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps management endpoints non-CORS", async () => {
    const route = createOperationRouter({ listCampaigns: ok, getCampaign: ok });
    const list = await route(new Request("http://local/api/v1/campaigns"));
    expect(list.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await route(new Request("http://local/api/v1/campaigns", { method: "OPTIONS" }));
    expect(preflight.status).toBe(404);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses preflight for unknown paths", async () => {
    const route = createOperationRouter();
    expect((await route(new Request("http://local/unknown", { method: "OPTIONS" }))).status).toBe(404);
  });
});

describe("path parameter decoding", () => {
  it("returns 400 for a malformed percent-encoded parameter", async () => {
    let called = false;
    const route = createOperationRouter({ getCampaign: () => { called = true; return ok(); } });
    const response = await route(new Request("http://local/api/v1/campaigns/%E0%A4%A"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid path parameter" });
    expect(called).toBe(false);
  });

  it("returns a CORS 400 for a malformed SDK parameter", async () => {
    const route = createOperationRouter({ recordDeliveryEvent: ok });
    const response = await route(new Request("http://local/api/v1/deliveries/%C0/event", { method: "POST" }));
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("decodes a well-formed parameter", async () => {
    const route = createOperationRouter({
      getCampaign: (_request, context) => Response.json({ id: context.params.id }),
    });
    const response = await route(new Request("http://local/api/v1/campaigns/camp%20one"));
    expect(await response.json()).toEqual({ id: "camp one" });
  });
});
