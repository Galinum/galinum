import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function installationUpgrade(schema) {
  const marker = "CREATE TABLE installations (";
  const start = schema.indexOf(marker);
  if (start < 0) throw new Error("Installation schema is missing");
  const end = schema.indexOf("CREATE TABLE push_records (", start);
  const ddl = schema.slice(start, end < 0 ? undefined : end).trim();
  const tables = [...ddl.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]);
  if (JSON.stringify(tables) !== JSON.stringify(["installations", "installation_requests"])) throw new Error("Unexpected tables in installation upgrade; update the extraction boundary");
  return `BEGIN;\n\n${ddl}\n\nCOMMIT;\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "..");
  const target = resolve(root, "packages/server/upgrades/installations.sql");
  const output = installationUpgrade(readFileSync(resolve(root, "packages/server/schema.sql"), "utf8"));
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== output) throw new Error("Installation upgrade is stale; generate it from schema.sql");
  } else writeFileSync(target, output);
  process.stdout.write("VERIFIED transactional installation upgrade\n");
}
