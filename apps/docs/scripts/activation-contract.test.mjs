import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const docs = new URL("../", import.meta.url);
const contract = JSON.parse(readFileSync(new URL("openapi.json", docs), "utf8"));
const cloud = JSON.parse(readFileSync(new URL("../../packages/server/cloud-operations.json", docs), "utf8"));
const schemas = contract.components.schemas;
const operations = [
  ["/api/v1/launch-policy", "getLaunchPolicy", "setLaunchPolicy", "LaunchPolicy", "defaultMode"],
  ["/api/v1/campaigns/{id}/activation", "getCampaignActivation", "setCampaignActivationMode", "CampaignActivationView", "mode"],
];

for (const [path, read, write, response, field] of operations) {
  test(`${path} keeps Cloud availability and credential boundaries`, () => {
    const { get, patch } = contract.paths[path];
    assert.equal(get.operationId, read);
    assert.equal(patch.operationId, write);
    assert.deepEqual(get.security, [{ secretKey: [] }, { hostedAgentKey: [] }]);
    assert.deepEqual(patch.security, [{ secretKey: [] }]);
    for (const operation of [get, patch]) {
      assert.ok(cloud.operations.includes(operation.operationId));
      assert.ok(operation.responses[501]);
      assert.deepEqual(operation.responses[200].content["application/json"].schema, { $ref: `#/components/schemas/${response}` });
    }
    assert.ok(patch.responses[403]);
    assert.ok(patch.responses[409]);
    assert.equal(get["x-mcp"].mode, "readonly");
    assert.equal(patch["x-mcp"].mode, "full");
    assert.equal(patch["x-mcp"].annotations.destructiveHint, true);
  });

  test(`${path} requires a revision and rejects extra writable fields`, () => {
    const body = contract.paths[path].patch.requestBody.content["application/json"].schema;
    assert.deepEqual(body.required, [field, "expectedRevision"]);
    assert.deepEqual(Object.keys(body.properties), [field, "expectedRevision"]);
    assert.equal(body.additionalProperties, false);
    assert.deepEqual(body.properties.expectedRevision, { type: "string" });
    assert.deepEqual(body.properties[field], field === "mode"
      ? { anyOf: [{ $ref: "#/components/schemas/LaunchMode" }, { type: "null" }] }
      : { $ref: "#/components/schemas/LaunchMode" });
  });
}

test("activation response preserves the settled fields, states, and nullable evidence", () => {
  assert.deepEqual(schemas.CampaignActivationView.required, [
    "campaignId", "revision", "defaultMode", "override", "effectiveMode", "approval",
    "assessment", "requirements", "coverage", "lastCheckedAt", "launch", "warnings",
  ]);
  assert.deepEqual(schemas.LaunchPolicy.required, ["defaultMode", "revision"]);
  assert.deepEqual(schemas.LaunchMode.enum, ["automatic", "manual"]);
  assert.deepEqual(schemas.ActivationCoverage.properties.state.enum, ["present", "absent", "reverted", "unknown", "pending"]);
  assert.deepEqual(schemas.ActivationAssessment.properties.state.enum, ["not_initial", "waiting", "eligible"]);
  assert.deepEqual(schemas.ActivationBlockerCode.enum, [
    "manual", "approval", "no_sources", "mapping", "source_pending", "source_paused",
    "source_unavailable", "project_paused", "withdrawn", "deployment", "evidence_unknown",
    "reverted", "expired", "readiness",
  ]);
  assert.deepEqual(schemas.ShippingWarning.properties.reason.enum, ["rollback", "revert"]);
  for (const field of ["override", "lastCheckedAt", "launch"]) {
    assert.ok(schemas.CampaignActivationView.properties[field].anyOf.some((entry) => entry.type === "null"));
  }
  assert.ok(schemas.ActivationCoverage.properties.evidence.anyOf.some((entry) => entry.type === "null"));
  assert.deepEqual(schemas.ActivationEvidence.required, ["id", "provider", "label", "url", "revision", "reportedAt"]);
  assert.deepEqual(schemas.ActivationReceipt.required, ["mode", "startedAt", "contentHash", "requirementsDigest", "evidence"]);
  for (const name of ["Campaign", "CampaignDetail"]) {
    for (const field of ["activation", "defaultMode", "override", "effectiveMode"]) {
      assert.equal(schemas[name].properties?.[field], undefined);
    }
  }
});
