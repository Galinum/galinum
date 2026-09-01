import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLocalProduct } from "./local-product.js";
import { OPERATIONS } from "./operations.js";

const budget = JSON.parse(
  readFileSync(new URL("../conformance-budget.json", import.meta.url), "utf8"),
) as { missing: string[] };

describe("management API implementation coverage", () => {
  it("matches the reviewed missing-operation budget", () => {
    const implemented = new Set(Object.keys(createLocalProduct().handlers));
    const actual = OPERATIONS
      .filter((operation) => operation.availability === "product")
      .map((operation) => operation.operationId)
      .filter((operationId) => !implemented.has(operationId))
      .sort();
    expect(actual).toEqual([...budget.missing].sort());
  });

  it("contains no handler outside the OpenAPI contract", () => {
    const contracted = new Set(OPERATIONS.map((operation) => operation.operationId));
    const unknown = Object.keys(createLocalProduct().handlers).filter(
      (operationId) => !contracted.has(operationId as never),
    );
    expect(unknown).toEqual([]);
  });

  it("classifies the managed hosted-agent control plane as cloud-only", () => {
    const cloud = OPERATIONS.filter((operation) => operation.availability === "galinum_cloud");
    expect(cloud).toHaveLength(9);
    expect(cloud.map((operation) => operation.operationId)).toContain("reportAgentUsage");
    expect(cloud.map((operation) => operation.operationId)).toContain("claimCampaignEvaluation");
  });
});
