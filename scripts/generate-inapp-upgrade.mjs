import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const schema = readFileSync(resolve(root, "packages/server/schema.sql"), "utf8");
const start = schema.indexOf("CREATE TABLE inapp_feedback (");
if (start < 0) throw new Error("In-app schema is missing");
const output = `BEGIN;\n\n${schema.slice(start).trim()}\n\nCOMMIT;\n`;
const target = resolve(root, "packages/server/upgrades/inapp.sql");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("In-app upgrade is stale");
} else writeFileSync(target, output);
process.stdout.write("VERIFIED in-app upgrade\n");
