import type { JsonSchema } from "./schema.js";
import { COMPONENTS, buildOpenApiDocument } from "./spec.js";
import { toYaml } from "./yaml.js";

export const GENERATED_BANNER = [
  "// GENERATED FILE - do not edit.",
  "// Source: src/contracts/spec.ts. Regenerate with `pnpm openapi`.",
  "// The contract test fails when this file and the spec disagree.",
].join("\n");

/** Render one schema as a TypeScript type. */
export function tsType(schema: JsonSchema): string {
  if (schema.enum !== undefined) {
    const union = schema.enum.map((value) => JSON.stringify(value)).join(" | ");
    return schema.nullable === true ? `${union} | null` : union;
  }

  let rendered: string;
  switch (schema.type) {
    case "string":
      rendered = "string";
      break;
    case "number":
    case "integer":
      rendered = "number";
      break;
    case "boolean":
      rendered = "boolean";
      break;
    case "null":
      rendered = "null";
      break;
    case "array":
      rendered = schema.items === undefined ? "unknown[]" : `Array<${tsType(schema.items)}>`;
      break;
    case "object": {
      if (schema.properties === undefined) {
        rendered = "Record<string, unknown>";
        break;
      }
      const required = new Set(schema.required ?? []);
      const lines = Object.entries(schema.properties).map(([key, property]) => {
        const optional = required.has(key) ? "" : "?";
        return `  ${key}${optional}: ${tsType(property)};`;
      });
      rendered = `{\n${lines.join("\n")}\n}`;
      break;
    }
    default:
      rendered = "unknown";
  }

  return schema.nullable === true ? `${rendered} | null` : rendered;
}

/** Render every component as an exported interface, in spec order. */
export function renderTypeScript(components: Record<string, JsonSchema> = COMPONENTS): string {
  const blocks = Object.entries(components).map(([name, schema]) => {
    const description =
      schema.description === undefined
        ? ""
        : `/** ${schema.description.replace(/\*\//g, "*\\/")} */\n`;
    return `${description}export interface ${name} ${tsType(schema)}`;
  });

  return `${GENERATED_BANNER}\n\n${blocks.join("\n\n")}\n`;
}

/** Render the committed `openapi.yaml` from the single source of truth. */
export function renderOpenApiYaml(): string {
  return toYaml(buildOpenApiDocument());
}
