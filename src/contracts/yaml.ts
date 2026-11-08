/**
 * A deliberately small YAML emitter for the generated `openapi.yaml`.
 *
 * The document is plain data (objects, arrays, scalars), so a full YAML dependency
 * would be the only thing this repo needed it for. This emitter handles exactly the
 * shapes the contract builds, and the drift test proves the checked-in file matches
 * it byte for byte.
 */

const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);
const PLAIN = /^[A-Za-z0-9_/][A-Za-z0-9_./-]*$/;
const NUMERIC = /^[-+]?\d+(\.\d+)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  if (value === "") return '""';
  if (PLAIN.test(value) && !RESERVED.has(value.toLowerCase()) && !NUMERIC.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function emitObject(value: Record<string, unknown>, indent: number): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];

  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const renderedKey = yamlScalar(key);

    if (isPlainObject(item)) {
      if (Object.keys(item).length === 0) {
        lines.push(`${pad}${renderedKey}: {}`);
      } else {
        lines.push(`${pad}${renderedKey}:\n${emitObject(item, indent + 2)}`);
      }
      continue;
    }

    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${pad}${renderedKey}: []`);
      } else {
        lines.push(`${pad}${renderedKey}:\n${emitArray(item, indent + 2)}`);
      }
      continue;
    }

    lines.push(`${pad}${renderedKey}: ${yamlScalar(item as string | number | boolean | null)}`);
  }

  return lines.join("\n");
}

function emitArray(items: unknown[], indent: number): string {
  const pad = " ".repeat(indent);

  return items
    .map((item) => {
      if (isPlainObject(item)) {
        if (Object.keys(item).length === 0) return `${pad}- {}`;
        const nested = emitObject(item, indent + 2).split("\n");
        nested[0] = `${pad}- ${(nested[0] ?? "").trimStart()}`;
        return nested.join("\n");
      }
      if (Array.isArray(item)) {
        if (item.length === 0) return `${pad}- []`;
        const nested = emitArray(item, indent + 2).split("\n");
        nested[0] = `${pad}- ${(nested[0] ?? "").trimStart()}`;
        return nested.join("\n");
      }
      return `${pad}- ${yamlScalar(item as string | number | boolean | null)}`;
    })
    .join("\n");
}

export function toYaml(value: unknown): string {
  if (isPlainObject(value)) return `${emitObject(value, 0)}\n`;
  if (Array.isArray(value)) return `${emitArray(value, 0)}\n`;
  return `${yamlScalar(value as string | number | boolean | null)}\n`;
}
