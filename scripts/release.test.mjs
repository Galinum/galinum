import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  buildOutputFailures,
  buildReleaseManifest,
  dependencyRangeFailure,
  intraReleaseEdges,
  orderReleasePackages,
  outputDirectoryEntryFailures,
  outputEntryTypeFailures,
  outputPathFailures,
  packedManifestFailures,
  releaseManifestFailures,
  resolveReleaseVersion,
  serializeReleaseManifest,
  tarballFilename,
  unexpectedPackageFailures,
  validateRegistry,
} from "./release-lib.mjs";
import { archiveTree, copyWorktree } from "./release-packages.mjs";

const root = resolve(import.meta.dirname, "..");
const registry = JSON.parse(readFileSync(resolve(root, "release/packages.json"), "utf8"));
const corePackage = JSON.parse(readFileSync(resolve(root, "packages/core/package.json"), "utf8"));
const dashboardPackage = JSON.parse(readFileSync(resolve(root, "packages/dashboard/package.json"), "utf8"));
const reactPackage = JSON.parse(readFileSync(resolve(root, "packages/react/package.json"), "utf8"));
const serverPackage = JSON.parse(readFileSync(resolve(root, "packages/server/package.json"), "utf8"));
const serverCli = readFileSync(resolve(root, "packages/server/src/cli.ts"), "utf8");

describe("release registry", () => {
  it("accepts the committed registry", () => {
    assert.deepEqual(validateRegistry(registry), []);
  });

  it("keeps all product packages private at lockstep 0.16.0", () => {
    assert.deepEqual(registry.packages.map((entry) => entry.name), ["@galinum/core", "@galinum/dashboard", "@galinum/react", "@galinum/server"]);
    for (const manifest of [corePackage, dashboardPackage, reactPackage, serverPackage]) {
      assert.equal(manifest.version, "0.16.0", manifest.name);
      assert.equal(manifest.private, true, manifest.name);
      assert.equal(manifest.license, "Apache-2.0", manifest.name);
      assert.equal(manifest.publishConfig, undefined, manifest.name);
    }
  });

  it("keeps the React SDK peer contract and packed license", () => {
    assert.deepEqual(reactPackage.peerDependencies, { react: ">=18", "react-dom": ">=18" });
    assert.equal(reactPackage.engines.node, ">=20");
    assert.ok(reactPackage.files.includes("LICENSE"));
    assert.deepEqual(packedManifestFailures(reactPackage, {
      name: "@galinum/react",
      version: "0.16.0",
      license: "Apache-2.0",
      releaseNames: ["@galinum/core", "@galinum/dashboard", "@galinum/react", "@galinum/server"],
      requires: [],
    }), []);
  });

  it("keeps the server binary executable after packing", () => {
    assert.equal(serverCli.startsWith("#!/usr/bin/env node\n"), true);
    assert.equal(serverCli.includes('process.argv[2] === "--help"'), true);
    assert.equal(
      readFileSync(resolve(root, "scripts/release-packages.mjs"), "utf8").includes(
        "pnpm: { overrides: dependencies }",
      ),
      true,
    );
  });

  it("rejects duplicate and unsafe registry entries", () => {
    const failures = validateRegistry({
      schemaVersion: 1,
      packages: [
        { name: "@galinum/core", path: "packages/core" },
        { name: "@galinum/core", path: "../outside" },
      ],
    });
    assert.equal(failures.length, 2);
    assert.match(failures.join(), /duplicate registry package name/);
    assert.match(failures.join(), /invalid registry package path/);
  });
});

describe("release version agreement", () => {
  it("rejects 0.0.0", () => {
    const { failures } = resolveReleaseVersion([{ name: "@galinum/core", version: "0.0.0" }]);
    assert.match(failures.join(), /must not be released at 0\.0\.0/);
  });

  it("rejects disagreeing versions", () => {
    const { version, failures } = resolveReleaseVersion([
      { name: "@galinum/core", version: "0.15.0" },
      { name: "@galinum/server", version: "0.2.1" },
    ]);
    assert.equal(version, null);
    assert.match(failures.join(), /disagree on version/);
  });

  it("accepts one exact lockstep version", () => {
    const { version, failures } = resolveReleaseVersion([
      { name: "@galinum/core", version: "0.15.0" },
      { name: "@galinum/dashboard", version: "0.15.0" },
      { name: "@galinum/server", version: "0.15.0" },
    ]);
    assert.equal(version, "0.15.0");
    assert.deepEqual(failures, []);
  });
});

describe("dependency ranges", () => {
  it("rejects ranges and non-registry references", () => {
    for (const range of ["^0.1.0", "~0.1.0", ">=0.1.0", "0.1.x", "*", "latest"]) {
      for (const field of ["dependencies", "optionalDependencies"]) {
        assert.match(dependencyRangeFailure(range, field), /is not an exact version/, field + " " + range);
      }
    }
    const references = {
      "workspace:*": /workspace reference/,
      "file:../core": /file reference/,
      "link:../core": /link reference/,
      "git+https://example.com/core.git": /Git reference/,
      "github:Galinum/core": /Git reference/,
      "https://example.com/core.tgz": /HTTP reference/,
    };
    for (const [range, pattern] of Object.entries(references)) assert.match(dependencyRangeFailure(range, "dependencies"), pattern, range);
    assert.equal(dependencyRangeFailure("0.1.0", "dependencies"), null);
  });

  it("accepts semver ranges only in peerDependencies", () => {
    for (const range of [">=18", "^19.2.3", "~19.2", "18 || 19", ">=18.0.0 <20.0.0", "19.x", "*", "19.2.3", "19.2.3-rc.1"]) {
      assert.equal(dependencyRangeFailure(range, "peerDependencies"), null, range);
    }
    for (const range of ["latest", ">=", "^^19", "19..2", "19.2.3 -", "not a range", "", "   ", "next", "19.2.3.4", "1.x.3"]) {
      assert.match(dependencyRangeFailure(range, "peerDependencies"), /is not a valid semver range|is not a version string/, range);
    }
    for (const [range, pattern] of Object.entries({
      "workspace:*": /workspace reference/,
      "file:../core": /file reference/,
      "link:../core": /link reference/,
      "portal:../core": /link reference/,
      "git+https://example.com/react.git": /Git reference/,
      "git://example.com/react.git": /Git reference/,
      "github:facebook/react": /Git reference/,
      "http://example.com/react.tgz": /HTTP reference/,
      "https://example.com/react.tgz": /HTTP reference/,
    })) {
      assert.match(dependencyRangeFailure(range, "peerDependencies"), pattern, range);
    }
  });
});

describe("build order", () => {
  it("builds core before server", () => {
    const releaseNames = ["@galinum/core", "@galinum/dashboard", "@galinum/react", "@galinum/server"];
    const edges = intraReleaseEdges([corePackage, dashboardPackage, reactPackage, serverPackage], releaseNames);
    assert.deepEqual(edges.get("@galinum/server"), ["@galinum/core"]);
    assert.deepEqual(edges.get("@galinum/react"), []);
    assert.deepEqual(orderReleasePackages(edges), ["@galinum/core", "@galinum/react", "@galinum/dashboard", "@galinum/server"]);
  });

  it("rejects a dependency cycle", () => {
    const edges = new Map([["a", ["b"]], ["b", ["a"]]]);
    assert.throws(() => orderReleasePackages(edges), /dependency cycle/);
  });
});

describe("build output", () => {
  it("requires every declared entry point", () => {
    const failures = buildOutputFailures(serverPackage, (target) => target !== "dist/cli.js");
    assert.match(failures.join(), /missing build output dist\/cli\.js/);
    assert.deepEqual(buildOutputFailures(serverPackage, () => true), []);
  });
});

describe("source archive", () => {
  it("copies the recorded tree without ignored worktree residue", () => {
    const repository = mkdtempSync(resolve(tmpdir(), "galinum-release-fixture-"));
    const checkout = mkdtempSync(resolve(tmpdir(), "galinum-release-archive-"));
    try {
      const git = (...args) => {
        const result = spawnSync("git", args, {
          cwd: repository,
          encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
      };
      git("init", "--quiet");
      git("config", "user.name", "Release fixture");
      git("config", "user.email", "release@example.invalid");
      writeFileSync(resolve(repository, ".gitignore"), "dist/\n");
      writeFileSync(resolve(repository, "tracked.txt"), "tracked\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "fixture");
      mkdirSync(resolve(repository, "dist"));
      writeFileSync(resolve(repository, "dist/stale.js"), "stale\n");

      archiveTree(repository, "HEAD^{tree}", checkout);

      assert.equal(readFileSync(resolve(checkout, "tracked.txt"), "utf8"), "tracked\n");
      assert.equal(existsSync(resolve(checkout, "dist/stale.js")), false);
      assert.equal(readFileSync(resolve(repository, "dist/stale.js"), "utf8"), "stale\n");
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("copies current source while excluding ignored output", () => {
    const repository = mkdtempSync(resolve(tmpdir(), "galinum-release-worktree-"));
    const checkout = mkdtempSync(resolve(tmpdir(), "galinum-release-current-"));
    try {
      const git = (...args) => {
        const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      };
      git("init", "--quiet");
      git("config", "user.name", "Release fixture");
      git("config", "user.email", "release@example.invalid");
      writeFileSync(resolve(repository, ".gitignore"), "dist/\n");
      writeFileSync(resolve(repository, "tracked.txt"), "old\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "fixture");
      writeFileSync(resolve(repository, "tracked.txt"), "current\n");
      writeFileSync(resolve(repository, "new.txt"), "new\n");
      mkdirSync(resolve(repository, "dist"));
      writeFileSync(resolve(repository, "dist/stale.js"), "stale\n");

      copyWorktree(repository, checkout);

      assert.equal(readFileSync(resolve(checkout, "tracked.txt"), "utf8"), "current\n");
      assert.equal(readFileSync(resolve(checkout, "new.txt"), "utf8"), "new\n");
      assert.equal(existsSync(resolve(checkout, "dist/stale.js")), false);
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});

describe("unexpected packages", () => {
  it("rejects an undeclared workspace package and a missing declared one", () => {
    const failures = unexpectedPackageFailures(
      ["packages/core", "packages/dashboard", "packages/server", "packages/gone"],
      ["packages/core", "packages/server", "packages/dashboard"],
    );
    assert.deepEqual(failures, [
      "packages/gone is listed in the registry but missing from the workspace",
    ]);
  });
});

describe("packed manifests", () => {
  const expected = {
    name: "@galinum/server",
    version: "0.15.0",
    license: "Apache-2.0",
    releaseNames: ["@galinum/core", "@galinum/dashboard", "@galinum/server"],
    requires: ["@galinum/core"],
  };

  it("accepts an exact intra-release dependency", () => {
    const failures = packedManifestFailures({
      name: "@galinum/server",
      version: "0.15.0",
      private: true,
      license: "Apache-2.0",
      dependencies: { "@galinum/core": "0.15.0", pg: "8.23.0" },
    }, expected);
    assert.deepEqual(failures, []);
  });

  it("accepts a host-provided peer range", () => {
    const failures = packedManifestFailures({
      name: "@galinum/server",
      version: "0.15.0",
      private: true,
      license: "Apache-2.0",
      dependencies: { "@galinum/core": "0.15.0" },
      peerDependencies: { react: ">=18", "react-dom": "19.2.3" },
    }, expected);
    assert.deepEqual(failures, []);
  });

  it("rejects an unparsable peer range and a drifted release-owned peer", () => {
    const failures = packedManifestFailures({
      name: "@galinum/server",
      version: "0.15.0",
      private: true,
      license: "Apache-2.0",
      dependencies: { "@galinum/core": "0.15.0" },
      peerDependencies: { react: "latest", "@galinum/dashboard": "^0.15.0" },
    }, expected);
    assert.match(failures.join(), /peerDependencies react is not a valid semver range/);
    assert.match(failures.join(), /must depend on @galinum\/dashboard at 0\.15\.0/);
  });

  it("rejects an unresolved workspace protocol", () => {
    const failures = packedManifestFailures({
      name: "@galinum/server",
      version: "0.15.0",
      private: true,
      license: "Apache-2.0",
      dependencies: { "@galinum/core": "workspace:*" },
    }, expected);
    assert.match(failures.join(), /workspace reference/);
  });

  it("rejects a drifted intra-release version", () => {
    const failures = packedManifestFailures({
      name: "@galinum/server",
      version: "0.15.0",
      private: true,
      license: "Apache-2.0",
      dependencies: { "@galinum/core": "0.1.0" },
    }, expected);
    assert.match(failures.join(), /must depend on @galinum\/core at 0\.15\.0/);
  });

  it("rejects a dropped intra-release dependency and a lost private flag", () => {
    const failures = packedManifestFailures({ name: "@galinum/server", version: "0.15.0" }, expected);
    assert.match(failures.join(), /must stay private/);
    assert.match(failures.join(), /lost its release dependency on @galinum\/core/);
  });
});

describe("output paths", () => {
  it("rejects an implicit or unsafe destination", () => {
    const packages = ["packages/core", "packages/dashboard", "packages/server"];
    assert.match(outputPathFailures(root, null, null, packages).join(), /explicit --output directory is required/);
    assert.match(outputPathFailures(root, ".", root, packages).join(), /must not be the repository root/);
    assert.match(outputPathFailures(root, "..", resolve(root, ".."), packages).join(), /must not contain the repository/);
    assert.match(outputPathFailures(root, ".git/out", resolve(root, ".git/out"), packages).join(), /must not be inside \.git/);
    assert.match(outputPathFailures(root, "packages/core/out", resolve(root, "packages/core/out"), packages).join(), /must not be inside the release package packages\/core/);
    assert.deepEqual(outputPathFailures(root, "/tmp/release", "/tmp/release", packages), []);
  });

  it("rejects unrelated files already in the destination", () => {
    const allowed = ["release-manifest.json", "galinum-core-0.15.0.tgz"];
    assert.deepEqual(outputDirectoryEntryFailures(allowed, allowed), []);
    assert.match(outputDirectoryEntryFailures(["notes.txt"], allowed).join(), /unrelated file notes\.txt/);
  });

  it("rejects symlinked or non-file output entries", () => {
    const entry = (name, kind) => ({
      name,
      isSymbolicLink: () => kind === "symlink",
      isFile: () => kind === "file",
    });
    assert.deepEqual(
      outputEntryTypeFailures(
        [
          entry("release-manifest.json", "symlink"),
          entry("galinum-core-0.15.0.tgz", "directory"),
          entry("unrelated", "symlink"),
        ],
        ["release-manifest.json", "galinum-core-0.15.0.tgz"],
      ),
      [
        "output entry must not be a symbolic link release-manifest.json",
        "output entry must be a file galinum-core-0.15.0.tgz",
      ],
    );
  });
});

describe("release manifest", () => {
  const release = {
    version: "0.15.0",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    openapiPath: "apps/docs/openapi.json",
    openapiSha256: "c".repeat(64),
    skill: {
      path: "apps/docs/skill/galinum",
      files: [
        {
          path: "references/api.md",
          filename: "galinum-skill-api-0.15.0.md",
          sha256: "1".repeat(64),
        },
        {
          path: "SKILL.md",
          filename: "galinum-skill-0.15.0.md",
          sha256: "2".repeat(64),
        },
      ],
    },
    packages: [
      { name: "@galinum/server", filename: "galinum-server-0.15.0.tgz", sha256: "d".repeat(64) },
      { name: "@galinum/dashboard", filename: "galinum-dashboard-0.15.0.tgz", sha256: "e".repeat(64) },
      { name: "@galinum/core", filename: "galinum-core-0.15.0.tgz", sha256: "f".repeat(64) },
    ],
  };

  it("orders packages and serializes deterministically", () => {
    const first = buildReleaseManifest(release);
    const second = buildReleaseManifest({ ...release, packages: [...release.packages].reverse() });
    assert.equal(serializeReleaseManifest(first), serializeReleaseManifest(second));
    assert.deepEqual(first.packages.map((entry) => entry.name), ["@galinum/core", "@galinum/dashboard", "@galinum/server"]);
    assert.equal(first.skill.version, "0.15.0");
    assert.deepEqual(
      first.skill.files.map((entry) => entry.path),
      ["SKILL.md", "references/api.md"],
    );
    assert.equal(serializeReleaseManifest(first).endsWith("\n"), true);
  });

  it("accepts its own output and rejects a tampered digest", () => {
    const manifest = buildReleaseManifest(release);
    assert.deepEqual(releaseManifestFailures(manifest), []);
    const tampered = { ...manifest, packages: [{ ...manifest.packages[0], sha256: "short" }, manifest.packages[1]] };
    assert.match(releaseManifestFailures(tampered).join(), /manifest digest is invalid/);
    const tamperedSkill = {
      ...manifest,
      skill: {
        ...manifest.skill,
        files: [{ ...manifest.skill.files[0], sha256: "0".repeat(64) }, manifest.skill.files[1]],
      },
    };
    assert.match(releaseManifestFailures(tamperedSkill).join(), /skill digest differs from its files/);
  });

  it("derives npm tarball filenames", () => {
    assert.equal(tarballFilename("@galinum/core", "0.15.0"), "galinum-core-0.15.0.tgz");
  });
});
