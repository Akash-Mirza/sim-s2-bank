import { readFileSync, writeFileSync } from "node:fs";
import { renderOpenApiYaml, renderTypeScript } from "../contracts/codegen.js";

const OPENAPI_PATH = "openapi.yaml";
const TYPES_PATH = "src/contracts/api-types.ts";

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * `pnpm openapi` writes the two generated artifacts.
 * `pnpm openapi:check` fails when either is stale — the same check the contract
 * test runs, exposed as a command for CI and release review.
 */
function main(): void {
  const check = process.argv.includes("--check");
  const artifacts = [
    { path: OPENAPI_PATH, content: renderOpenApiYaml() },
    { path: TYPES_PATH, content: renderTypeScript() },
  ];

  if (check) {
    const stale = artifacts.filter((artifact) => read(artifact.path) !== artifact.content);

    if (stale.length > 0) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "generated contract is stale; run `pnpm openapi`",
          files: stale.map((artifact) => artifact.path),
        }),
      );
      process.exit(1);
    }

    console.log(
      JSON.stringify({ level: "info", msg: "contract is current", files: artifacts.length }),
    );
    return;
  }

  for (const artifact of artifacts) {
    writeFileSync(artifact.path, artifact.content, "utf8");
  }

  console.log(
    JSON.stringify({
      level: "info",
      msg: "contract written",
      openapi: OPENAPI_PATH,
      types: TYPES_PATH,
    }),
  );
}

main();
