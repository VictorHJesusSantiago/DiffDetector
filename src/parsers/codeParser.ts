import type { CodeEndpoint, CodeEnvVar, CodeFacts, HttpMethod } from "../core/types.js";
import type { ScanSource, SourceFile } from "../core/scanSource.js";
import { parseWithAst } from "./tsAstParser.js";

const AST_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);
const CODE_EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "py"];

interface FileFacts {
  endpoints: CodeEndpoint[];
  envVars: CodeEnvVar[];
}

function normalizePath(rawPath: string): string {
  let p = rawPath.trim();
  if (!p.startsWith("/")) p = "/" + p;
  // remove barra final exceto raiz
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  // normaliza parâmetros estilo flask/fastapi <id> ou {id} para :id
  p = p.replace(/[{<]([a-zA-Z_][a-zA-Z0-9_]*)[}>]/g, ":$1");
  return p;
}

export function parseFileContent(file: SourceFile): FileFacts {
  const extension = file.relPath.split(".").pop() ?? "";

  // Para JS/TS, usamos a árvore sintática real (typescript compiler API) como fonte primária:
  // não é enganado por comentários, strings dentro de outras expressões, ou formatação incomum.
  if (AST_EXTENSIONS.has(extension.toLowerCase())) {
    return parseWithAst(file.relPath, file.content);
  }

  // Python (sem AST disponível aqui): rotas Flask/FastAPI e variáveis de ambiente via regex.
  const endpoints: CodeEndpoint[] = [];
  const envVars: CodeEnvVar[] = [];

  const pyRouteRe =
    /@(?:app|router|blueprint|bp)\.(get|post|put|patch|delete|options|head)\s*\(\s*(['"])([^'"]+)\2/gi;
  for (const match of file.content.matchAll(pyRouteRe)) {
    endpoints.push({
      method: match[1].toUpperCase() as HttpMethod,
      path: normalizePath(match[3]),
      file: file.relPath,
      line: file.lines.lineAt(match.index),
    });
  }

  const pyEnvRe = /os\.(?:environ\.get|getenv|environ\[)\s*\(?\s*['"]([A-Z][A-Z0-9_]*)['"]/g;
  for (const match of file.content.matchAll(pyEnvRe)) {
    envVars.push({ name: match[1], file: file.relPath, line: file.lines.lineAt(match.index) });
  }

  return { endpoints, envVars };
}

export async function parseCodeDirectory(source: ScanSource): Promise<CodeFacts> {
  const perFile = await source.collect<FileFacts>("codeParser", { extensions: CODE_EXTENSIONS }, (file) => [
    parseFileContent(file),
  ]);

  const endpoints = perFile.flatMap((facts) => facts.endpoints);
  const envVars = perFile.flatMap((facts) => facts.envVars);

  return { endpoints: dedupeEndpoints(endpoints), envVars: dedupeEnvVars(envVars) };
}

function dedupeEndpoints(items: readonly CodeEndpoint[]): CodeEndpoint[] {
  const map = new Map<string, CodeEndpoint>();
  for (const item of items) {
    const key = `${item.method} ${item.path}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function dedupeEnvVars(items: readonly CodeEnvVar[]): CodeEnvVar[] {
  const map = new Map<string, CodeEnvVar>();
  for (const item of items) {
    if (!map.has(item.name)) map.set(item.name, item);
  }
  return [...map.values()];
}

export { normalizePath };
