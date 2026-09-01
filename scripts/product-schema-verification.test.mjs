import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareSchemaTables } from "./product-schema-lib.mjs";

describe("product schema verification", () => {
  it("rejects duplicate table declarations", () => {
    assert.deepEqual(compareSchemaTables(["campaigns", "campaigns"], ["campaigns"]), [
      "schema.sql declares campaigns more than once",
    ]);
  });

  it("reports missing and extra tables", () => {
    assert.deepEqual(compareSchemaTables(["extra"], ["campaigns"]), [
      "schema.sql is missing campaigns",
      "schema.sql adds extra outside ProductDB",
    ]);
  });
});
