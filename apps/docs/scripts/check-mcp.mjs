#!/usr/bin/env node
// Deterministic checks for the hosted Galinum MCP contract.
//
// Guards: every operation is classified, hosted-agent and browser-SDK routes
// stay unexposed, tool names are unique, the reviewed inventory fixture and
// openapi x-mcp metadata agree, tool input schemas are expressible, and the
// intent/authority guidance survives. Run with:  node scripts/check-mcp.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const openapi = JSON.parse(readFileSync(join(root, "openapi.json"), "utf8"));
const inventory = JSON.parse(readFileSync(join(root, "mcp/inventory.json"), "utf8"));
const instructions = readFileSync(join(root, "mcp/instructions.md"), "utf8");
const docsConfig = JSON.parse(readFileSync(join(root, "docs.json"), "utf8"));

const failures = [];
function check(name, ok) {
  if (!ok) failures.push(name);
}

const documentationPages = (docsConfig.navigation?.tabs ?? [])
  .flatMap((tab) => tab.groups ?? [])
  .flatMap((group) => group.pages ?? [])
  .filter((page) => typeof page === "string");
check("customer MCP guide uses the non-reserved mcp-server path", documentationPages.includes("mcp-server"));
check("reserved mcp path is not used for a documentation page", !documentationPages.includes("mcp"));
check("reserved repository-root mcp.mdx is absent", !existsSync(join(root, "mcp.mdx")));
check("repository-root mcp-server.mdx exists", existsSync(join(root, "mcp-server.mdx")));
const guide = readFileSync(join(root, "mcp-server.mdx"), "utf8");
check("guide names the canonical full endpoint", guide.includes("https://mcp.galinum.com/mcp"));
check("guide marks the old full endpoint retired", guide.includes("`https://galinum.com/mcp` is retired"));
check("guide keeps readonly on its existing endpoint", guide.includes("https://galinum.com/mcp/readonly"));
check("guide has no readonly subdomain alias", !guide.includes("https://mcp.galinum.com/mcp/readonly"));

const operations = [];
for (const [path, methods] of Object.entries(openapi.paths)) {
  for (const [verb, op] of Object.entries(methods)) {
    if (typeof op !== "object" || Array.isArray(op)) continue;
    operations.push({ path, verb, op });
  }
}

for (const { path, verb, op } of operations) {
  check(`${verb.toUpperCase()} ${path} has x-mcp`, Boolean(op["x-mcp"]));
  if (op["x-mcp"]?.exposed) {
    check(`${verb.toUpperCase()} ${path} has an operationId`, Boolean(op.operationId));
    check(`${verb.toUpperCase()} ${path} names a tool`, Boolean(op["x-mcp"].tool));
  }
}

for (const { path, verb, op } of operations) {
  const schemes = (op.security || openapi.security || []).map((s) => Object.keys(s)[0]);
  const publishableOnly = schemes.length > 0 && schemes.every((s) => s === "publishableKey");
  const hostedAgentOnly = schemes.length > 0 && schemes.every((s) => s === "hostedAgentKey");
  const hostedAgentSurface =
    path.startsWith("/api/v1/evaluations") || path.startsWith("/api/v1/agent/");
  if (publishableOnly || hostedAgentOnly || hostedAgentSurface) {
    check(
      `${verb.toUpperCase()} ${path} stays unexposed`,
      op["x-mcp"]?.exposed === false,
    );
  }
}

const exposed = operations.filter(({ op }) => op["x-mcp"]?.exposed);
check("28 exposed operations", exposed.length === 28);
check("28 inventory tools", inventory.tools.length === 28);

const names = exposed.map(({ op }) => op["x-mcp"].tool);
check("tool names are unique", new Set(names).size === names.length);

const fixtureByName = new Map(inventory.tools.map((t) => [t.name, t]));
for (const { path, verb, op } of exposed) {
  const meta = op["x-mcp"];
  const fixture = fixtureByName.get(meta.tool);
  check(`${meta.tool} is in the inventory fixture`, Boolean(fixture));
  if (!fixture) continue;
  check(`${meta.tool} maps to its reviewed operationId`, fixture.operationId === op.operationId);
  for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    check(
      `${meta.tool} ${hint} matches the fixture`,
      meta.annotations?.[hint] === fixture[hint],
    );
  }
  const expectedMode = fixture.readOnlyHint ? "readonly" : "full";
  check(`${meta.tool} mode is ${expectedMode}`, meta.mode === expectedMode);
  check(`${meta.tool} is not a GET write`, !(verb === "get" && !fixture.readOnlyHint));
}

for (const tool of inventory.tools) {
  check(`${tool.name} exists in openapi`, names.includes(tool.name));
  check(`${tool.name} is snake_case`, /^[a-z][a-z0-9_]*$/.test(tool.name));
  check(
    `${tool.name} annotations are coherent`,
    !(tool.readOnlyHint && tool.destructiveHint),
  );
}

const READONLY = [
  "list_campaigns", "get_campaign", "list_campaign_deliveries",
  "get_campaign_event_conversions", "list_users", "get_user", "list_events",
  "list_goals", "get_goal", "list_agent_runs", "get_audience_capabilities",
  "check_audience", "explain_audience", "list_segments", "get_segment",
  "list_segment_versions", "get_segment_version", "get_usage",
];
const readonlyFixture = inventory.tools.filter((t) => t.readOnlyHint).map((t) => t.name);
check("read-only inventory is the exact 18-name subset",
  READONLY.length === 18 &&
  readonlyFixture.length === 18 &&
  READONLY.every((n) => readonlyFixture.includes(n)));

function assertExpressible(label, schema, depth = 0) {
  if (!schema || typeof schema !== "object") return;
  if (depth > 12) return;
  if (schema.$ref) {
    check(`${label} ref resolves inside components`, schema.$ref.startsWith("#/components/"));
    return;
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    for (const sub of schema[key] ?? []) assertExpressible(label, sub, depth + 1);
  }
  for (const sub of Object.values(schema.properties ?? {})) assertExpressible(label, sub, depth + 1);
  if (schema.items) assertExpressible(label, schema.items, depth + 1);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    assertExpressible(label, schema.additionalProperties, depth + 1);
  }
}

for (const { op } of exposed) {
  const tool = op["x-mcp"].tool;
  for (const param of op.parameters ?? []) {
    check(`${tool} parameter ${param.name} has a schema`, Boolean(param.schema));
    check(
      `${tool} parameter ${param.name} is path or query`,
      param.in === "path" || param.in === "query",
    );
    assertExpressible(`${tool}.${param.name}`, param.schema);
  }
  const content = op.requestBody?.content ?? {};
  for (const type of Object.keys(content)) {
    check(
      `${tool} body ${type} is supported`,
      type === "application/json" || type === "multipart/form-data",
    );
    assertExpressible(`${tool}.body`, content[type].schema);
  }
}

for (const { op } of exposed) {
  const params = op.parameters ?? [];
  if (params.some((p) => p.name === "page")) {
    check(
      `${op["x-mcp"].tool} keeps perPage alongside page`,
      params.some((p) => p.name === "perPage"),
    );
  }
}

const topLevel = openapi["x-mcp"] ?? {};
check("x-mcp.protocolVersion is 2026-07-28", topLevel.protocolVersion === "2026-07-28");
check("x-mcp.instructions exists", typeof topLevel.instructions === "string" && topLevel.instructions.length > 400);
check("x-mcp.readonlyInstructions exists", typeof topLevel.readonlyInstructions === "string");
check("readonly instructions say writes are unavailable", /not available|unavailable/i.test(topLevel.readonlyInstructions ?? ""));
check("full endpoint is https://mcp.galinum.com/mcp", topLevel.endpoints?.full?.url === "https://mcp.galinum.com/mcp");
check("readonly endpoint is https://galinum.com/mcp/readonly", topLevel.endpoints?.readonly?.url === "https://galinum.com/mcp/readonly");
check("full and readonly endpoints have no URL aliases", Object.keys(topLevel.endpoints ?? {}).length === 2);
check("instructions embed the reviewed file", topLevel.instructions === instructions.trim());

const INSTRUCTION_INVARIANTS = [
  [/direct/i, "direct mode"],
  [/outcome-measured/i, "outcome-measured mode"],
  [/optimi[sz]ed/i, "optimized mode"],
  [/smallest/i, "smallest mode wins"],
  [/draft/i, "draft stop"],
  [/ambiguous/i, "ambiguous launch authority"],
  [/every page/i, "complete campaign pagination"],
  [/pageCount/i, "campaign page-count boundary"],
  [/concurrent/i, "no concurrency guarantee"],
  [/idempotency key/i, "idempotent run logging"],
  [/[Nn]ever retry an uncertain campaign creation/, "no retry on uncertain creation"],
  [/overlap/i, "overlap avoidance"],
];
for (const [pattern, label] of INSTRUCTION_INVARIANTS) {
  check(`instructions keep ${label}`, pattern.test(instructions));
}

const GUIDED = ["create_campaign", "update_campaign", "set_campaign_status", "create_goal", "update_goal", "list_campaigns"];
for (const name of GUIDED) {
  const entry = exposed.find(({ op }) => op["x-mcp"].tool === name);
  check(`${name} carries guidance`, typeof entry?.op["x-mcp"].guidance === "string");
}
for (const name of ["create_campaign", "update_campaign", "set_campaign_status"]) {
  const entry = exposed.find(({ op }) => op["x-mcp"].tool === name);
  check(`${name} guidance keeps the visibility rule`, /every page/.test(entry?.op["x-mcp"].guidance ?? ""));
}
check(
  "create_campaign guidance forbids inventing extras",
  /do not add a goal, variants/i.test(
    exposed.find(({ op }) => op["x-mcp"].tool === "create_campaign")?.op["x-mcp"].guidance ?? "",
  ),
);
check(
  "set_campaign_status guidance requires explicit launch authority",
  /explicit launch/i.test(
    exposed.find(({ op }) => op["x-mcp"].tool === "set_campaign_status")?.op["x-mcp"].guidance ?? "",
  ),
);
check(
  "list_campaigns guidance requires complete pagination",
  /every page/.test(
    exposed.find(({ op }) => op["x-mcp"].tool === "list_campaigns")?.op["x-mcp"].guidance ?? "",
  ),
);

if (failures.length) {
  console.error(`check-mcp: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`check-mcp: ok (${exposed.length} tools, ${readonlyFixture.length} read-only)`);
