import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { MemoryMediaStore } from "./local-media-store.js";

describe("media path decoding", () => {
  it("serves immutable media for cross-origin browser rendering", async () => {
    const media = new MemoryMediaStore();
    const object = await media.put({ projectId: "local", bytes: new Uint8Array([1]), contentType: "image/png", extension: "png" });
    const app = createApp({}, media);
    const response = await app(new Request(`http://local${object.path}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("returns 400 for a malformed percent-encoded media path", async () => {
    const app = createApp({}, new MemoryMediaStore());
    const response = await app(new Request("http://local/media/%E0%A4%A"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid media path" });
  });

  it("returns 404 for a well-formed unknown media path", async () => {
    const app = createApp({}, new MemoryMediaStore());
    expect((await app(new Request("http://local/media/projects/local/media/missing.png"))).status).toBe(404);
  });
});
