import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];
const ignored = new Set([".git", ".mintlify", ".next", "coverage", "dist", "node_modules"]);
const textExtensions = new Set(["", ".css", ".js", ".json", ".md", ".mdx", ".mjs", ".mts", ".ts", ".tsx", ".yaml", ".yml"]);

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else files.push(file);
  }
  return files;
}

const files = walk(root);
const lockfiles = files.filter((file) => ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"].includes(file.split("/").at(-1)));
if (lockfiles.length !== 1 || lockfiles[0] !== join(root, "pnpm-lock.yaml")) failures.push("workspace must have one root pnpm-lock.yaml");
if (files.some((file) => file.endsWith("pnpm-workspace.yaml") && file !== join(root, "pnpm-workspace.yaml"))) failures.push("nested pnpm workspaces are not allowed");
if (!existsSync(join(root, "LICENSE"))) failures.push("root Apache-2.0 license is missing");
if (existsSync(join(root, "LICENSE.md"))) failures.push("LICENSE.md duplicates the root LICENSE");

const workspacePackages = [
  { path: "apps/docs", name: "@galinum/docs" },
  { path: "packages/core", name: "@galinum/core", release: true, node: "24.x" },
  { path: "packages/dashboard", name: "@galinum/dashboard", release: true, node: "24.x", packedLicense: "LICENSES" },
  { path: "packages/react", name: "@galinum/react", release: true, node: ">=20", packedLicense: "LICENSE" },
  { path: "packages/server", name: "@galinum/server", release: true, node: "24.x" },
];

const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifests = new Map();
for (const entry of workspacePackages) {
  const manifest = JSON.parse(readFileSync(join(root, entry.path, "package.json"), "utf8"));
  manifests.set(entry.name, manifest);
  if (manifest.name !== entry.name || manifest.private !== true) {
    failures.push(entry.path + " must be the private " + entry.name + " workspace package");
  }
  if (entry.node && manifest.engines?.node !== entry.node) failures.push(entry.name + " Node engine is invalid");
  if (entry.release) {
    if (manifest.bugs?.url !== "https://github.com/Galinum/galinum/issues") {
      failures.push(entry.name + " issue URL is invalid");
    }
    if (manifest.publishConfig !== undefined) failures.push(entry.name + " must not declare publishConfig");
    if (manifest.packageManager !== undefined) failures.push(entry.name + " must not declare a nested packageManager");
  }
  if (entry.packedLicense) {
    if (!existsSync(join(root, entry.path, entry.packedLicense))) failures.push(entry.name + " is missing " + entry.packedLicense);
    if (!(manifest.files ?? []).includes(entry.packedLicense)) failures.push(entry.name + " must pack " + entry.packedLicense);
  }
}
for (const manifest of [rootPackage, ...manifests.values()]) {
  if (manifest.license !== "Apache-2.0") failures.push(manifest.name + " must declare license Apache-2.0");
  if (typeof manifest.description !== "string" || manifest.description.length === 0) {
    failures.push(manifest.name + " must declare a description");
  }
  if (manifest.homepage !== "https://docs.galinum.com") failures.push(manifest.name + " homepage is invalid");
  if (manifest.repository?.url !== "git+https://github.com/Galinum/galinum.git") {
    failures.push(manifest.name + " repository URL is invalid");
  }
}

const corePackage = manifests.get("@galinum/core");
const reactPackage = manifests.get("@galinum/react");
const serverPackage = manifests.get("@galinum/server");

if (reactPackage.version !== undefined) {
  const version = readFileSync(join(root, "packages/react/src/version.ts"), "utf8");
  const declared = /SDK_VERSION\s*=\s*"([^"]+)"/.exec(version)?.[1] ?? null;
  if (declared !== reactPackage.version) {
    failures.push("@galinum/react SDK_VERSION " + JSON.stringify(declared) + " differs from package version " + JSON.stringify(reactPackage.version));
  }
}

const productCategory = "self-driving product communications";
const categorySurfaces = [
  { file: "package.json", contents: JSON.stringify(rootPackage.description) },
  { file: "README.md", contents: readFileSync(join(root, "README.md"), "utf8") },
  { file: "apps/docs/index.mdx", contents: readFileSync(join(root, "apps/docs/index.mdx"), "utf8") },
  { file: "apps/docs/mcp/instructions.md", contents: readFileSync(join(root, "apps/docs/mcp/instructions.md"), "utf8") },
  { file: "apps/docs/skill/galinum/SKILL.md", contents: readFileSync(join(root, "apps/docs/skill/galinum/SKILL.md"), "utf8") },
];
for (const surface of categorySurfaces) {
  if (!surface.contents.toLowerCase().includes(productCategory)) failures.push(`${surface.file} must state the product category`);
}

const requiredLegalFiles = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "licenses/shadcn-ui-MIT.txt", "licenses/mintlify-starter-MIT.txt"];
for (const name of requiredLegalFiles) {
  if (!existsSync(join(root, name))) failures.push(`${name} is missing`);
}
const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
for (const name of ["licenses/shadcn-ui-MIT.txt", "licenses/mintlify-starter-MIT.txt"]) {
  if (!notices.includes(name)) failures.push(`THIRD_PARTY_NOTICES.md must link ${name}`);
}

function declaredPackages(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

const packageImportRules = [
  { path: "packages/core/", dependencies: declaredPackages(corePackage) },
  { path: "packages/react/", dependencies: declaredPackages(reactPackage) },
  { path: "packages/server/", dependencies: declaredPackages(serverPackage) },
];
function packageName(specifier) {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

for (const file of files.filter((candidate) => textExtensions.has(extname(candidate)))) {
  const contents = readFileSync(file, "utf8");
  const name = relative(root, file);
  if (/[/\\]Users[/\\][^/\\]+/.test(contents) || /[A-Za-z]:\\Users\\[^\\]+/.test(contents)) failures.push(`${name} contains a user-specific path`);
  if (name.startsWith("packages/core/") && /process\.env/.test(contents)) failures.push(`${name} must stay runtime-independent`);
  const rule = packageImportRules.find(({ path }) => name.startsWith(path));
  if (rule && /\.(?:js|mjs|mts|ts|tsx)$/.test(name)) {
    const specifiers = [
      ...contents.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g),
      ...contents.matchAll(/\bimport\(["']([^"']+)["']\)/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      const importedPackage = packageName(specifier);
      if (importedPackage && importedPackage !== "vitest" && !rule.dependencies.has(importedPackage)) {
        failures.push(`${name} imports undeclared package ${importedPackage}`);
      }
    }
  }
}

if (failures.length) {
  failures.forEach((failure) => process.stderr.write(`${failure}\n`));
  process.exit(1);
}

process.stdout.write("VERIFIED one pnpm workspace with product metadata and legal files\n");
