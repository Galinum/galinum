import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rootPaths = [".github/", "examples/self-host/", "release/", "scripts/", "AGENTS.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

const packageLanes = [
  {
    name: "core",
    paths: ["packages/core/"],
    release: true,
    commands: [
      ["pnpm", "--filter", "@galinum/core", "typecheck"],
      ["pnpm", "--filter", "@galinum/core", "test"],
      ["pnpm", "--filter", "@galinum/core", "build"],
    ],
  },
  {
    name: "dashboard",
    paths: ["packages/dashboard/"],
    requires: ["core"],
    prerequisites: [["pnpm", "--filter", "@galinum/core", "build"]],
    release: true,
    commands: [
      ["pnpm", "verify:dashboard"],
      ["pnpm", "--filter", "@galinum/dashboard", "test"],
      ["pnpm", "--filter", "@galinum/dashboard", "typecheck"],
      ["pnpm", "--filter", "@galinum/dashboard", "build"],
      ["pnpm", "verify:dashboard-built"],
    ],
  },
  {
    name: "docs",
    paths: ["apps/docs/"],
    commands: [["pnpm", "check"]],
  },
  {
    name: "react",
    paths: ["packages/react/"],
    release: true,
    commands: [
      ["pnpm", "--filter", "@galinum/react", "typecheck"],
      ["pnpm", "--filter", "@galinum/react", "test"],
      ["pnpm", "--filter", "@galinum/react", "build"],
    ],
  },
  {
    name: "react-example",
    paths: ["examples/react-nextjs/"],
    requires: ["react"],
    prerequisites: [["pnpm", "--filter", "@galinum/react", "build"]],
    commands: [
      ["pnpm", "--filter", "@galinum/example-react-nextjs", "typecheck"],
      ["pnpm", "--filter", "@galinum/example-react-nextjs", "build"],
    ],
  },
  {
    name: "server",
    paths: ["packages/server/", "apps/docs/openapi.json"],
    requires: ["core"],
    prerequisites: [["pnpm", "--filter", "@galinum/core", "build"]],
    release: true,
    commands: [
      ["pnpm", "verify:server-operations"],
      ["pnpm", "--filter", "@galinum/server", "typecheck"],
      ["pnpm", "--filter", "@galinum/server", "test"],
      ["pnpm", "--filter", "@galinum/server", "build"],
    ],
  },
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function changedFiles() {
  const base = argument("--base");
  if (process.argv.includes("--all") || !base || /^0+$/.test(base)) return null;
  if (spawnSync("git", ["cat-file", "-e", `${base}^{commit}`]).status !== 0) return null;
  const result = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.split("\n").filter(Boolean);
}

export function selectAffected(files) {
  const everyLane = packageLanes.map((lane) => lane.name);
  if (files === null) return everyLane;
  if (files.some((file) => rootPaths.some((rootPath) => file === rootPath || file.startsWith(rootPath)))) return everyLane;
  const changed = new Set(
    packageLanes
      .filter((lane) => lane.paths.some((path) => files.some((file) => file === path || file.startsWith(path))))
      .map((lane) => lane.name),
  );
  return packageLanes
    .filter((lane) => changed.has(lane.name) || (lane.requires ?? []).some((name) => changed.has(name)))
    .map((lane) => lane.name);
}

export function prerequisiteCommands(lane, selected) {
  const satisfied = (lane.requires ?? []).every((name) => selected.includes(name));
  return satisfied ? [] : (lane.prerequisites ?? []);
}

export function selectedLanes(selected) {
  return packageLanes.filter((lane) => selected.includes(lane.name));
}

function run(command) {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const selected = selectAffected(changedFiles());
  process.stdout.write(`affected packages: ${selected.join(", ") || "none"}\n`);
  if (process.argv.includes("--list-only")) return;
  if (selected.length) {
    run(["pnpm", "verify:workspace"]);
  }
  const lanes = selectedLanes(selected);
  for (const lane of lanes) {
    for (const command of prerequisiteCommands(lane, selected)) run(command);
    for (const command of lane.commands) run(command);
  }
  if (lanes.some((lane) => lane.release)) run(["pnpm", "verify:release"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
