import { describe, expect, it } from "vitest";
import { planCampaignLifecycle, type CampaignLifecycleCommand, type CampaignLifecycleInput } from "./campaign-lifecycle.js";
const draft: CampaignLifecycleInput = { status: "draft", startedAt: null, endedAt: null, deliverUntil: null };
const launch = { action: "launch", readiness: { ok: true } } as const;
const automatic = { ...launch, initialOnly: true };

describe("campaign lifecycle plans", () => {
  it("starts once and preserves the first start when manually resumed", () => {
    expect(planCampaignLifecycle(draft, automatic, 100)).toEqual({ ok: true, initial: true, lifecycle: { status: "running", startedAt: 100, endedAt: null } });
    expect(planCampaignLifecycle({ ...draft, status: "paused", startedAt: 10 }, launch, 100)).toEqual({ ok: true, initial: false, lifecycle: { status: "running", startedAt: 10, endedAt: null } });
  });
  it.each(["running", "paused", "ended"] as const)("does not automatically activate %s", (status) => {
    expect(planCampaignLifecycle({ ...draft, status }, automatic, 100).ok).toBe(false);
  });
  it("rejects an already-started draft through the initial-only path", () => {
    expect(planCampaignLifecycle({ ...draft, startedAt: 0 }, automatic, 100).ok).toBe(false);
  });
  it.each([99, 100])("treats expiry %i as exclusive", (deliverUntil) => {
    expect(planCampaignLifecycle({ ...draft, deliverUntil }, launch, 100).ok).toBe(false);
    expect(planCampaignLifecycle({ ...draft, deliverUntil }, { action: "end" }, 100)).toEqual({ ok: true, initial: false, lifecycle: { status: "ended", startedAt: null, endedAt: 100 } });
  });
  it("permits an unexpired launch and records end without replacing start", () => {
    expect(planCampaignLifecycle({ ...draft, deliverUntil: 101 }, launch, 100).ok).toBe(true);
    expect(planCampaignLifecycle({ ...draft, status: "paused", startedAt: 5 }, { action: "end" }, 100)).toEqual({ ok: true, initial: false, lifecycle: { status: "ended", startedAt: 5, endedAt: 100 } });
  });
  it.each(["launch", "pause", "end"] as const)("does not apply %s to an ended campaign", (action) => {
    expect(planCampaignLifecycle({ ...draft, status: "ended", endedAt: 50 }, action === "launch" ? launch : { action }, 100).ok).toBe(false);
  });
  it("pauses only running campaigns without requiring readiness", () => {
    expect(planCampaignLifecycle(draft, { action: "pause" }, 100).ok).toBe(false);
    expect(planCampaignLifecycle({ ...draft, status: "running", startedAt: 50 }, { action: "pause" }, 100)).toEqual({ ok: true, initial: false, lifecycle: { status: "paused", startedAt: 50, endedAt: null } });
  });
  it.each([NaN, Infinity, -Infinity])("rejects invalid clock %s", (now) => {
    expect(planCampaignLifecycle(draft, launch, now).ok).toBe(false);
  });
  it.each([undefined, null, { ok: false, error: "Unverified channel" }, { ok: "true" }])("rejects unavailable readiness %j", (readiness) => {
    expect(planCampaignLifecycle(draft, { action: "launch", readiness } as unknown as CampaignLifecycleCommand, 100).ok).toBe(false);
    expect(planCampaignLifecycle({ ...draft, status: "paused", startedAt: 5 }, { action: "launch", readiness } as unknown as CampaignLifecycleCommand, 100).ok).toBe(false);
  });
});
