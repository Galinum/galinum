import { validateImageFile, type MediaStore } from "@galinum/core";
import { readBody } from "./request-body.js";
import type { OperationHandler } from "./router.js";

const campaignMediaPolicy = {
  formats: ["png", "jpeg", "webp", "gif"],
  maxBytes: 4 * 1024 * 1024,
  maxDimension: 4096,
} as const;

const maxRequestBytes = campaignMediaPolicy.maxBytes + 256 * 1024;

function bearer(request: Request) {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

export function createUploadCampaignMediaHandler(input: {
  projectId: string;
  secretKey: string;
  media: MediaStore;
}): OperationHandler {
  return async (request) => {
    if (bearer(request) !== input.secretKey) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const buffered = await readBody(request, maxRequestBytes);
    if (!buffered.ok && buffered.status === 413) {
      return Response.json(
        { error: `Uploads must be ${Math.floor(campaignMediaPolicy.maxBytes / (1024 * 1024))} MB or smaller` },
        { status: 413 },
      );
    }
    if (!buffered.ok) return Response.json({ error: "Invalid multipart request" }, { status: 400 });
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    let form: FormData;
    try {
      form = await new Request(request.url, { method: "POST", headers, body: buffered.value as BodyInit }).formData();
    } catch {
      return Response.json({ error: "Invalid multipart request" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "file is required" }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const validation = validateImageFile(bytes, file.type, {
      formats: [...campaignMediaPolicy.formats],
      maxBytes: campaignMediaPolicy.maxBytes,
      maxDimension: campaignMediaPolicy.maxDimension,
    });
    if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 });
    let stored;
    try {
      stored = await input.media.put({
        projectId: input.projectId,
        bytes,
        contentType: validation.contentType,
        extension: validation.extension,
      });
    } catch {
      return Response.json({ error: "Media upload failed" }, { status: 502 });
    }
    return Response.json({
      media: {
        url: input.media.publicUrl(stored.path),
        contentType: stored.contentType,
        width: validation.info.width,
        height: validation.info.height,
        sizeBytes: stored.sizeBytes,
      },
    }, { status: 201 });
  };
}
