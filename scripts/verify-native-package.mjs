import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const directory = join(root, "packages/react-native");
const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
const external = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)]);
const visited = new Set();
function check(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isIdentifier(node)) assert(!["process", "Buffer", "require", "__dirname", "__filename"].includes(node.text), `${file} contains Node global ${node.text}`);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier.text;
      assert(!specifier.startsWith("node:") && !builtinModules.includes(specifier), `${file} imports Node`);
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        assert(target.startsWith(join(directory, "dist") + "/"), `${file} escapes client package`);
        check(target);
      } else {
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        assert(external.has(name), `${file} imports undeclared ${name}`);
        assert(!["@galinum/core", "@galinum/server", "@galinum/dashboard"].includes(name), `${file} imports server graph`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) assert.fail(`${file} contains unchecked dynamic import`);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const entry of Object.values(manifest.exports)) check(resolve(directory, entry.default));
for (const file of readdirSync(join(directory, "dist"))) if (file.endsWith(".d.ts")) {
  const content = readFileSync(join(directory, "dist", file), "utf8");
  assert(!/node:|NodeJS\.|@galinum\/(server|core|dashboard)/.test(content), `${file} leaks server types`);
}
const scratch = mkdtempSync(join(root, "node_modules/.native-package-"));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
try {
  run("pnpm", ["pack", "--pack-destination", scratch]);
  const tarball = join(scratch, readdirSync(scratch).find(name => name.endsWith(".tgz")));
  const files = run("tar", ["-tzf", tarball]).trim().split("\n");
  for (const file of files) assert(/^package\/(dist\/(?:specs\/)?[^/]+\.(js|d\.ts)|src\/specs\/[^/]+\.ts|android\/build\.gradle|android\/src\/(main|expo|bare)\/.+\.(java|xml)|ios\/[^/]+\.(h|mm)|ios\/INTEGRATION\.md|ios-receipts\/[^/]+\.swift|Galinum(Journal|ReceiptStore)\.podspec|app\.plugin\.js|react-native\.config\.cjs|package\.json|README\.md|LICENSE)$/.test(file), `Unexpected packed ${file}`);
  for (const file of ["app.plugin.js", "android/src/expo/java/com/galinum/journal/GalinumExpoMessagingService.java", "android/src/bare/java/com/galinum/journal/GalinumFirebaseReceiver.java"]) assert(files.includes("package/" + file), `Missing packed ${file}`);
  for (const file of ["GalinumReceiptStore.podspec", "ios-receipts/GalinumReceiptStore.swift", "ios/GalinumNotifications.mm"]) assert(files.includes("package/" + file), `Missing iOS carrier ${file}`);
  const packed = JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"]));
  const contracts = JSON.parse(readFileSync(join(root, "packages/contracts/package.json"), "utf8"));
  assert.equal(packed.dependencies["@galinum/contracts"], contracts.version);
  assert.deepEqual(Object.keys(packed.exports), [".", "./expo", "./bare"]);
  for (const entry of Object.values(packed.exports)) {
    assert(files.includes("package/" + entry.default.slice(2)));
    assert(files.includes("package/" + entry.types.slice(2)));
  }
  process.stdout.write(`VERIFIED native client graph (${visited.size} modules), declarations and packed exports (${files.length} files)\n`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
