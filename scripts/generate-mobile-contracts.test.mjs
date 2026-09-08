import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateMobile, schemaType } from "./generate-mobile-contracts.mjs";

test("mobile contracts match canonical OpenAPI and remain runtime independent", () => {
  const contract = JSON.parse(readFileSync(new URL("../apps/docs/openapi.json", import.meta.url), "utf8"));
  const source = readFileSync(new URL("../packages/contracts/src/index.ts", import.meta.url), "utf8");
  assert.equal(source, generateMobile(contract));
  assert.doesNotMatch(source, /\bimport\b|\brequire\s*\(/);
  const pkg = JSON.parse(readFileSync(new URL("../packages/contracts/package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.dependencies, {});
});
test("unsupported schema constructs fail generation", () => {
  assert.throws(() => schemaType({ oneOf: [] }, {}), /Unsupported mobile schema keyword/);
  assert.throws(() => schemaType({ type: "object", additionalProperties: true }, {}), /additionalProperties/);
  assert.throws(() => schemaType({ $ref: "#/components/schemas/Known", type: "string" }, { Known: {} }), /constraint siblings/);
  assert.throws(() => schemaType({ $ref: "#/components/schemas/Unknown" }, {}), /Unknown mobile schema/);
});
