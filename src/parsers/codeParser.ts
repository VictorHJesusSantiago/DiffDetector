import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { CodeEndpoint, CodeEnvVar, CodeFacts, HttpMethod } from "../core/types.js";
import type { ParseCache } from "../core/parseCache.js";
import { parseWithAst } from "./tsAstParser.js";

const AST_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);

const DEFAULT_IGNORE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/coverage/**"];

const CODE_EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "py"];

function normalizePath(rawPath: string): string {
  let p = rawPath.trim();
  if (!p.startsWith("/")) p = "/" + p;
  // remove barra final exceto raiz
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  // normaliza parâmetros estilo flask/fastapi <id> ou {id} para :id
  p = p.replace(/[{<]([a-zA-Z_][a-zA-Z0-9_]*)[}>]/g, ":$1");
  return p;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function parseFileContent(relFile: string, content: string): { endpoints: CodeEndpoint[]; envVars: CodeEnvVar[] } {
  const ext = relFile.split(".").pop() ?? "";

  // Para JS/TS, usamos a árvore sintática real (typescript compiler API) como fonte primária:
  // não é enganado por comentários, strings dentro de outras expressões, ou formatação incomum.
  if (AST_EXTENSIONS.has(ext)) {
    return parseWithAst(relFile, content);
  }

  // Python (sem AST disponível aqui): rotas Flask/FastAPI e variáveis de ambiente via regex.
  const endpoints: CodeEndpoint[] = [];
  const envVars: CodeEnvVar[] = [];

  const pyRouteRe =
    /@(?:app|router|blueprint|bp)\.(get|post|put|patch|delete|options|head)\s*\(\s*(['"])([^'"]+)\2/gi;
  for (const match of content.matchAll(pyRouteRe)) {
    endpoints.push({
      method: match[1].toUpperCase() as HttpMethod,
      path: normalizePath(match[3]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }

  const pyEnvRe = /os\.(?:environ\.get|getenv|environ\[)\s*\(?\s*['"]([A-Z][A-Z0-9_]*)['"]/g;
  for (const match of content.matchAll(pyEnvRe)) {
    envVars.push({ name: match[1], file: relFile, line: lineOf(content, match.index ?? 0) });
  }

  return { endpoints, envVars };
}

export async function parseCodeDirectory(codeDir: string, cache?: ParseCache): Promise<CodeFacts> {
  const files = await fg(`**/*.{${CODE_EXTENSIONS.join(",")}}`, {
    cwd: codeDir,
    ignore: DEFAULT_IGNORE,
    absolute: false,
  });

  const endpoints: CodeEndpoint[] = [];
  const envVars: CodeEnvVar[] = [];

  for (const relFile of files) {
    const fullPath = `${codeDir}/${relFile}`;

    if (cache) {
      const cached = await cache.get(fullPath, relFile);
      if (cached) {
        endpoints.push(...cached.endpoints);
        envVars.push(...cached.envVars);
        continue;
      }
    }

    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    const facts = parseFileContent(relFile, content);
    endpoints.push(...facts.endpoints);
    envVars.push(...facts.envVars);

    if (cache) await cache.set(fullPath, relFile, facts);
  }

  return { endpoints: dedupeEndpoints(endpoints), envVars: dedupeEnvVars(envVars) };
}

function dedupeEndpoints(items: CodeEndpoint[]): CodeEndpoint[] {
  const map = new Map<string, CodeEndpoint>();
  for (const item of items) {
    const key = `${item.method} ${item.path}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function dedupeEnvVars(items: CodeEnvVar[]): CodeEnvVar[] {
  const map = new Map<string, CodeEnvVar>();
  for (const item of items) {
    if (!map.has(item.name)) map.set(item.name, item);
  }
  return [...map.values()];
}

export { normalizePath };
