import type { DocEndpointRef, HttpMethod } from "../core/types.js";
import type { ScanSource } from "../core/scanSource.js";
import { normalizePath } from "./codeParser.js";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

// Comentários JSDoc/TSDoc do tipo `@route GET /x` ou `@swagger GET /x` — "documentação embutida"
// no próprio código-fonte, distinta de código executável, mas ainda assim documentação.
const ROUTE_TAG_RE = /@(?:route|swagger)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/[^\s*]*)/gi;

export async function parseJsDocRoutes(source: ScanSource): Promise<DocEndpointRef[]> {
  return source.collect<DocEndpointRef>("jsdoc", { extensions: ["js", "ts", "jsx", "tsx"] }, (file) => {
    const refs: DocEndpointRef[] = [];
    for (const match of file.content.matchAll(ROUTE_TAG_RE)) {
      const method = match[1].toUpperCase() as HttpMethod;
      if (!HTTP_METHODS.includes(method)) continue;
      refs.push({
        method,
        path: normalizePath(match[2]),
        file: file.relPath,
        line: file.lines.lineAt(match.index),
        context: `@route ${method} ${match[2]} (JSDoc embutido)`,
      });
    }
    return refs;
  });
}
