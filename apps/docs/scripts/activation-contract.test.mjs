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
  test(`${path} keeps product availability and credential boundaries`, () => {
    const { get, patch } = contract.paths[path];
    assert.equal(get.operationId, read);
    assert.equal(patch.operationId, write);
    assert.deepEqual(get.security, [{ secretKey: [] }, { hostedAgentKey: [] }]);
    assert.deepEqual(patch.security, [{ secretKey: [] }]);
    for (const operation of [get, patch]) {
      assert.ok(!cloud.operations.includes(operation.operationId));
      assert.equal(operation.responses[501], undefined);
      assert.doesNotMatch(operation.description, /Cloud.only|self-host returns 501/i);
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
  assert.deepEqual(schemas.ActivationCoverage.required, ["requirementId", "mappingId", "state", "evidence"]);
  assert.equal(schemas.ActivationCoverage.properties.mappingLabel.type, "string");
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


test("source declarations use atomic create and revisioned replacement shapes", () => {
  const create = contract.paths["/api/v1/campaigns"].post.requestBody.content["application/json"].schema;
  const update = contract.paths["/api/v1/campaigns/{id}"].patch.requestBody.content["application/json"].schema;
  assert.deepEqual(create.properties.sourceChanges, { $ref: "#/components/schemas/CampaignSourceChangesCreate" });
  assert.deepEqual(update.properties.sourceChanges, { $ref: "#/components/schemas/CampaignSourceChangesUpdate" });
  assert.ok(!create.required.includes("sourceChanges"));
  assert.ok(!(update.required ?? []).includes("sourceChanges"));
  assert.deepEqual(schemas.CampaignSourceChangesCreate.required, ["changes"]);
  assert.equal(schemas.CampaignSourceChangesCreate.properties.expectedRevision, undefined);
  assert.deepEqual(schemas.CampaignSourceChangesUpdate.required, ["expectedRevision", "changes"]);
  for (const name of ["CampaignSourceChangesCreate", "CampaignSourceChangesUpdate"]) {
    assert.equal(schemas[name].additionalProperties, false);
    assert.equal(schemas[name].properties.changes.minItems, undefined);
  }
  const [commit, pullRequest] = schemas.CampaignSourceChange.oneOf;
  assert.deepEqual(commit.required, ["sourceId", "kind", "sha"]);
  assert.deepEqual(pullRequest.required, ["sourceId", "kind", "number", "shas"]);
  assert.equal(commit.additionalProperties, false);
  assert.equal(pullRequest.additionalProperties, false);
  assert.equal(commit.properties.kind.const, "commit");
  assert.equal(pullRequest.properties.kind.const, "pull_request");
  assert.equal(pullRequest.properties.shas.minItems, 1);
  assert.equal(pullRequest.properties.shas.maxItems, undefined);
  const detail = schemas.CampaignDetail.allOf.find((entry) => entry.properties);
  assert.ok(detail.required.includes("sourceChanges"));
  assert.deepEqual(detail.properties.sourceChanges, { $ref: "#/components/schemas/CampaignSourceChanges" });
  assert.deepEqual(schemas.CampaignSourceChanges.required, ["revision", "changes"]);
});


test("hosted source jobs remain separate from product activation and operator HTTP", () => {
  for (const [path, method, id] of [
    ["/api/v1/github/refs/due", "get", "listDueGithubRefs"],
    ["/api/v1/github/refs/{refId}/claim", "post", "claimGithubRef"],
    ["/api/v1/github/refs/{refId}/reconcile", "post", "reconcileGithubRef"],
  ]) {
    const operation = contract.paths[path][method];
    assert.equal(operation.operationId, id);
    assert.ok(cloud.operations.includes(id));
    assert.equal(operation["x-mcp"].exposed, false);
  }
  assert.ok(Object.keys(contract.paths).every((path) => !path.startsWith("/operator/")));
});


test("complete source reads do not inherit declaration write-size limits", () => {
  const readChanges = schemas.CampaignSourceChanges.properties.changes;
  assert.deepEqual(readChanges.items, { $ref: "#/components/schemas/CampaignSourceChange" });
  assert.equal(readChanges.maxItems, undefined);
  assert.equal(schemas.CampaignSourceChange.oneOf[1].properties.shas.maxItems, undefined);
  assert.equal(schemas.CampaignSourceChanges.additionalProperties, false);
  for (const name of ["CampaignSourceChangesCreate", "CampaignSourceChangesUpdate"]) {
    const writeChanges = schemas[name].properties.changes;
    assert.equal(writeChanges.maxItems, 100);
    assert.deepEqual(writeChanges.items, { $ref: "#/components/schemas/CampaignSourceChangeInput" });
  }
  assert.deepEqual(schemas.CampaignSourceChangeInput.allOf, [
    { $ref: "#/components/schemas/CampaignSourceChange" },
    { type: "object", properties: { shas: { type: "array", maxItems: 250 } } },
  ]);
});
