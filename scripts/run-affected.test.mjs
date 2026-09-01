import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prerequisiteCommands, selectAffected, selectedLanes } from "./run-affected.mjs";

function dashboardLane(selected) {
  return selectedLanes(selected).find((lane) => lane.name === "dashboard");
}

describe("affected package selection", () => {
  it("runs docs for an unknown base", () => {
    assert.deepEqual(selectAffected(null), ["core", "dashboard", "docs", "react", "react-example", "server"]);
  });

  it("runs docs for a documentation change", () => {
    assert.deepEqual(selectAffected(["apps/docs/index.mdx"]), ["docs"]);
  });

  it("runs docs for a shared workspace change", () => {
    assert.deepEqual(selectAffected(["pnpm-lock.yaml"]), ["core", "dashboard", "docs", "react", "react-example", "server"]);
  });

  it("runs every package for a release registry change", () => {
    assert.deepEqual(selectAffected(["release/packages.json"]), ["core", "dashboard", "docs", "react", "react-example", "server"]);
  });

  it("runs only dashboard for a dashboard primitive", () => {
    assert.deepEqual(selectAffected(["packages/dashboard/src/ui/button.tsx"]), ["dashboard"]);
    assert.deepEqual(prerequisiteCommands(dashboardLane(["dashboard"]), ["dashboard"]), [
      ["pnpm", "--filter", "@galinum/core", "build"],
    ]);
  });

  it("runs core, dashboard, and server for a core change", () => {
    assert.deepEqual(selectAffected(["packages/core/src/messages.ts"]), ["core", "dashboard", "server"]);
    assert.deepEqual(prerequisiteCommands(dashboardLane(["core", "dashboard", "server"]), ["core", "dashboard", "server"]), []);
  });

  it("runs docs and server for the OpenAPI contract", () => {
    assert.deepEqual(selectAffected(["apps/docs/openapi.json"]), ["docs", "server"]);
  });

  it("runs only server for a server change", () => {
    assert.deepEqual(selectAffected(["packages/server/src/app.ts"]), ["server"]);
  });

  it("runs react and its example for a React SDK change", () => {
    assert.deepEqual(selectAffected(["packages/react/src/client.ts"]), ["react", "react-example"]);
    assert.deepEqual(prerequisiteCommands(selectedLanes(["react"])[0], ["react", "react-example"]), []);
  });

  it("builds React before checking an example-only change", () => {
    const selected = selectAffected(["examples/react-nextjs/app/page.tsx"]);
    assert.deepEqual(selected, ["react-example"]);
    assert.deepEqual(prerequisiteCommands(selectedLanes(selected)[0], selected), [
      ["pnpm", "--filter", "@galinum/react", "build"],
    ]);
  });

  it("builds core before checking a server-only change", () => {
    const selected = selectAffected(["packages/server/src/app.ts"]);
    assert.deepEqual(prerequisiteCommands(selectedLanes(selected)[0], selected), [
      ["pnpm", "--filter", "@galinum/core", "build"],
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

  it("runs no package for unrelated prose", () => {
    assert.deepEqual(selectAffected(["README.md"]), []);
  });
});
