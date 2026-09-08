import { describe, expect, it } from "vitest";
import type { InstallationState } from "@galinum/contracts";
import { selectInstallations } from "./installations.js";

const eligible: InstallationState = { id: "a", appId: "app", platform: "ios", environment: "production", userId: "user", bindingGeneration: 1, revision: 4, tokenRevision: 1, hasToken: true, permission: "granted", consent: true, capabilities: { actions: [], channels: [], richImages: false }, lastActiveAt: null, createdAt: 0 };
describe("installation selection", () => {
  it("requires every eligibility condition and never falls back from a specific installation", () => {
    const installations = [eligible, { ...eligible, id: "b", permission: "provisional" as const }, { ...eligible, id: "c", consent: false }, { ...eligible, id: "d", hasToken: false }, { ...eligible, id: "e", permission: "denied" as const }, { ...eligible, id: "f", userId: null }];
    expect(selectInstallations(installations, "user", { kind: "all" }).map((row) => row.id)).toEqual(["a", "b"]);
    expect(selectInstallations(installations, "user", { kind: "specific", installationId: "c" })).toEqual([]);
    expect(selectInstallations(installations, "other", { kind: "last_active" })).toEqual([]);
  });
  it("uses activity then codepoint ordering without mutating the caller array", () => {
    const installations = [{ ...eligible, id: "b", lastActiveAt: 10 }, { ...eligible, id: "A", lastActiveAt: 10 }, eligible];
    expect(selectInstallations(installations, "user", { kind: "last_active" }).map((row) => row.id)).toEqual(["A"]);
    expect(installations.map((row) => row.id)).toEqual(["b", "A", "a"]);
  });
});
