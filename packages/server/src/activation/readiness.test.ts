import { describe, expect, it, vi } from "vitest";
import { canonicalizeExpression, expressionHash, type AudienceExpression, type CampaignChannel, type LaunchReadiness } from "@galinum/core";
import type { CampaignAudience } from "@galinum/core/contract";
import { campaignDefinitionReadiness, type CampaignReadinessResources, type RawCampaignDefinition, type ReadinessAudienceVersion } from "./readiness.js";
import { MemoryProductStore, createLocalProduct, stockWebReadiness, type ProductCampaign } from "../local-product.js";
import { MemoryMediaStore } from "../local-media-store.js";
import { createApp } from "../app.js";

const projectId = "project";
const expression: AudienceExpression = { version: 1, root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "pro" } };
const expressionJson = canonicalizeExpression(expression);
const hash = expressionHash(expressionJson);
function definition(content: unknown = { body: "Feature announcement", presentation: "toast" }, patch: Partial<RawCampaignDefinition> = {}): RawCampaignDefinition {
  return { name: "Feature", channel: "web_inapp", pages: null, deliverFrom: null, deliverUntil: null, goalId: null, audience: { kind: "all" },
    variants: [{ id: "variant", name: "A", contentJson: JSON.stringify(content), weight: 100, isControl: true }], ...patch };
}
function version(patch: Partial<ReadinessAudienceVersion> = {}): ReadinessAudienceVersion {
  return { id: "version", projectId, segmentId: null, segmentVersion: null, schemaVersion: 1, expressionJson, expressionHash: hash, ...patch };
}
function audience(patch: Partial<Extract<CampaignAudience, { kind: "expression" }>> = {}): CampaignAudience {
  return { kind: "expression", audienceVersionId: "version", schemaVersion: 1, expression, expressionHash: hash, summary: "Pro accounts", reason: null, legacy: false, ...patch };
}
function resources() {
  return {
    getGoal: vi.fn<CampaignReadinessResources["getGoal"]>(async (scope, id) => ({ projectId: scope, id })),
    getAudienceVersion: vi.fn<CampaignReadinessResources["getAudienceVersion"]>(async (scope, reference) => version({ projectId: scope, ...reference })),
    getMedia: vi.fn<CampaignReadinessResources["getMedia"]>(async (scope, url) => ({ projectId: scope, url })),
    channelReadiness: vi.fn<CampaignReadinessResources["channelReadiness"]>(async () => ({ ok: true })),
  };
}
const check = (value: RawCampaignDefinition, lookups: CampaignReadinessResources = resources()) => campaignDefinitionReadiness(projectId, value, lookups);

describe("shared current campaign definition readiness", () => {
  it("accepts valid current definitions only with a supplied channel capability", async () => {
    const lookups = resources();
    expect(await check(definition(), lookups)).toEqual({ ok: true });
    expect(lookups.channelReadiness).toHaveBeenCalledWith(projectId, "web_inapp");
    lookups.channelReadiness.mockResolvedValueOnce({ ok: false, error: "Channel is unavailable" });
    expect(await check(definition(), lookups)).toEqual({ ok: false, error: "Channel is unavailable" });
  });
  it.each([undefined, null, { ok: "true" }, {}, { ok: false }])("fails closed for malformed capability %j", async (result) => {
    const lookups = resources(); lookups.channelReadiness.mockResolvedValueOnce(result as LaunchReadiness);
    expect((await check(definition(), lookups)).ok).toBe(false);
  });
  it.each(["zero", "negative", "fractional", "above-100", "empty", "too-many", "two-controls", "duplicate-id"])("rejects invalid %s allocation from current stored facts", async (failure) => {
    const value = definition();
    if (failure === "zero") value.variants[0].weight = 0;
    if (failure === "negative") value.variants[0].weight = -1;
    if (failure === "fractional") value.variants[0].weight = 0.5;
    if (failure === "above-100") value.variants[0].weight = 101;
    if (failure === "empty") value.variants = [];
    if (failure === "too-many") value.variants = Array.from({ length: 11 }, (_, index) => ({ ...value.variants[0], id: `variant-${index}`, name: String(index), isControl: index === 0 }));
    if (failure === "two-controls") value.variants.push({ ...value.variants[0], id: "other", name: "B" });
    if (failure === "duplicate-id") value.variants.push({ ...value.variants[0], name: "B", isControl: false });
    const lookups = resources();
    expect(await check(value, lookups)).toEqual({ ok: false, error: "Invalid variant allocation." });
    expect(lookups.channelReadiness).not.toHaveBeenCalled();
  });
  it("allows zero-weight retired variants and does not require a control variant or weights totaling 100", async () => {
    const value = definition(); value.variants[0].isControl = false;
    value.variants.push({ ...value.variants[0], id: "retired", name: "Retired", weight: 0 });
    expect(await check(value)).toEqual({ ok: true });
    value.variants[1].weight = 100;
    expect(await check(value)).toEqual({ ok: true });
  });
  it.each(["{", "null", "[]", '"text"', "42", "{}"])("rejects invalid or empty raw JSON %s", async (contentJson) => {
    const value = definition(); value.variants[0].contentJson = contentJson;
    expect((await check(value)).ok).toBe(false);
  });
  it.each([
    { title: "t".repeat(121), body: "valid", presentation: "toast" },
    { body: "b".repeat(601), presentation: "toast" },
    { body: " ", title: "\t", presentation: "toast" },
    { body: "body", title: null, presentation: "toast" },
    { body: 12, presentation: "toast" },
    { body: "body", presentation: "banner" },
    { body: "body", presentation: null },
  ])("rejects invalid web content %j", async (content) => {
    expect((await check(definition(content))).ok).toBe(false);
  });
  it("accepts exact web limits and legacy omitted presentation without mutating stored content", async () => {
    const value = definition({ title: "t".repeat(120), body: "b".repeat(600) }); const before = structuredClone(value);
    expect(await check(value)).toEqual({ ok: true }); expect(value).toEqual(before);
    expect(await check(definition({ body: "Legacy media", media: { url: "https://media.example.test/image", alt: "Screenshot" } }))).toEqual({ ok: true });
  });
  it.each(["javascript:alert(1)", "//other.test", "/\\other.test", "data:text/plain,x", "https://user:secret@example.test", "https://example.test/\npath"])("rejects unsafe web CTA %s", async (url) => {
    expect((await check(definition({ body: "Body", cta: { label: "Read", url } }))).ok).toBe(false);
  });
  it.each(["/news", "mailto:support@example.test", "https://example.test/news", "http://example.test/news"])("accepts existing web CTA %s", async (url) => {
    expect(await check(definition({ body: "Body", cta: { label: "Read", url } }))).toEqual({ ok: true });
  });
  it.each([
    { name: "" }, { name: "x".repeat(81) }, { pages: [] }, { pages: ["relative"] }, { channel: "mobile_push" },
    { deliverFrom: 200, deliverUntil: 100 }, { deliverFrom: 100, deliverUntil: 100 }, { deliverFrom: NaN }, { deliverUntil: Infinity },
  ] satisfies Partial<RawCampaignDefinition>[])("rejects malformed definition fields %j", async (patch) => {
    expect((await check(definition(undefined, patch))).ok).toBe(false);
  });
  it("does not mistake a future start for invalid launch readiness", async () => {
    expect(await check(definition(undefined, { deliverFrom: 4_000_000_000_000, deliverUntil: 4_000_000_000_001 }))).toEqual({ ok: true });
  });
});

describe("email definition rules with an explicit channel capability", () => {
  const email = (content: unknown = { subject: "Feature", body: "# Feature" }) => definition(content, { channel: "email" });
  it("accepts exact subject, body and preview limits with HTTP CTA", async () => {
    const lookups = resources();
    expect(await check(email({ subject: "s".repeat(200), body: "b".repeat(50_000), previewText: "p".repeat(200), cta: { label: "Read", url: "https://example.test" } }), lookups)).toEqual({ ok: true });
    expect(lookups.channelReadiness).toHaveBeenCalledWith(projectId, "email");
  });
  it.each([
    { subject: "s".repeat(201), body: "Body" }, { subject: "Subject", body: "b".repeat(50_001) },
    { subject: "Subject", body: "Body", previewText: "p".repeat(201) }, { subject: "Subject\r\nBcc: other", body: "Body" },
    { subject: "Subject\nOther", body: "Body" }, { subject: "", body: "Body" }, { subject: "Subject", body: " " },
    { body: "Body" }, { subject: "Subject" }, { subject: "Subject", body: "Body", title: "Web" },
    { subject: "Subject", body: "Body", presentation: "toast" }, { subject: "Subject", body: "Body", media: { url: "https://example.test/media", alt: "Image" } },
  ])("rejects invalid email content %j", async (content) => {
    expect((await check(email(content))).ok).toBe(false);
  });
  it.each(["/news", "mailto:support@example.test", "javascript:alert(1)", "//example.test", "https://user:password@example.test"])("rejects non-HTTP or unsafe email CTA %s", async (url) => {
    expect((await check(email({ subject: "Subject", body: "Body", cta: { label: "Read", url } }))).ok).toBe(false);
  });
  it("requires an email CTA URL and rejects campaign pages", async () => {
    expect((await check(email({ subject: "Subject", body: "Body", cta: { label: "Read" } }))).ok).toBe(false);
    expect((await check({ ...email(), pages: ["/news"] })).ok).toBe(false);
  });
});

describe("current project resource references", () => {
  it("looks up the exact goal and rejects missing, foreign or mismatched results", async () => {
    const lookups = resources(); const value = definition(undefined, { goalId: "goal" });
    expect(await check(value, lookups)).toEqual({ ok: true });
    expect(lookups.getGoal).toHaveBeenCalledWith(projectId, "goal");
    for (const result of [null, { projectId: "other", id: "goal" }, { projectId, id: "other" }]) {
      lookups.getGoal.mockResolvedValueOnce(result); expect((await check(value, lookups)).ok).toBe(false);
    }
  });
  it("validates anonymous and segment expression identity against raw stored versions", async () => {
    const lookups = resources();
    expect(await check(definition(undefined, { audience: audience() }), lookups)).toEqual({ ok: true });
    expect(lookups.getAudienceVersion).toHaveBeenCalledWith(projectId, { id: "version", segmentId: null, segmentVersion: null });
    const segment: CampaignAudience = { kind: "segment", audienceVersionId: "version", segmentId: "segment", segmentVersion: 3, segmentKey: "pro",
      schemaVersion: 1, expression, expressionHash: hash, summary: "Pro accounts", reason: null };
    expect(await check(definition(undefined, { audience: segment }), lookups)).toEqual({ ok: true });
    expect(lookups.getAudienceVersion).toHaveBeenLastCalledWith(projectId, { id: "version", segmentId: "segment", segmentVersion: 3 });
    for (const result of [null, version(), version({ segmentId: "segment", segmentVersion: 2 }), version({ segmentId: "segment", segmentVersion: 3, projectId: "other" })]) {
      lookups.getAudienceVersion.mockResolvedValueOnce(result); expect((await check(definition(undefined, { audience: segment }), lookups)).ok).toBe(false);
    }
  });
  it.each([
    null, { kind: "invalid", audienceVersionId: null }, { kind: "expression" },
    audience({ expressionHash: "0".repeat(64) }), audience({ schemaVersion: 2 }), audience({ audienceVersionId: null }),
    { ...audience(), expression: { version: 1, root: { kind: "invalid" } } },
  ])("rejects invalid public-wire audience %j", async (value) => {
    expect((await check(definition(undefined, { audience: value }))).ok).toBe(false);
  });
  it.each([
    null, version({ id: "missing" }), version({ projectId: "other" }), version({ expressionHash: "0".repeat(64) }),
    version({ schemaVersion: 2 }), version({ expressionJson: "{" }), version({ expressionJson: "{}" }),
    version({ expressionJson: JSON.stringify({ ...expression, root: { ...expression.root, value: "free" } }) }),
  ])("rejects unavailable or inconsistent stored version %j", async (record) => {
    const lookups = resources(); lookups.getAudienceVersion.mockResolvedValueOnce(record);
    expect((await check(definition(undefined, { audience: audience() }), lookups)).ok).toBe(false);
  });
  it("retains valid legacy expressions and checks supplied raw targeting", async () => {
    const value = definition(undefined, { audience: audience({ audienceVersionId: null, legacy: true }), legacyTargetingJson: JSON.stringify({ traits: { plan: "pro" } }) });
    const lookups = resources();
    expect(await check(value, lookups)).toEqual({ ok: true }); expect(lookups.getAudienceVersion).not.toHaveBeenCalled();
    expect((await check({ ...value, legacyTargetingJson: "{" })).ok).toBe(false);
    expect((await check({ ...value, legacyTargetingJson: JSON.stringify({ traits: { plan: "free" } }) })).ok).toBe(false);
  });
  it("requires project-owned existing media and valid alternative text", async () => {
    const lookups = resources(); const url = "https://media.example.test/image";
    const value = definition({ body: "Body", media: { url, alt: "Screenshot" } });
    expect(await check(value, lookups)).toEqual({ ok: true }); expect(lookups.getMedia).toHaveBeenCalledWith(projectId, url);
    for (const record of [null, { projectId: "other", url }, { projectId, url: `${url}-other` }]) {
      lookups.getMedia.mockResolvedValueOnce(record); expect((await check(value, lookups)).ok).toBe(false);
    }
    for (const media of [{ url }, { url, alt: "" }, { url, alt: "x".repeat(301) }, { url, alt: "Image", decorative: true }, { url, decorative: "true" }]) {
      expect((await check(definition({ body: "Body", media }))).ok).toBe(false);
    }
    expect(await check(definition({ body: "Body", media: { url, decorative: true } }))).toEqual({ ok: true });
  });
  it("looks up distinct media in stable URL order regardless of variant order", async () => {
    const value = definition();
    const urls = ["https://media.example.test/z", "https://media.example.test/a", "https://media.example.test/z"];
    value.variants = urls.map((url, index) => ({ id: `variant-${index}`, name: String(index), weight: 1, isControl: index === 0,
      contentJson: JSON.stringify({ body: "Body", media: { url, alt: "Screenshot" } }) }));
    const lookups = resources();
    expect(await check(value, lookups)).toEqual({ ok: true });
    const expected = [[projectId, "https://media.example.test/a"], [projectId, "https://media.example.test/z"]];
    expect(lookups.getMedia.mock.calls).toEqual(expected);
    lookups.getMedia.mockClear(); value.variants.reverse();
    expect(await check(value, lookups)).toEqual({ ok: true });
    expect(lookups.getMedia.mock.calls).toEqual(expected);
  });
  it("validates all raw messages before acquiring any media resource", async () => {
    const value = definition({ body: "Body", media: { url: "https://media.example.test/z", alt: "Screenshot" } });
    value.variants.push({ id: "broken", name: "Broken", weight: 0, isControl: false, contentJson: "{" });
    const lookups = resources();
    expect((await check(value, lookups)).ok).toBe(false);
    expect(lookups.getMedia).not.toHaveBeenCalled();
  });
  it.each(["getGoal", "getAudienceVersion", "getMedia", "channelReadiness"] as const)("fails closed without exposing errors from %s", async (method) => {
    const lookups = resources(); lookups[method].mockRejectedValueOnce(new Error("backend credential details"));
    const value = definition({ body: "Body", media: { url: "https://media.example.test/image", decorative: true } }, { goalId: "goal", audience: audience() });
    expect(await check(value, lookups)).toEqual({ ok: false, error: "Campaign definition could not be verified." });
  });
});

function storedCampaign(): ProductCampaign {
  return { id: "campaign", name: "Stored feature", status: "draft", channel: "web_inapp", goalId: null, createdAt: 1, startedAt: null, endedAt: null,
    deliverFrom: null, deliverUntil: null, pages: null, audience: { kind: "all" },
    variants: [{ id: "variant", campaign_id: "campaign", name: "A", content_json: JSON.stringify({ body: "Legacy stored body" }), weight: 100, isControl: true }] };
}

describe("stock readiness composition", () => {
  it("launches and resumes authored variants with duplicate display names", async () => {
    const product = createLocalProduct({ secretKey: "readiness-secret", publishableKey: "readiness-public" });
    const app = createApp(product.handlers, product.media, product.operatorHandler);
    const request = (path: string, value: unknown) => app(new Request(`http://local/api/v1${path}`, {
      method: "POST", headers: { authorization: "Bearer readiness-secret", "content-type": "application/json" }, body: JSON.stringify(value),
    }));
    try {
      const created = await request("/campaigns", { name: "Duplicate labels", variants: [
        { message: { title: "One", presentation: "toast" } },
        { name: "A", message: { title: "Two", presentation: "toast" } },
      ] });
      expect(created.status).toBe(201);
      const { campaign } = await created.json();
      expect(campaign.variants.map((variant: { name: string }) => variant.name)).toEqual(["A", "A"]);
      expect(new Set(campaign.variants.map((variant: { id: string }) => variant.id)).size).toBe(2);
      for (const action of ["launch", "pause", "launch"]) {
        expect((await request(`/campaigns/${campaign.id}/status`, { action })).status).toBe(200);
      }
    } finally { await product.close(); }
  });
  it("uses real stored facts for zero weights and malformed JSON and preserves legacy presentation omission", async () => {
    const store = new MemoryProductStore(); const media = new MemoryMediaStore(); const campaign = storedCampaign();
    await store.transaction((session) => session.createCampaign(campaign));
    expect(await stockWebReadiness(store, campaign, media, "local")).toEqual({ ok: true });
    for (const patch of [{ weight: 0 }, { content_json: "{" }, { content_json: "{}" }, { content_json: JSON.stringify({ body: "Body", presentation: "invalid" }) }]) {
      await store.transaction((session) => session.saveCampaignContent({ ...campaign, variants: [{ ...campaign.variants[0], ...patch }] }));
      expect((await stockWebReadiness(store, (await store.getCampaign(campaign.id))!, media, "local")).ok).toBe(false);
    }
  });
  it("uses actual media existence and project ownership in the stock wrapper", async () => {
    const store = new MemoryProductStore(); const media = new MemoryMediaStore(); const campaign = storedCampaign();
    const image = await media.put({ projectId: "local", bytes: new Uint8Array([1]), contentType: "image/png", extension: "png" });
    campaign.variants[0].content_json = JSON.stringify({ body: "Body", media: { url: image.path, alt: "Screenshot" } });
    expect(await stockWebReadiness(store, campaign, media, "local")).toEqual({ ok: true });
    expect((await stockWebReadiness(store, campaign, media, "other")).ok).toBe(false);
    campaign.variants[0].content_json = JSON.stringify({ body: "Body", media: { url: "/media/projects/local/media/missing.png", alt: "Screenshot" } });
    expect((await stockWebReadiness(store, campaign, media, "local")).ok).toBe(false);
  });
  it("resolves current inline versions through the borrowed store and rejects missing goal or segment references", async () => {
    const store = new MemoryProductStore(); const media = new MemoryMediaStore(); const campaign = storedCampaign();
    const storedAudience = { kind: "expression" as const, audienceVersionId: "version", schemaVersion: 1, expressionJson, expressionHash: hash, summary: "Pro accounts", reason: null };
    campaign.audience = storedAudience;
    await store.transaction(async (session) => {
      await session.createCampaign(campaign);
      expect(await stockWebReadiness(session, campaign, media, "local")).toEqual({ ok: true });
      expect((await stockWebReadiness(session, { ...campaign, goalId: "missing" }, media, "local")).ok).toBe(false);
      expect((await stockWebReadiness(session, { ...campaign, audience: { ...storedAudience, audienceVersionId: "missing" } }, media, "local")).ok).toBe(false);
      const missingSegment: ProductCampaign = { ...campaign, audience: { kind: "segment", audienceVersionId: "version", segmentId: "missing", segmentKey: "pro", segmentVersion: 1,
        schemaVersion: 1, expressionJson, expressionHash: hash, summary: "Pro accounts", reason: null } };
      expect((await stockWebReadiness(session, missingSegment, media, "local")).ok).toBe(false);
    });
  });

  it("still requires presentation when authoring through the public API", async () => {
    const product = createLocalProduct({ secretKey: "readiness-secret", publishableKey: "readiness-public" });
    const app = createApp(product.handlers, product.media, product.operatorHandler);
    try {
      const response = await app(new Request("http://local/api/v1/campaigns", { method: "POST", headers: { authorization: "Bearer readiness-secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "Authored", message: { body: "New messages require presentation" } }) }));
      expect(response.status).toBe(400);
    } finally { await product.close(); }
  });
  it("does not add email delivery capability to the stock web runtime", async () => {
    const campaign = { ...storedCampaign(), channel: "email" as CampaignChannel } as ProductCampaign;
    campaign.variants[0].content_json = JSON.stringify({ subject: "Subject", body: "Body" });
    expect((await stockWebReadiness(new MemoryProductStore(), campaign, new MemoryMediaStore(), "local")).ok).toBe(false);
  });
});
