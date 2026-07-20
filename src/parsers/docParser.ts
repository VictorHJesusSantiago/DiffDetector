import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { DocEndpointRef, DocEnvVarRef, DocFacts, HttpMethod } from "../core/types.js";
import { normalizePath } from "./codeParser.js";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

// Casa "GET /api/users/:id", "`POST /users`", "curl -X GET https://host/api/x"
const METHOD_PATH_RE =
  /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(?:https?:\/\/[^\s'"`]+)?(\/[a-zA-Z0-9_\-/:{}<>.]*)/g;

// Variáveis de ambiente citadas em texto solto: `DATABASE_URL`, ENV: FOO_BAR, etc. (exige "_" para reduzir falsos positivos)
const ENV_VAR_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

// Variáveis de ambiente citadas entre crases, mesmo sem "_": `PORT`, `TOKEN`
const ENV_VAR_BACKTICK_RE = /`([A-Z][A-Z0-9_]{1,})`/g;

const DOC_EXTENSIONS = ["md", "mdx"];
const DEFAULT_IGNORE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**"];

// Palavras comuns em maiúsculas que não são variáveis de ambiente (evita falsos positivos)
const ENV_STOPWORDS = new Set([
  "HTTP_GET",
  "HTTP_POST",
  "README_MD",
  "TODO_LIST",
  "API_KEY_HERE",
]);

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function lineTextAt(content: string, line: number): string {
  const lines = content.split("\n");
  return (lines[line - 1] ?? "").trim().slice(0, 200);
}

/** Extrai endpoints e env vars citados em um bloco de texto solto (Markdown, ou HTML já sem tags). */
export function extractDocFactsFromText(relFile: string, content: string): DocFacts {
  const endpoints: DocEndpointRef[] = [];
  const envVars: DocEnvVarRef[] = [];
  const seenEndpoint = new Set<string>();
  const seenEnv = new Set<string>();

  for (const match of content.matchAll(METHOD_PATH_RE)) {
    const method = match[1].toUpperCase() as HttpMethod;
    if (!HTTP_METHODS.includes(method)) continue;
    const rawPath = match[2];
    if (!rawPath || rawPath === "/") continue;
    const path = normalizePath(rawPath);
    const line = lineOf(content, match.index ?? 0);
    const key = `${relFile}:${method} ${path}:${line}`;
    if (seenEndpoint.has(key)) continue;
    seenEndpoint.add(key);
    endpoints.push({ method, path, file: relFile, line, context: lineTextAt(content, line) });
  }

  const envMatches = [...content.matchAll(ENV_VAR_RE), ...content.matchAll(ENV_VAR_BACKTICK_RE)];
  for (const match of envMatches) {
    const name = match[1];
    if (ENV_STOPWORDS.has(name) || HTTP_METHODS.includes(name as HttpMethod)) continue;
    const line = lineOf(content, match.index ?? 0);
    const key = `${relFile}:${name}:${line}`;
    if (seenEnv.has(key)) continue;
    seenEnv.add(key);
    envVars.push({ name, file: relFile, line, context: lineTextAt(content, line) });
  }

  return { endpoints, envVars };
}

export async function parseDocsDirectory(docsDir: string): Promise<DocFacts> {
  const files = await fg(`**/*.{${DOC_EXTENSIONS.join(",")}}`, {
    cwd: docsDir,
    ignore: DEFAULT_IGNORE,
    absolute: false,
  });

  const endpoints: DocEndpointRef[] = [];
  const envVars: DocEnvVarRef[] = [];

  for (const relFile of files) {
    const fullPath = `${docsDir}/${relFile}`;
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const facts = extractDocFactsFromText(relFile, content);
    endpoints.push(...facts.endpoints);
    envVars.push(...facts.envVars);
  }

  return { endpoints, envVars: dedupeEnvRefs(envVars) };
}

function dedupeEnvRefs(items: DocEnvVarRef[]): DocEnvVarRef[] {
  const map = new Map<string, DocEnvVarRef>();
  for (const item of items) {
    if (!map.has(item.name)) map.set(item.name, item);
  }
  return [...map.values()];
}
