import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "$ref", "minimum", "maximum", "minLength", "maxLength", "pattern", "maxItems", "uniqueItems", "description", "example", "oneOf", "minItems", "maxProperties"]);
export function schemaType(schema, schemas) {
  for (const key of Object.keys(schema)) if (!allowed.has(key)) throw new Error(`Unsupported mobile schema keyword: ${key}`);
  if (schema.$ref) {
    if (Object.keys(schema).some((key) => !["$ref", "description", "example", "oneOf", "minItems", "maxProperties"].includes(key))) throw new Error("Mobile references cannot have constraint siblings");
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (!schemas[name] || schema.$ref !== `#/components/schemas/${name}`) throw new Error(`Unknown mobile schema: ${schema.$ref}`);
    return name;
  }
  if (schema.oneOf) {
    if (!schema.oneOf.length) throw new Error("Unsupported mobile schema keyword: empty oneOf");
    return schema.oneOf.map((child) => `(${schemaType(child, schemas)})`).join(" | ");
  }
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.map((type) => schemaType({ ...schema, type }, schemas)).join(" | ");
  switch (schema.type) {
    case "string": return "string";
    case "integer": case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `(${schemaType(schema.items, schemas)})[]`;
    case "object":
      if (typeof schema.additionalProperties === "object" && !schema.properties) return `{ [key: string]: ${schemaType(schema.additionalProperties, schemas)} }`;
      if (schema.additionalProperties !== false) throw new Error("Mobile objects must declare additionalProperties: false");
      return `{ ${Object.entries(schema.properties).map(([key, value]) => `${JSON.stringify(key)}${schema.required?.includes(key) ? "" : "?"}: ${schemaType(value, schemas)}`).join("; ")} }`;
    default: throw new Error(`Unsupported mobile schema type: ${schema.type}`);
  }
}
export function generateMobile(contract) {
  const bodyBytes = contract["x-installation-body-bytes"];
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes <= 0) throw new Error("Installation body byte limit is required");
  const schemas = Object.fromEntries(Object.entries(contract.components.schemas).filter(([name]) => name.startsWith("Installation") || name.startsWith("Push")));
  const fixtures = Object.entries(schemas).filter(([, schema]) => schema.example !== undefined).map(([name, schema]) => `export const ${name}Example: ${name} = ${JSON.stringify(schema.example, null, 2)};`).join("\n");
  return `export { validateSchema, type WireSchema } from "./validate.js";\n\nexport const INSTALLATION_BODY_BYTES = ${bodyBytes};\n\n` + fixtures + "\n\n" + Object.entries(schemas).map(([name, schema]) => `export type ${name} = ${schemaType(schema, schemas)};`).join("\n") + `\n\nexport const installationSchemas = ${JSON.stringify(schemas, null, 2)} as const;\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "..");
  const output = generateMobile(JSON.parse(readFileSync(resolve(root, "apps/docs/openapi.json"), "utf8")));
  const target = resolve(root, "packages/contracts/src/index.ts");
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== output) throw new Error("Mobile contracts are stale");
  } else writeFileSync(target, output);
  process.stdout.write("VERIFIED mobile installation contracts\n");
}
