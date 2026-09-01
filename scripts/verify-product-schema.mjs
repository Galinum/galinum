import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compareSchemaTables, productTableNames } from "./product-schema-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const schema = readFileSync(resolve(root, "packages/server/schema.sql"), "utf8");
const expectedTables = [...productTableNames(readFileSync(resolve(root, "packages/core/src/db-types.ts"), "utf8")), "projects"].sort();
const actualTables = [...schema.matchAll(/CREATE TABLE\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)].map((match) => match[1] || match[2]).sort();
const failures = compareSchemaTables(actualTables, expectedTables);

if (failures.length) {
  failures.forEach((failure) => process.stderr.write(`${failure}\n`));
  process.exit(1);
}
process.stdout.write(`VERIFIED product schema with ${actualTables.length} tables\n`);
