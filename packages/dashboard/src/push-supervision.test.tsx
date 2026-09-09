import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CampaignDetailResult, PushInspection } from "@galinum/core/contract";
import { CampaignDetailPage, type CampaignDetailPageProps } from "./campaign-detail.js";
import { CampaignsPage } from "./campaigns.js";
import { parsePushSupervisionQuery, PushSupervision } from "./push-supervision.js";

const stats = { sent: 123, frequencyCapped: 0, delivered: 0, shown: 456, opened: 0, clicked: 789, dismissed: 0, bounced: 0, complained: 0, unsubscribed: 0, converted: 0 };
const content = { title: "<script>stored</script>", body: "Body <img onerror=alert(1)>", destination: { kind: "app" as const, url: "example://inert" }, image: "https://example.test/inert.png", actions: [{ id: "action-id", title: "Action label" }], data: { source: "stored-data" }, ios: { subtitle: "Subtitle", categoryId: "category", badge: 2, sound: "ios-sound" }, android: { channelId: "channel", sound: "android-sound" } };
const detail: CampaignDetailResult = { evaluatedAt: 1000, campaign: {
  id: "push", name: "Push campaign", channel: "push", push: { appId: "app", selection: { kind: "specific", installationId: "device" }, ttlSeconds: 3600, replacementKey: "replace" },
  status: "draft", effectiveStatus: "draft", goalId: null, createdBy: "api", createdAt: 100, startedAt: null, endedAt: null, deliverFrom: null, deliverUntil: 2000,
  stats, audience: { kind: "all" }, sourceChanges: { revision: "0", changes: [] }, pages: ["/must-not-render"], targeting: null,
  variants: [{ id: "v", name: "A", isControl: true, weight: 2, content, stats }],
} };
const outcomeKinds = ["accepted", "rejected", "unknown", "blocked"] as const;
const inspection: PushInspection = {
  evaluatedAt: 1500, page: 1, perPage: 25, testTargets: 2,
  users: { targeted: 10, accepted: 8, engaged: 2, converted: 1 },
  devices: { targeted: 30, accepted: 27, receiptObserved: 1, receiptUnknown: 27, waiting: 1, attempts: 32, confirmedSubmissions: 29, possibleSubmissions: 1, preSendBlocks: 1, pendingOutcomes: 1 },
  planning: { waiting: 1, active: 10, closed: 0 },
  records: { targets: 30, attempts: 32, outcomes: 31, observations: 3, recipients: 11, slots: 32, conversions: 1 },
  pageCounts: { targets: 2, attempts: 2, outcomes: 2, observations: 1, recipients: 1, slots: 2, conversions: 1 },
  targets: [], attempts: [{ id: "unrelated-page-attempt", campaignId: "push", targetId: "target", slotId: "slot", ordinal: 1, startedAt: 1000, validUntil: 2000, slotRevision: 1 }], observations: [], recipients: [], slots: [], conversions: [],
  outcomes: outcomeKinds.map((kind, index) => ({ id: `outcome-${index}`, campaignId: "push", attemptId: `other-page-attempt-${index}`, targetId: "target", slotId: "slot", observedAt: 1000, result: { kind, code: "public-code", retryAfterMs: 2000 }, submission: index === 2 ? "possible" : index === 3 ? "none" : "confirmed" })),
};
const href = ({ kind, page }: { kind: string; page: number }) => `/campaigns/push?keep=value&pushKind=${kind}&pushPage=${page}`;
const props = (): CampaignDetailPageProps => ({
  campaignId: "push", projectName: "Project", query: { state: "", page: 1 }, Link: p => <a {...p} />,
  management: { getCampaign: vi.fn(async () => detail), listCampaignDeliveries: vi.fn(async () => { throw new Error("Legacy delivery read"); }) },
  pushSupervision: { inspectPushCampaign: vi.fn(async () => inspection) }, pushQuery: { kind: "outcomes", page: 1 }, pushInspectionHref: href,
  renderMessage: vi.fn(() => { throw new Error("Legacy preview"); }), renderContext: () => <aside>Activation and review</aside>, renderActions: () => <span>Pause and end</span>,
});

describe("public push supervision composition", () => {
  it("loads only canonical inspection, preserves safety context, and keeps all push content inert", async () => {
    const input = props(); const html = renderToStaticMarkup(await CampaignDetailPage(input));
    expect(input.pushSupervision.inspectPushCampaign).toHaveBeenCalledExactlyOnceWith("push", { page: 1, perPage: 25 });
    expect(input.management.listCampaignDeliveries).not.toHaveBeenCalled(); expect(input.renderMessage).not.toHaveBeenCalled();
    for (const text of ["Unique users", "Device slots", "Submission facts", "Receipt unknown slots", "Provider rejected", "Submission uncertain", "Blocked before send", "Possible submission", "Confirmed submission", "Not submitted", "public-code", "2000 ms", "other-page-attempt", "Activation and review", "Pause and end", "variant totals are unavailable", "control", "weight 2", "stored-data", "Subtitle", "ios-sound", "android-sound", "example://inert", "3600 seconds", "replace", "Action label", "action-id"]) expect(html).toContain(text);
    for (const text of ["Impressions", "click-through", "unrelated-page-attempt", "/must-not-render", "Each user", "<script", "<img", 'href="example:', 'src="https://example.test']) expect(html).not.toContain(text);
    expect(html).toContain("&lt;script&gt;stored&lt;/script&gt;");
    expect(html.indexOf("Pause and end")).toBeLessThan(html.indexOf("Activation and review"));
    expect(html.indexOf("Activation and review")).toBeLessThan(html.indexOf("Unique users"));
    expect(html).toContain("pushKind=attempts&amp;pushPage=1"); expect(html).toContain("keep=value");
    expect(html).toContain('scope="col"'); expect(html).toContain('aria-current="page"');
  });
  it.each([401, 403, 404, 429, 500, 200])("shows inspection failure %s without fabricated zero totals", async (status) => {
    const input = props(); input.pushSupervision.inspectPushCampaign = vi.fn(async () => { throw { status, detail: "private error" }; });
    const html = renderToStaticMarkup(await CampaignDetailPage(input));
    expect(html).toContain("Push inspection could not be loaded"); expect(html).toContain("Retry push inspection");
    expect(html).toContain("Activation and review"); expect(html).toContain("Stored push content");
    expect(html).not.toContain("Unique users"); expect(html).not.toContain("private error");
    expect(html.includes("Access to push inspection was denied")).toBe(status === 401 || status === 403);
  });
  it("retains canonical totals for a stale page without recursive loads or page-local joins", async () => {
    const input = props(); input.pushQuery.page = 9;
    input.pushSupervision.inspectPushCampaign = vi.fn(async () => ({ ...inspection, page: 9, outcomes: [] }));
    const html = renderToStaticMarkup(await CampaignDetailPage(input));
    expect(input.pushSupervision.inspectPushCampaign).toHaveBeenCalledTimes(1);
    expect(html).toContain("31 outcomes · Page 9 of 2"); expect(html).toContain("Go to last available page");
    expect(html).toContain("Unique users"); expect(html).not.toContain("No outcomes yet");
    expect(html).toContain("pushPage=2");
  });
  it("renders each independent record collection and its count", () => {
    for (const kind of Object.keys(inspection.records) as Array<keyof PushInspection["records"]>) {
      const html = renderToStaticMarkup(<PushSupervision inspection={inspection} query={{ kind, page: 1 }} href={href} Link={p => <a {...p} />} />);
      expect(html).toContain(`${inspection.records[kind]} ${kind}`);
      expect(html.includes("unrelated-page-attempt")).toBe(kind === "attempts");
    }
  });
  it("shows a genuine empty draft without claiming missing outcomes failed", async () => {
    const input = props(); input.pushSupervision.inspectPushCampaign = vi.fn(async () => ({ ...inspection, outcomes: [], records: { ...inspection.records, outcomes: 0 }, pageCounts: { ...inspection.pageCounts, outcomes: 1 } }));
    const html = renderToStaticMarkup(await CampaignDetailPage(input));
    expect(html).toContain("No outcomes yet"); expect(html).toContain("0 outcomes · Page 1 of 1");
    expect(html).not.toContain("failed");
  });
  it("keeps email and web delivery metrics and legacy previews without inspecting push", async () => {
    for (const channel of ["email", "web_inapp"] as const) {
      const input = props(); const { push: _push, ...common } = detail.campaign;
      input.management.getCampaign = async () => ({ ...detail, campaign: { ...common, channel, variants: [{ ...detail.campaign.variants[0], content: channel === "email" ? { subject: "Subject", body: "Email body" } : { presentation: "toast", title: "Web title" } }] } });
      input.management.listCampaignDeliveries = vi.fn(async () => ({ values: [], total: 0, page: 1, pageCount: 1 }));
      input.renderMessage = undefined;
      const html = renderToStaticMarkup(await CampaignDetailPage(input));
      expect(input.pushSupervision.inspectPushCampaign).not.toHaveBeenCalled();
      expect(input.management.listCampaignDeliveries).toHaveBeenCalledTimes(1);
      expect(html).toContain(channel === "email" ? "Email body" : "Web title");
      expect(html).toContain(channel === "email" ? "Unsubscribed" : "Impressions");
    }
  });
  it("renders mixed lists with truthful push labels and no legacy push counters", async () => {
    const { push: _push, ...common } = detail.campaign;
    const listCampaigns = vi.fn(async () => ({ values: [detail.campaign, { ...common, id: "email", channel: "email" as const }, { ...common, id: "web", channel: "web_inapp" as const }], total: 3, page: 1, pageCount: 1, evaluatedAt: 1000 }));
    const html = renderToStaticMarkup(await CampaignsPage({ management: { listCampaigns }, Link: p => <a {...p} />, docsUrl: "https://docs.galinum.com", query: { q: "", page: 1, status: "" } }));
    const pushRow = html.split('href="/campaigns/push"')[1].split("</a>")[0];
    expect(pushRow).toContain("Push · Created"); expect(pushRow).toContain("View push supervision");
    expect(pushRow).not.toContain("456"); expect(pushRow).not.toContain("789"); expect(pushRow).not.toContain("Impressions");
    expect(html).toContain("Email · Created"); expect(html).toContain("Web in-app · Created"); expect(listCampaigns).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "NaN", "Infinity", "1.5", "-1", "0", "9007199254740992"])("normalizes invalid query page %s", pushPage => {
    expect(parsePushSupervisionQuery({ pushKind: "invalid", pushPage })).toEqual({ kind: "outcomes", page: 1 });
  });
  it("caps valid UI pages and preserves known collections", () => {
    expect(parsePushSupervisionQuery({ pushKind: "slots", pushPage: "10001" })).toEqual({ kind: "slots", page: 10000 });
  });
});
