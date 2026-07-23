import type { DependencyRef } from "../core/types.js";
import type { ScanSource, SourceFile } from "../core/scanSource.js";

const REQUIREMENTS_BASENAME_RE = /^requirements.*\.txt$/i;
const REQUIREMENT_LINE_RE = /^([a-zA-Z0-9_.-]+)\s*==\s*([a-zA-Z0-9_.-]+)/;

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Lê dependências declaradas em package.json e requirements.txt (nome + versão real). */
export async function parseCodeDependencies(source: ScanSource): Promise<DependencyRef[]> {
  const [fromPackageJson, fromRequirements] = await Promise.all([
    source.collect<DependencyRef>("packageJson", { where: (entry) => entry.basename === "package.json" }, (file) => {
      let pkg: PackageJson;
      try {
        pkg = JSON.parse(file.content) as PackageJson;
      } catch {
        // package.json malformado no repositório escaneado: nada a declarar.
        return [];
      }
      return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).map(([name, version]) => ({
        name,
        version,
        file: file.relPath,
        line: 1,
      }));
    }),

    source.collect<DependencyRef>("requirementsTxt", { basenamePattern: REQUIREMENTS_BASENAME_RE }, (file) => {
      const deps: DependencyRef[] = [];
      file.content.split("\n").forEach((lineText, index) => {
        const match = REQUIREMENT_LINE_RE.exec(lineText.trim());
        if (match) deps.push({ name: match[1], version: match[2], file: file.relPath, line: index + 1 });
      });
      return deps;
    }),
  ]);

  return [...fromPackageJson, ...fromRequirements];
}

/**
 * Formas em que a documentação cita a versão de uma dependência. A versão anterior usava um
 * único padrão `\b(nome)[@\s]v?(\d+\.\d+...)`, cujo `[@\s]` fazia **qualquer** palavra seguida
 * de um número casar: "Node 20.1", "porta 8080.1", "seção 3.2 do manual" viravam dependências,
 * e cada uma delas comparada contra o package.json produzia `DEPENDENCIA_DIVERGENTE` falso.
 *
 * Agora só casa quando existe um marcador explícito de que aquilo é um pacote:
 * `nome@1.2.3`, `nome v1.2.3`, ou o nome entre crases seguido da versão.
 */
const DOC_DEPENDENCY_PATTERNS: readonly RegExp[] = [
  // nome@1.2.3 e @escopo/nome@1.2.3 — a arroba é inequívoca.
  /(?<![\w/@])((?:@[a-z0-9][\w.-]*\/)?[a-z][\w.-]{1,50})@\^?~?(\d+\.\d+(?:\.\d+)?)/gi,
  // `nome` 1.2.3 / `nome` v1.2.3 — o nome vem marcado como código.
  /`((?:@[a-z0-9][\w.-]*\/)?[a-z][\w.-]{1,50})`\s+v?(\d+\.\d+(?:\.\d+)?)/gi,
  // nome v1.2.3 — o "v" antes do número é o marcador.
  /(?<![\w/@])((?:@[a-z0-9][\w.-]*\/)?[a-z][\w.-]{1,50})\s+v(\d+\.\d+(?:\.\d+)?)/gi,
];

/**
 * Palavras que aparecem antes de um número de versão sem serem dependências. Sem essa lista,
 * "versão v1.2.0" registra uma dependência chamada "versão".
 */
const DOC_DEPENDENCY_STOPWORDS = new Set([
  "versao",
  "versão",
  "version",
  "release",
  "tag",
  "v",
  "porta",
  "port",
  "secao",
  "seção",
  "section",
  "capitulo",
  "capítulo",
  "item",
  "rfc",
  "issue",
  "pr",
]);

function normalizeStopword(name: string): string {
  return name.toLowerCase().replace(/[`]/g, "");
}

function extractDocDependencies(file: SourceFile): DependencyRef[] {
  const deps: DependencyRef[] = [];
  const seen = new Set<string>();

  for (const pattern of DOC_DEPENDENCY_PATTERNS) {
    for (const match of file.content.matchAll(pattern)) {
      const name = match[1];
      if (DOC_DEPENDENCY_STOPWORDS.has(normalizeStopword(name))) continue;
      const key = `${name}@${match[2]}:${file.lines.lineAt(match.index)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push({
        name,
        version: match[2],
        file: file.relPath,
        line: file.lines.lineAt(match.index),
        context: file.lines.contextAt(match.index),
      });
    }
  }
  return deps;
}

/** Varre Markdown à procura de versões de dependências citadas na documentação. */
export async function parseDocDependencies(source: ScanSource): Promise<DependencyRef[]> {
  return source.collect<DependencyRef>("docDependencies", { extensions: ["md", "mdx"] }, extractDocDependencies);
}

export { extractDocDependencies };
