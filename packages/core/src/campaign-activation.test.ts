import { describe, expect, it } from "vitest";
import {
  assessAutomaticActivation,
  type ActivationCoverage,
  type ActivationEvidence,
  type ActivationInput,
  type LaunchMode,
} from "./campaign-activation.js";

function evidence(id = "deployment-1"): ActivationEvidence {
  return { id, provider: "fixture", label: "Production", url: "https://example.test/deployments/1",
    revision: "revision-1", reportedAt: 10 };
}

function input(patch: Partial<ActivationInput> = {}): ActivationInput {
  return {
    status: "draft", startedAt: null, defaultMode: "automatic", override: null,
    approved: true, withdrawn: false, projectPaused: false, readiness: { ok: true },
    sources: [{ id: "source-1", state: "ready" }],
    requirements: [{ id: "change-1", sourceId: "source-1", label: "Feature", mappingIds: ["web"] }],
    coverage: [{ requirementId: "change-1", mappingId: "web", state: "present", evidence: evidence() }],
    deliverUntil: null, now: 100,
    ...patch,
  };
}

const eligible = { state: "eligible", blockers: [] };

describe("initial automatic activation", () => {
  it("blocks failed launch readiness even with approval and current deployment coverage", () => {
    const campaign = input({ readiness: { ok: false, error: "The sending domain is unverified." } });
    expect(assessAutomaticActivation(campaign)).toEqual({ state: "waiting", blockers: [
      { code: "readiness", detail: "The sending domain is unverified." },
    ] });
  });

  it("requires explicit launch readiness from JavaScript callers", () => {
    const campaign = Object.assign(input(), { readiness: undefined });
    expect(Reflect.apply(assessAutomaticActivation, undefined, [campaign])).toEqual({ state: "waiting", blockers: [
      { code: "readiness", detail: "Launch readiness has not been verified." },
    ] });
  });

  it("accepts approved current coverage without a delivery expiry", () => {
    expect(assessAutomaticActivation(input())).toEqual(eligible);
  });

  it.each(["draft", "running", "paused", "ended"] as const)("never restarts a started %s campaign", (status) => {
    expect(assessAutomaticActivation(input({ status, startedAt: 0 })))
      .toEqual({ state: "not_initial", blockers: [] });
  });

  it.each(["running", "paused", "ended"] as const)("refuses %s even without a start timestamp", (status) => {
    expect(assessAutomaticActivation(input({ status })))
      .toEqual({ state: "not_initial", blockers: [] });
  });

  it.each<{ defaultMode: LaunchMode; override: LaunchMode | null; automatic: boolean }>([
    { defaultMode: "automatic", override: null, automatic: true },
    { defaultMode: "manual", override: null, automatic: false },
    { defaultMode: "automatic", override: "manual", automatic: false },
    { defaultMode: "manual", override: "automatic", automatic: true },
    { defaultMode: "automatic", override: "automatic", automatic: true },
    { defaultMode: "manual", override: "manual", automatic: false },
  ])("uses current default $defaultMode and override $override", ({ defaultMode, override, automatic }) => {
    expect(assessAutomaticActivation(input({ defaultMode, override }))).toEqual(automatic
      ? eligible : { state: "waiting", blockers: [{ code: "manual" }] });
  });

  it("becomes eligible when approval follows the same successful deployment", () => {
    const campaign = input({ approved: false });
    expect(assessAutomaticActivation(campaign))
      .toEqual({ state: "waiting", blockers: [{ code: "approval" }] });
    campaign.approved = true;
    expect(assessAutomaticActivation(campaign)).toEqual(eligible);
  });

  it.each([
    [99, "waiting"], [100, "waiting"], [101, "eligible"], [null, "eligible"],
  ] as const)("treats delivery expiry %s as exclusive", (deliverUntil, state) => {
    expect(assessAutomaticActivation(input({ deliverUntil }))).toEqual({ state,
      blockers: state === "waiting" ? [{ code: "expired" }] : [] });
  });

  it.each([NaN, Infinity, -Infinity])("fails safely for invalid time %s", (time) => {
    expect(assessAutomaticActivation(input({ now: time })).blockers).toContainEqual({ code: "expired" });
    expect(assessAutomaticActivation(input({ deliverUntil: time })).blockers).toContainEqual({ code: "expired" });
  });
});

describe("source and mapping safety", () => {
  it.each([
    ["pending", "source_pending"], ["paused", "source_paused"], ["unavailable", "source_unavailable"],
  ] as const)("waits for a %s source even with present deployment coverage", (state, code) => {
    expect(assessAutomaticActivation(input({ sources: [{ id: "source-1", state }] })))
      .toEqual({ state: "waiting", blockers: [{ code, sourceId: "source-1" }] });
  });

  it("checks all sources, including one without a resolved requirement", () => {
    expect(assessAutomaticActivation(input({ sources: [
      { id: "source-1", state: "ready" }, { id: "source-2", state: "paused" },
    ] }))).toEqual({ state: "waiting", blockers: [{ code: "source_paused", sourceId: "source-2" }] });
  });

  it("does not let a duplicate ready source hide a contradictory paused state", () => {
    expect(assessAutomaticActivation(input({ sources: [
      { id: "source-1", state: "paused" }, { id: "source-1", state: "ready" },
    ] })).state).toBe("waiting");
  });

  it.each<Partial<ActivationInput>>([
    { sources: [], requirements: [], coverage: [] },
    { requirements: [], coverage: [] },
    { sources: [] },
  ])("rejects empty source or requirement sets: %j", (patch) => {
    const result = assessAutomaticActivation(input(patch));
    expect(result.state).toBe("waiting");
    expect(result.blockers).toContainEqual({ code: "no_sources" });
  });

  it("requires every requirement's source to exist", () => {
    expect(assessAutomaticActivation(input({ sources: [{ id: "another-source", state: "ready" }] })))
      .toEqual({ state: "waiting", blockers: [{ code: "source_unavailable", sourceId: "source-1", requirementId: "change-1" }] });
  });

  it.each([{ mappingIds: [] }, { mappingIds: [""] }])("rejects an unresolved mapping set $mappingIds", ({ mappingIds }) => {
    const result = assessAutomaticActivation(input({ requirements: [
      { id: "change-1", sourceId: "source-1", label: "Feature", mappingIds },
    ] }));
    expect(result.state).toBe("waiting");
    expect(result.blockers).toEqual([expect.objectContaining({ code: "mapping", requirementId: "change-1" })]);
  });
});

describe("complete deployment coverage", () => {
  it.each([
    ["absent", "deployment"], ["pending", "deployment"],
    ["unknown", "evidence_unknown"], ["reverted", "reverted"],
  ] as const)("blocks %s coverage with its reason and exact scope", (state, code) => {
    const campaign = input();
    campaign.coverage[0] = { ...campaign.coverage[0], state, reason: "Provider reason" };
    expect(assessAutomaticActivation(campaign)).toEqual({ state: "waiting", blockers: [{
      code, sourceId: "source-1", requirementId: "change-1", mappingId: "web", detail: "Provider reason",
    }] });
  });

  it("requires evidence behind a present claim", () => {
    const campaign = input();
    campaign.coverage[0].evidence = null;
    expect(assessAutomaticActivation(campaign)).toEqual({ state: "waiting", blockers: [{
      code: "evidence_unknown", sourceId: "source-1", requirementId: "change-1", mappingId: "web",
    }] });
  });

  it.each<{ coverage: ActivationCoverage[] }>([
    { coverage: [] },
    { coverage: [{ requirementId: "other-change", mappingId: "web", state: "present", evidence: evidence() }] },
    { coverage: [{ requirementId: "change-1", mappingId: "other-mapping", state: "present", evidence: evidence() }] },
  ])("cannot substitute unrelated coverage: $coverage", ({ coverage }) => {
    expect(assessAutomaticActivation(input({ coverage }))).toEqual({ state: "waiting", blockers: [{
      code: "evidence_unknown", sourceId: "source-1", requirementId: "change-1", mappingId: "web", detail: "Coverage is missing.",
    }] });
  });

  it.each(["present", "absent", "reverted", "unknown", "pending"] as const)("rejects duplicate present/%s coverage in either order", (state) => {
    const campaign = input();
    campaign.coverage.push({ ...campaign.coverage[0], state, evidence: evidence("deployment-2") });
    const assessment = assessAutomaticActivation(campaign);
    expect(assessment.state).toBe("waiting");
    expect(assessment.blockers).toContainEqual(expect.objectContaining({ code: "evidence_unknown", mappingId: "web" }));
    campaign.coverage.reverse();
    expect(assessAutomaticActivation(campaign)).toEqual(assessment);
  });

  it("requires every mapping of every change across sources and reevaluates revised requirements", () => {
    const campaign = input({
      sources: [{ id: "source-1", state: "ready" }, { id: "source-2", state: "ready" }],
      requirements: [
        { id: "change-1", sourceId: "source-1", label: "Web and worker", mappingIds: ["web", "worker"] },
        { id: "change-2", sourceId: "source-2", label: "API", mappingIds: ["api"] },
      ],
    });
    campaign.coverage.push({ requirementId: "change-1", mappingId: "worker", state: "present", evidence: evidence("worker-deployment") });
    expect(assessAutomaticActivation(campaign).blockers).toEqual([expect.objectContaining({ requirementId: "change-2", mappingId: "api" })]);
    campaign.coverage.push({ requirementId: "change-2", mappingId: "api", state: "present", evidence: evidence("api-deployment") });
    expect(assessAutomaticActivation(campaign)).toEqual(eligible);
    for (const coverage of campaign.coverage) {
      coverage.state = "pending";
      expect(assessAutomaticActivation(campaign).blockers).toEqual([expect.objectContaining({
        code: "deployment", requirementId: coverage.requirementId, mappingId: coverage.mappingId,
      })]);
      coverage.state = "present";
    }
    campaign.requirements.push({ id: "change-3", sourceId: "source-1", label: "Added after approval", mappingIds: ["web"] });
    expect(assessAutomaticActivation(campaign).blockers).toEqual([expect.objectContaining({ requirementId: "change-3", code: "evidence_unknown" })]);
  });

  it("collects independent blockers instead of stopping at manual mode or approval", () => {
    const campaign = input({ override: "manual", approved: false, withdrawn: true, projectPaused: true, deliverUntil: 100,
      sources: [{ id: "source-1", state: "pending" }, { id: "source-2", state: "paused" }, { id: "source-3", state: "unavailable" }],
      requirements: [
        { id: "change-1", sourceId: "source-1", label: "Unmapped", mappingIds: [] },
        { id: "change-2", sourceId: "source-2", label: "Reverted", mappingIds: ["api"] },
      ],
      coverage: [{ requirementId: "change-2", mappingId: "api", state: "reverted", evidence: evidence() }],
    });
    expect(assessAutomaticActivation(campaign)).toEqual({ state: "waiting", blockers: [
      { code: "manual" }, { code: "approval" }, { code: "withdrawn" }, { code: "project_paused" },
      { code: "source_pending", sourceId: "source-1" }, { code: "source_paused", sourceId: "source-2" },
      { code: "source_unavailable", sourceId: "source-3" },
      { code: "mapping", sourceId: "source-1", requirementId: "change-1" },
      { code: "reverted", sourceId: "source-2", requirementId: "change-2", mappingId: "api" }, { code: "expired" },
    ] });
  });

  it("does not mutate its input or depend on wall-clock time", () => {
    const campaign = input({ deliverUntil: 101 });
    const before = structuredClone(campaign);
    function freeze(value: object) {
      for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
      Object.freeze(value);
    }
    freeze(campaign);
    expect(assessAutomaticActivation(campaign)).toEqual(eligible);
    expect(assessAutomaticActivation(campaign)).toEqual(eligible);
    expect(campaign).toEqual(before);
  });
});
