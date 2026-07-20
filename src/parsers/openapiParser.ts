import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import type { DocEndpointRef, HttpMethod } from "../core/types.js";
import { normalizePath } from "./codeParser.js";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**"];

interface OpenApiDoc {
  paths?: Record<string, Record<string, unknown>>;
}

/**
 * Trata specs OpenAPI/Swagger (.yaml/.yml/.json com bloco "paths") como fonte de
 * documentação estruturada, contrato formal — normalmente mais confiável que Markdown solto.
 */
export async function parseOpenApiSpecs(docsDir: string): Promise<DocEndpointRef[]> {
  const files = await fg(["**/*openapi*.{yaml,yml,json}", "**/*swagger*.{yaml,yml,json}"], {
    cwd: docsDir,
    ignore: DEFAULT_IGNORE,
    absolute: false,
    caseSensitiveMatch: false,
  });

  const refs: DocEndpointRef[] = [];

  for (const relFile of files) {
    const fullPath = `${docsDir}/${relFile}`;
    let raw: string;
    try {
      raw = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    let doc: OpenApiDoc | undefined;
    try {
      doc = relFile.endsWith(".json") ? JSON.parse(raw) : (parseYaml(raw) as OpenApiDoc);
    } catch {
      continue;
    }
    if (!doc?.paths) continue;

    for (const [rawPath, operations] of Object.entries(doc.paths)) {
      if (!operations || typeof operations !== "object") continue;
      for (const rawMethod of Object.keys(operations)) {
        const method = rawMethod.toUpperCase() as HttpMethod;
        if (!HTTP_METHODS.includes(method)) continue;
        refs.push({
          method,
          path: normalizePath(rawPath),
          file: relFile,
          line: 1,
          context: `${method} ${rawPath} (OpenAPI)`,
        });
      }
    }
  }

  return refs;
}
