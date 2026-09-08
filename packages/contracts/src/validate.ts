export type WireSchema = { $ref?: string; type?: string | readonly string[]; enum?: readonly unknown[]; oneOf?: readonly WireSchema[]; properties?: Readonly<Record<string, WireSchema>>; required?: readonly string[]; additionalProperties?: boolean | WireSchema; items?: WireSchema; minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number; maxItems?: number; minItems?: number; maxProperties?: number; uniqueItems?: boolean };
export function validateSchema(schema: WireSchema, value: unknown, schemas: Readonly<Record<string, WireSchema>>): boolean {
  if (schema.$ref) { const resolved = schemas[schema.$ref.split("/").at(-1)!]; return !!resolved && validateSchema(resolved, value, schemas); }
  if (schema.oneOf) return schema.oneOf.filter((child) => validateSchema(child, value, schemas)).length === 1;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.type)) return schema.type.some((type) => validateSchema({ ...schema, type }, value, schemas));
  switch (schema.type) {
    case "null": return value === null;
    case "string": return typeof value === "string" && [...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? Infinity) && (!schema.pattern || new RegExp(schema.pattern).test(value));
    case "number": return typeof value === "number" && Number.isFinite(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && value.every((entry) => validateSchema(schema.items!, entry, schemas)) && (!schema.uniqueItems || new Set(value.map((entry) => JSON.stringify(entry))).size === value.length);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= (schema.maxProperties ?? Infinity) && (schema.required ?? []).every((key) => Object.hasOwn(value, key)) && Object.entries(value).every(([key, entry]) => {
      const field = schema.properties?.[key];
      return field ? validateSchema(field, entry, schemas) : typeof schema.additionalProperties === "object" && validateSchema(schema.additionalProperties, entry, schemas);
    });
    default: return false;
  }
}
