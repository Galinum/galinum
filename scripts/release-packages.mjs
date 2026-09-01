import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  buildOutputFailures,
  buildReleaseManifest,
  intraReleaseEdges,
  manifestFilename,
  orderReleasePackages,
  outputDirectoryEntryFailures,
  outputEntryTypeFailures,
  outputPathFailures,
  packedManifestFailures,
  releaseManifestFailures,
  resolveReleaseVersion,
  serializeReleaseManifest,
  sha256,
  skillArtifactFilename,
  skillSourceFiles,
  skillSourcePath,
  tarballFilename,
  unexpectedPackageFailures,
  validateRegistry,
} from "./release-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const openapiPath = "apps/docs/openapi.json";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      command +
        " " +
        args.join(" ") +
        " failed\n" +
        (result.stdout ?? "") +
        (result.stderr ?? ""),
    );
  }
  return result;
}

function argument(name) {
  const flag = "--" + name;
  const index = process.argv.indexOf(flag);
  if (index !== -1) return process.argv[index + 1] ?? null;
  const inline = process.argv.find((value) => value.startsWith(flag + "="));
  return inline ? inline.slice(flag.length + 1) : null;
}

function fail(failures) {
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function workspacePackagePaths(sourceRoot) {
  const directory = resolve(sourceRoot, "packages");
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(directory, entry.name, "package.json")),
    )
    .map((entry) => "packages/" + entry.name)
    .sort();
}

function packedManifest(tarball) {
  return JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"]).stdout);
}

function canonicalOutputPath(outputDirectory) {
  let existing = outputDirectory;
  while (!existsSync(existing)) existing = dirname(existing);
  return resolve(realpathSync(existing), relative(existing, outputDirectory));
}

function packOnce(sourceRoot, packagePath, filename) {
  const scratch = mkdtempSync(join(tmpdir(), "galinum-release-pack-"));
  try {
    run("pnpm", ["pack", "--pack-destination", scratch], {
      cwd: resolve(sourceRoot, packagePath),
    });
    const produced = readdirSync(scratch);
    if (produced.length !== 1) {
      throw new Error(
        packagePath + " produced " + produced.length + " tarballs",
      );
    }
    if (produced[0] !== filename) {
      throw new Error(
        packagePath + " produced " + produced[0] + " instead of " + filename,
      );
    }
    const bytes = readFileSync(join(scratch, produced[0]));
    return { bytes, sha256: sha256(bytes) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function archiveTree(repositoryRoot, ref, destination) {
  mkdirSync(destination, { recursive: true });
  const archive = join(destination, ".source.tar");
  run("git", ["archive", "--format=tar", "--output", archive, ref], {
    cwd: repositoryRoot,
  });
  run("tar", ["-xf", archive, "-C", destination]);
  rmSync(archive, { force: true });
}

export function copyWorktree(repositoryRoot, destination) {
  mkdirSync(destination, { recursive: true });
  const listed = run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: null },
  ).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const name of listed) {
    const source = resolve(repositoryRoot, name);
    if (!existsSync(source)) continue;
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("release source must be a regular file " + name);
    }
    const target = resolve(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function inspectPackedArtifacts(packed, release) {
  const failures = [];
  for (const artifact of packed) {
    const inspection = mkdtempSync(join(tmpdir(), "galinum-release-read-"));
    try {
      const tarball = join(inspection, artifact.filename);
      writeFileSync(tarball, artifact.bytes);
      failures.push(
        ...packedManifestFailures(packedManifest(tarball), {
          name: artifact.name,
          version: release.version,
          license: release.license,
          releaseNames: release.names,
          requires: release.edges.get(artifact.name) ?? [],
        }),
      );
    } finally {
      rmSync(inspection, { recursive: true, force: true });
    }
  }
  return failures;
}

function smokeInstalledCli(packed) {
  const scratch = mkdtempSync(join(tmpdir(), "galinum-release-install-"));
  try {
    const dependencies = {};
    for (const artifact of packed) {
      const tarball = join(scratch, artifact.filename);
      writeFileSync(tarball, artifact.bytes);
      dependencies[artifact.name] = "file:" + tarball;
    }
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify(
        { private: true, dependencies, pnpm: { overrides: dependencies } },
        null,
        2,
      ) + "\n",
    );
    run("pnpm", ["install", "--ignore-scripts", "--prefer-offline"], {
      cwd: scratch,
    });
    const executable = join(
      scratch,
      "node_modules",
      ".bin",
      "galinum-server",
    );
    const result = spawnSync(executable, ["--help"], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH },
    });
    if (result.status !== 0 || result.stdout !== "Usage: galinum-server\n") {
      throw new Error(
        "installed galinum-server failed its CLI smoke\n" +
          (result.stdout ?? "") +
          (result.stderr ?? ""),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const outputArgument = checkOnly ? null : argument("output");
  const outputDirectory = outputArgument
    ? resolve(process.cwd(), outputArgument)
    : null;
  const failures = [];

  if (!checkOnly) {
    const status = run("git", ["status", "--porcelain"]).stdout.trim();
    if (status) fail(["release packing requires a clean worktree\n" + status]);
    if (
      outputDirectory &&
      existsSync(outputDirectory) &&
      lstatSync(outputDirectory).isSymbolicLink()
    ) {
      failures.push("output directory must not be a symbolic link");
    }
  }

  const commit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const tree = run("git", ["rev-parse", "HEAD^{tree}"]).stdout.trim();
  const sourceRoot = mkdtempSync(join(tmpdir(), "galinum-release-tree-"));

  try {
    if (checkOnly) copyWorktree(root, sourceRoot);
    else archiveTree(root, tree, sourceRoot);
    run(
      "pnpm",
      ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
      { cwd: sourceRoot },
    );

    const registry = readJson(resolve(sourceRoot, "release/packages.json"));
    failures.push(...validateRegistry(registry));
    fail(failures);

    if (!checkOnly) {
      const canonicalOutput = outputDirectory
        ? canonicalOutputPath(outputDirectory)
        : null;
      failures.push(
        ...outputPathFailures(
          realpathSync(root),
          outputArgument,
          canonicalOutput,
          registry.packages.map((entry) => entry.path),
        ),
      );
      fail(failures);
    }

    const entries = registry.packages.map((entry) => ({
      ...entry,
      manifest: readJson(resolve(sourceRoot, entry.path, "package.json")),
    }));
    for (const entry of entries) {
      if (entry.manifest.name !== entry.name) {
        failures.push(
          entry.path +
            " declares " +
            entry.manifest.name +
            " instead of " +
            entry.name,
        );
      }
      if (entry.manifest.private !== true) {
        failures.push(entry.name + " must stay private");
      }
      if (entry.manifest.license !== "Apache-2.0") {
        failures.push(entry.name + " must declare license Apache-2.0");
      }
    }
    failures.push(
      ...unexpectedPackageFailures(
        registry.packages.map((entry) => entry.path),
        workspacePackagePaths(sourceRoot),
      ),
    );

    const manifests = entries.map((entry) => entry.manifest);
    const resolvedVersion = resolveReleaseVersion(
      manifests.map((manifest) => ({
        name: manifest.name,
        version: manifest.version,
      })),
    );
    failures.push(...resolvedVersion.failures);
    fail(failures);

    const releaseNames = manifests.map((manifest) => manifest.name);
    const edges = intraReleaseEdges(manifests, releaseNames);
    const order = orderReleasePackages(edges);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const skillFiles = skillSourceFiles.map((entry) => {
      const source = resolve(sourceRoot, skillSourcePath, entry.path);
      if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) {
        throw new Error("skill release source must be a regular file " + entry.path);
      }
      const bytes = readFileSync(source);
      return {
        path: entry.path,
        filename: skillArtifactFilename(entry.stem, resolvedVersion.version),
        bytes,
        sha256: sha256(bytes),
      };
    });

    for (const name of order) {
      run("pnpm", ["--filter", name, "build"], { cwd: sourceRoot });
    }
    for (const name of order) {
      const entry = byName.get(name);
      failures.push(
        ...buildOutputFailures(entry.manifest, (target) =>
          existsSync(resolve(sourceRoot, entry.path, target)),
        ),
      );
    }
    fail(failures);

    const packed = [];
    for (const name of order) {
      const entry = byName.get(name);
      const filename = tarballFilename(name, resolvedVersion.version);
      const first = packOnce(sourceRoot, entry.path, filename);
      const second = packOnce(sourceRoot, entry.path, filename);
      if (first.sha256 !== second.sha256) {
        failures.push(
          name +
            " packed non-deterministically: " +
            first.sha256 +
            " then " +
            second.sha256,
        );
      }
      packed.push({
        name,
        filename,
        bytes: first.bytes,
        sha256: first.sha256,
      });
    }
    fail(failures);
    failures.push(
      ...inspectPackedArtifacts(packed, {
        version: resolvedVersion.version,
        license: "Apache-2.0",
        names: releaseNames,
        edges,
      }),
    );
    fail(failures);
    smokeInstalledCli(packed);

    if (checkOnly) {
      process.stdout.write(
        "VERIFIED " +
          packed.length +
          " reproducible release packages and " +
          skillFiles.length +
          " skill files at " +
          resolvedVersion.version +
          "\n",
      );
      return;
    }

    const manifest = buildReleaseManifest({
      version: resolvedVersion.version,
      commit,
      tree,
      openapiPath,
      openapiSha256: sha256(
        readFileSync(resolve(sourceRoot, openapiPath)),
      ),
      skill: { path: skillSourcePath, files: skillFiles },
      packages: packed,
    });
    failures.push(...releaseManifestFailures(manifest));
    fail(failures);

    mkdirSync(outputDirectory, { recursive: true });
    const allowed = [
      manifestFilename,
      ...packed.map((artifact) => artifact.filename),
      ...skillFiles.map((artifact) => artifact.filename),
    ];
    const outputEntries = readdirSync(outputDirectory, {
      withFileTypes: true,
    });
    failures.push(
      ...outputDirectoryEntryFailures(
        outputEntries.map((entry) => entry.name),
        allowed,
      ),
    );
    failures.push(...outputEntryTypeFailures(outputEntries, allowed));
    fail(failures);

    for (const artifact of packed) {
      writeFileSync(join(outputDirectory, artifact.filename), artifact.bytes);
    }
    for (const artifact of skillFiles) {
      writeFileSync(join(outputDirectory, artifact.filename), artifact.bytes);
    }
    writeFileSync(
      join(outputDirectory, manifestFilename),
      serializeReleaseManifest(manifest),
    );
    process.stdout.write(
      "RELEASED " +
        packed.length +
        " packages at " +
        resolvedVersion.version +
        " into " +
        outputDirectory +
        "\n",
    );
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
