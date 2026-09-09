import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function effectiveSecurity(contract, operation) {
  const security = operation.security === undefined ? contract.security ?? [] : operation.security;
  if (!Array.isArray(security)) throw new Error("Security must be an array of alternatives");
  return security.map((alternative) => {
    if (!alternative || typeof alternative !== "object" || Array.isArray(alternative)) throw new Error("Invalid security alternative");
    for (const [scheme, scopes] of Object.entries(alternative)) {
      if (!contract.components?.securitySchemes?.[scheme] || !Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) throw new Error("Invalid security requirement");
    }
    return alternative;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
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
      security: effectiveSecurity(contract, operation),
      availability: cloudOperations.has(operation.operationId) ? "galinum_cloud" : "product",
    });
  }
}

const operationIds = new Set(operations.map((operation) => operation.operationId));
for (const operationId of cloudOperations) {
  if (!operationIds.has(operationId)) throw new Error(`Unknown cloud-only operation: ${operationId}`);
}

const output = `export const SECURITY_SCHEMES = ${JSON.stringify(contract.components.securitySchemes, null, 2)} as const;\nexport type SecurityScheme = keyof typeof SECURITY_SCHEMES;\n\nexport const OPERATIONS = ${JSON.stringify(operations, null, 2)} as const;\n\nexport type OperationId = (typeof OPERATIONS)[number]["operationId"];\n`;
const target = resolve(root, "packages/server/src/operations.ts");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("packages/server/src/operations.ts is stale");
} else {
  writeFileSync(target, output);
}
process.stdout.write(`VERIFIED ${operations.length} server operations\n`);

}
