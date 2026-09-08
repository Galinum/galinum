import { createHash } from "node:crypto";
import type { PushTransaction } from "./types.js";
export class PushError extends Error { constructor(public status: number, message: string) { super(message); } }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export async function nextOrder(tx: PushTransaction) { const clock = await tx.getPushRecord("clock", "clock") ?? { id: "clock", value: 0 }; clock.value++; await tx.savePushControl("clock", clock); return clock.value; }
