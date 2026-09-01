import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
const inventory = JSON.parse(readFileSync(process.argv[3], "utf8"));
const openapi = JSON.parse(readFileSync(file, "utf8"));

const MISSING_IDS = {
  "get /api/v1/audiences/capabilities": "getAudienceCapabilities",
  "post /api/v1/audiences/check": "checkAudience",
  "post /api/v1/audiences/explain": "explainAudience",
  "post /api/v1/segments": "createSegment",
  "get /api/v1/segments": "listSegments",
  "get /api/v1/segments/{id}": "getSegment",
  "patch /api/v1/segments/{id}": "updateSegment",
  "post /api/v1/segments/{id}/archive": "archiveSegment",
  "get /api/v1/segments/{id}/versions": "listSegmentVersions",
  "get /api/v1/segments/{id}/versions/{version}": "getSegmentVersion",
};

for (const [key, id] of Object.entries(MISSING_IDS)) {
  const [verb, path] = key.split(" ");
  const op = openapi.paths[path]?.[verb];
  if (!op) throw new Error("missing operation " + key);
  if (op.operationId && op.operationId !== id) throw new Error("conflicting operationId " + key);
  op.operationId = id;
}

const VISIBILITY =
  "Before you create, launch, or update a campaign, read recent agent runs and query running and scheduled campaigns as two separate paginated searches. Read every page through pageCount for both statuses before treating their deduplicated union as a complete point-in-time snapshot. Repeat both searches immediately before the write. Never claim protection against concurrent campaign changes.";

const GUIDANCE = {
  create_campaign:
    "Classify the request as direct, outcome-measured, or optimized before you write anything, then use the smallest mode the user asked for. A direct communication is one message: do not add a goal, variants, a delivery window, an evaluation, or optimization unless the user asked for them. Treat ordinary announcements as direct even when the product has goals. Use a single message field for direct communication. Set a delivery window only from timing the user gave you, or after you resolve the missing dates with them. If the user said draft, propose, or prepare, stop at draft and never launch. Launch only when the user gave explicit launch, send, or announce authority. If launch authority is ambiguous, stop at draft and ask. Avoid overlapping audiences and delivery periods with other running or scheduled campaigns. " +
    VISIBILITY +
    " If a create call is uncertain, never retry it: read campaigns back and confirm what exists before you act again.",
  update_campaign:
    "Change only what the user asked to change. Do not add a goal, variants, a delivery window, or optimization to a campaign that did not request them. " +
    VISIBILITY +
    " If an update is uncertain, read the campaign back before you retry.",
  set_campaign_status:
    "This is the launch, pause, and end control. Launch only with explicit launch, send, or announce authority from the user. If that authority is ambiguous, leave the campaign in draft and ask. " +
    VISIBILITY +
    " If a launch call is uncertain, read the campaign status back before you act again.",
  create_goal:
    "Create a goal only when the user asked to measure an outcome or to optimize toward one. Never invent a goal to accompany an ordinary announcement.",
  update_goal:
    "Change only the goal fields the user asked to change. Never introduce optimization the user did not request.",
  list_campaigns:
    "Use status or q to narrow the campaign set. Read every page through pageCount before treating the result as complete. When querying multiple statuses, deduplicate campaigns by ID before reasoning about overlap.",
  list_agent_runs:
    "Read recent runs before you create, launch, or update a campaign, so you can see what another agent already did. Log your own material decisions with create_agent_run.",
  create_agent_run:
    "Log material decisions, proposals, and launches here. Reuse the same idempotency key when you retry, so one decision never produces two run records.",
};

const byOperationId = new Map(inventory.tools.map((t) => [t.operationId, t]));
const seen = new Set();

for (const [path, methods] of Object.entries(openapi.paths)) {
  for (const [verb, op] of Object.entries(methods)) {
    if (typeof op !== "object" || Array.isArray(op)) continue;
    const tool = op.operationId ? byOperationId.get(op.operationId) : undefined;
    if (!tool) {
      op["x-mcp"] = { exposed: false, reason: describeExclusion(op, path) };
      continue;
    }
    seen.add(tool.operationId);
    op["x-mcp"] = {
      exposed: true,
      tool: tool.name,
      mode: tool.readOnlyHint ? "readonly" : "full",
      annotations: {
        readOnlyHint: tool.readOnlyHint,
        destructiveHint: tool.destructiveHint,
        idempotentHint: tool.idempotentHint,
        openWorldHint: tool.openWorldHint,
      },
    };
    const guidance = GUIDANCE[tool.name];
    if (guidance) op["x-mcp"].guidance = guidance;
  }
}

function describeExclusion(op, path) {
  const schemes = (op.security || openapi.security || []).map((s) => Object.keys(s)[0]);
  if (schemes.includes("publishableKey")) return "browser-sdk";
  if (path.startsWith("/api/v1/evaluations") || path.startsWith("/api/v1/agent/")) return "hosted-agent";
  return "not-exposed";
}

openapi["x-mcp"] = {
  protocolVersion: inventory.protocolVersion,
  endpoints: inventory.endpoints,
  instructions: readFileSync(process.argv[4], "utf8").trim(),
  readonlyInstructions:
    "This endpoint exposes read-only tools only. Campaign, goal, and segment writes are not available here. Connect to the full endpoint when the user asks you to create, update, or launch something.",
};

const missing = inventory.tools.filter((t) => !seen.has(t.operationId));
if (missing.length) throw new Error("inventory tools without an operation: " + missing.map((t) => t.name).join(", "));

writeFileSync(file, JSON.stringify(openapi, null, 2) + "\n");
console.log("annotated", seen.size, "tools");
