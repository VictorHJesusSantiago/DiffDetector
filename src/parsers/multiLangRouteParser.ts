import type { CodeEndpoint, HttpMethod } from "../core/types.js";
import type { ScanSource, SourceFile } from "../core/scanSource.js";
import { normalizePath } from "./codeParser.js";

/**
 * Saídas de build de linguagens compiladas: um `.class` decompilado ou um fonte copiado para
 * `target/` reintroduziria endpoints que já não existem. Aplicado só aqui — `bin/` em projetos
 * JS costuma conter entrypoints de CLI legítimos, que o codeParser precisa continuar vendo.
 */
const COMPILED_OUTPUT_DIRS = ["target", "bin", "obj", "vendor"];

interface EndpointPattern {
  readonly regex: RegExp;
  readonly methodGroup: number;
  readonly pathGroup: number;
}

interface LanguageSpec {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly patterns: readonly EndpointPattern[];
}

/**
 * Cada linguagem vira dados (regex + índice dos grupos), não uma função. As seis funções
 * `extractX` anteriores eram o mesmo laço copiado seis vezes, com a única diferença sendo qual
 * grupo capturava o método e qual capturava o caminho — variação que agora é declarada.
 */
const LANGUAGES: readonly LanguageSpec[] = [
  {
    id: "java",
    extensions: ["java"],
    patterns: [
      // Spring: @GetMapping("/x")
      { regex: /@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/g, methodGroup: 1, pathGroup: 2 },
      // Spring: @RequestMapping(value = "/x", method = RequestMethod.POST)
      {
        regex:
          /@RequestMapping\s*\(\s*(?:value\s*=\s*)?"([^"]+)"[^)]*method\s*=\s*RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/g,
        methodGroup: 2,
        pathGroup: 1,
      },
    ],
  },
  {
    id: "go",
    extensions: ["go"],
    patterns: [
      // gin/chi: router.GET("/x", handler)
      { regex: /\b(?:router|r|engine|e|mux|group)\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/g, methodGroup: 1, pathGroup: 2 },
      // gorilla/mux: r.HandleFunc("/x", h).Methods("GET")
      { regex: /HandleFunc\s*\(\s*"([^"]+)"[^)]*\)\.Methods\s*\(\s*"(GET|POST|PUT|PATCH|DELETE)"/g, methodGroup: 2, pathGroup: 1 },
    ],
  },
  {
    id: "ruby",
    extensions: ["rb"],
    // Rails routes.rb: get '/x', to: 'controller#action'
    patterns: [{ regex: /\b(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi, methodGroup: 1, pathGroup: 2 }],
  },
  {
    id: "php",
    extensions: ["php"],
    patterns: [
      // Laravel: Route::get('/x', ...)
      { regex: /Route::(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi, methodGroup: 1, pathGroup: 2 },
      // Symfony: #[Route('/x', methods: ['GET'])]
      {
        regex: /#\[Route\s*\(\s*['"]([^'"]+)['"][^\]]*methods:\s*\[\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/gi,
        methodGroup: 2,
        pathGroup: 1,
      },
    ],
  },
  {
    id: "csharp",
    extensions: ["cs"],
    // ASP.NET: [HttpGet("x")]
    patterns: [{ regex: /\[Http(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"\s*\)\]/g, methodGroup: 1, pathGroup: 2 }],
  },
  {
    id: "rust",
    extensions: ["rs"],
    patterns: [
      // actix-web: #[get("/x")]
      { regex: /#\[(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*\)\]/gi, methodGroup: 1, pathGroup: 2 },
      // axum: .route("/x", get(handler))
      { regex: /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\s*\(/gi, methodGroup: 2, pathGroup: 1 },
    ],
  },
];

const SPEC_BY_EXTENSION = new Map<string, LanguageSpec>(
  LANGUAGES.flatMap((spec) => spec.extensions.map((extension) => [extension, spec] as const)),
);

function extractEndpoints(file: SourceFile, spec: LanguageSpec): CodeEndpoint[] {
  const endpoints: CodeEndpoint[] = [];
  for (const pattern of spec.patterns) {
    for (const match of file.content.matchAll(pattern.regex)) {
      endpoints.push({
        method: match[pattern.methodGroup].toUpperCase() as HttpMethod,
        path: normalizePath(match[pattern.pathGroup]),
        file: file.relPath,
        line: file.lines.lineAt(match.index),
      });
    }
  }
  return endpoints;
}

/**
 * Extrai endpoints HTTP de linguagens além de JS/TS/Python: Java (Spring), Go (gin/mux),
 * Ruby (Rails routes.rb), PHP (Laravel/Symfony), C# (ASP.NET) e Rust (actix-web/axum).
 * Todas alimentam o mesmo `CodeFacts.endpoints` usado pelo motor de drift — nenhum tipo
 * novo de achado é necessário.
 */
export async function parseMultiLangRoutes(source: ScanSource): Promise<CodeEndpoint[]> {
  return source.collect<CodeEndpoint>(
    "multiLangRoutes",
    { extensions: [...SPEC_BY_EXTENSION.keys()], excludeDirectories: COMPILED_OUTPUT_DIRS },
    (file) => {
      const extension = file.relPath.split(".").pop()?.toLowerCase() ?? "";
      const spec = SPEC_BY_EXTENSION.get(extension);
      return spec ? extractEndpoints(file, spec) : [];
    },
  );
}
