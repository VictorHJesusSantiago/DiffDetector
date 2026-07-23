import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { LineIndex } from "./lineIndex.js";
import { SCAN_IGNORE_GLOBS, joinScanPath } from "./fileSystem.js";
import type { ParseCache } from "./parseCache.js";

/** Orçamento de memória para conteúdo memoizado. Acima disso, arquivos são lidos sem reter. */
const DEFAULT_CONTENT_BUDGET_BYTES = 64 * 1024 * 1024;

export interface FileEntry {
  /** Caminho relativo à raiz do scan, sempre com "/" como separador (contrato do fast-glob). */
  readonly relPath: string;
  readonly basename: string;
  /** Extensão em minúsculas, sem o ponto. Vazia quando o arquivo não tem extensão. */
  readonly extension: string;
  /** True quando algum segmento do caminho começa com ponto (`.github/`, `.env.example`). */
  readonly hasDotSegment: boolean;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface SourceFile {
  readonly relPath: string;
  readonly content: string;
  readonly lines: LineIndex;
}

export interface SelectCriteria {
  /** Extensões aceitas, em minúsculas e sem ponto. */
  readonly extensions?: readonly string[];
  /** Casa contra o nome do arquivo (não contra o caminho inteiro). */
  readonly basenamePattern?: RegExp;
  /** Casa contra o caminho relativo completo. */
  readonly pathPattern?: RegExp;
  /** Predicado adicional, aplicado depois dos demais critérios. */
  readonly where?: (entry: FileEntry) => boolean;
  /**
   * Inclui arquivos sob diretórios ocultos e arquivos ocultos. Falso por padrão, reproduzindo
   * o comportamento do fast-glob sem `dot: true` — só os parsers que precisam (`.env.example`,
   * `.github/workflows/**`) pedem explicitamente.
   */
  readonly includeDotPaths?: boolean;
  /** Nomes de diretório a excluir, adicionais aos globais (ex.: `target`, `bin`, `obj`). */
  readonly excludeDirectories?: readonly string[];
}

function toFileEntry(path: string, mtimeMs: number, size: number): FileEntry {
  const lastSlash = path.lastIndexOf("/");
  const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const dotIndex = basename.lastIndexOf(".");
  const extension = dotIndex > 0 ? basename.slice(dotIndex + 1).toLowerCase() : "";
  const hasDotSegment = path.split("/").some((segment) => segment.startsWith("."));
  return { relPath: path, basename, extension, hasDotSegment, mtimeMs, size };
}

function containsDirectory(relPath: string, directory: string): boolean {
  return relPath.split("/").slice(0, -1).includes(directory);
}

/**
 * Inventário do diretório e porta única de acesso ao filesystem durante um scan.
 *
 * Antes, cada um dos quinze parsers fazia o seu próprio glob sobre a mesma árvore — ~17
 * travessias por scan — e um mesmo arquivo `.ts` chegava a ser lido sete vezes (codeParser,
 * jsdocParser, filas, CLI, WebSocket, tabelas, roles), com um `LineIndex` reconstruído a cada
 * leitura. Aqui a árvore é percorrida uma vez, cada arquivo é lido no máximo uma vez, e o
 * `LineIndex` é construído uma vez por arquivo e compartilhado por todos os parsers.
 *
 * É também o ponto onde o cancelamento é observado: um scan abortado por timeout para de
 * progredir na próxima fronteira de arquivo, em vez de seguir varrendo até o fim.
 */
export class ScanSource {
  private readonly contents = new Map<string, SourceFile>();
  private memoizedBytes = 0;

  private constructor(
    readonly rootDir: string,
    private readonly entries: readonly FileEntry[],
    private readonly cache: ParseCache | undefined,
    private readonly signal: AbortSignal | undefined,
    private readonly contentBudgetBytes: number,
  ) {}

  static async create(
    rootDir: string,
    options: { cache?: ParseCache; signal?: AbortSignal; contentBudgetBytes?: number } = {},
  ): Promise<ScanSource> {
    options.signal?.throwIfAborted();

    const found = await fg("**/*", {
      cwd: rootDir,
      ignore: [...SCAN_IGNORE_GLOBS],
      dot: true,
      onlyFiles: true,
      stats: true,
      // Não seguir links simbólicos: evita laços infinitos e impede que um link plantado dentro
      // de um diretório permitido leve a varredura para fora dele (a API aceita caminhos do
      // cliente — ver ScanRootPolicy).
      followSymbolicLinks: false,
      suppressErrors: true,
    });

    const entries = found.map((entry) =>
      toFileEntry(entry.path, entry.stats?.mtimeMs ?? 0, entry.stats?.size ?? 0),
    );

    return new ScanSource(
      rootDir,
      entries,
      options.cache,
      options.signal,
      options.contentBudgetBytes ?? DEFAULT_CONTENT_BUDGET_BYTES,
    );
  }

  /** Constrói uma fonte a partir de conteúdo em memória — para testes sem tocar o disco. */
  static fromFiles(files: readonly { relPath: string; content: string }[], rootDir = "<memória>"): ScanSource {
    const entries = files.map((file) => toFileEntry(file.relPath, 0, Buffer.byteLength(file.content)));
    const source = new ScanSource(rootDir, entries, undefined, undefined, Number.POSITIVE_INFINITY);
    for (const file of files) {
      source.contents.set(file.relPath, {
        relPath: file.relPath,
        content: file.content,
        lines: new LineIndex(file.content),
      });
    }
    return source;
  }

  get fileCount(): number {
    return this.entries.length;
  }

  select(criteria: SelectCriteria = {}): readonly FileEntry[] {
    const extensions = criteria.extensions ? new Set(criteria.extensions) : undefined;
    return this.entries.filter((entry) => {
      if (!criteria.includeDotPaths && entry.hasDotSegment) return false;
      if (extensions && !extensions.has(entry.extension)) return false;
      if (criteria.basenamePattern && !criteria.basenamePattern.test(entry.basename)) return false;
      if (criteria.pathPattern && !criteria.pathPattern.test(entry.relPath)) return false;
      if (criteria.excludeDirectories?.some((dir) => containsDirectory(entry.relPath, dir))) return false;
      if (criteria.where && !criteria.where(entry)) return false;
      return true;
    });
  }

  /** Caminhos relativos que casam com o critério — para quem só precisa da lista de arquivos. */
  selectPaths(criteria: SelectCriteria = {}): string[] {
    return this.select(criteria).map((entry) => entry.relPath);
  }

  /** Lê (e memoiza) o conteúdo de um arquivo; null quando ele não pode ser lido. */
  async read(entry: FileEntry): Promise<SourceFile | null> {
    this.signal?.throwIfAborted();

    const memoized = this.contents.get(entry.relPath);
    if (memoized) return memoized;

    let content: string;
    try {
      content = await readFile(joinScanPath(this.rootDir, entry.relPath), "utf-8");
    } catch {
      // Arquivo removido entre o inventário e a leitura, permissão negada ou conteúdo binário
      // ilegível: casos normais ao varrer repositório de terceiros, não motivo para abortar.
      return null;
    }

    const file: SourceFile = { relPath: entry.relPath, content, lines: new LineIndex(content) };

    // Acima do orçamento, o arquivo ainda é entregue — apenas não fica retido. O scan de um
    // monorepo gigante degrada para o comportamento antigo em vez de estourar a heap.
    const bytes = Buffer.byteLength(content);
    if (this.memoizedBytes + bytes <= this.contentBudgetBytes) {
      this.contents.set(entry.relPath, file);
      this.memoizedBytes += bytes;
    }
    return file;
  }

  /**
   * Seleciona, lê e extrai fatos de um conjunto de arquivos, consultando o cache de parsing
   * quando ele está ativo. `parserId` separa os resultados de parsers diferentes sobre o mesmo
   * arquivo — é o que permite o cache valer para todos eles, e não só para o codeParser.
   *
   * `extract` precisa devolver valores serializáveis em JSON (é o que vai para o cache).
   */
  async collect<T>(
    parserId: string,
    criteria: SelectCriteria,
    extract: (file: SourceFile) => T[],
  ): Promise<T[]> {
    const results: T[] = [];

    for (const entry of this.select(criteria)) {
      this.signal?.throwIfAborted();

      const cached = this.cache?.get<T>(parserId, entry);
      if (cached) {
        results.push(...cached);
        continue;
      }

      const file = await this.read(entry);
      if (!file) continue;

      const facts = extract(file);
      results.push(...facts);
      this.cache?.set(parserId, entry, facts);
    }

    return results;
  }
}
