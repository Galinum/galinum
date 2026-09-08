import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const compose = readFileSync(new URL("../examples/self-host/compose.yaml", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../examples/self-host/Dockerfile", import.meta.url), "utf8");
const readme = readFileSync(new URL("../examples/self-host/README.md", import.meta.url), "utf8");
const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");

describe("self-host example", () => {
  it("pins Node and Postgres major versions", () => {
    assert.match(dockerfile, /FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}/);
    assert.match(compose, /image: postgres:17@sha256:[0-9a-f]{64}/);
  });

  it("initializes only the product schema", () => {
    assert.match(compose, /packages\/server\/schema\.sql/);
    const initializationScripts = [...compose.matchAll(/([^\s:]+\.sql):\/docker-entrypoint-initdb.d\//g)].map(match => match[1]);
    assert.deepEqual(initializationScripts, ["../../packages/server/schema.sql"]);
  });

  it("keeps the published media origin aligned with the bound port", () => {
    assert.match(compose, /PORT: "3000"/);
    assert.match(compose, /GALINUM_PUBLIC_URL: http:\/\/localhost:3000/);
    assert.match(compose, /127\.0\.0\.1:3000:3000/);
    assert.doesNotMatch(compose, /- "3000:3000"/);
    assert.match(readme, /development keys and uploaded media stay local/);
  });

  it("uses an explicit Docker context allowlist", () => {
    const rules = dockerignore.trim().split("\n");
    assert.equal(rules[0], "**");
    assert.equal(rules.slice(1).every((rule) => rule.startsWith("!") && !rule.includes("*")), true);
    const allowed = new Set(rules.slice(1).map((rule) => rule.slice(1).replace(/\/$/, "")));
    for (const path of ["root-secret.txt", ".env", ".npmrc", "node_modules/token", "packages/server/src/untracked-secret.txt"]) {
      assert.equal(allowed.has(path), false, path);
    }
    for (const path of ["package.json", "pnpm-lock.yaml", "packages/core/src/index.ts", "packages/server/schema.sql", "packages/server/src/cli.ts"]) {
      assert.equal(allowed.has(path), true, path);
    }
  });

  it("includes every workspace dependency manifest needed to build the server", () => {
    const registry = JSON.parse(readFileSync(new URL("../release/packages.json", import.meta.url), "utf8"));
    const packages = new Map(registry.packages.map(entry => {
      const manifest = JSON.parse(readFileSync(new URL(`../${entry.path}/package.json`, import.meta.url), "utf8"));
      return [manifest.name, { ...entry, manifest }];
    }));
    const required = new Set(["@galinum/server"]);
    const allowed = new Set(dockerignore.trim().split("\n"));
    for (const name of required) {
      const entry = packages.get(name);
      assert.ok(entry, name);
      assert.ok(allowed.has(`!${entry.path}/package.json`), `${name} package manifest is missing from the Docker context`);
      const dependencies = { ...entry.manifest.dependencies, ...entry.manifest.devDependencies, ...entry.manifest.optionalDependencies };
      for (const [dependency, version] of Object.entries(dependencies)) if (version.startsWith("workspace:")) required.add(dependency);
    }
  });

  it("states the current self-host boundary", () => {
    assert.match(readme, /does not include Galinum Cloud billing/);
    assert.match(readme, /development-only keys/);
  });

  it("documents the dashboard stylesheet build", () => {
    assert.match(readme, /@import "tailwindcss"/);
    assert.match(readme, /@import "@galinum\/dashboard\/tokens\.css"/);
    assert.match(readme, /Serve the compiled CSS/);
  });
});
