import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import {
  dashboardBoundaryFailures,
  dashboardTokenFailures,
} from "./dashboard-boundary-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, "packages/dashboard");
const sourceRoot = resolve(packageRoot, "src");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const shadcnLicense = resolve(packageRoot, "LICENSES/shadcn-ui-MIT.txt");
const failures = [];

if (packageJson.name !== "@galinum/dashboard") failures.push("dashboard package identity is invalid");
if (packageJson.private !== true) failures.push("dashboard package must stay private");
if (!existsSync(shadcnLicense)) failures.push("dashboard package shadcn/ui license is missing");
if (!packageJson.files?.includes("LICENSES")) failures.push("dashboard package must include third-party licenses");
if (
  JSON.stringify(packageJson.peerDependencies) !==
  JSON.stringify({ react: "19.2.3", "react-dom": "19.2.3" })
) {
  failures.push("dashboard peers must be exact React and React DOM versions");
}
if (packageJson.peerDependencies?.next !== undefined) {
  failures.push("dashboard must not add a Next peer before it imports Next code");
}

const uiNames = [
  "alert-dialog",
  "avatar",
  "badge",
  "button",
  "card",
  "dialog",
  "dropdown-menu",
  "empty",
  "field",
  "input",
  "label",
  "native-select",
  "select",
  "separator",
  "sheet",
  "sidebar",
  "skeleton",
  "spinner",
  "switch",
  "table",
  "tooltip",
];
const componentNames = ["activity-list", "charts", "greeting", "page-header", "stat-tile"];
const expectedExports = new Set([
  ...componentNames.map((name) => "./components/" + name),
  ...uiNames.map((name) => "./ui/" + name),
  "./utils",
  "./use-mobile",
  "./tokens.css",
  "./home",
  "./metrics",
  "./users",
  "./events",
  "./campaigns",
  "./campaign-detail",
  "./user-detail",
  "./mount",
  "./agent-runs",
]);
const actualExports = Object.keys(packageJson.exports ?? {});
for (const name of actualExports) {
  if (!expectedExports.has(name)) failures.push("unexpected dashboard export " + name);
}
for (const name of expectedExports) {
  if (!actualExports.includes(name)) failures.push("missing dashboard export " + name);
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

const checkedSources = sourceFiles(sourceRoot).filter((path) => (
  [".css", ".ts", ".tsx"].includes(extname(path)) && !/\.test\.[^.]+$/.test(path)
));
for (const path of checkedSources) {
  const name = relative(root, path);
  const contents = readFileSync(path, "utf8");
  if (extname(path) === ".css") failures.push(...dashboardTokenFailures(contents));
  else failures.push(...dashboardBoundaryFailures(name, contents, contents.startsWith('"use client"')));
}

if (process.argv.includes("--built")) {
  for (const path of checkedSources) {
    if (!/\.(?:ts|tsx)$/.test(path)) continue;
    const sourceRelative = relative(sourceRoot, path);
    const js = resolve(packageRoot, "dist", sourceRelative.replace(/\.tsx?$/, ".js"));
    const declaration = resolve(packageRoot, "dist", sourceRelative.replace(/\.tsx?$/, ".d.ts"));
    if (!existsSync(js)) failures.push(relative(root, js) + " is missing");
    if (!existsSync(declaration)) failures.push(relative(root, declaration) + " is missing");
    const source = readFileSync(path, "utf8");
    if (source.startsWith('"use client"') && existsSync(js) && !readFileSync(js, "utf8").startsWith('"use client"')) {
      failures.push(relative(root, js) + " is missing its client directive");
    }
  }
  const builtTokens = resolve(packageRoot, "dist/tokens.css");
  if (!existsSync(builtTokens)) failures.push("packages/dashboard/dist/tokens.css is missing");
  else if (!readFileSync(builtTokens).equals(readFileSync(resolve(sourceRoot, "tokens.css")))) {
    failures.push("built dashboard tokens differ from source");
  }
}

if (failures.length > 0) {
  failures.forEach((failure) => process.stderr.write(failure + "\n"));
  process.exit(1);
}

process.stdout.write("VERIFIED dashboard package boundary, exports, tokens, and built output\n");
