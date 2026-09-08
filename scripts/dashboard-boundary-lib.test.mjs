import assert from "node:assert/strict";
import { it } from "node:test";
import { dashboardBoundaryFailures } from "./dashboard-boundary-lib.mjs";

const source = "packages/dashboard/src/components/campaign.tsx";

it("permits imports within the dashboard package", () => {
  assert.deepEqual(dashboardBoundaryFailures(source, 'import { cn } from "../lib/utils.js";', false), []);
});

it("rejects relative imports into another package or checkout", () => {
  for (const specifier of ["../../../server/src/app.js", "../../../../another-checkout/module.js"]) {
    assert.deepEqual(dashboardBoundaryFailures(source, `import { value } from "${specifier}";`, false), [
      `${source} imports outside the dashboard package ${specifier}`,
    ]);
  }
});

it("rejects unlisted external dependencies", () => {
  assert.deepEqual(dashboardBoundaryFailures(source, 'import { value } from "unlisted-package";', false), [
    `${source} imports unsupported package unlisted-package`,
  ]);
});
