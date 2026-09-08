import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { installationUpgrade } from "./generate-installation-upgrade.mjs";

test("installation upgrade is transactional and derives from the canonical schema", () => {
  const schema = readFileSync(new URL("../packages/server/schema.sql", import.meta.url), "utf8");
  const upgrade = readFileSync(new URL("../packages/server/upgrades/installations.sql", import.meta.url), "utf8");
  assert.equal(upgrade, installationUpgrade(schema));
  assert.match(upgrade, /^BEGIN;/);
  assert.match(upgrade, /COMMIT;\n$/);
  assert.throws(() => installationUpgrade(schema + "\nCREATE TABLE unrelated (id text);"), /Unexpected tables/);
});
