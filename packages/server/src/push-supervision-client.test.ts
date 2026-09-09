import { describe, expect, it, vi } from "vitest";
import { createLocalProduct } from "./local-product.js";
import { createApp } from "./app.js";
import { createPushSupervisionClient, ManagementClientError } from "./management-client.js";

async function inspection() {
  const product = createLocalProduct();
  try {
    const app = createApp(product.handlers);
    const headers = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const created = await app(new Request("http://local/api/v1/campaigns", { method: "POST", headers, body: JSON.stringify({ name: "Draft", channel: "push", push: { appId: "app", selection: { kind: "all" } }, message: { title: "Title", body: "Body", destination: { kind: "app", url: "example://stored" } } }) }));
    expect(created.status).toBe(201);
    const id = (await created.json()).campaign.id;
    return await createPushSupervisionClient(request => app(new Request(request, { headers }))).inspectPushCampaign(id, { page: 1, perPage: 25 });
  } finally { await product.close(); }
}

describe("push supervision client validation", () => {
  it("preserves the complete canonical empty inspection and encodes the campaign ID", async () => {
    const value = await inspection();
    const execute = vi.fn(async (_request: Request) => Response.json(value));
    expect(await createPushSupervisionClient(execute, "https://host.test").inspectPushCampaign("a/b?c", { page: 1, perPage: 25 })).toEqual(value);
    expect(execute.mock.calls[0][0].url).toBe("https://host.test/api/v1/campaigns/a%2Fb%3Fc/push?page=1&perPage=25");
  });
  it("rejects incomplete counters, malformed rows and leaked private properties under the generated schema", async () => {
    const valid = await inspection();
    const cases = [
      { ...valid, users: { targeted: 0 } }, { ...valid, devices: { ...valid.devices, receiptUnknown: -1 } },
      { ...valid, records: { ...valid.records, targets: 0.5 } }, { ...valid, pageCounts: {} },
      { ...valid, tokenScope: "private" }, { ...valid, recipients: [{ id: "r", admission: "private" }] },
      { ...valid, attempts: [{ id: "a", fence: "private" }] }, { ...valid, targets: [{ id: "t", tokenScope: "private" }] },
      ...["outcomes", "observations", "slots", "conversions"].map(kind => ({ ...valid, [kind]: [{}] })),
      { ...valid, planning: undefined }, { ...valid, evaluatedAt: "now" },
    ];
    for (const value of cases) await expect(createPushSupervisionClient(async () => Response.json(value)).inspectPushCampaign("id", { page: 1, perPage: 25 })).rejects.toMatchObject({ kind: "invalid_response", status: 200 });
  });
  it.each([401, 403, 404, 429, 500])("preserves HTTP failure %s with the existing error type", async status => {
    try { await createPushSupervisionClient(async () => Response.json({ error: "Denied" }, { status })).inspectPushCampaign("id", { page: 1, perPage: 25 }); }
    catch (error) { expect(error).toBeInstanceOf(ManagementClientError); expect(error).toMatchObject({ kind: "request_failed", status, detail: "Denied" }); return; }
    throw new Error("Expected rejection");
  });
  it("rejects invalid JSON", async () => {
    await expect(createPushSupervisionClient(async () => new Response("not json")).inspectPushCampaign("id", { page: 1, perPage: 25 })).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([{ page: 0, perPage: 25 }, { page: 1.5, perPage: 25 }, { page: Infinity, perPage: 25 }, { page: 1, perPage: 0 }, { page: 1, perPage: 101 }, { page: 1, perPage: NaN }, { page: Number.MAX_SAFE_INTEGER, perPage: 25 }])("rejects unsafe pagination before transport: %j", async input => {
    const execute = vi.fn();
    await expect(createPushSupervisionClient(execute).inspectPushCampaign("id", input)).rejects.toBeInstanceOf(RangeError);
    expect(execute).not.toHaveBeenCalled();
  });
});
