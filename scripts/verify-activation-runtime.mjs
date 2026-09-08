import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const limits = { requestBytes: 65536, responseBytes: 262144, transcriptBytes: 2097152, providerRequests: 1000, cliBytes: 65536 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function options(args) {
  const result = { package: resolve(import.meta.dirname, "../packages/server"), memoryOnly: false, evidence: null };
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    assert(!seen.has(flag), `Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--memory-only") result.memoryOnly = true;
    else if (flag === "--package" || flag === "--evidence") {
      const value = args.shift();
      assert(value && !value.startsWith("--"), `Missing value for ${flag}`);
      if (flag === "--package") result.package = resolve(value);
      else {
        assert(isAbsolute(value) && value.endsWith(".json"), "--evidence requires an absolute .json file path");
        result.evidence = value;
      }
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return result;
}
function maintenanceUrl(value) {
  const url = new URL(value);
  assert(["postgres:", "postgresql:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && url.pathname === "/postgres" && !url.search && !url.hash,
  "Runtime verification requires a loopback postgres maintenance database without URL parameters or fragments");
  return url;
}
async function boundedFile(path, maxBytes) {
  assert((await stat(path)).size <= maxBytes, "Package input exceeds size limit");
  return readFile(path, "utf8");
}
function packageFile(directory, path) {
  assert(typeof path === "string" && path.startsWith("./"), "Missing package entrypoint");
  const absolute = resolve(directory, path);
  assert(absolute.startsWith(`${directory}${sep}`), "Package entrypoint escapes its directory");
  return absolute;
}
async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitFor(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`${label} timed out`);
}
async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert(size <= limits.responseBytes, "HTTP response exceeds size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}
async function listen(server) {
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await within(new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }), 5000, "Server startup");
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await within(closed, 5000, "Server shutdown");
}
async function scoped(proof, work) {
  const tasks = [];
  let result;
  let failure;
  try { result = await work((name, close) => tasks.push({ name, close })); }
  catch (error) { failure = error; }
  for (const task of tasks.reverse()) {
    try { await task.close(); proof.cleanup.push({ resource: task.name, closed: true }); }
    catch (error) { proof.cleanup.push({ resource: task.name, closed: false }); failure ??= error; }
  }
  if (failure) throw failure;
  return result;
}
function fixtureResponse(path, deployed) {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const commit = (sha) => ({ sha, message: sha === head ? "Follow-up" : "Feature", parents: sha === head ? [{ sha: base }] : [] });
  const restCommit = (sha) => ({ sha, commit: { message: commit(sha).message }, parents: commit(sha).parents });
  if (path === "/app/installations/7/access_tokens") return { token: "fixture_installation_token", expires_at: "2099-01-01T00:00:00Z" };
  if (path === "/repos/example/product") return { id: 12, owner: { login: "example" }, name: "product", description: null,
    default_branch: "main", private: false, archived: false, disabled: false };
  if (path === "/repos/example/product/branches/main") return { name: "main", commit: { sha: head }, protected: true };
  if (path === "/repos/example/product/deployments") return deployed ? [{ id: 11, sha: head, environment: "production", created_at: "2026-01-01T00:00:00Z" }] : [];
  if (path === "/repos/example/product/deployments/11/statuses") return [{ id: 13, state: "success", environment: "production", created_at: "2026-01-01T00:00:01Z" }];
  for (const sha of [base, head]) {
    if (path === `/repos/example/product/git/commits/${sha}`) return commit(sha);
    if (path === `/repos/example/product/commits/${sha}`) return restCommit(sha);
  }
  if (path === "/repos/example/product/commits") return [restCommit(head), restCommit(base)];
  const comparison = /^\/repos\/example\/product\/compare\/([ab]{40})\.\.\.([ab]{40})$/.exec(path);
  if (comparison) {
    const [, before, after] = comparison;
    assert([base, head].includes(before) && [base, head].includes(after), "Unknown comparison commit");
    const ahead = before === base && after === head;
    const behind = before === head && after === base;
    return { status: ahead ? "ahead" : behind ? "behind" : "identical", ahead_by: ahead ? 1 : 0, behind_by: behind ? 1 : 0,
      total_commits: ahead ? 1 : 0, base_commit: { sha: before }, merge_base_commit: { sha: ahead || behind ? base : before },
      commits: ahead ? [restCommit(head)] : [], files: [] };
  }
  throw new Error(`Unexpected fixture route: ${path}`);
}
async function database(pg, maintenance, schema, register, proof) {
  const name = `galinum_runtime_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  register("maintenance connection", () => admin.end());
  await admin.connect();
  const identity = async (client, expected) => {
    const row = (await client.query("SELECT current_database() AS name, inet_server_addr()::text AS address, current_user AS username")).rows[0];
    assert.equal(row.name, expected);
    assert(["127.0.0.1", "127.0.0.1/32", "::1", "::1/128"].includes(row.address), "Database server is not loopback");
    return row;
  };
  const owner = await identity(admin, "postgres");
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  register("disposable database", async () => {
    await identity(admin, "postgres");
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    assert.equal((await admin.query("SELECT datname FROM pg_database WHERE datname=$1", [name])).rowCount, 0);
    proof.database.removed = true;
  });
  proof.database = { name, removed: false };
  const target = new URL(maintenance);
  target.pathname = `/${name}`;
  if (!target.username) target.username = owner.username;
  const client = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  try {
    await client.connect();
    await identity(client, name);
    await client.query(schema);
  } finally { await client.end(); }
  return target.toString();
}
async function main() {
  const config = options(process.argv.slice(2));
  const maintenance = config.memoryOnly ? null : maintenanceUrl(process.env.GALINUM_RUNTIME_DATABASE_URL ?? "postgresql://127.0.0.1/postgres");
  const manifestPath = resolve(config.package, "package.json");
  const manifest = JSON.parse(await boundedFile(manifestPath, 65536));
  assert.equal(manifest.name, "@galinum/server");
  const entrypoint = (key) => packageFile(config.package, manifest.exports[key]?.import);
  const { createLocalProduct, createPostgresProduct } = await import(pathToFileURL(entrypoint("./runtime")));
  const { createApp } = await import(pathToFileURL(entrypoint(".")));
  const { nodeAdapter } = await import(pathToFileURL(packageFile(config.package, "./dist/node-adapter.js")));
  const cliPath = packageFile(config.package, manifest.bin?.["galinum-server"]);
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const secrets = [privateKey, "fixture_installation_token"];
  const proof = { verified: false, version: manifest.version, scenarios: [], cli: null, database: null, cleanup: [] };
  const transcript = [];
  const providerRequests = [];
  let transcriptBytes = 0;
  let fixtureError;
  let providerBytes = 0;
  let deployed = true;
  const record = (entry) => {
    transcriptBytes += Buffer.byteLength(JSON.stringify(entry));
    assert(transcriptBytes <= limits.transcriptBytes, "Transcript exceeds size limit");
    transcript.push(entry);
  };
  let failure;
  try {
    await scoped(proof, async (register) => {
      const fixture = createServer(async (request, response) => {
        try {
          let bytes = 0;
          for await (const chunk of request) {
            bytes += chunk.length;
            assert(bytes <= limits.requestBytes, "Fixture request exceeds size limit");
          }
          const url = new URL(request.url, "http://fixture");
          assert(providerRequests.length < limits.providerRequests, "Provider request limit exceeded");
          const requestRecord = { method: request.method, path: url.pathname, query: url.search };
          providerBytes += Buffer.byteLength(JSON.stringify(requestRecord));
          assert(providerBytes <= limits.transcriptBytes, "Provider transcript exceeds size limit");
          providerRequests.push(requestRecord);
          const body = fixtureResponse(url.pathname, deployed);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        } catch (error) {
          fixtureError ??= error;
          response.writeHead(500, { "content-type": "application/json" });
          response.end('{"error":"Fixture request rejected"}');
        }
      });
      register("GitHub HTTP fixture", () => closeServer(fixture));
      const fixtureOrigin = await listen(fixture);
      let connectionString;
      if (maintenance) {
        const require = createRequire(manifestPath);
        connectionString = await database(require("pg"), maintenance,
          await boundedFile(resolve(config.package, "schema.sql"), 2097152), register, proof);
      }
      const modes = config.memoryOnly ? ["memory"] : ["memory", "postgres"];
      for (const mode of modes) {
        for (const order of ["deployment-before-approval", "approval-before-deployment"]) {
          await scoped(proof, async (registerRuntime) => {
            let offset = 0;
            const projectId = `${mode}_${order}`;
            const sourceId = `${projectId}_source`;
            const keys = { secretKey: `sk_${randomUUID()}`, publishableKey: `pk_${randomUUID()}`, operatorKey: `operator_${randomUUID()}` };
            secrets.push(...Object.values(keys));
            const productOptions = { ...keys, projectId, now: () => Date.now() + offset, activationWorkerIntervalMs: 100,
              managementRateLimit: { perMinute: 1000, perHour: 1000 }, github: { appId: 9, clientId: "Iv.fixture", privateKey,
                fetch: (input, init) => {
                  const url = new URL(String(input));
                  assert.equal(url.origin, "https://api.github.com", "Provider attempted an unexpected origin");
                  return fetch(`${fixtureOrigin}${url.pathname}${url.search}`, { ...init, redirect: "error",
                    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
                } } };
            const product = mode === "memory" ? createLocalProduct(productOptions) : await createPostgresProduct({ ...productOptions, connectionString });
            registerRuntime(`${projectId} product`, () => within(product.close(), 15000, "Product shutdown"));
            const server = createServer(nodeAdapter(createApp(product.handlers, product.media, product.operatorHandler)));
            registerRuntime(`${projectId} HTTP server`, () => closeServer(server));
            const origin = await listen(server);
            const call = async (path, method = "GET", body, credential = "management", status = 200) => {
              if (fixtureError) throw fixtureError;
              const key = credential === "operator" ? keys.operatorKey : credential === "sdk" ? keys.publishableKey : keys.secretKey;
              const encoded = body === undefined ? undefined : JSON.stringify(body);
              assert(!encoded || Buffer.byteLength(encoded) <= limits.requestBytes);
              const response = await fetch(`${origin}${path}`, { method, body: encoded, redirect: "error", signal: AbortSignal.timeout(5000),
                headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
              const value = await responseJson(response);
              record({ mode, order, path, method, credential, body, status: response.status, response: value });
              assert.equal(response.status, status, `${method} ${path} returned an unexpected status`);
              return value;
            };
            await call("/api/health");
            await call(`/operator/sources/${sourceId}`, "PUT", { expectedRevision: "0", installationId: 7, repositoryId: 12,
              owner: "example", name: "product", branch: "main", enabled: true, paused: false }, "operator");
            await call("/operator/mappings", "POST", { id: null, expectedVersion: null, repositoryId: "12", environment: "production",
              sourceIds: [sourceId], scopeDescription: "Entire repository", confirmed: true }, "operator");
            const changes = [{ sourceId, kind: "commit", sha: "a".repeat(40) }];
            const { campaign } = await call("/api/v1/campaigns", "POST", { name: "Release", message: { presentation: "toast", title: "Shipped" }, sourceChanges: { changes } }, "management", 201);
            const path = `/api/v1/campaigns/${campaign.id}`;
            await call(path, "PATCH", { name: "Rejected", sourceChanges: { expectedRevision: "0", changes: [] } }, "management", 409);
            assert.deepEqual((await call(path)).campaign.sourceChanges, { revision: "1", changes });
            assert.equal((await call(path)).campaign.name, "Release");
            const reviewPath = `/operator/campaigns/${campaign.id}`;
            const review = await call(`${reviewPath}/review`, "GET", undefined, "operator");
            await call(`${reviewPath}/approve`, "POST", { expectedRevision: review.revision }, "management", 401);
            await call(`${reviewPath}/approve`, "POST", { expectedRevision: review.revision }, "sdk", 401);
            await call(`${reviewPath}/approve`, "POST", { expectedRevision: review.revision, approvedBy: "forged" }, "operator", 400);
            deployed = order === "deployment-before-approval";
            if (!deployed) await call(`${reviewPath}/approve`, "POST", { expectedRevision: review.revision }, "operator");
            product.worker.start();
            await waitFor(async () => (await call(`${path}/activation`)).lastCheckedAt !== null, "Initial deployment check");
            assert.equal((await call(path)).campaign.status, "draft");
            if (deployed) await call(`${reviewPath}/approve`, "POST", { expectedRevision: review.revision }, "operator");
            else { deployed = true; offset += 601000; }
            await waitFor(async () => (await call(path)).campaign.status === "running", "Automatic activation");
            const activation = await call(`${path}/activation`);
            assert.equal(activation.launch.mode, "automatic");
            assert(activation.launch.evidence.length > 0, "Automatic receipt lacks deployment evidence");
            await call("/api/v1/identify", "POST", { userId: "reader" }, "sdk");
            const messages = await call("/api/v1/messages?userId=reader", "GET", undefined, "sdk");
            assert.equal(messages.messages.length, 1);
            assert.equal(messages.messages[0].content.title, "Shipped");
            const manual = await call("/api/v1/campaigns", "POST", { name: "Manual", message: { presentation: "toast", title: "Manual" }, launch: true }, "management", 201);
            assert.equal((await call(`/api/v1/campaigns/${manual.campaign.id}/activation`)).launch.mode, "manual");
            proof.scenarios.push({ mode, order, automaticReceipt: true, manualReceipt: true, sdkDelivery: true,
              staleEditRolledBack: true, operatorSeparated: true, pollingWithoutWebhooks: true, clockAdvancedForPeriodicRetry: order === "approval-before-deployment" });
          });
        }
      }
      assert(providerRequests.some(({ path }) => path.includes("/compare/")), "Commit graph comparison was not exercised");
      if (fixtureError) throw fixtureError;
      await scoped(proof, async (registerCli) => {
        const probe = createServer();
        registerCli("CLI port probe", () => closeServer(probe));
        const origin = await listen(probe);
        await closeServer(probe);
        const cliKeys = { GALINUM_SECRET_KEY: `sk_${randomUUID()}`, GALINUM_PUBLISHABLE_KEY: `pk_${randomUUID()}`, GALINUM_OPERATOR_KEY: `operator_${randomUUID()}` };
        secrets.push(...Object.values(cliKeys));
        const networkGuard = `
          const request = globalThis.fetch;
          globalThis.fetch = (input, init) => {
            const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
            if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
              throw new Error("CLI attempted a nonlocal network request");
            }
            return request(input, init);
          };
        `;
        const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(networkGuard)}`, cliPath], {
          cwd: config.package, stdio: ["ignore", "pipe", "pipe"], env: {
          PATH: process.env.PATH, ...cliKeys, PORT: new URL(origin).port, GALINUM_HOST: "127.0.0.1", GALINUM_PUBLIC_URL: origin,
          GALINUM_GITHUB_APP_ID: "9", GALINUM_GITHUB_CLIENT_ID: "Iv.fixture", GALINUM_GITHUB_PRIVATE_KEY: privateKey,
        } });
        let mounted = false;
        let logs = "";
        let logBytes = 0;
        let overflow = false;
        const capture = (chunk) => {
          logBytes += chunk.length;
          if (logBytes > limits.cliBytes) { overflow = true; child.kill("SIGTERM"); }
          else logs += chunk.toString("utf8");
        };
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        const exited = new Promise((resolve, reject) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
          child.once("error", reject);
        });
        exited.catch(() => {});
        registerCli("CLI process", async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          let exit;
          try { exit = await within(exited, 5000, "CLI shutdown"); }
          catch (error) {
            child.kill("SIGKILL");
            await within(exited, 5000, "CLI forced shutdown");
            throw error;
          }
          assert.equal(exit.code, 0, "CLI did not exit cleanly after SIGTERM");
          assert(!overflow, "CLI output exceeded limit");
          assert(!secrets.some((secret) => logs.includes(secret)) && !logs.includes("PRIVATE KEY"), "CLI printed configured credentials");
          proof.cli = { operatorMounted: mounted, explicitGithubEnvironment: mounted, noSecretsLogged: true, sigtermExitCode: exit.code, outboundNetworkGuard: true, outputBytes: logBytes };
        });
        await waitFor(async () => {
          assert(!overflow && child.exitCode === null && child.signalCode === null, "CLI stopped before readiness");
          try {
            const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
            await response.body?.cancel();
            return response.ok;
          }
          catch { return false; }
        }, "CLI startup");
        const response = await fetch(`${origin}/operator/shipping`, { headers: { authorization: `Bearer ${cliKeys.GALINUM_OPERATOR_KEY}` }, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        assert.equal((await responseJson(response)).controls.paused, false);
        mounted = true;
      });
    });
    proof.verified = true;
  } catch (error) { failure = error; proof.error = error.message; }
  proof.provider = { requests: providerRequests.length, branchReads: providerRequests.filter(({ path }) => path.includes("/branches/")).length,
    gitCommitReads: providerRequests.filter(({ path }) => path.includes("/git/commits/")).length, comparisons: providerRequests.filter(({ path }) => path.includes("/compare/")).length };
  const redact = (value) => secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), JSON.stringify(value, null, 2));
  if (config.evidence) {
    await mkdir(dirname(config.evidence), { recursive: true });
    const transcriptPath = config.evidence.replace(/\.json$/, ".http.json");
    await writeFile(transcriptPath, `${redact({ transcript, providerRequests })}\n`);
    proof.transcript = transcriptPath;
    await writeFile(config.evidence, `${redact(proof)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ verified: proof.verified, version: proof.version, scenarios: proof.scenarios,
    cli: proof.cli, database: proof.database, cleanup: proof.cleanup.every(({ closed }) => closed), ...(proof.error ? { error: proof.error } : {}), evidence: config.evidence })}\n`);
  if (failure) process.exitCode = 1;
}

if (process.argv.includes("--help")) {
  process.stdout.write("Usage: node scripts/verify-activation-runtime.mjs [--package directory] [--memory-only] [--evidence /absolute/proof.json]\n");
} else {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ verified: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}
