import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("root CI wiring", () => {
  it("runs workspace and affected-package checks", () => {
    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /pnpm verify:workspace/);
    assert.match(workflow, /pnpm verify:affected/);
    assert.match(workflow, /pnpm verify:clean-clone/);
  });

  it("checks built dashboard output through the clean-clone verify gate", () => {
    const rootPackage = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.match(rootPackage.scripts.verify, /verify:dashboard-built/);
  });

  it("applies the product schema to Postgres 17", () => {
    assert.match(workflow, /image: postgres:17@sha256:[0-9a-f]{64}/);
    assert.match(workflow, /psql .*packages\/server\/schema\.sql/);
    assert.match(workflow, /RUN_DB_INTEGRATION: "1"/);
    assert.match(workflow, /pnpm --filter @galinum\/server test/);
  });

  it("does not deploy or change repository visibility", () => {
    assert.doesNotMatch(workflow, /deploy|repository visibility|--visibility|gh repo edit/i);
  });

  it("pins actions to immutable commits", () => {
    const actions = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)].map((match) => match[1]);
    assert.ok(actions.length > 0);
    assert.ok(actions.every((revision) => /^[0-9a-f]{40}$/.test(revision)));
  });
});
