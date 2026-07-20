import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { DocEndpointRef, HttpMethod } from "../core/types.js";
import { normalizePath } from "./codeParser.js";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**"];

// Comentários JSDoc/TSDoc do tipo `@route GET /x` ou `@swagger GET /x` — "documentação embutida"
// no próprio código-fonte, distinta de código executável, mas ainda assim documentação.
const ROUTE_TAG_RE = /@(?:route|swagger)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/[^\s*]*)/gi;

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

export async function parseJsDocRoutes(codeDir: string): Promise<DocEndpointRef[]> {
  const files = await fg("**/*.{js,ts,jsx,tsx}", { cwd: codeDir, ignore: DEFAULT_IGNORE });
  const refs: DocEndpointRef[] = [];
  for (const relFile of files) {
    let content: string;
    try {
      content = await readFile(`${codeDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    for (const match of content.matchAll(ROUTE_TAG_RE)) {
      const method = match[1].toUpperCase() as HttpMethod;
      if (!HTTP_METHODS.includes(method)) continue;
      const line = lineOf(content, match.index ?? 0);
      refs.push({
        method,
        path: normalizePath(match[2]),
        file: relFile,
        line,
        context: `@route ${method} ${match[2]} (JSDoc embutido)`,
      });
    }
  }
  return refs;
}
