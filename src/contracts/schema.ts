/**
 * The JSON Schema subset the S2 contract uses.
 *
 * Keeping the components to flat objects with scalar/array properties is what makes
 * `src/contracts/api-types.ts` generatable without dragging in a schema compiler.
 */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  format?: string;
  description?: string;
  nullable?: boolean;
  enum?: readonly string[];
  required?: readonly string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean;
  minLength?: number;
  maximum?: number;
  example?: string | number | boolean;
}

export const stringSchema = (description?: string): JsonSchema => ({
  type: "string",
  ...(description === undefined ? {} : { description }),
});

export const amountSchema = (description = "AED amount as a decimal string"): JsonSchema => ({
  type: "string",
  description,
  example: "1250.00",
});

export const nullableString = (description?: string): JsonSchema => ({
  type: "string",
  nullable: true,
  ...(description === undefined ? {} : { description }),
});

export const arrayOf = (items: JsonSchema, description?: string): JsonSchema => ({
  type: "array",
  items,
  ...(description === undefined ? {} : { description }),
});

export const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
