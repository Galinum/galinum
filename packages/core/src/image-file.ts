// Byte-level validation for uploaded raster images. Declared MIME types are
// attacker-controlled, so acceptance is decided by sniffing the actual bytes:
// only raster formats the caller's policy allows pass, and dimensions are
// parsed from the file so oversized images are rejected server-side. SVG (a
// script container, not a raster) never sniffs as any of these and is
// rejected like any other non-image.
//
// Policies: profile images (avatars/logos) allow PNG/JPEG/WebP; campaign
// media (app/lib/campaign-media.ts) additionally allows GIF — animation is
// preserved because the original bytes are stored untouched.

export type RasterFormat = "png" | "jpeg" | "webp" | "gif";

export const IMAGE_MIME_TYPES: Record<RasterFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const IMAGE_EXTENSIONS: Record<RasterFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  gif: "gif",
};

export const PROFILE_IMAGE_FORMATS: RasterFormat[] = ["png", "jpeg", "webp"];

export const ACCEPTED_IMAGE_MIME_TYPES = PROFILE_IMAGE_FORMATS.map(
  (format) => IMAGE_MIME_TYPES[format],
);

// 4 MB keeps uploads (plus multipart overhead) under Vercel's 4.5 MB
// function request-body ceiling, which would 413 before the action runs.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;

export type ImageInfo = {
  format: RasterFormat;
  width: number;
  height: number;
};

const u16be = (b: Buffer, o: number) => (b[o] << 8) | b[o + 1];
const u24le = (b: Buffer, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Buffer, o: number) => b.readUInt32BE(o);

function inspectPng(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 45) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, i) => bytes[i] === byte)) return null;
  let offset = 8;
  let info: ImageInfo | null = null;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return null;
      info = { format: "png", width: u32be(bytes, offset + 8), height: u32be(bytes, offset + 12) };
    }
    if (type === "IDAT" && length > 0) hasImageData = true;
    if (type === "IEND") return length === 0 && end === bytes.length && hasImageData ? info : null;
    offset = end;
  }
  return null;
}

function inspectJpeg(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return null;
  }
  let offset = 2;
  let info: ImageInfo | null = null;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    let marker = bytes[offset + 1];
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) return offset + 2 === bytes.length ? info : null;
    if (marker === 0xda) {
      if (offset + 4 > bytes.length) return null;
      const scanStart = offset + 2 + u16be(bytes, offset + 2);
      return info && scanStart < bytes.length - 2 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
        ? info
        : null;
    }
    if (offset + 4 > bytes.length) return null;
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 && // DHT
      marker !== 0xc8 && // JPG extension
      marker !== 0xcc; // DAC
    if (isSof) {
      if (offset + 9 > bytes.length) return null;
      info = {
        format: "jpeg",
        height: u16be(bytes, offset + 5),
        width: u16be(bytes, offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function inspectWebp(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 26) return null;
  if (bytes.toString("latin1", 0, 4) !== "RIFF") return null;
  if (bytes.toString("latin1", 8, 12) !== "WEBP") return null;
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  let offset = 12;
  let canvas: ImageInfo | null = null;
  let image: ImageInfo | null = null;
  let animated = false;
  while (offset + 8 <= bytes.length) {
    const chunk = bytes.toString("latin1", offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    const end = data + chunkLength;
    const next = end + (chunkLength % 2);
    if (end > bytes.length || next > bytes.length) return null;
    if (chunk === "VP8 ") {
      if (chunkLength <= 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return null;
      image = {
        format: "webp",
        width: (bytes[data + 6] | (bytes[data + 7] << 8)) & 0x3fff,
        height: (bytes[data + 8] | (bytes[data + 9] << 8)) & 0x3fff,
      };
    } else if (chunk === "VP8L") {
      if (chunkLength <= 5 || bytes[data] !== 0x2f) return null;
      image = {
        format: "webp",
        width: 1 + (((bytes[data + 2] & 0x3f) << 8) | bytes[data + 1]),
        height: 1 + (((bytes[data + 4] & 0x0f) << 10) | (bytes[data + 3] << 2) | ((bytes[data + 2] & 0xc0) >> 6)),
      };
    } else if (chunk === "VP8X") {
      if (chunkLength !== 10) return null;
      canvas = { format: "webp", width: 1 + u24le(bytes, data + 4), height: 1 + u24le(bytes, data + 7) };
    } else if (chunk === "ANMF") {
      animated = chunkLength > 16;
    }
    offset = next;
  }
  if (offset !== bytes.length) return null;
  if (image) return canvas ?? image;
  return canvas && animated ? canvas : null;
}

function inspectGif(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 28 || bytes[bytes.length - 1] !== 0x3b) return null;
  const header = bytes.toString("latin1", 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  let offset = 13;
  if ((bytes[10] & 0x80) !== 0) offset += 3 * (1 << ((bytes[10] & 0x07) + 1));
  let hasImageData = false;
  while (offset < bytes.length) {
    const marker = bytes[offset];
    if (marker === 0x3b) return offset === bytes.length - 1 && hasImageData ? {
      format: "gif",
      width: bytes[6] | (bytes[7] << 8),
      height: bytes[8] | (bytes[9] << 8),
    } : null;
    if (marker === 0x2c) {
      if (offset + 11 > bytes.length) return null;
      const packed = bytes[offset + 9];
      offset += 10;
      if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1));
      if (offset >= bytes.length) return null;
      offset += 1;
      let payloadBytes = 0;
      while (offset < bytes.length) {
        const length = bytes[offset++];
        if (length === 0) break;
        if (offset + length > bytes.length) return null;
        payloadBytes += length;
        offset += length;
      }
      if (payloadBytes === 0) return null;
      hasImageData = true;
      continue;
    }
    if (marker === 0x21) {
      if (offset + 2 > bytes.length) return null;
      offset += 2;
      while (offset < bytes.length) {
        const length = bytes[offset++];
        if (length === 0) break;
        if (offset + length > bytes.length) return null;
        offset += length;
      }
      continue;
    }
    return null;
  }
  return null;
}

export function inspectImage(bytes: Buffer): ImageInfo | null {
  return inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes) ?? inspectGif(bytes);
}

export type ImageValidation =
  | { ok: true; info: ImageInfo; contentType: string; extension: string }
  | { ok: false; error: string };

export type ImagePolicy = {
  formats: RasterFormat[];
  maxBytes: number;
  maxDimension: number;
};

function formatList(formats: RasterFormat[]): string {
  const names = formats.map((format) =>
    format === "jpeg" ? "JPEG" : format.toUpperCase(),
  );
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

export function validateImageFile(
  bytes: Buffer,
  declaredType: string,
  policy: ImagePolicy = {
    formats: PROFILE_IMAGE_FORMATS,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimension: MAX_IMAGE_DIMENSION,
  },
): ImageValidation {
  const accepted = policy.formats.map((format) => IMAGE_MIME_TYPES[format]);
  if (bytes.length === 0) {
    return { ok: false, error: "The selected file is empty." };
  }
  if (bytes.length > policy.maxBytes) {
    return {
      ok: false,
      error: `Images must be ${Math.floor(policy.maxBytes / (1024 * 1024))} MB or smaller.`,
    };
  }
  if (!accepted.includes(declaredType)) {
    return { ok: false, error: `Use a ${formatList(policy.formats)} image.` };
  }
  const info = inspectImage(bytes);
  if (!info || !policy.formats.includes(info.format)) {
    return {
      ok: false,
      error: `That file is not a valid ${formatList(policy.formats)} image.`,
    };
  }
  if (IMAGE_MIME_TYPES[info.format] !== declaredType) {
    return { ok: false, error: "The file's content does not match its type." };
  }
  if (info.width < 1 || info.height < 1) {
    return { ok: false, error: "That image has no visible pixels." };
  }
  if (info.width > policy.maxDimension || info.height > policy.maxDimension) {
    return {
      ok: false,
      error: `Images must be at most ${policy.maxDimension}×${policy.maxDimension} pixels.`,
    };
  }
  return {
    ok: true,
    info,
    contentType: IMAGE_MIME_TYPES[info.format],
    extension: IMAGE_EXTENSIONS[info.format],
  };
}
