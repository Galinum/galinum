import { sha256 } from "@noble/hashes/sha2.js";
import { installationSchemas, type InstallationState } from "@galinum/contracts";
import { GalinumError } from "./types.js";

type Schema = { $ref?: string; type?: string | readonly string[]; enum?: readonly unknown[]; properties?: Record<string, Schema>; required?: readonly string[]; additionalProperties?: boolean; items?: Schema; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; maxItems?: number; uniqueItems?: boolean };
function valid(value: unknown, schema: Schema): boolean {
  if (schema.$ref) return valid(value, installationSchemas[schema.$ref.split("/").at(-1) as keyof typeof installationSchemas] as Schema);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isSafeInteger(value) ? "integer" : typeof value;
  if (!types.includes(kind) || schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === "number" && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (typeof value === "string" && (Array.from(value).length < (schema.minLength ?? 0) || Array.from(value).length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  if (Array.isArray(value)) return value.length <= (schema.maxItems ?? Infinity) && (!schema.uniqueItems || new Set(value).size === value.length) && value.every(item => valid(item, schema.items!));
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return (schema.required ?? []).every(key => key in object) && Object.entries(object).every(([key, item]) => schema.properties?.[key] ? valid(item, schema.properties[key]) : schema.additionalProperties !== false);
  }
  return true;
}
export function parseInstallation(value: unknown): InstallationState {
  if (!valid(value, installationSchemas.InstallationResponse as Schema)) throw new GalinumError("invalid_response");
  return (value as { installation: InstallationState }).installation;
}
export function copyJson<T>(value: T): T {
  try { return JSON.parse(JSON.stringify(value)) as T; } catch { throw new GalinumError("invalid_input"); }
}
export function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function digest(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), byte => byte.toString(16).padStart(2, "0")).join("");
}
