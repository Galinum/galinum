#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const skillDirectory = resolve(scriptDirectory, "..");
const productDirectory = resolve(skillDirectory, "../../..");
const artifactDirectory = join(productDirectory, ".audit", "verification", "verify-galinum");
const serverEntrypoint = join(productDirectory, "packages", "server", "dist", "cli.js");

function fail(message) {
  throw new Error(message);
}

function requireNode24() {
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    fail(`Node 24 is required; received ${process.version}. Run this helper through \"fnm exec --using=24 -- node\".`);
  }
}

function runDirectory(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId ?? "")) {
    fail("Run ID must use 1-80 letters, digits, dots, underscores, or hyphens.");
  }
  return join(artifactDirectory, runId);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value, mode = 0o644) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(path, mode);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: productDirectory, encoding: "utf8" });
  if (result.status !== 0) fail(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function productVersion() {
  return readJson(join(productDirectory, "packages", "server", "package.json")).version;
}

function buildServer() {
  const result = spawnSync("pnpm", ["--filter", "@galinum/server...", "build"], {
    cwd: productDirectory,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) fail(`Server build failed with exit code ${result.status ?? "unknown"}.`);
  if (!existsSync(serverEntrypoint)) fail(`Build did not create ${serverEntrypoint}.`);
}

async function unusedPort() {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function processOwnsPort(pid, port) {
  const result = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().split(/\s+/).includes(String(pid));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health(origin) {
  const response = await fetch(`${origin}/api/health`);
  const body = await response.json();
  if (response.status !== 200 || body.status !== "ok") fail(`Health check failed with ${response.status}.`);
  return body;
}

async function waitForHealth(origin) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await health(origin);
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw lastError;
}

async function launch(runId) {
  buildServer();
  mkdirSync(artifactDirectory, { recursive: true });
  const directory = runDirectory(runId);
  mkdirSync(directory);
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const secretKey = `pk_verify_${randomUUID()}`;
  const publishableKey = `pk_pub_verify_${randomUUID()}`;
  const logPath = join(directory, "server.log");
  const logDescriptor = openSync(logPath, "wx");
  const childEnvironment = { ...process.env };
  delete childEnvironment.DATABASE_URL;
  delete childEnvironment.DATABASE_ADMIN_URL;
  delete childEnvironment.GALINUM_MEDIA_DIR;
  Object.assign(childEnvironment, {
    PORT: String(port),
    GALINUM_HOST: "127.0.0.1",
    GALINUM_PUBLIC_URL: origin,
    GALINUM_SECRET_KEY: secretKey,
    GALINUM_PUBLISHABLE_KEY: publishableKey,
  });
  const child = spawn(process.execPath, [serverEntrypoint], {
    cwd: productDirectory,
    detached: true,
    env: childEnvironment,
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  closeSync(logDescriptor);
  child.unref();
  const runtimePath = join(directory, "runtime.json");
  const launchState = {
    runId,
    pid: child.pid,
    port,
    origin,
    secretKey,
    publishableKey,
    serverEntrypoint,
    commit: git(["rev-parse", "HEAD"]),
    worktreeStatus: git(["status", "--porcelain=v1"]),
    serverVersion: productVersion(),
    launchedAt: new Date().toISOString(),
  };
  writeJson(runtimePath, launchState, 0o600);
  try {
    await waitForHealth(origin);
    writeJson(join(directory, "launch.json"), {
      runId,
      pid: child.pid,
      port,
      origin,
      commit: launchState.commit,
      worktreeStatus: launchState.worktreeStatus,
      serverVersion: launchState.serverVersion,
      launchedAt: launchState.launchedAt,
    });
  } catch (error) {
    if (processIsAlive(child.pid)) process.kill(child.pid, "SIGTERM");
    unlinkSync(runtimePath);
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ runId, origin, artifacts: directory }, null, 2)}\n`);
}

function runtime(runId) {
  const path = join(runDirectory(runId), "runtime.json");
  if (!existsSync(path)) fail(`No live runtime exists for ${runId}.`);
  return { path, state: readJson(path) };
}

async function doctor(runId) {
  const { state } = runtime(runId);
  if (!processIsAlive(state.pid)) fail(`PID ${state.pid} is not running.`);
  const command = processCommand(state.pid);
  if (!command.includes(state.serverEntrypoint)) fail(`PID ${state.pid} is not the server started by this run.`);
  if (!processOwnsPort(state.pid, state.port)) fail(`PID ${state.pid} does not own ${state.origin}.`);
  if (state.commit !== git(["rev-parse", "HEAD"])) fail("The product commit changed after launch.");
  if (state.worktreeStatus !== git(["status", "--porcelain=v1"])) fail("The product worktree changed after launch.");
  if (state.serverVersion !== productVersion()) fail("The server package version changed after launch.");
  const body = await health(state.origin);
  const result = {
    ok: true,
    runId,
    pid: state.pid,
    origin: state.origin,
    serverVersion: state.serverVersion,
    commit: state.commit,
    health: body,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return state;
}

function redactBody(body) {
  return body === undefined ? "(none)" : JSON.stringify(body, null, 2);
}

async function request(state, transcriptPath, step, credential, method, path, body, expectedStatus) {
  const key = credential === "secret" ? state.secretKey : credential === "publishable" ? state.publishableKey : null;
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${state.origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = responseText;
  }
  appendFileSync(transcriptPath, [
    `=== ${step} ===`,
    `${method} ${path}`,
    `Authorization: ${credential}${key ? " (value redacted)" : ""}`,
    `Request body:\n${redactBody(body)}`,
    `Response status: ${response.status}`,
    `Response body:\n${typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody, null, 2)}`,
    "",
  ].join("\n"));
  const accepted = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  if (!accepted.includes(response.status)) fail(`${step} returned ${response.status}; expected ${accepted.join(" or ")}.`);
  return responseBody;
}

function assert(value, message) {
  if (!value) fail(message);
}

const freeExpression = {
  version: 1,
  root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "free" },
};

const enterpriseExpression = {
  version: 1,
  root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "enterprise" },
};

async function campaignLifecycle(state, transcriptPath) {
  const created = await request(state, transcriptPath, "1. Create a draft campaign", "secret", "POST", "/api/v1/campaigns", {
    name: `Verification lifecycle ${state.runId}`,
    message: { presentation: "toast", title: "Verification lifecycle" },
  }, 201);
  const campaignId = created.campaign.id;
  assert(created.campaign.status === "draft", "Created campaign was not a draft.");
  const detail = await request(state, transcriptPath, "2. Read the created campaign", "secret", "GET", `/api/v1/campaigns/${campaignId}`, undefined, 200);
  assert(detail.campaign.id === campaignId, "Campaign detail did not return the created campaign.");
  const launched = await request(state, transcriptPath, "3. Launch the campaign", "secret", "POST", `/api/v1/campaigns/${campaignId}/status`, { action: "launch" }, 200);
  assert(launched.status === "running", "Campaign did not enter running state.");
  const running = await request(state, transcriptPath, "4. List running campaigns", "secret", "GET", "/api/v1/campaigns?status=running", undefined, 200);
  assert(running.campaigns.some((campaign) => campaign.id === campaignId), "Running list omitted the campaign.");
  const paused = await request(state, transcriptPath, "5. Pause the campaign", "secret", "POST", `/api/v1/campaigns/${campaignId}/status`, { action: "pause" }, 200);
  assert(paused.status === "paused", "Campaign did not enter paused state.");
  const pausedDetail = await request(state, transcriptPath, "6. Confirm the paused campaign", "secret", "GET", `/api/v1/campaigns/${campaignId}`, undefined, 200);
  assert(pausedDetail.campaign.status === "paused", "Campaign detail did not persist the paused state.");
  const relaunched = await request(state, transcriptPath, "7. Relaunch the campaign", "secret", "POST", `/api/v1/campaigns/${campaignId}/status`, { action: "launch" }, 200);
  assert(relaunched.status === "running", "Campaign did not return to running state.");
  const relaunchedDetail = await request(state, transcriptPath, "8. Confirm the relaunched campaign", "secret", "GET", `/api/v1/campaigns/${campaignId}`, undefined, 200);
  assert(relaunchedDetail.campaign.status === "running", "Campaign detail did not persist the relaunched state.");
  const ended = await request(state, transcriptPath, "9. End the campaign", "secret", "POST", `/api/v1/campaigns/${campaignId}/status`, { action: "end" }, 200);
  assert(ended.status === "ended", "Campaign did not enter ended state.");
  const finalDetail = await request(state, transcriptPath, "10. Confirm the terminal state", "secret", "GET", `/api/v1/campaigns/${campaignId}`, undefined, 200);
  assert(finalDetail.campaign.status === "ended", "Campaign detail did not persist the ended state.");
  return { campaignId, observedStates: ["draft", "running", "paused", "running", "ended"] };
}

async function audienceMatching(state, transcriptPath) {
  await request(state, transcriptPath, "1. Identify a free user", "publishable", "POST", "/api/v1/identify", { userId: "verify-free", traits: { plan: "free", seats: 4 } }, 200);
  await request(state, transcriptPath, "2. Identify a pro user", "publishable", "POST", "/api/v1/identify", { userId: "verify-pro", traits: { plan: "pro", seats: 12 } }, 200);
  await request(state, transcriptPath, "3. Track a CSV export", "publishable", "POST", "/api/v1/track", { userId: "verify-free", event: "exported", props: { format: "csv" } }, 200);
  await request(state, transcriptPath, "4. Track a JSON export", "publishable", "POST", "/api/v1/track", { userId: "verify-pro", event: "exported", props: { format: "json" } }, 200);
  const capabilities = await request(state, transcriptPath, "5. Discover observed audience fields", "secret", "GET", "/api/v1/audiences/capabilities", undefined, 200);
  assert(capabilities.capabilities.traits.some((trait) => trait.key === "plan"), "Capabilities omitted the plan trait.");
  const exportedCapability = capabilities.capabilities.events.find((event) => event.name === "exported");
  assert(exportedCapability?.properties.some((property) => property.key === "format"), "Capabilities omitted the exported event format property.");
  const expression = {
    version: 1,
    root: {
      kind: "all",
      children: [
        freeExpression.root,
        { kind: "event", event: "exported", where: [{ kind: "field", field: { kind: "event_property", key: "format" }, op: "eq", value: "csv" }] },
      ],
    },
  };
  const checked = await request(state, transcriptPath, "6. Check the audience", "secret", "POST", "/api/v1/audiences/check", { expression, sampleLimit: 2 }, 200);
  assert(checked.matchedCount === 1 && checked.totalUsers === 2, "Audience count was not 1 of 2.");
  assert(checked.samples.some((sample) => sample.externalUserId === "verify-free"), "Audience sample omitted the matching user.");
  const matching = await request(state, transcriptPath, "7. Explain the matching user", "secret", "POST", "/api/v1/audiences/explain", { expression, userId: "verify-free" }, 200);
  assert(matching.matched === true, "The free CSV user did not match.");
  assert(matching.trace.children?.[0]?.observed === "free" && matching.trace.children?.[1]?.occurrences === 1, "Matching explanation omitted condition evidence.");
  const excluded = await request(state, transcriptPath, "8. Explain the excluded user", "secret", "POST", "/api/v1/audiences/explain", { expression, userId: "verify-pro" }, 200);
  assert(excluded.matched === false, "The pro JSON user unexpectedly matched.");
  assert(excluded.trace.children?.[0]?.observed === "pro" && excluded.trace.children?.[1]?.occurrences === 0, "Exclusion explanation omitted condition evidence.");
  return { matchedCount: checked.matchedCount, totalUsers: checked.totalUsers, matchedUser: "verify-free", excludedUser: "verify-pro" };
}

async function segmentVersioning(state, transcriptPath) {
  const segmentKey = `verify-enterprise-${state.runId.toLowerCase().replaceAll(".", "-")}`.slice(0, 64).replace(/[_-]+$/, "");
  const created = await request(state, transcriptPath, "1. Create a reusable segment", "secret", "POST", "/api/v1/segments", {
    key: segmentKey,
    name: "Verification users",
    expression: freeExpression,
    reason: "Initial verification audience",
  }, 201);
  const segmentId = created.segment.id;
  assert(created.segment.currentVersion === 1, "Segment did not start at version 1.");
  const revised = await request(state, transcriptPath, "2. Replace the segment expression", "secret", "PATCH", `/api/v1/segments/${segmentId}`, {
    expression: enterpriseExpression,
    expectedVersion: 1,
    reason: "Narrow verification audience",
  }, 200);
  assert(revised.segment.currentVersion === 2, "Segment did not advance to version 2.");
  const stale = await request(state, transcriptPath, "3. Reject a stale expression update", "secret", "PATCH", `/api/v1/segments/${segmentId}`, {
    expression: freeExpression,
    expectedVersion: 1,
  }, 409);
  assert(stale.currentVersion === 2, "Stale response omitted current version 2.");
  const versions = await request(state, transcriptPath, "4. List immutable versions", "secret", "GET", `/api/v1/segments/${segmentId}/versions`, undefined, 200);
  assert(versions.versions.map((version) => version.version).join(",") === "2,1", "Segment history was not versions 2 then 1.");
  const original = await request(state, transcriptPath, "5. Read version 1", "secret", "GET", `/api/v1/segments/${segmentId}/versions/1`, undefined, 200);
  assert(original.version.expression.root.value === "free", "Version 1 did not retain the original expression.");
  const archived = await request(state, transcriptPath, "6. Archive the segment", "secret", "POST", `/api/v1/segments/${segmentId}/archive`, undefined, 200);
  assert(archived.segment.status === "archived", "Segment did not enter archived state.");
  const listed = await request(state, transcriptPath, "7. Confirm the archived segment", "secret", "GET", "/api/v1/segments?status=archived", undefined, 200);
  assert(listed.segments.some((segment) => segment.id === segmentId), "Archived list omitted the segment.");
  const retained = await request(state, transcriptPath, "8. Read version 1 after archive", "secret", "GET", `/api/v1/segments/${segmentId}/versions/1`, undefined, 200);
  assert(retained.version.expression.root.value === "free", "Archive did not preserve version history.");
  const rejectedCampaign = await request(state, transcriptPath, "9. Reject a campaign using the archived segment", "secret", "POST", "/api/v1/campaigns", {
    name: "Archived segment rejection",
    message: { presentation: "toast", title: "This campaign must not exist" },
    audience: { kind: "segment", segment: segmentId },
  }, 409);
  assert(rejectedCampaign.error === "Segment is archived", "Archived segment selection returned an unexpected error.");
  return { segmentId, versions: [2, 1], staleWriteStatus: 409, finalStatus: "archived", historyReadableAfterArchive: true, archivedSelectionStatus: 409 };
}

async function webInappDelivery(state, transcriptPath) {
  const goal = await request(state, transcriptPath, "1. Create an activation goal", "secret", "POST", "/api/v1/goals", { name: "Verification activation", targetEvent: "activated" }, 201);
  const campaign = await request(state, transcriptPath, "2. Create and launch a web campaign", "secret", "POST", "/api/v1/campaigns", {
    name: `Verification delivery ${state.runId}`,
    message: { presentation: "toast", title: "Verify this message" },
    goalId: goal.goal.id,
    launch: true,
  }, 201);
  const campaignId = campaign.campaign.id;
  await request(state, transcriptPath, "3. Identify the recipient", "publishable", "POST", "/api/v1/identify", { userId: "verify-recipient", traits: { plan: "free" } }, 200);
  const messages = await request(state, transcriptPath, "4. Poll eligible messages", "publishable", "GET", "/api/v1/messages?userId=verify-recipient", undefined, 200);
  assert(messages.messages.length === 1 && messages.messages[0].campaignId === campaignId, "Recipient did not receive the campaign.");
  const deliveryId = messages.messages[0].deliveryId;
  await request(state, transcriptPath, "5. Record the visible impression", "publishable", "POST", `/api/v1/deliveries/${deliveryId}/event`, { type: "shown" }, 200);
  await request(state, transcriptPath, "6. Track the target event", "publishable", "POST", "/api/v1/track", { userId: "verify-recipient", event: "activated" }, 200);
  const detail = await request(state, transcriptPath, "7. Read campaign conversion totals", "secret", "GET", `/api/v1/campaigns/${campaignId}`, undefined, 200);
  assert(detail.campaign.stats.converted === 1, "Campaign detail did not show one conversion.");
  const deliveries = await request(state, transcriptPath, "8. Confirm the converted delivery", "secret", "GET", `/api/v1/campaigns/${campaignId}/deliveries?state=converted`, undefined, 200);
  assert(deliveries.total === 1 && deliveries.deliveries[0].id === deliveryId, "Converted delivery feed did not contain the recipient.");
  return { goalId: goal.goal.id, campaignId, deliveryId, converted: 1 };
}

async function usersEventsMetrics(state, transcriptPath) {
  await request(state, transcriptPath, "1. Identify the first user", "publishable", "POST", "/api/v1/identify", { userId: "verify-user-one", traits: { plan: "free" } }, 200);
  await request(state, transcriptPath, "2. Merge a region into the first user", "publishable", "POST", "/api/v1/identify", { userId: "verify-user-one", traits: { region: "south" } }, 200);
  await request(state, transcriptPath, "3. Identify the second user", "publishable", "POST", "/api/v1/identify", { userId: "verify-user-two", traits: { plan: "pro", region: "north" } }, 200);
  await request(state, transcriptPath, "4. Track an activation", "publishable", "POST", "/api/v1/track", { userId: "verify-user-one", event: "activated", props: { source: "verification" } }, 200);
  await request(state, transcriptPath, "5. Track an export", "publishable", "POST", "/api/v1/track", { userId: "verify-user-two", event: "exported", props: { format: "csv" } }, 200);
  const users = await request(state, transcriptPath, "6. Filter the user list", "secret", "GET", "/api/v1/users?traitKey=plan&traitValue=free", undefined, 200);
  assert(users.total === 1 && users.users[0].externalUserId === "verify-user-one", "Filtered user list did not return only the free user.");
  const detail = await request(state, transcriptPath, "7. Read the user detail", "secret", "GET", `/api/v1/users/${users.users[0].id}`, undefined, 200);
  assert(detail.user.traits.plan === "free" && detail.user.traits.region === "south", "User detail did not preserve merged traits.");
  const events = await request(state, transcriptPath, "8. Filter the event list", "secret", "GET", "/api/v1/events?name=activated&externalUserId=verify-user-one", undefined, 200);
  assert(events.total === 1 && events.events[0].props.source === "verification", "Filtered event list omitted the activation.");
  const overview = await request(state, transcriptPath, "9. Read the project overview", "secret", "GET", "/api/v1/overview", undefined, 200);
  assert(overview.endUsers === 2 && overview.eventsLast7d === 2, "Overview totals did not include both users and events.");
  const metrics = await request(state, transcriptPath, "10. Read project metrics", "secret", "GET", "/api/v1/metrics", undefined, 200);
  assert(metrics.totals.events === 2 && metrics.hasAnyActivity === true, "Metrics did not report two events.");
  const usage = await request(state, transcriptPath, "11. Read current usage", "secret", "GET", "/api/v1/usage", undefined, 200);
  assert(usage.activeUsers === 2, "Usage did not report two active users.");
  return { mergedTraits: ["plan", "region"], endUsers: overview.endUsers, events: metrics.totals.events, activeUsers: usage.activeUsers };
}

const scenarios = {
  "campaign-lifecycle": campaignLifecycle,
  "audience-matching": audienceMatching,
  "segment-versioning": segmentVersioning,
  "web-inapp-delivery": webInappDelivery,
  "users-events-metrics": usersEventsMetrics,
};

async function scenario(runId, scenarioName) {
  const state = await doctor(runId);
  const drive = scenarios[scenarioName];
  if (!drive) fail(`Unknown scenario ${scenarioName}. Choose ${Object.keys(scenarios).join(", ")}.`);
  const directory = runDirectory(runId);
  const markerPath = join(directory, "scenario.json");
  if (existsSync(markerPath)) fail("This run already drove a scenario. Launch a fresh run for isolated state.");
  writeJson(markerPath, { scenario: scenarioName, startedAt: new Date().toISOString() });
  const transcriptPath = join(directory, `${scenarioName}.http.txt`);
  try {
    const observations = await drive(state, transcriptPath);
    const proof = {
      verified: true,
      runId,
      scenario: scenarioName,
      origin: state.origin,
      observations,
      transcript: transcriptPath,
      completedAt: new Date().toISOString(),
    };
    const proofPath = join(directory, `${scenarioName}.proof.json`);
    writeJson(proofPath, proof);
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  } catch (error) {
    writeJson(join(directory, `${scenarioName}.failure.json`), {
      verified: false,
      runId,
      scenario: scenarioName,
      error: error instanceof Error ? error.message : String(error),
      transcript: transcriptPath,
      failedAt: new Date().toISOString(),
    });
    throw error;
  }
}

async function cleanup(runId) {
  const directory = runDirectory(runId);
  const runtimePath = join(directory, "runtime.json");
  if (!existsSync(runtimePath)) fail(`No live runtime exists for ${runId}.`);
  const state = readJson(runtimePath);
  let outcome = "already-stopped";
  if (processIsAlive(state.pid)) {
    const command = processCommand(state.pid);
    if (!command.includes(state.serverEntrypoint) || !processOwnsPort(state.pid, state.port)) {
      fail(`Refusing to stop PID ${state.pid}; it no longer matches this run.`);
    }
    process.kill(state.pid, "SIGTERM");
    for (let attempt = 0; attempt < 50 && processIsAlive(state.pid); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (processIsAlive(state.pid)) process.kill(state.pid, "SIGKILL");
    outcome = "stopped";
  }
  unlinkSync(runtimePath);
  const result = {
    runId,
    pid: state.pid,
    origin: state.origin,
    outcome,
    evidencePreservedAt: directory,
    cleanedAt: new Date().toISOString(),
  };
  writeJson(join(directory, "cleanup.json"), result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function usage() {
  process.stdout.write([
    "Usage:",
    "  control-galinum.mjs launch <run-id>",
    "  control-galinum.mjs doctor <run-id>",
    "  control-galinum.mjs scenario <run-id> <scenario>",
    "  control-galinum.mjs cleanup <run-id>",
    "",
    `Scenarios: ${Object.keys(scenarios).join(", ")}`,
    "",
  ].join("\n"));
}

requireNode24();
const [command, runId, scenarioName] = process.argv.slice(2);
try {
  if (command === "launch") await launch(runId);
  else if (command === "doctor") await doctor(runId);
  else if (command === "scenario") await scenario(runId, scenarioName);
  else if (command === "cleanup") await cleanup(runId);
  else {
    usage();
    if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
