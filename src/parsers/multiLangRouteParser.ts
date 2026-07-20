import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { CodeEndpoint, HttpMethod } from "../core/types.js";
import { normalizePath } from "./codeParser.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/vendor/**", "**/target/**", "**/bin/**", "**/obj/**"];

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

interface LanguageSpec {
  extensions: string[];
  extract: (relFile: string, content: string) => CodeEndpoint[];
}

// Java/Spring: @GetMapping("/x"), @RequestMapping(value = "/x", method = RequestMethod.POST)
function extractJava(relFile: string, content: string): CodeEndpoint[] {
  const endpoints: CodeEndpoint[] = [];
  const mappingRe = /@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/g;
  for (const match of content.matchAll(mappingRe)) {
    endpoints.push({
      method: match[1].toUpperCase() as HttpMethod,
      path: normalizePath(match[2]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }
  const requestMappingRe =
    /@RequestMapping\s*\(\s*(?:value\s*=\s*)?"([^"]+)"[^)]*method\s*=\s*RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/g;
  for (const match of content.matchAll(requestMappingRe)) {
    endpoints.push({
      method: match[2].toUpperCase() as HttpMethod,
      path: normalizePath(match[1]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }
  return endpoints;
}

// Go: gin/chi/mux — router.GET("/x", handler), r.HandleFunc("/x", h).Methods("GET")
function extractGo(relFile: string, content: string): CodeEndpoint[] {
  const endpoints: CodeEndpoint[] = [];
  const ginRe = /\b(?:router|r|engine|e|mux|group)\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/g;
  for (const match of content.matchAll(ginRe)) {
    endpoints.push({
      method: match[1].toUpperCase() as HttpMethod,
      path: normalizePath(match[2]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }
  const muxRe = /HandleFunc\s*\(\s*"([^"]+)"[^)]*\)\.Methods\s*\(\s*"(GET|POST|PUT|PATCH|DELETE)"/g;
  for (const match of content.matchAll(muxRe)) {
    endpoints.push({
      method: match[2].toUpperCase() as HttpMethod,
      path: normalizePath(match[1]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }
  return endpoints;
}

// Ruby on Rails: get '/x', to: 'controller#action' (config/routes.rb)
function extractRuby(relFile: string, content: string): CodeEndpoint[] {
  const endpoints: CodeEndpoint[] = [];
  const railsRe = /\b(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi;
  for (const match of content.matchAll(railsRe)) {
    endpoints.push({
      method: match[1].toUpperCase() as HttpMethod,
      path: normalizePath(match[2]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }
  return endpoints;
}

// PHP Laravel/Symfony: Route::get('/x', ...); #[Route('/x', methods: ['GET'])]
function extractPhp(relFile: string, content: string): CodeEndpoint[] {
  const endpoints: CodeEndpoint[] = [];
  const laravelRe = /Route::(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi;
  for (const match of content.matchAll(laravelRe)) {
    endpoints.push({
      method: match[1].toUpperCase() as HttpMethod,
      path: normalizePath(match[2]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }
  const symfonyRe = /#\[Route\s*\(\s*['"]([^'"]+)['"][^\]]*methods:\s*\[\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/gi;
  for (const match of content.matchAll(symfonyRe)) {
    endpoints.push({
      method: match[2].toUpperCase() as HttpMethod,
      path: normalizePath(match[1]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }
  return endpoints;
}

// C# ASP.NET: [HttpGet("x")], [Route("x")]
function extractCSharp(relFile: string, content: string): CodeEndpoint[] {
  const endpoints: CodeEndpoint[] = [];
  const attrRe = /\[Http(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"\s*\)\]/g;
  for (const match of content.matchAll(attrRe)) {
    endpoints.push({
      method: match[1].toUpperCase() as HttpMethod,
      path: normalizePath(match[2]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }
  return endpoints;
}

// Rust actix-web/axum: .route("/x", get(handler)); #[get("/x")]
function extractRust(relFile: string, content: string): CodeEndpoint[] {
  const endpoints: CodeEndpoint[] = [];
  const actixAttrRe = /#\[(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*\)\]/gi;
  for (const match of content.matchAll(actixAttrRe)) {
    endpoints.push({
      method: match[1].toUpperCase() as HttpMethod,
      path: normalizePath(match[2]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }
  const axumRouteRe = /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\s*\(/gi;
  for (const match of content.matchAll(axumRouteRe)) {
    endpoints.push({
      method: match[2].toUpperCase() as HttpMethod,
      path: normalizePath(match[1]),
      file: relFile,
      line: lineOf(content, match.index ?? 0),
    });
  }
  return endpoints;
}

const LANGUAGES: LanguageSpec[] = [
  { extensions: ["java"], extract: extractJava },
  { extensions: ["go"], extract: extractGo },
  { extensions: ["rb"], extract: extractRuby },
  { extensions: ["php"], extract: extractPhp },
  { extensions: ["cs"], extract: extractCSharp },
  { extensions: ["rs"], extract: extractRust },
];

/**
 * Extrai endpoints HTTP de linguagens além de JS/TS/Python: Java (Spring), Go (gin/mux),
 * Ruby (Rails routes.rb), PHP (Laravel/Symfony), C# (ASP.NET) e Rust (actix-web/axum).
 * Todas alimentam o mesmo `CodeFacts.endpoints` usado pelo motor de drift — nenhum tipo
 * novo de achado é necessário.
 */
export async function parseMultiLangRoutes(codeDir: string): Promise<CodeEndpoint[]> {
  const allExtensions = LANGUAGES.flatMap((l) => l.extensions);
  const files = await fg(`**/*.{${allExtensions.join(",")}}`, {
    cwd: codeDir,
    ignore: DEFAULT_IGNORE,
    absolute: false,
  });

  const endpoints: CodeEndpoint[] = [];
  for (const relFile of files) {
    const ext = relFile.split(".").pop() ?? "";
    const spec = LANGUAGES.find((l) => l.extensions.includes(ext));
    if (!spec) continue;
    let content: string;
    try {
      content = await readFile(`${codeDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    endpoints.push(...spec.extract(relFile, content));
  }
  return endpoints;
}
