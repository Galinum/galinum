import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const contract = JSON.parse(readFileSync(resolve(root, "apps/docs/openapi.json"), "utf8"));
const cloud = JSON.parse(readFileSync(resolve(root, "packages/server/cloud-operations.json"), "utf8"));
const cloudOperations = new Set(cloud.operations);
const methods = ["get", "post", "put", "patch", "delete"];
const operations = [];

for (const [path, item] of Object.entries(contract.paths)) {
  for (const method of methods) {
    const operation = item[method];
    if (!operation) continue;
    if (!operation.operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
    operations.push({
      method: method.toUpperCase(),
      path,
      operationId: operation.operationId,
      availability: cloudOperations.has(operation.operationId) ? "galinum_cloud" : "product",
    });
  }
}

const operationIds = new Set(operations.map((operation) => operation.operationId));
for (const operationId of cloudOperations) {
  if (!operationIds.has(operationId)) throw new Error(`Unknown cloud-only operation: ${operationId}`);
}

const output = `export const OPERATIONS = ${JSON.stringify(operations, null, 2)} as const;\n\nexport type OperationId = (typeof OPERATIONS)[number]["operationId"];\n`;
const target = resolve(root, "packages/server/src/operations.ts");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("packages/server/src/operations.ts is stale");
} else {
  writeFileSync(target, output);
}
process.stdout.write(`VERIFIED ${operations.length} server operations\n`);
