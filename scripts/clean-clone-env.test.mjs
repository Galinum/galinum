import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cleanStartEnv, currentTreeDeletedFiles, publicRegistryEnv } from "./verify-clean-clone.mjs";

const config = { NPM_CONFIG_USERCONFIG: "/tmp/npmrc", NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/" };

describe("clean clone install environment", () => {
  it("clears registry auth variables and tokens", () => {
    const env = publicRegistryEnv({
      NPM_TOKEN: "secret",
      NODE_AUTH_TOKEN: "secret",
      NPM_CONFIG_REGISTRY: "https://private.example.com/",
      "npm_config_//private.example.com/:_authToken": "secret",
      PNPM_HOME: "/private/pnpm",
      YARN_NPM_AUTH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      AWS_CREDENTIAL_FILE: "/tmp/creds",
      PATH: "/usr/bin",
    }, config);
    assert.equal(env.PATH, "/usr/bin");
    for (const name of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "PNPM_HOME", "YARN_NPM_AUTH_TOKEN", "GITHUB_TOKEN", "AWS_CREDENTIAL_FILE"]) {
      assert.equal(env[name], undefined, name);
    }
    assert.equal(env["npm_config_//private.example.com/:_authToken"], undefined);
  });

  it("pins the isolated public npm config", () => {
    const env = publicRegistryEnv({ NPM_CONFIG_USERCONFIG: "/home/user/.npmrc" }, config);
    assert.equal(env.NPM_CONFIG_USERCONFIG, "/tmp/npmrc");
    assert.equal(env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org/");
  });

  it("starts from the operating-system variables and the chosen port", () => {
    const env = cleanStartEnv({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      APP_DATABASE_URL: "postgres://example",
      APP_PUBLIC_URL: "https://example.test",
      APP_SECRET: "secret",
    }, 4321);
    assert.deepEqual(env, { PATH: "/usr/bin", LANG: "en_US.UTF-8", PORT: "4321" });
  });

  it("collects staged and unstaged deletions from the current tree", () => {
    const calls = [];
    const files = currentTreeDeletedFiles("/repo", (command, args, options) => {
      calls.push([command, args, options.encoding]);
      return { status: 0, stdout: "first\0second\0", stderr: "" };
    });
    assert.deepEqual(files, ["first", "second"]);
    assert.deepEqual(calls, [["git", ["-C", "/repo", "diff", "--name-only", "--diff-filter=D", "-z", "HEAD"], "utf8"]]);
  });
});
