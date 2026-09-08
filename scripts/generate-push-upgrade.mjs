import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const schema = readFileSync(resolve(root, "packages/server/schema.sql"), "utf8");
const start = schema.indexOf("CREATE TABLE push_records (");
if (start < 0 || !schema.includes("  push_json text,")) throw new Error("Push schema is missing");
const output = `BEGIN;\n\nALTER TABLE campaigns ADD COLUMN push_json text;\n\n${schema.slice(start).trim()}\n\nCOMMIT;\n`;
const target = resolve(root, "packages/server/upgrades/push.sql");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("Push upgrade is stale");
} else writeFileSync(target, output);
process.stdout.write("VERIFIED push upgrade\n");
