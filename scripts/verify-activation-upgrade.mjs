import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--evidence" || !args[1])) {
  throw new Error("Usage: node scripts/verify-activation-upgrade.mjs [--evidence path.json]");
}
const evidencePath = args.length ? resolve(args[1]) : null;
const baseline = { commit: "b6f3d665bc8e7771e1be37e125ea7cad2f01ebef", path: "packages/server/schema.sql",
  sha256: "faa2f72126650c805487812cf65cd95f58c4cec978c37818870ff6873e576502" };
const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
const loopback = ["127.0.0.1", "127.0.0.1/32", "::1", "::1/128"];
const maintenance = new URL(process.env.GALINUM_UPGRADE_DATABASE_URL ?? "postgresql://127.0.0.1/postgres");
if (!["postgres:", "postgresql:"].includes(maintenance.protocol) || maintenance.search || maintenance.hash ||
  !["127.0.0.1", "[::1]"].includes(maintenance.hostname) || maintenance.pathname !== "/postgres") {
  throw new Error("Upgrade verification requires a numeric loopback postgres maintenance database without URL parameters.");
}
const names = ["upgrade", "fresh"].map((kind) => `galinum_${kind}_${randomUUID().replaceAll("-", "")}`);
const proof = { verified: false, baseline, databases: names, preservation: null, schema: null, replay: null, cleanup: { verified: false, dropped: [] } };
const admin = new pg.Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 10000, statement_timeout: 30000 });
const clients = [];
const created = new Set();
let connected = false;
let failure;

async function identity(client, expected) {
  const row = (await client.query("SELECT current_database() AS database, inet_server_addr()::text AS address, current_user AS username")).rows[0];
  assert.equal(row.database, expected, "Unexpected database identity");
  assert(loopback.includes(row.address), "Database server is not loopback");
  return row;
}
async function catalog(client) {
  const tables = (await client.query(`SELECT c.relname AS name, c.relkind AS kind, c.relpersistence AS persistence,
    c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`)).rows;
  const columns = (await client.query(`SELECT c.relname AS table_name, a.attname AS name, a.attnum AS position,
    format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
    pg_get_expr(d.adbin,d.adrelid) AS default_expression, a.attidentity AS identity, a.attgenerated AS generated,
    co.collname AS collation
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`)).rows;
  const constraints = (await client.query(`SELECT c.relname AS table_name, con.conname AS name, con.contype AS type,
    pg_get_constraintdef(con.oid,true) AS definition, con.condeferrable AS deferrable,
    con.condeferred AS deferred, con.convalidated AS validated
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,con.conname`)).rows;
  const indexes = (await client.query(`SELECT t.relname AS table_name, i.relname AS name, pg_get_indexdef(x.indexrelid) AS definition,
    x.indisunique AS unique, x.indisprimary AS primary, x.indisvalid AS valid, x.indisready AS ready
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' ORDER BY t.relname,i.relname`)).rows;
  return { tables, columns, constraints, indexes };
}
async function rows(client, tables, original = false) {
  const result = {};
  for (const table of tables) result[table] = (await client.query(`SELECT (to_jsonb(t) ${original && table === "campaigns" ? "- 'push_json'" : ""})::text AS row FROM public.${quote(table)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows.map((row) => row.row);
  return result;
}
async function seed(client) {
  await client.query(`
    INSERT INTO projects VALUES ('project', 'Upgrade fixture', 1000);
    INSERT INTO email_suppressions VALUES ('project','suppressed@example.test','unsubscribed',1100);
    INSERT INTO end_users VALUES ('user1','project','reader1','{"plan":"free"}',1200,1900), ('user2','project','reader2','{"plan":"pro"}',1300,1950);
    INSERT INTO events VALUES ('event1','project','user1','activated','{"source":"message"}',1800);
    INSERT INTO goals (id,project_id,name,description,target_event,guardrails_json,created_at)
      VALUES ('goal','project','Activation','Help readers activate','activated','{"frequency":1}',1400);
    INSERT INTO agent_runs (id,project_id,goal_id,kind,input_json,output_json,rationale,created_at,idempotency_key)
      VALUES ('activity','project','goal','campaign_creation','{"intent":"release"}','{"created":true}','Explain the released feature',1500,'activity-key');
    INSERT INTO segments (id,project_id,key,name,description,idempotency_key,created_at,updated_at)
      VALUES ('segment','project','free-readers','Free readers','Readers on the free plan','segment-key',1500,1500);
    INSERT INTO audience_versions (id,project_id,segment_id,segment_version,schema_version,expression_json,expression_hash,reason,agent_run_id,created_at)
      VALUES ('audience','project','segment',1,1,'{"version":1,"root":{"kind":"field","field":{"kind":"trait","key":"plan"},"op":"eq","value":"free"}}','fixture-expression-hash','Target relevant readers','activity',1550);
    INSERT INTO campaigns (id,project_id,goal_id,name,status,audience_version_id,pages_json,hypothesis,created_at,started_at,ended_at,deliver_from,deliver_until)
      VALUES ('draft','project','goal','Draft','draft','audience','["/dashboard"]','Help activation',1600,NULL,NULL,3000,5000),
      ('running','project','goal','Running','running','audience','["/dashboard"]','Help activation',1601,1700,NULL,1700,5000),
      ('ended','project','goal','Ended','ended','audience',NULL,'Help activation',1602,1701,1900,1701,1900);
    UPDATE agent_runs SET campaign_id='running' WHERE id='activity';
    INSERT INTO campaign_execution_state VALUES ('running','user1',1850);
    INSERT INTO variants (id,campaign_id,name,content_json,weight,is_control)
      VALUES ('variant-draft','draft','A','{"title":"Draft","presentation":"toast"}',1,true),
      ('variant-running','running','A','{"title":"Running","presentation":"toast"}',1,true),
      ('variant-ended','ended','A','{"title":"Ended","presentation":"modal"}',1,true);
    INSERT INTO deliveries (id,campaign_id,variant_id,end_user_id,provider_message_id,state,queued_at,sent_at,delivered_at,shown_at,converted_at)
      VALUES ('delivery-running','running','variant-running','user1','provider-running','converted',1710,1720,1730,1740,1800),
      ('delivery-ended','ended','variant-ended','user2','provider-ended','sent',1711,1721,1731,1741,NULL);
  `);
}
async function syntheticState(client) {
  return (await client.query(`SELECT
    (SELECT count(*)::int FROM campaign_shipping_preparations) AS preparations,
    (SELECT count(*)::int FROM campaign_shipping_preparations WHERE approved_by IS NOT NULL OR approved_at IS NOT NULL OR reviewed_content_hash IS NOT NULL) AS approvals,
    (SELECT count(*)::int FROM campaign_activation_state WHERE launch_json IS NOT NULL) AS launch_receipts,
    (SELECT count(*)::int FROM campaign_activation_state) AS activation_states,
    (SELECT count(*)::int FROM shipping_sources) AS sources,
    (SELECT count(*)::int FROM github_deployment_mappings) AS mappings,
    (SELECT count(*)::int FROM campaign_shipping_warnings) AS warnings`)).rows[0];
}
try {
  const [baselineSql, migrationSql, freshSql] = await Promise.all([
    readFile(resolve(root,"packages/server/test-fixtures/schema-0.17.sql"),"utf8"),
    readFile(resolve(root,"packages/server/migrations/activation-1.sql"),"utf8"),
    readFile(resolve(root,"packages/server/schema.sql"),"utf8"),
  ]);
  assert.equal(hash(baselineSql), baseline.sha256, "Baseline fixture must match the exact public schema");
  await admin.connect(); connected=true;
  const maintenanceIdentity = await identity(admin,"postgres");
  for (const name of names) {
    await identity(admin,"postgres");
    await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`); created.add(name);
    const target = new URL(maintenance); target.pathname=`/${name}`;
    if (!target.username) target.username=maintenanceIdentity.username;
    const client = new pg.Client({connectionString:target.toString(),connectionTimeoutMillis:10000,statement_timeout:30000});
    clients.push(client); await client.connect(); await identity(client,name);
  }
  const [upgrade,fresh]=clients;
  await upgrade.query(baselineSql); await seed(upgrade);
  const oldCatalog=await catalog(upgrade);
  const oldTables=oldCatalog.tables.map((table)=>table.name);
  const before=await rows(upgrade,oldTables,true);
  assert(oldTables.every((table)=>before[table].length>0),"Every baseline table must contain representative data");
  const relationshipsSql=`SELECT c.id,c.status,c.started_at,c.ended_at,c.deliver_from,c.deliver_until,c.goal_id,c.audience_version_id,
    a.segment_id,a.agent_run_id,v.id AS variant_id,d.id AS delivery_id,d.end_user_id,r.id AS activity_id
    FROM campaigns c JOIN audience_versions a ON a.id=c.audience_version_id JOIN variants v ON v.campaign_id=c.id
    LEFT JOIN deliveries d ON d.variant_id=v.id LEFT JOIN agent_runs r ON r.campaign_id=c.id ORDER BY c.id`;
  const relationships=(await upgrade.query(relationshipsSql)).rows;
  for (const name of ["installations", "push", "inapp"]) {
    await upgrade.query(await readFile(resolve(root, `packages/server/upgrades/${name}.sql`), "utf8"));
  }
  await upgrade.query(migrationSql);
  assert.deepEqual(await rows(upgrade,oldTables,true),before,"Upgrade changed baseline rows");
  assert.deepEqual((await upgrade.query(relationshipsSql)).rows,relationships,"Upgrade changed lifecycle or relationships");
  const empty=await syntheticState(upgrade);
  assert(Object.values(empty).every((count)=>count===0),"Upgrade invented preparation, approval or activation evidence");
  const upgradedCatalog=await catalog(upgrade);
  await fresh.query(freshSql);
  const freshCatalog=await catalog(fresh);
  assert.deepEqual(upgradedCatalog,freshCatalog,"Upgraded and fresh catalogs differ");
  for (const client of clients) {
    const versions=(await client.query("SELECT version,applied_at FROM product_schema_versions ORDER BY version")).rows;
    assert.equal(versions.length,1);assert.equal(versions[0].version,"activation-1");assert(Number(versions[0].applied_at)>0);
  }
  const allTables=upgradedCatalog.tables.map((table)=>table.name);
  const beforeReplay=await rows(upgrade,allTables);
  let replayError;
  try { await upgrade.query(migrationSql); } catch (error) { replayError=error; }
  assert.equal(replayError?.code,"42P07","Reapplying migration must reject existing activation tables");
  let transactionError;
  try { await upgrade.query("SELECT 1"); } catch (error) { transactionError=error; }
  assert.equal(transactionError?.code,"25P02","Failed migration must retain an aborted transaction until rollback");
  await upgrade.query("ROLLBACK");
  assert.deepEqual(await rows(upgrade,allTables),beforeReplay,"Rejected replay partially changed rows");
  assert.deepEqual(await catalog(upgrade),upgradedCatalog,"Rejected replay partially changed schema");
  proof.preservation={unchanged:true,tables:Object.fromEntries(oldTables.map((table)=>[table,before[table].length])),rowDigest:hash(before),relationships,syntheticState:empty};
  proof.schema={version:"activation-1",catalogEqual:true,counts:Object.fromEntries(Object.entries(freshCatalog).map(([key,value])=>[key,value.length])),catalogDigest:hash(freshCatalog),migrationSha256:hash(migrationSql),freshSchemaSha256:hash(freshSql)};
  proof.replay={rejected:true,errorCode:replayError.code,transactionAborted:true,rowsUnchanged:true,catalogUnchanged:true};
} catch (error) {
  failure=error; proof.error=error.message;
} finally {
  for (const client of clients) {
    try { await client.end(); } catch (error) { failure??=error; proof.error??=error.message; }
  }
  for (const name of created) {
    try {
      await identity(admin,"postgres");
      await admin.query(`DROP DATABASE ${quote(name)} WITH (FORCE)`);
      proof.cleanup.dropped.push(name);
    } catch (error) { failure??=error; proof.error??=error.message; }
  }
  if (connected) {
    try {
      await identity(admin,"postgres");
      const remaining=(await admin.query("SELECT datname FROM pg_database WHERE datname=ANY($1::text[])",[names])).rows;
      assert.equal(remaining.length,0,"Disposable databases remain");
      proof.cleanup.verified=true;
    } catch (error) { failure??=error; proof.error??=error.message; }
  }
  await admin.end();
  proof.verified=!failure && proof.cleanup.verified;
  const evidence=`${JSON.stringify(proof,null,2)}\n`;
  if (evidencePath) { await mkdir(dirname(evidencePath),{recursive:true});await writeFile(evidencePath,evidence); }
  process.stdout.write(evidence);
}
if (failure) process.exitCode=1;
