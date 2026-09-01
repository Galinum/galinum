import type { ActivityCursor } from "@galinum/core/contract";

export * from "@galinum/core/contract";

export function encodeActivityCursor(cursor: ActivityCursor) {
  return Buffer.from(`${cursor.occurredAt}.${cursor.kind}.${cursor.id}`, "utf8").toString("base64url");
}

export function decodeActivityCursor(value: string): ActivityCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(".");
  const kindEnd = decoded.indexOf(".", separator + 1);
  if (separator < 1 || kindEnd < 0) return null;
  const occurredAt = Number(decoded.slice(0, separator));
  const kind = decoded.slice(separator + 1, kindEnd);
  const id = decoded.slice(kindEnd + 1);
  if (!/^-?\d+$/.test(decoded.slice(0, separator)) || !Number.isSafeInteger(occurredAt)) return null;
  if (kind !== "delivery" && kind !== "user") return null;
  if (!id) return null;
  return { occurredAt, kind, id };
}
