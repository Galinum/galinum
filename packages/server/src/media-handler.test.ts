import { describe, expect, it } from "vitest";
import { MemoryMediaStore } from "./local-media-store.js";
import { createUploadCampaignMediaHandler } from "./media-handler.js";
import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";

function png(width: number, height: number) {
  const bytes = Buffer.alloc(58);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(1, 33);
  bytes.write("IDAT", 37, "latin1");
  bytes[41] = 1;
  bytes.write("IEND", 50, "latin1");
  return bytes;
}

describe("campaign media upload", () => {
  it("validates and stores an owned raster image", async () => {
    const media = new MemoryMediaStore("https://self.example");
    const handler = createUploadCampaignMediaHandler({ projectId: "local", secretKey: "pk_secret", media });
    const app = createApp({ uploadCampaignMedia: handler }, media);
    const form = new FormData();
    form.set("file", new File([png(640, 480)], "image.png", { type: "image/png" }));
    const response = await app(new Request("http://local/api/v1/campaign-media", {
      method: "POST",
      headers: { authorization: "Bearer pk_secret" },
      body: form,
    }));
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(Object.keys(result)).toEqual(["media"]);
    expect(result.media).toMatchObject({ contentType: "image/png", width: 640, height: 480, sizeBytes: 58 });
    expect(result.media.url).toMatch(/^https:\/\/self\.example\/media\/projects\/local\/media\//);
    const served = await app(new Request(`http://local${new URL(result.media.url).pathname}`));
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(Array.from(new Uint8Array(await served.arrayBuffer()))).toEqual(Array.from(png(640, 480)));
  });

  it("rejects a mismatched file type", async () => {
    const handler = createUploadCampaignMediaHandler({ projectId: "local", secretKey: "pk_secret", media: new MemoryMediaStore() });
    const form = new FormData();
    form.set("file", new File([png(10, 10)], "image.jpg", { type: "image/jpeg" }));
    const response = await handler(new Request("http://local/api/v1/campaign-media", {
      method: "POST",
      headers: { authorization: "Bearer pk_secret" },
      body: form,
    }), { params: {} });
    expect(response.status).toBe(400);
  });

  it("rejects a declared oversize request before parsing the body", async () => {
    const media = new MemoryMediaStore();
    const handler = createUploadCampaignMediaHandler({ projectId: "local", secretKey: "pk_secret", media });
    const form = new FormData();
    form.set("file", new File([png(10, 10)], "image.png", { type: "image/png" }));
    const request = new Request("http://local/api/v1/campaign-media", {
      method: "POST",
      headers: { authorization: "Bearer pk_secret", "content-length": String(5 * 1024 * 1024) },
      body: form,
    });
    let parsed = false;
    request.formData = async () => { parsed = true; throw new Error("body must not be parsed"); };
    const response = await handler(request, { params: {} });
    expect(response.status).toBe(413);
    expect(parsed).toBe(false);
  });

  it("accepts a declared length within the multipart allowance", async () => {
    const handler = createUploadCampaignMediaHandler({ projectId: "local", secretKey: "pk_secret", media: new MemoryMediaStore() });
    const form = new FormData();
    form.set("file", new File([png(10, 10)], "image.png", { type: "image/png" }));
    const response = await handler(new Request("http://local/api/v1/campaign-media", {
      method: "POST",
      headers: { authorization: "Bearer pk_secret" },
      body: form,
    }), { params: {} });
    expect(response.status).toBe(201);
  });

  it("still rejects oversized bytes without a declared length", async () => {
    const handler = createUploadCampaignMediaHandler({ projectId: "local", secretKey: "pk_secret", media: new MemoryMediaStore() });
    const oversized = Buffer.concat([png(10, 10), Buffer.alloc(5 * 1024 * 1024)]);
    const form = new FormData();
    form.set("file", new File([oversized], "image.png", { type: "image/png" }));
    const response = await handler(new Request("http://local/api/v1/campaign-media", {
      method: "POST",
      headers: { authorization: "Bearer pk_secret" },
      body: form,
    }), { params: {} });
    expect(response.status).toBe(413);
  });

  it("requires the secret key before any size check", async () => {
    const handler = createUploadCampaignMediaHandler({ projectId: "local", secretKey: "pk_secret", media: new MemoryMediaStore() });
    const response = await handler(new Request("http://local/api/v1/campaign-media", {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-length": String(9 * 1024 * 1024) },
    }), { params: {} });
    expect(response.status).toBe(401);
  });

  it("maps storage write failures to 502", async () => {
    const media = new MemoryMediaStore();
    media.put = async () => { throw new Error("storage unavailable"); };
    const handler = createUploadCampaignMediaHandler({ projectId: "local", secretKey: "pk_secret", media });
    const form = new FormData();
    form.set("file", new File([png(10, 10)], "image.png", { type: "image/png" }));
    const response = await handler(new Request("http://local/api/v1/campaign-media", {
      method: "POST",
      headers: { authorization: "Bearer pk_secret" },
      body: form,
    }), { params: {} });
    expect(response.status).toBe(502);
  });

  it("maps storage read failures during message verification to 503", async () => {
    const media = new MemoryMediaStore();
    const stored = await media.put({ projectId: "local", bytes: png(10, 10), contentType: "image/png", extension: "png" });
    media.get = async () => { throw new Error("storage unavailable"); };
    const product = createLocalProduct({ media });
    const app = createApp(product.handlers);
    const response = await app(new Request("http://local/api/v1/campaigns", {
      method: "POST",
      headers: { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Unavailable media",
        message: { presentation: "toast", title: "Media", media: { url: stored.path, alt: "Media" } },
      }),
    }));
    expect(response.status).toBe(503);
    await product.close();
  });
});
