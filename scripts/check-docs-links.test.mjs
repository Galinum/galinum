import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { checkDocs } from "./check-docs-links.mjs";

function fixture(link) {
  const root = mkdtempSync(join(tmpdir(), "galinum-docs-links-"));
  mkdirSync(join(root, "logo"));
  writeFileSync(join(root, "logo/light.svg"), "");
  writeFileSync(join(root, "logo/dark.svg"), "");
  writeFileSync(join(root, "logo/favicon.png"), "");
  writeFileSync(join(root, "index.mdx"), `# Home\n\n${link}\n`);
  writeFileSync(join(root, "guide.mdx"), "# Guide\n\n## Start here\n");
  writeFileSync(join(root, "openapi.json"), JSON.stringify({ paths: { "/api/v1/items": { get: {} } } }));
  writeFileSync(join(root, "docs.json"), JSON.stringify({
    logo: { light: "logo/light.svg", dark: "logo/dark.svg" },
    favicon: "logo/favicon.png",
    navigation: { tabs: [{ groups: [{ pages: ["index", "guide"] }] }, { openapi: "openapi.json", groups: [{ pages: ["GET /api/v1/items"] }] }] },
  }));
  return root;
}

describe("documentation links", () => {
  it("accepts valid pages, operations, assets, and anchors", () => {
    assert.deepEqual(checkDocs(fixture("[Start](/guide#start-here)")), []);
  });

  it("rejects a missing internal page", () => {
    assert.deepEqual(checkDocs(fixture("[Missing](/missing)")), ["index.mdx links to missing page /missing"]);
  });

  it("rejects a missing MDX component target", () => {
    assert.deepEqual(checkDocs(fixture('<Card href="/missing">Missing</Card>')), ["index.mdx links to missing page /missing"]);
  });
});
