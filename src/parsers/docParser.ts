import type { DocEndpointRef, DocEnvVarRef, DocFacts, HttpMethod } from "../core/types.js";
import type { ScanSource, SourceFile } from "../core/scanSource.js";
import { LineIndex } from "../core/lineIndex.js";
import { normalizePath } from "./codeParser.js";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

// Casa "GET /api/users/:id", "`POST /users`", "curl -X GET https://host/api/x"
const METHOD_PATH_RE =
  /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(?:https?:\/\/[^\s'"`]+)?(\/[a-zA-Z0-9_\-/:{}<>.]*)/g;

// Variáveis de ambiente citadas em texto solto: `DATABASE_URL`, ENV: FOO_BAR, etc. (exige "_" para reduzir falsos positivos)
const ENV_VAR_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

// Variáveis de ambiente citadas entre crases, mesmo sem "_": `PORT`, `TOKEN`
const ENV_VAR_BACKTICK_RE = /`([A-Z][A-Z0-9_]{1,})`/g;

export const DOC_EXTENSIONS = ["md", "mdx"];

// Palavras comuns em maiúsculas que não são variáveis de ambiente (evita falsos positivos)
const ENV_STOPWORDS = new Set(["HTTP_GET", "HTTP_POST", "README_MD", "TODO_LIST", "API_KEY_HERE"]);

/** Extrai endpoints e env vars citados em um bloco de texto solto (Markdown, ou HTML já sem tags). */
export function extractDocFacts(file: SourceFile): DocFacts {
  const endpoints: DocEndpointRef[] = [];
  const envVars: DocEnvVarRef[] = [];
  const seenEndpoint = new Set<string>();
  const seenEnv = new Set<string>();
  const { content, lines, relPath } = file;

  for (const match of content.matchAll(METHOD_PATH_RE)) {
    const method = match[1].toUpperCase() as HttpMethod;
    if (!HTTP_METHODS.includes(method)) continue;
    const rawPath = match[2];
    if (!rawPath || rawPath === "/") continue;
    const path = normalizePath(rawPath);
    const line = lines.lineAt(match.index);
    const key = `${method} ${path}:${line}`;
    if (seenEndpoint.has(key)) continue;
    seenEndpoint.add(key);
    endpoints.push({ method, path, file: relPath, line, context: lines.contextAt(match.index) });
  }

  const envMatches = [...content.matchAll(ENV_VAR_RE), ...content.matchAll(ENV_VAR_BACKTICK_RE)];
  for (const match of envMatches) {
    const name = match[1];
    if (ENV_STOPWORDS.has(name) || HTTP_METHODS.includes(name as HttpMethod)) continue;
    const line = lines.lineAt(match.index);
    const key = `${name}:${line}`;
    if (seenEnv.has(key)) continue;
    seenEnv.add(key);
    envVars.push({ name, file: relPath, line, context: lines.contextAt(match.index) });
  }

  return { endpoints, envVars };
}

/** Mantido para quem só tem o texto (ex.: HTML já convertido) e não um SourceFile. */
export function extractDocFactsFromText(relPath: string, content: string): DocFacts {
  return extractDocFacts({ relPath, content, lines: new LineIndex(content) });
}

export async function parseDocsDirectory(source: ScanSource): Promise<DocFacts> {
  const perFile = await source.collect<DocFacts>("docParser", { extensions: DOC_EXTENSIONS }, (file) => [
    extractDocFacts(file),
  ]);

  return {
    endpoints: perFile.flatMap((facts) => facts.endpoints),
    envVars: dedupeEnvRefs(perFile.flatMap((facts) => facts.envVars)),
  };
}

/** Lista os arquivos de documentação Markdown (relativos à raiz do scan). */
export function listDocFiles(source: ScanSource): string[] {
  return source.selectPaths({ extensions: DOC_EXTENSIONS });
}

function dedupeEnvRefs(items: readonly DocEnvVarRef[]): DocEnvVarRef[] {
  const map = new Map<string, DocEnvVarRef>();
  for (const item of items) {
    if (!map.has(item.name)) map.set(item.name, item);
  }
  return [...map.values()];
}
