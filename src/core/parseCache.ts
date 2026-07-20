import { readFile, writeFile, stat } from "node:fs/promises";
import type { CodeEndpoint, CodeEnvVar } from "./types.js";

interface CacheEntry {
  mtimeMs: number;
  size: number;
  endpoints: CodeEndpoint[];
  envVars: CodeEnvVar[];
}

interface CacheFile {
  version: 2;
  entries: Record<string, CacheEntry>;
}

/**
 * Cache local (arquivo JSON no cwd, por padrão .drift-cache.json) dos fatos extraídos de
 * cada arquivo de código, indexado por mtime+size. Em repositórios grandes escaneados com
 * frequência (ex.: hook de pre-commit, --watch), evita reparsear arquivos que não mudaram
 * desde o scan anterior — o parser só roda de fato sobre o que foi tocado.
 */
export class ParseCache {
  private data: CacheFile = { version: 2, entries: {} };
  private readonly path: string;
  private dirty = false;
  hits = 0;
  misses = 0;

  constructor(cachePath = ".drift-cache.json") {
    this.path = cachePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed?.version === 2 && parsed.entries) this.data = parsed;
    } catch {
      this.data = { version: 2, entries: {} };
    }
  }

  /** Retorna os fatos em cache se o arquivo não mudou, ou null se precisa reparsear. */
  async get(absolutePath: string, relativeKey: string): Promise<{ endpoints: CodeEndpoint[]; envVars: CodeEnvVar[] } | null> {
    try {
      const st = await stat(absolutePath);
      const prev = this.data.entries[relativeKey];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
        this.hits++;
        return { endpoints: prev.endpoints, envVars: prev.envVars };
      }
    } catch {
      // segue para miss
    }
    this.misses++;
    return null;
  }

  async set(absolutePath: string, relativeKey: string, facts: { endpoints: CodeEndpoint[]; envVars: CodeEnvVar[] }): Promise<void> {
    try {
      const st = await stat(absolutePath);
      this.data.entries[relativeKey] = { mtimeMs: st.mtimeMs, size: st.size, ...facts };
      this.dirty = true;
    } catch {
      // arquivo pode ter sumido entre o glob e o stat — ignora silenciosamente
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await writeFile(this.path, JSON.stringify(this.data, null, 2), "utf-8");
  }
}
