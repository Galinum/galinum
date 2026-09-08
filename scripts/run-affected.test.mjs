import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prerequisiteCommands, selectAffected, selectedLanes } from "./run-affected.mjs";

function dashboardLane(selected) {
  return selectedLanes(selected).find((lane) => lane.name === "dashboard");
}

describe("affected package selection", () => {
  it("selects push, its server host and dependent native HTTP checks", () => { assert.deepEqual(selectAffected(["packages/push/src/engine.ts"]), ["push", "server", "native"]); });
  it("selects all contract consumers for a generated mobile change", () => {
    assert.deepEqual(selectAffected(["packages/contracts/src/index.ts"]), ["contracts", "core", "dashboard", "react", "react-example", "push", "server", "native"]);
  });
  it("runs docs for an unknown base", () => {
    assert.deepEqual(selectAffected(null), ["contracts", "core", "dashboard", "docs", "react", "react-example", "push", "server", "native"]);
  });

  it("runs docs for a documentation change", () => {
    assert.deepEqual(selectAffected(["apps/docs/index.mdx"]), ["docs"]);
  });

  it("runs docs for a shared workspace change", () => {
    assert.deepEqual(selectAffected(["pnpm-lock.yaml"]), ["contracts", "core", "dashboard", "docs", "react", "react-example", "push", "server", "native"]);
  });

  it("runs every package for a release registry change", () => {
    assert.deepEqual(selectAffected(["release/packages.json"]), ["contracts", "core", "dashboard", "docs", "react", "react-example", "push", "server", "native"]);
  });

  it("runs only dashboard for a dashboard primitive", () => {
    assert.deepEqual(selectAffected(["packages/dashboard/src/ui/button.tsx"]), ["dashboard"]);
    assert.deepEqual(prerequisiteCommands(dashboardLane(["dashboard"]), ["dashboard"]), [
      ["pnpm", "--filter", "@galinum/contracts", "build"],
      ["pnpm", "--filter", "@galinum/core", "build"],
    ]);
  });

  it("runs core, dashboard, and server for a core change", () => {
    assert.deepEqual(selectAffected(["packages/core/src/messages.ts"]), ["core", "dashboard", "push", "server", "native"]);
    assert.deepEqual(prerequisiteCommands(dashboardLane(["core", "dashboard", "push", "server", "native"]), ["core", "dashboard", "push", "server", "native"]), []);
  });

  it("runs docs and server for the OpenAPI contract", () => {
    assert.deepEqual(selectAffected(["apps/docs/openapi.json"]), ["contracts", "core", "dashboard", "docs", "react", "react-example", "push", "server", "native"]);
  });

  it("runs server and native HTTP tests for a server change", () => {
    assert.deepEqual(selectAffected(["packages/server/src/app.ts"]), ["server", "native"]);
  });

  it("runs react and its example for a React SDK change", () => {
    assert.deepEqual(selectAffected(["packages/react/src/client.ts"]), ["react", "react-example"]);
    assert.deepEqual(prerequisiteCommands(selectedLanes(["react"])[0], ["react", "react-example"]), [["pnpm", "--filter", "@galinum/contracts", "build"]]);
  });

  it("builds React before checking an example-only change", () => {
    const selected = selectAffected(["examples/react-nextjs/app/page.tsx"]);
    assert.deepEqual(selected, ["react-example"]);
    assert.deepEqual(prerequisiteCommands(selectedLanes(selected)[0], selected), [
      ["pnpm", "--filter", "@galinum/contracts", "build"],
      ["pnpm", "--filter", "@galinum/react", "build"],
    ]);
  });

  it("builds core before checking a server-only change", () => {
    const selected = selectAffected(["packages/server/src/app.ts"]);
    assert.deepEqual(prerequisiteCommands(selectedLanes(selected)[0], selected), [
      ["pnpm", "--filter", "@galinum/contracts", "build"],
      ["pnpm", "--filter", "@galinum/core", "build"],
      ["pnpm", "--filter", "@galinum/push", "build"],
    ]);
  });

  it("verifies the release for every release-owned lane", () => {
    for (const name of ["core", "dashboard", "react", "server"]) {
      assert.equal(selectedLanes([name])[0].release, true, name);
    }
    assert.equal(selectedLanes(["docs"])[0].release, undefined);
  });

  it("typechecks, tests, and builds the React SDK", () => {
    assert.deepEqual(selectedLanes(["react"])[0].commands, [
      ["pnpm", "--filter", "@galinum/react", "typecheck"],
      ["pnpm", "--filter", "@galinum/react", "test"],
      ["pnpm", "--filter", "@galinum/react", "build"],
    ]);
  });

  it("checks native package and example changes", () => {
    assert.deepEqual(selectAffected(["packages/react-native/src/client.ts"]), ["native"]);
    assert.deepEqual(selectAffected(["examples/react-native-expo/App.tsx"]), ["native"]);
  });

  it("runs no package for unrelated prose", () => {
    assert.deepEqual(selectAffected(["README.md"]), []);
  });
});
