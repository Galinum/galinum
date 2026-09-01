import { createHash } from "node:crypto";
import semver from "semver";

export const releaseSchemaVersion = 2;
export const registrySchemaVersion = 1;
export const manifestFilename = "release-manifest.json";
export const skillSourcePath = "apps/docs/skill/galinum";
export const skillSourceFiles = [
  { path: "SKILL.md", stem: "galinum-skill" },
  { path: "references/api.md", stem: "galinum-skill-api" },
];

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const rejectedReferences = [
  ["workspace:", "workspace reference"],
  ["file:", "file reference"],
  ["link:", "link reference"],
  ["portal:", "link reference"],
  ["git+", "Git reference"],
  ["git:", "Git reference"],
  ["github:", "Git reference"],
  ["http:", "HTTP reference"],
  ["https:", "HTTP reference"],
];
const installedField = { accepts: isExactVersion, failure: "is not an exact version" };
const hostProvidedField = { accepts: isSemverRange, failure: "is not a valid semver range" };
const dependencyFieldRules = new Map([
  ["dependencies", installedField],
  ["optionalDependencies", installedField],
  ["peerDependencies", hostProvidedField],
]);
const dependencyFields = [...dependencyFieldRules.keys()];

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function skillArtifactFilename(stem, version) {
  return stem + "-" + version + ".md";
}

export function skillDigest(files) {
  return sha256(
    JSON.stringify(
      [...files]
        .sort((left, right) => (left.path < right.path ? -1 : 1))
        .map(({ path, sha256 }) => ({ path, sha256 })),
    ),
  );
}

export function isExactVersion(range) {
  return typeof range === "string" && exactVersion.test(range);
}

export function isSemverRange(range) {
  return typeof range === "string" && semver.validRange(range) !== null;
}

export function dependencyRangeFailure(range, field) {
  if (typeof range !== "string" || range.trim() === "") return "is not a version string";
  for (const [prefix, kind] of rejectedReferences) {
    if (range.startsWith(prefix)) return "uses a " + kind;
  }
  const rule = dependencyFieldRules.get(field);
  if (!rule) return "is in an unknown dependency field";
  return rule.accepts(range) ? null : rule.failure;
}

function unsafeRelativePath(value) {
  if (typeof value !== "string" || value === "") return true;
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) return true;
  return value.split("/").includes("..");
}

export function validateRegistry(registry) {
  const failures = [];
  if (registry?.schemaVersion !== registrySchemaVersion) failures.push("registry schemaVersion must be " + registrySchemaVersion);
  const packages = Array.isArray(registry?.packages) ? registry.packages : null;
  if (!packages || packages.length === 0) {
    failures.push("registry must list at least one release package");
    return failures;
  }
  const names = new Set();
  const paths = new Set();
  for (const entry of packages) {
    if (typeof entry?.name !== "string" || !entry.name.startsWith("@galinum/")) failures.push("invalid registry package name " + JSON.stringify(entry?.name ?? null));
    else if (names.has(entry.name)) failures.push("duplicate registry package name " + entry.name);
    else names.add(entry.name);
    if (unsafeRelativePath(entry?.path)) failures.push("invalid registry package path " + JSON.stringify(entry?.path ?? null));
    else if (paths.has(entry.path)) failures.push("duplicate registry package path " + entry.path);
    else paths.add(entry.path);
  }
  return failures;
}

export function unexpectedPackageFailures(registryPaths, workspacePaths) {
  const failures = [];
  const declared = new Set(registryPaths);
  const found = new Set(workspacePaths);
  for (const path of [...found].sort()) if (!declared.has(path)) failures.push(path + " is not a release-owned package in the registry");
  for (const path of [...declared].sort()) if (!found.has(path)) failures.push(path + " is listed in the registry but missing from the workspace");
  return failures;
}

export function resolveReleaseVersion(entries) {
  const failures = [];
  const versions = new Set();
  for (const entry of entries) {
    if (!isExactVersion(entry.version)) failures.push(entry.name + " version " + JSON.stringify(entry.version ?? null) + " is not an exact release version");
    else if (entry.version === "0.0.0") failures.push(entry.name + " must not be released at 0.0.0");
    versions.add(entry.version);
  }
  if (versions.size > 1) failures.push("release packages disagree on version: " + [...versions].sort().join(", "));
  return { version: versions.size === 1 ? [...versions][0] : null, failures };
}

export function intraReleaseEdges(manifests, releaseNames) {
  const owned = new Set(releaseNames);
  const edges = new Map();
  for (const manifest of manifests) {
    const dependencies = new Set();
    for (const field of dependencyFields) {
      for (const name of Object.keys(manifest[field] ?? {})) if (owned.has(name)) dependencies.add(name);
    }
    edges.set(manifest.name, [...dependencies].sort());
  }
  return edges;
}

export function orderReleasePackages(edges) {
  let remaining = [...edges.keys()].sort();
  const ordered = [];
  const done = new Set();
  while (remaining.length) {
    const ready = remaining.filter((name) => (edges.get(name) ?? []).every((dependency) => done.has(dependency)));
    if (!ready.length) throw new Error("release packages form a dependency cycle: " + remaining.join(", "));
    for (const name of ready) {
      ordered.push(name);
      done.add(name);
    }
    remaining = remaining.filter((name) => !done.has(name));
  }
  return ordered;
}

export function buildOutputTargets(manifest) {
  const targets = new Set();
  const collect = (value) => {
    if (typeof value === "string") {
      if (value.startsWith("./")) targets.add(value.slice(2));
      return;
    }
    if (value && typeof value === "object") for (const nested of Object.values(value)) collect(nested);
  };
  for (const field of ["main", "module", "types", "exports", "bin"]) collect(manifest[field]);
  return [...targets].sort();
}

export function buildOutputFailures(manifest, hasFile) {
  return buildOutputTargets(manifest)
    .filter((target) => !hasFile(target))
    .map((target) => manifest.name + " is missing build output " + target);
}

export function packedManifestFailures(packed, expected) {
  const failures = [];
  const name = packed?.name;
  if (name !== expected.name) failures.push("packed manifest declares " + JSON.stringify(name ?? null) + " instead of " + expected.name);
  if (packed?.version !== expected.version) failures.push(expected.name + " packs version " + JSON.stringify(packed?.version ?? null) + " instead of " + expected.version);
  if (packed?.private !== true) failures.push(expected.name + " must stay private");
  if (packed?.license !== expected.license) {
    failures.push(expected.name + " must declare license " + expected.license);
  }
  for (const field of dependencyFields) {
    for (const [dependency, range] of Object.entries(packed?.[field] ?? {})) {
      const failure = dependencyRangeFailure(range, field);
      if (failure) failures.push(expected.name + " " + field + " " + dependency + " " + failure + ": " + JSON.stringify(range ?? null));
      else if (expected.releaseNames.includes(dependency) && range !== expected.version) failures.push(expected.name + " must depend on " + dependency + " at " + expected.version + ", not " + range);
    }
  }
  const packedDependencies = new Set();
  for (const field of dependencyFields) for (const dependency of Object.keys(packed?.[field] ?? {})) packedDependencies.add(dependency);
  for (const dependency of expected.requires) {
    if (!packedDependencies.has(dependency)) failures.push(expected.name + " lost its release dependency on " + dependency);
  }
  return failures;
}

export function tarballFilename(name, version) {
  return name.replace(/^@/, "").replace("/", "-") + "-" + version + ".tgz";
}

function isInside(parent, candidate) {
  return candidate === parent || candidate.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

export function outputPathFailures(root, requested, resolved, packagePaths) {
  const failures = [];
  if (typeof requested !== "string" || requested.trim() === "") return ["an explicit --output directory is required"];
  if (resolved === root) failures.push("output directory must not be the repository root");
  if (isInside(resolved, root)) failures.push("output directory must not contain the repository");
  if (isInside(root + "/.git", resolved)) failures.push("output directory must not be inside .git");
  for (const path of packagePaths) {
    if (isInside(root + "/" + path, resolved)) failures.push("output directory must not be inside the release package " + path);
  }
  return failures;
}

export function outputDirectoryEntryFailures(entries, allowed) {
  const permitted = new Set(allowed);
  return entries
    .filter((entry) => !permitted.has(entry))
    .sort()
    .map((entry) => "output directory holds unrelated file " + entry);
}

export function outputEntryTypeFailures(entries, allowed) {
  const permitted = new Set(allowed);
  const failures = [];
  for (const entry of entries) {
    if (!permitted.has(entry.name)) continue;
    if (entry.isSymbolicLink()) failures.push("output entry must not be a symbolic link " + entry.name);
    else if (!entry.isFile()) failures.push("output entry must be a file " + entry.name);
  }
  return failures;
}

export function buildReleaseManifest(release) {
  return {
    schemaVersion: releaseSchemaVersion,
    version: release.version,
    source: { commit: release.commit, tree: release.tree },
    openapi: { path: release.openapiPath, sha256: release.openapiSha256 },
    skill: {
      path: release.skill.path,
      version: release.version,
      sha256: skillDigest(release.skill.files),
      files: [...release.skill.files]
        .sort((left, right) => (left.path < right.path ? -1 : 1))
        .map(({ path, filename, sha256 }) => ({ path, filename, sha256 })),
    },
    packages: [...release.packages]
      .sort((left, right) => (left.name < right.name ? -1 : 1))
      .map((entry) => ({ name: entry.name, version: release.version, filename: entry.filename, sha256: entry.sha256 })),
  };
}

export function serializeReleaseManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + "\n";
}

export function releaseManifestFailures(manifest) {
  const failures = [];
  if (manifest?.schemaVersion !== releaseSchemaVersion) failures.push("manifest schemaVersion must be " + releaseSchemaVersion);
  if (!isExactVersion(manifest?.version) || manifest.version === "0.0.0") failures.push("manifest version is not a releasable version");
  if (!/^[0-9a-f]{40}$/.test(manifest?.source?.commit ?? "")) failures.push("manifest source commit is invalid");
  if (!/^[0-9a-f]{40}$/.test(manifest?.source?.tree ?? "")) failures.push("manifest source tree is invalid");
  if (!/^[0-9a-f]{64}$/.test(manifest?.openapi?.sha256 ?? "")) failures.push("manifest OpenAPI digest is invalid");
  if (manifest?.skill?.path !== skillSourcePath) failures.push("manifest skill path is invalid");
  if (manifest?.skill?.version !== manifest?.version) failures.push("manifest skill version differs from the release version");
  const skillFiles = Array.isArray(manifest?.skill?.files) ? manifest.skill.files : [];
  if (skillFiles.length !== skillSourceFiles.length) failures.push("manifest skill file set is invalid");
  const expectedSkillPaths = new Set(skillSourceFiles.map((entry) => entry.path));
  const expectedSkillFilenames = new Map(
    skillSourceFiles.map((entry) => [
      entry.path,
      skillArtifactFilename(entry.stem, manifest?.version),
    ]),
  );
  const seenSkillPaths = new Set();
  const seenSkillFilenames = new Set();
  for (const entry of skillFiles) {
    if (!expectedSkillPaths.has(entry?.path) || seenSkillPaths.has(entry?.path)) {
      failures.push("manifest skill file path is invalid " + JSON.stringify(entry?.path ?? null));
    }
    seenSkillPaths.add(entry?.path);
    if (entry?.filename !== expectedSkillFilenames.get(entry?.path)) {
      failures.push("manifest skill filename is invalid " + JSON.stringify(entry?.filename ?? null));
    } else if (seenSkillFilenames.has(entry.filename)) {
      failures.push("manifest skill filename is duplicated " + entry.filename);
    }
    seenSkillFilenames.add(entry?.filename);
    if (!/^[0-9a-f]{64}$/.test(entry?.sha256 ?? "")) failures.push("manifest skill file digest is invalid");
  }
  if (skillFiles.length > 0 && manifest?.skill?.sha256 !== skillDigest(skillFiles)) {
    failures.push("manifest skill digest differs from its files");
  }
  const packages = Array.isArray(manifest?.packages) ? manifest.packages : [];
  if (!packages.length) failures.push("manifest must record at least one package");
  for (const entry of packages) {
    if (entry?.version !== manifest?.version) failures.push(entry?.name + " manifest version differs from the release version");
    if (entry?.filename !== tarballFilename(entry?.name ?? "", entry?.version ?? "")) failures.push(entry?.name + " manifest filename is invalid");
    if (!/^[0-9a-f]{64}$/.test(entry?.sha256 ?? "")) failures.push(entry?.name + " manifest digest is invalid");
  }
  return failures;
}
