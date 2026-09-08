import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import pg from "pg";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const packagePath = require.resolve("kysely-codegen/package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const executable = resolve(dirname(packagePath), typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin["kysely-codegen"]);
const maintenance = new URL(process.env.GALINUM_CODEGEN_DATABASE_URL ?? "postgresql://127.0.0.1/postgres");
if (!['postgres:', 'postgresql:'].includes(maintenance.protocol) || maintenance.search ||
  !['127.0.0.1', '[::1]'].includes(maintenance.hostname) || maintenance.pathname !== '/postgres') {
  throw new Error("Code generation requires a loopback postgres maintenance database");
}
const database = `galinum_codegen_${randomUUID().replaceAll("-", "")}`;
const target = new URL(maintenance);
target.pathname = `/${database}`;
const directory = await mkdtemp(resolve(tmpdir(), "galinum-codegen-"));
const output = resolve(directory, "types.ts");
const admin = new pg.Client({ connectionString: maintenance.toString() });
let created = false;
const proof = { database, schema: false, generated: false, cleanup: false };
try {
  await admin.connect();
  const identity = (await admin.query("select current_database() as name, inet_server_addr()::text as address, current_user as username")).rows[0];
  if (identity.name !== "postgres" || !["127.0.0.1/32", "127.0.0.1", "::1/128", "::1"].includes(identity.address)) throw new Error("Maintenance database identity failed");
  if (!target.username) target.username = identity.username;
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  const client = new pg.Client({ connectionString: target.toString() });
  try {
    await client.connect();
    await client.query(await readFile(resolve(root, "packages/server/schema.sql"), "utf8"));
    proof.schema = true;
  } finally { await client.end(); }
  await writeFile(resolve(directory, "empty.env"), "");
  const result = spawnSync(process.execPath, [executable, "--url", "env(DATABASE_URL)", "--dialect", "postgres",
    "--include-pattern", "public.*", "--exclude-pattern", "public.projects", "--env-file", resolve(directory, "empty.env"),
    "--out-file", output, "--log-level", "error"], {
    cwd: directory, env: { PATH: process.env.PATH, DATABASE_URL: target.toString() }, encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "Database type generation failed");
  const source = await readFile(output, "utf8");
  if (!source.includes("export interface DB {") || !source.includes("export type Int8 =")) throw new Error("Unexpected generated type format");
  const normalized = source.replace("export interface DB {", "export interface ProductDB {")
    .replace(/\bPushRecords\b/g, "PushRecordsTable")
    .replace(/export type Int8 =[^;]+;/, "export type Int8 = ColumnType<number, number | string, number | string>;");
  await writeFile(resolve(root, "packages/core/src/db-types.ts"), normalized);
  proof.generated = true;
} finally {
  try {
    if (created) {
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      proof.cleanup = true;
    }
  } finally {
    await admin.end();
    await rm(directory, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify(proof)}\n`);
  }
}
