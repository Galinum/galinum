import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./verify-activation-runtime.mjs", import.meta.url));
function run(args, url) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, ...(url ? { GALINUM_RUNTIME_DATABASE_URL: url } : {}) },
    encoding: "utf8", timeout: 5000, maxBuffer: 131072,
  });
  assert.ifError(result.error);
  return result;
}

describe("activation runtime verifier inputs", () => {
  it("rejects unsafe database URLs before reading a package or connecting", () => {
    for (const url of ["postgresql://example.test/postgres", "postgresql://127.0.0.1/customer", "postgresql://localhost/postgres?host=example.test", "postgresql://[::1]/postgres#fragment"]) {
      const result = run(["--package", "missing-runtime-package-fixture"], url);
      assert.equal(result.status, 1);
      assert.match(JSON.parse(result.stdout).error, /loopback postgres maintenance/);
    }
  });

  it("rejects missing, duplicate and unknown options and relative evidence paths", () => {
    for (const args of [["--package"], ["--memory-only", "--memory-only"], ["--unknown"], ["--evidence", "relative.json"]]) {
      const result = run(args);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).verified, false);
      assert.match(JSON.parse(result.stdout).error, /Missing value|Duplicate option|Unknown option|absolute/);
    }
  });

  it("ignores database configuration in memory-only mode", () => {
    const result = run(["--memory-only", "--package", "missing-runtime-package-fixture"], "postgresql://example.test/customer");
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /ENOENT/);
    assert.doesNotMatch(JSON.parse(result.stdout).error, /loopback/);
  });

  it("prints usage without loading a package", () => {
    const result = run(["--help"], "postgresql://example.test/customer");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--package.*--memory-only.*--evidence/);
  });
});
