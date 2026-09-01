import { describe, expect, it } from "vitest";
import {
  inspectImage,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  validateImageFile,
} from "./image-file";

function png(width: number, height: number): Buffer {
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

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0), // APP0, length 16
    0xff, 0xc0, 0x00, 0x11, 0x08, // SOF0, length 17, precision 8
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    0x03, ...Array(9).fill(0),
    0xff, 0xda, 0x00, 0x02,
    0x00,
    0xff, 0xd9,
  ]);
}

function webpLossy(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(24, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8 ", 12, "latin1");
  bytes.writeUInt32LE(12, 16);
  // 3-byte frame tag, then sync code, then 14-bit dimensions.
  bytes[23] = 0x9d;
  bytes[24] = 0x01;
  bytes[25] = 0x2a;
  bytes.writeUInt16LE(width, 26);
  bytes.writeUInt16LE(height, 28);
  return bytes;
}

function webpLossless(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(24, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8L", 12, "latin1");
  bytes.writeUInt32LE(12, 16);
  bytes[20] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  bytes[21] = w & 0xff;
  bytes[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  bytes[23] = (h >> 2) & 0xff;
  bytes[24] = (h >> 10) & 0x0f;
  return bytes;
}

function webpExtended(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(36, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8X", 12, "latin1");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  bytes.write("VP8L", 30, "latin1");
  bytes.writeUInt32LE(6, 34);
  bytes[38] = 0x2f;
  bytes[39] = (width - 1) & 0xff;
  bytes[40] = (((width - 1) >> 8) & 0x3f) | (((height - 1) & 0x03) << 6);
  bytes[41] = ((height - 1) >> 2) & 0xff;
  bytes[42] = ((height - 1) >> 10) & 0x0f;
  bytes[43] = 1;
  return bytes;
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(28);
  bytes.write("GIF89a", 0, "latin1");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  bytes[13] = 0x2c;
  bytes.writeUInt16LE(width, 18);
  bytes.writeUInt16LE(height, 20);
  bytes[23] = 2;
  bytes[24] = 1;
  bytes[25] = 1;
  bytes[26] = 0;
  bytes[27] = 0x3b;
  return bytes;
}

describe("inspectImage", () => {
  it("parses PNG dimensions", () => {
    expect(inspectImage(png(640, 480))).toEqual({
      format: "png",
      width: 640,
      height: 480,
    });
  });

  it("parses JPEG dimensions from the SOF segment", () => {
    expect(inspectImage(jpeg(1024, 768))).toEqual({
      format: "jpeg",
      width: 1024,
      height: 768,
    });
  });

  it("parses lossy WebP dimensions", () => {
    expect(inspectImage(webpLossy(320, 240))).toEqual({
      format: "webp",
      width: 320,
      height: 240,
    });
  });

  it("parses lossless WebP dimensions", () => {
    expect(inspectImage(webpLossless(100, 50))).toEqual({
      format: "webp",
      width: 100,
      height: 50,
    });
  });

  it("parses extended WebP canvas dimensions", () => {
    expect(inspectImage(webpExtended(2048, 1024))).toEqual({
      format: "webp",
      width: 2048,
      height: 1024,
    });
  });

  it("rejects SVG bytes", () => {
    expect(
      inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
  });

  it("parses GIF dimensions from the logical screen descriptor", () => {
    expect(inspectImage(gif(320, 240))).toEqual({
      format: "gif",
      width: 320,
      height: 240,
    });
    expect(inspectImage(Buffer.from("GIF00a\x10\x00\x10\x00"))).toBeNull();
  });

  it("rejects truncated or corrupt files", () => {
    expect(inspectImage(Buffer.alloc(0))).toBeNull();
    expect(inspectImage(png(10, 10).subarray(0, 10))).toBeNull();
    const badSync = webpLossy(10, 10);
    badSync[23] = 0x00;
    expect(inspectImage(badSync)).toBeNull();
    // JPEG that ends at start-of-scan without a frame header.
    expect(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });

  it("rejects header-only payloads for every supported format", () => {
    expect(inspectImage(png(10, 10).subarray(0, 33))).toBeNull();
    expect(inspectImage(jpeg(10, 10).subarray(0, -6))).toBeNull();
    expect(inspectImage(webpLossy(10, 10).subarray(0, -1))).toBeNull();
    expect(inspectImage(gif(10, 10).subarray(0, -1))).toBeNull();
  });

  it("keeps animated GIF payloads with a terminal trailer", () => {
    const frame = gif(10, 10);
    const animated = Buffer.concat([frame.subarray(0, 13), Buffer.from([0x21, 0xf9, 0x00]), frame.subarray(13)]);
    expect(inspectImage(animated)).toMatchObject({ format: "gif", width: 10, height: 10 });
  });
});

describe("validateImageFile", () => {
  it("accepts a valid PNG with matching declared type", () => {
    const result = validateImageFile(png(64, 64), "image/png");
    expect(result).toMatchObject({
      ok: true,
      contentType: "image/png",
      extension: "png",
    });
  });

  it("maps JPEG to the jpg extension", () => {
    expect(validateImageFile(jpeg(64, 64), "image/jpeg")).toMatchObject({
      ok: true,
      extension: "jpg",
    });
  });

  it("rejects an empty file", () => {
    expect(validateImageFile(Buffer.alloc(0), "image/png").ok).toBe(false);
  });

  it("rejects files over the byte limit", () => {
    const result = validateImageFile(
      Buffer.alloc(MAX_IMAGE_BYTES + 1),
      "image/png",
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("4 MB");
  });

  it("rejects disallowed declared types, including SVG", () => {
    expect(validateImageFile(png(64, 64), "image/svg+xml").ok).toBe(false);
    expect(validateImageFile(png(64, 64), "image/gif").ok).toBe(false);
    expect(validateImageFile(png(64, 64), "").ok).toBe(false);
  });

  it("rejects bytes that do not match the declared type", () => {
    expect(validateImageFile(jpeg(64, 64), "image/png").ok).toBe(false);
    expect(validateImageFile(png(64, 64), "image/webp").ok).toBe(false);
  });

  it("rejects non-image bytes with an allowed declared type", () => {
    expect(
      validateImageFile(Buffer.from("<svg></svg>"), "image/png").ok,
    ).toBe(false);
  });

  it("rejects images over the dimension limit", () => {
    const result = validateImageFile(
      png(MAX_IMAGE_DIMENSION + 1, 100),
      "image/png",
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("4096");
    expect(
      validateImageFile(png(100, MAX_IMAGE_DIMENSION + 1), "image/png").ok,
    ).toBe(false);
    expect(
      validateImageFile(png(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION), "image/png").ok,
    ).toBe(true);
  });

  it("rejects zero-dimension images", () => {
    expect(validateImageFile(png(0, 100), "image/png").ok).toBe(false);
  });

  it("rejects GIF under the default profile-image policy", () => {
    expect(validateImageFile(gif(64, 64), "image/gif").ok).toBe(false);
  });

  it("accepts GIF under a policy that allows it", () => {
    const policy = {
      formats: ["png", "gif"] as ("png" | "gif")[],
      maxBytes: MAX_IMAGE_BYTES,
      maxDimension: MAX_IMAGE_DIMENSION,
    };
    expect(validateImageFile(gif(64, 64), "image/gif", policy)).toMatchObject({
      ok: true,
      contentType: "image/gif",
      extension: "gif",
    });
    // Bytes must still match the declared type.
    expect(validateImageFile(png(64, 64), "image/gif", policy).ok).toBe(false);
  });
});
