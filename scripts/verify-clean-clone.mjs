import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

import { copyWorktree } from "./release-packages.mjs";

const root = resolve(import.meta.dirname, "..");

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
}

// A public clone must install from the public registry with no ambient
// credentials: private-registry auth here would hide a missing public package.
export function publicRegistryEnv(source, config) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    const key = name.toUpperCase();
    if (key.startsWith("NPM_") || key.startsWith("PNPM_") || key.startsWith("YARN_")) continue;
    if (key.includes("REGISTRY") || key.includes("NODE_AUTH")) continue;
    if (key.includes("TOKEN") || key.includes("AUTH") || key.includes("CREDENTIAL")) continue;
    env[name] = value;
  }
  return { ...env, ...config };
}

const osVariables = ["HOME", "LANG", "PATH", "SHELL", "TMPDIR", "TZ", "USER"];

export function cleanStartEnv(source, port) {
  const env = {};
  for (const name of osVariables) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return { ...env, PORT: String(port) };
}

export function currentTreeDeletedFiles(repository, spawn = spawnSync) {
  const result = spawn(
    "git",
    ["-C", repository, "diff", "--name-only", "--diff-filter=D", "-z", "HEAD"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "git diff failed");
  return result.stdout.split("\0").filter(Boolean);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (port === null) throw new Error("Could not reserve a clean-clone port");
  return port;
}

async function startAndCheck(clone) {
  const port = await availablePort();
  const env = cleanStartEnv(process.env, port);
  const server = spawn("node", ["packages/server/dist/cli.js"], {
    cwd: clone,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const boundPort = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start\n${output}`)), 15_000);
    server.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = /127\.0\.0\.1:(\d+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    });
    server.stderr.on("data", (chunk) => { output += chunk.toString(); });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with ${code}\n${output}`));
    });
  });
  try {
    const response = await fetch(`http://127.0.0.1:${boundPort}/api/health`);
    if (!response.ok) throw new Error(`Health returned ${response.status}`);
    const health = await response.json();
    if (health.status !== "ok") throw new Error("Health payload is invalid");
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolveExit) => server.once("exit", resolveExit));
  }
}

async function main() {
  const scratch = mkdtempSync(resolve(tmpdir(), "galinum-clean-clone-"));
  const snapshot = resolve(scratch, "source");
  const clone = resolve(scratch, "repo");
  const userNpmrc = resolve(scratch, "npmrc-user");
  const globalNpmrc = resolve(scratch, "npmrc-global");
  const npmHome = resolve(scratch, "npm-home");
  try {
    writeFileSync(userNpmrc, "registry=https://registry.npmjs.org/\n");
    writeFileSync(globalNpmrc, "registry=https://registry.npmjs.org/\n");
    const installEnv = publicRegistryEnv(process.env, {
      NPM_CONFIG_USERCONFIG: userNpmrc,
      NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      NPM_CONFIG_CACHE: resolve(npmHome, "npm-cache"),
      XDG_CONFIG_HOME: resolve(npmHome, "config"),
    });
    run("git", ["clone", "--no-local", "--quiet", root, snapshot], root);
    copyWorktree(root, snapshot);
    const deleted = currentTreeDeletedFiles(root);
    for (const name of deleted) {
      const path = resolve(snapshot, name);
      if (existsSync(path)) rmSync(path, { force: true });
    }
    run("git", ["add", "-A"], snapshot);
    const changed = spawnSync("git", ["status", "--porcelain"], {
      cwd: snapshot,
      encoding: "utf8",
    }).stdout.trim();
    if (changed) {
      const sourceName = spawnSync("git", ["-C", root, "show", "-s", "--format=%an", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const sourceEmail = spawnSync("git", ["-C", root, "show", "-s", "--format=%ae", "HEAD"], { encoding: "utf8" }).stdout.trim();
      run("git", ["config", "user.name", sourceName], snapshot);
      run("git", ["config", "user.email", sourceEmail], snapshot);
      run("git", ["commit", "--quiet", "-m", "Verify current tree"], snapshot);
    }
    run("git", ["clone", "--no-local", "--quiet", snapshot, clone], snapshot);
    run("pnpm", ["install", "--frozen-lockfile"], clone, installEnv);
    run("pnpm", ["verify"], clone, installEnv);
    await startAndCheck(clone);
    process.stdout.write("VERIFIED clean clone dashboard release, build, tests, and credential-free start\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
