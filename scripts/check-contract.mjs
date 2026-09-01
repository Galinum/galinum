import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync(new URL("../apps/docs/openapi.json", import.meta.url), "utf8"));
const methods = ["get", "post", "put", "patch", "delete"];
const operations = [];

assert.equal(contract.openapi, "3.1.0");
assert.equal(contract.info?.title, "Galinum API");
assert.ok(Object.keys(contract.paths ?? {}).length > 0);
assert.deepEqual(Object.keys(contract.components?.securitySchemes ?? {}).sort(), ["hostedAgentKey", "publishableKey", "secretKey"]);

for (const item of Object.values(contract.paths)) {
  for (const method of methods) if (item[method]) operations.push(item[method].operationId);
}

assert.ok(operations.every(Boolean));
assert.equal(new Set(operations).size, operations.length);
process.stdout.write(`VERIFIED OpenAPI 3.1 contract with ${operations.length} unique operations\n`);
