export type BodyReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413 };

export async function readBody(request: Request, maxBytes: number): Promise<BodyReadResult<Uint8Array>> {
  const declaredValue = request.headers.get("content-length");
  const declared = declaredValue === null ? null : Number(declaredValue);
  if (declared !== null && Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };
  if (!request.body) return { ok: true, value: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) return { ok: false, status: 413 };
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }
  return { ok: true, value: Buffer.concat(chunks, size) };
}

export async function readJsonObject(
  request: Request,
  maxBytes: number,
): Promise<BodyReadResult<Record<string, unknown>>> {
  const buffered = await readBody(request, maxBytes);
  if (!buffered.ok) return buffered;
  try {
    const parsed = JSON.parse(Buffer.from(buffered.value).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, status: 400 };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400 };
  }
}
