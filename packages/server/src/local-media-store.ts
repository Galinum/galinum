import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MediaObject, MediaStore, StoredMediaObject } from "@galinum/core";

const projectPattern = /^[A-Za-z0-9_-]{1,128}$/;
const extensionPattern = /^[a-z0-9]{1,8}$/;

function objectKey(projectId: string, extension: string) {
  if (!projectPattern.test(projectId)) throw new Error("Invalid project id");
  if (!extensionPattern.test(extension)) throw new Error("Invalid media extension");
  return `projects/${projectId}/media/${randomUUID()}.${extension}`;
}

function publicPath(key: string) {
  return `/media/${key}`;
}

export function normalizePublicOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GALINUM_PUBLIC_URL must be an origin-only HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("GALINUM_PUBLIC_URL must be an origin-only HTTP(S) URL");
  }
  return url.origin;
}

function mediaReference(projectId: string, value: string, origin: string) {
  if (!projectPattern.test(projectId)) return null;
  let path = value;
  if (!path.startsWith("/")) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      return null;
    }
    if (url.origin !== origin || url.search || url.hash) return null;
    path = url.pathname;
  }
  const prefix = `/media/projects/${projectId}/media/`;
  if (!path.startsWith(prefix)) return null;
  const key = path.slice("/media/".length);
  const objectName = path.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(objectName) || objectName.includes("..")) return null;
  if (publicPath(key) !== path) return null;
  return { key, path };
}

export class MemoryMediaStore implements MediaStore {
  private readonly objects = new Map<string, MediaObject>();
  private readonly origin: string;

  constructor(origin = "http://localhost:3000") {
    this.origin = normalizePublicOrigin(origin);
  }

  async put(input: { projectId: string; bytes: Uint8Array; contentType: string; extension: string }) {
    const key = objectKey(input.projectId, input.extension);
    const object = { key, path: publicPath(key), contentType: input.contentType, sizeBytes: input.bytes.byteLength, bytes: new Uint8Array(input.bytes) };
    this.objects.set(key, object);
    return stored(object);
  }

  async get(key: string) {
    const object = this.objects.get(key);
    return object ? { ...object, bytes: new Uint8Array(object.bytes) } : null;
  }

  resolve(projectId: string, value: string) {
    return mediaReference(projectId, value, this.origin);
  }

  publicUrl(path: string) {
    return new URL(path, this.origin).href;
  }
}

export class FileMediaStore implements MediaStore {
  private readonly origin: string;

  constructor(private readonly root: string, origin: string) {
    this.origin = normalizePublicOrigin(origin);
  }

  async put(input: { projectId: string; bytes: Uint8Array; contentType: string; extension: string }) {
    const key = objectKey(input.projectId, input.extension);
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.bytes, { flag: "wx" });
    return { key, path: publicPath(key), contentType: input.contentType, sizeBytes: input.bytes.byteLength };
  }

  async get(key: string) {
    let path: string;
    try {
      path = this.path(key);
    } catch {
      return null;
    }
    try {
      const bytes = await readFile(path);
      return { key, path: publicPath(key), contentType: contentType(key), sizeBytes: bytes.byteLength, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  resolve(projectId: string, value: string) {
    return mediaReference(projectId, value, this.origin);
  }

  publicUrl(path: string) {
    return new URL(path, this.origin).href;
  }

  private path(key: string) {
    if (key.startsWith("/") || key.split("/").includes("..")) throw new Error("Invalid media key");
    const path = resolve(this.root, key);
    const prefix = `${resolve(this.root)}/`;
    if (!path.startsWith(prefix)) throw new Error("Media key escapes storage root");
    return path;
  }
}

function stored(object: MediaObject): StoredMediaObject {
  const { bytes: _, ...value } = object;
  return value;
}

function contentType(key: string) {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}
