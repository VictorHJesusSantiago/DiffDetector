import { rename, writeFile } from "node:fs/promises";
import { readTextFileOrNull } from "./fileSystem.js";
import type { FileEntry } from "./scanSource.js";

const CACHE_VERSION = 3;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  facts: unknown[];
}

interface CacheFile {
  version: typeof CACHE_VERSION;
  entries: Record<string, CacheEntry>;
}

/**
 * Cache local (arquivo JSON no cwd, por padrão .drift-cache.json) dos fatos extraídos de cada
 * arquivo, indexado por parser + caminho e invalidado por mtime+size. Em repositórios grandes
 * escaneados com frequência (hook de pre-commit, `--watch`), só o que mudou é reparseado.
 *
 * A chave inclui o `parserId` porque o mesmo arquivo é analisado por vários parsers com
 * resultados diferentes — na versão 2 o cache cobria apenas o codeParser, e os outros catorze
 * parsers o ignoravam por completo.
 *
 * As consultas são síncronas: mtime e tamanho já vêm do inventário do `ScanSource`, que os
 * obtém na mesma travessia do filesystem. A versão anterior fazia um `stat()` extra por
 * arquivo, dentro do laço de parsing.
 */
export class ParseCache {
  private data: CacheFile = { version: CACHE_VERSION, entries: {} };
  private readonly path: string;
  private dirty = false;
  /** Chaves consultadas neste scan; as demais são podadas ao salvar. */
  private readonly touched = new Set<string>();
  hits = 0;
  misses = 0;

  constructor(cachePath = ".drift-cache.json") {
    this.path = cachePath;
  }

  private static keyOf(parserId: string, relPath: string): string {
    return `${parserId}\u0000${relPath}`;
  }

  /** O arquivo de cache pode ter sido escrito por outra versão, ou truncado. Nada é assumido. */
  private static isCacheFile(value: unknown): value is CacheFile {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as { version?: unknown; entries?: unknown };
    return (
      candidate.version === CACHE_VERSION && typeof candidate.entries === "object" && candidate.entries !== null
    );
  }

  async load(): Promise<void> {
    const raw = await readTextFileOrNull(this.path);
    if (raw === null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (ParseCache.isCacheFile(parsed)) this.data = parsed;
    } catch {
      // Cache corrompido é descartável por definição: recomeça vazio em vez de abortar o scan.
      this.data = { version: CACHE_VERSION, entries: {} };
    }
  }

  /** Fatos em cache se o arquivo não mudou; null se precisa reparsear. */
  get<T>(parserId: string, entry: FileEntry): T[] | null {
    const key = ParseCache.keyOf(parserId, entry.relPath);
    this.touched.add(key);
    // Registro indexado por string: a chave pode não existir, ainda que o tipo não diga isso.
    const previous = this.data.entries[key] as CacheEntry | undefined;
    if (previous && previous.mtimeMs === entry.mtimeMs && previous.size === entry.size) {
      this.hits++;
      return previous.facts as T[];
    }
    this.misses++;
    return null;
  }

  set<T>(parserId: string, entry: FileEntry, facts: T[]): void {
    const key = ParseCache.keyOf(parserId, entry.relPath);
    this.touched.add(key);
    this.data.entries[key] = { mtimeMs: entry.mtimeMs, size: entry.size, facts };
    this.dirty = true;
  }

  /**
   * Grava o cache de forma atômica (arquivo temporário + rename) e descarta entradas de
   * arquivos que não foram vistos neste scan. A escrita direta anterior deixava um JSON
   * truncado quando dois scans concorrentes salvavam ao mesmo tempo, e o cache crescia para
   * sempre porque arquivos deletados nunca eram removidos.
   */
  async save(): Promise<void> {
    const pruned = this.pruneUntouchedEntries();
    if (!this.dirty && !pruned) return;

    const tempPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.data), "utf-8");
    await rename(tempPath, this.path);
  }

  private pruneUntouchedEntries(): boolean {
    let removedAny = false;
    for (const key of Object.keys(this.data.entries)) {
      if (this.touched.has(key)) continue;
      delete this.data.entries[key];
      removedAny = true;
    }
    return removedAny;
  }
}
