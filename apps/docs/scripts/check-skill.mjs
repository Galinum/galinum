#!/usr/bin/env node
// Deterministic checks for the distributable galinum skill.
//
// Guards intent routing (direct /
// outcome-measured / optimized), authority boundaries (draft never launches;
// require_human is propose-only), direct mode staying minimal (no goals,
// variants, or schedules), and the docs page embedding the skill files
// verbatim. Run with:  node scripts/check-skill.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(root, "skill/galinum/SKILL.md"), "utf8");
const api = readFileSync(join(root, "skill/galinum/references/api.md"), "utf8");
const docsPage = readFileSync(join(root, "skill/claude-code.mdx"), "utf8");
const openapi = JSON.parse(readFileSync(join(root, "openapi.json"), "utf8"));

// Slice a `## Heading` section out of SKILL.md (up to the next `## `).
function section(title) {
  const start = skill.indexOf(`\n## ${title}`);
  if (start === -1) return null;
  const rest = skill.slice(start + 1);
  const end = rest.indexOf("\n## ", 3);
  return end === -1 ? rest : rest.slice(0, end);
}

const failures = [];
function check(name, ok) {
  if (!ok) failures.push(name);
}

// --- Docs page embeds the skill files verbatim -----------------------------
check("claude-code.mdx embeds SKILL.md verbatim", docsPage.includes(skill.trim()));
check("claude-code.mdx embeds references/api.md verbatim", docsPage.includes(api.trim()));
check("skill names the canonical full MCP endpoint", skill.includes("https://mcp.galinum.com/mcp"));
check("api reference names the canonical full MCP endpoint", api.includes("https://mcp.galinum.com/mcp"));
check("skill marks the old full MCP endpoint retired", skill.includes("retired\n  `https://galinum.com/mcp`"));
check("api reference rejects the old full MCP endpoint", api.includes("`https://galinum.com/mcp` is not a compatibility endpoint"));

// --- Intent routing --------------------------------------------------------
const routing = section("Route the request first");
check("routing section exists", routing !== null);

// Each example request must sit in a routing-table row labeled with its mode.
const intentCases = [
  ["Announce the new CSV export", "Direct"],
  ["tell free users about the promo", "Direct"],
  ["draft a message about the pricing change", "Direct"],
  ["tell me whether people start using it", "Outcome-measured"],
  ["send the promo and track upgrades", "Outcome-measured"],
  ["Work toward the activation goal", "Optimized"],
  ["optimize onboarding", "Optimized"],
  ["A/B test this message", "Optimized"],
];
for (const [phrase, mode] of intentCases) {
  const row = (routing ?? "").split("\n").find((l) => l.includes(phrase));
  check(`routing table classifies "${phrase}" as ${mode}`, row !== undefined && row.includes(`**${mode}**`));
}
check(
  "routing: smallest mode wins, extras only on request",
  /smallest\s+mode/.test(routing ?? "") && (routing ?? "").includes("didn't ask for")
);
check(
  "routing: an active goal does not hijack an announcement",
  (routing ?? "").includes("does **not** turn an announcement into an optimization job")
);
{
  // Retrospective questions must be read-only, never a new communication.
  const idx = (routing ?? "").indexOf('"did the promo move upgrades?"');
  check(
    "routing: retrospective questions are read-only",
    idx !== -1 && (routing ?? "").slice(idx).includes("create or change nothing")
  );
}

// --- Authority boundaries --------------------------------------------------
const authority = section("Route the request first") ?? "";
check("authority: draft/propose does not launch", authority.includes("**do not launch**"));
check(
  "authority: ambiguous wording stops at a draft",
  authority.includes("ambiguous") && authority.includes("stop at a draft")
);
check(
  "authority: require_human is propose-only, not even a draft",
  authority.includes("`require_human` is propose-only (not even a draft)")
);
check(
  "authority: request wording cannot skip propose-first",
  authority.includes("cannot skip the propose-first step")
);
check(
  "authority: explicit approval of a logged proposal may launch",
  authority.includes("approving a previously logged proposal")
);

// --- Direct mode stays minimal --------------------------------------------
const direct = section("Direct communications");
check("direct section exists", direct !== null);
check("direct: no goal required and none created", (direct ?? "").includes("No active goal is\n   required, and you must not create one"));
check("direct: single-message shape, no invented variants", (direct ?? "").includes("single-`message` campaign shape"));
check("direct: no schedule run, no promised iteration", (direct ?? "").includes("Do **not** log a\n   `schedule` run"));
check("direct: proposal logged without goalId", (direct ?? "").includes("`proposal` run — no `goalId`"));
check("direct: launch logged without goalId", (direct ?? "").includes("again no `goalId`"));
check(
  "direct: reports ordinary engagement stats",
  (direct ?? "").includes("`shown` / `clicked` / `dismissed`") &&
    (direct ?? "").includes("`sent` /") &&
    (direct ?? "").includes("`unsubscribed`")
);

// --- Outcome-measured stays goal-free and unscheduled ----------------------
const outcome = section("Outcome-measured communications");
check("outcome section exists", outcome !== null);
check("outcome: does not create a goal", (outcome ?? "").includes("Do **not** create a goal"));
check("outcome: launch run carries targetEvent + campaign id", (outcome ?? "").includes('"campaignId"') && (outcome ?? "").includes('"targetEvent"'));
check("outcome: evaluates on request, not on a schedule", (outcome ?? "").includes("when the user asks"));

// --- Optimized loop keeps its shape ----------------------------------------
const optimized = section("Optimized communications — the goal loop");
check("optimized section exists", optimized !== null);
check("optimized: requires an active goal", (optimized ?? "").includes("Requires an **active goal**"));
check("optimized: never invents a goal to unblock the loop", (optimized ?? "").includes("Never create or invent a goal"));
for (const phase of ["Recall", "Observe", "Propose", "Act", "Schedule re-evaluation", "Evaluate and iterate"]) {
  check(`optimized: phase "${phase}" present`, (optimized ?? "").includes(phase));
}

// --- Shared safety checks survive ------------------------------------------
const guardrails = section("Guardrails — non-negotiable") ?? "";
check("guardrails: pre-flight checks in every mode", guardrails.includes("in every mode"));
check("guardrails: proofread / placeholder check", guardrails.includes("no placeholder text"));
check("guardrails: audience overlap check", guardrails.includes("overlapping campaigns stack"));
check(
  "guardrails: audience verified via the check endpoint before creating",
  guardrails.includes("POST /api/v1/audiences/check") &&
    guardrails.includes("unobserved_trait") &&
    guardrails.includes("silently targets\n     nobody")
);
check("guardrails: API-only, no database access", guardrails.includes("no direct database access"));
check("guardrails: log before you leap", guardrails.includes("Log before you leap"));
check("guardrails: email requires explicit consent", guardrails.includes("Email consent"));
check(
  "guardrails: email pre-flight checks serving and predicts capped recipients",
  guardrails.includes("GET /api/v1/usage") &&
    guardrails.includes("`emailServing` is not `ok`") &&
    guardrails.includes("`frequency_capped`")
);
check(
  "guardrails: email domain setup stays human-only",
  guardrails.includes("human-only precondition") && guardrails.includes("Settings → Email")
);

{
  const directWindow = section("Direct communications") ?? "";
  check(
    "window: time-sensitive comms carry deliverUntil instead of a return visit",
    directWindow.includes("`deliverUntil` stops delivery automatically")
  );
  check(
    "window: missing end dates are asked for, not guessed",
    directWindow.includes("ask when it ends") && directWindow.includes("rather than guessing")
  );
  check(
    "window: evergreen announcements get no invented window",
    directWindow.includes("Evergreen announcements need no window")
  );
  check(
    "window: scheduled starts never wait around or promise a return",
    directWindow.includes("never sit around waiting")
  );
  check("window: pre-flight window sanity check", guardrails.includes("Window sanity"));
}

// --- api.md ----------------------------------------------------------------
check("api.md: goalId omitted for direct communications", api.includes("omit it for direct\n  communications"));
check(
  "api.md: documents the delivery window and effective status",
  api.includes("deliverFrom") && api.includes("deliverUntil") && api.includes("effectiveStatus")
);
check(
  "api.md: documents both campaign channels",
  api.includes('`channel` — `web_inapp` (default) or `email`') &&
    api.includes("Email message content")
);
check(
  "api.md: documents current usage serving and frequency contract",
  api.includes("`payment_required`") &&
    api.includes("`emailServing`: `ok` | `paused`") &&
    api.includes("`frequencyCapped`") &&
    !api.includes("freeAllowance") &&
    !api.includes("free_allowance_exhausted")
);
check(
  "api.md: documents frequency-capped deliveries and campaign stats",
  api.includes("`frequency_capped` is terminal") &&
    api.includes("`sent`, `frequencyCapped`, `delivered`")
);

// --- Hosted usage-report contract -----------------------------------------
{
  const operation = openapi.paths?.["/api/v1/agent/usage-reports"]?.post;
  const body = operation?.requestBody;
  const schema = body?.content?.["application/json"]?.schema;
  const executionId = schema?.properties?.executionId;
  const calls = schema?.properties?.calls;
  const call = calls?.items;
  const counters = [
    ["inputTokens", 100_000_000],
    ["cachedInputTokens", 100_000_000],
    ["cacheWriteTokens", 100_000_000],
    ["outputTokens", 100_000_000],
    ["reasoningTokens", 100_000_000],
    ["toolCostMicros", 1_000_000_000],
  ];
  check(
    "openapi: usage-report execution id matches deployed bounds",
    executionId?.minLength === 1 && executionId?.maxLength === 128
  );
  check(
    "openapi: usage-report counters match deployed optional bounds",
    call !== undefined &&
      call.required === undefined &&
      counters.every(([name, maximum]) => {
        const counter = call.properties?.[name];
        return counter?.type?.includes("integer") &&
          counter.type.includes("null") &&
          counter.minimum === 0 &&
          counter.maximum === maximum &&
          counter.default === 0;
      })
  );
  check(
    "openapi: usage-report body limit is authoritative",
    body?.description?.includes("8,192 bytes") &&
      operation?.responses?.["413"] !== undefined &&
      calls?.maxItems === undefined &&
      calls?.description?.includes("at most 200 entries")
  );
  check(
    "openapi: usage-report cross-field constraints are explicit",
    call?.description?.includes("cachedInputTokens + cacheWriteTokens must not exceed inputTokens") &&
      call?.description?.includes("reasoningTokens must not exceed outputTokens") &&
      operation?.responses?.["400"]?.description?.includes("cachedInputTokens + cacheWriteTokens")
  );
}

// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`check-skill: ${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("check-skill: all checks passed");
