import { parse as parseYaml } from "yaml";
import type { DocEndpointRef, HttpMethod } from "../core/types.js";
import type { ScanSource } from "../core/scanSource.js";
import { normalizePath } from "./codeParser.js";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
const SPEC_BASENAME_RE = /(openapi|swagger).*\.(ya?ml|json)$/i;

interface OpenApiDoc {
  paths?: Record<string, unknown>;
}

/**
 * Trata specs OpenAPI/Swagger (.yaml/.yml/.json com bloco "paths") como fonte de
 * documentação estruturada, contrato formal — normalmente mais confiável que Markdown solto.
 */
export async function parseOpenApiSpecs(source: ScanSource): Promise<DocEndpointRef[]> {
  return source.collect<DocEndpointRef>("openapi", { basenamePattern: SPEC_BASENAME_RE }, (file) => {
    let parsed: unknown;
    try {
      parsed = file.relPath.endsWith(".json") ? JSON.parse(file.content) : parseYaml(file.content);
    } catch {
      // Spec malformado: nada a extrair. É dado de entrada de terceiro, não configuração
      // deste programa — não deve derrubar o scan.
      return [];
    }
    const doc = parsed as OpenApiDoc | null | undefined;
    if (!doc?.paths || typeof doc.paths !== "object") return [];

    const refs: DocEndpointRef[] = [];
    for (const [rawPath, operations] of Object.entries(doc.paths)) {
      if (!operations || typeof operations !== "object") continue;
      for (const rawMethod of Object.keys(operations)) {
        const method = rawMethod.toUpperCase() as HttpMethod;
        if (!HTTP_METHODS.includes(method)) continue;
        refs.push({
          method,
          path: normalizePath(rawPath),
          file: file.relPath,
          line: 1,
          context: `${method} ${rawPath} (OpenAPI)`,
        });
      }
    }
    return refs;
  });
}
