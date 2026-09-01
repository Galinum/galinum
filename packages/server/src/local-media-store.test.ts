import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileMediaStore, MemoryMediaStore, normalizePublicOrigin } from "./local-media-store.js";

const bytes = new Uint8Array([1, 2, 3]);
const origin = "https://self.example";

for (const [name, store] of [
  ["memory", new MemoryMediaStore(origin)],
  ["filesystem", new FileMediaStore(mkdtempSync(join(tmpdir(), "galinum-media-")), origin)],
] as const) {
  describe(`${name} media store`, () => {
    it("stores and resolves canonical project media paths", async () => {
      const saved = await store.put({ projectId: "local", bytes, contentType: "image/png", extension: "png" });
      expect(saved.path).toMatch(/^\/media\/projects\/local\/media\//);
      expect(store.publicUrl(saved.path)).toBe(`${origin}${saved.path}`);
      expect(store.resolve("local", saved.path)).toEqual({ key: saved.key, path: saved.path });
      expect(store.resolve("local", `${origin}${saved.path}`)).toEqual({ key: saved.key, path: saved.path });
      expect(store.resolve("other", saved.path)).toBeNull();
      expect(store.resolve("local", `https://other.example${saved.path}`)).toBeNull();
      expect(store.resolve("local", "/media/projects/local/media/../other.png")).toBeNull();
      expect(Array.from((await store.get(saved.key))?.bytes ?? [])).toEqual(Array.from(bytes));
    });
  });
}

describe("media public origin", () => {
  it("accepts only normalized HTTP(S) origins", () => {
    expect(normalizePublicOrigin("https://example.com/")).toBe("https://example.com");
    for (const value of ["ftp://example.com", "https://user@example.com", "https://example.com/path", "https://example.com?x=1", "not-a-url"]) {
      expect(() => normalizePublicOrigin(value)).toThrow("origin-only HTTP(S) URL");
    }
  });

  it("renders retained relative paths through a changed origin after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "galinum-media-origin-"));
    const first = new FileMediaStore(root, "https://old.example");
    const saved = await first.put({ projectId: "local", bytes, contentType: "image/png", extension: "png" });
    const restarted = new FileMediaStore(root, "https://new.example");
    expect(await restarted.get(saved.key)).not.toBeNull();
    expect(restarted.publicUrl(saved.path)).toBe(`https://new.example${saved.path}`);
  });
});
