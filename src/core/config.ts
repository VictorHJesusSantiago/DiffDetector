import { readFile } from "node:fs/promises";
import type { DriftConfig, DriftIgnoreEntry } from "./types.js";

export const DEFAULT_CONFIG: Required<Pick<DriftConfig, "renameDetectionMaxDistance">> = {
  renameDetectionMaxDistance: 3,
};

function isFileNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Lê um arquivo de configuração opcional. Ausência do arquivo é o caso normal e devolve o
 * padrão; qualquer outra falha (JSON malformado, permissão negada) é propagada.
 *
 * Antes, um `catch {}` genérico engolia os dois casos: uma vírgula sobrando no
 * drift.config.json fazia toda a configuração — severidades, tipos desligados, ignore list —
 * ser descartada em silêncio, e o scan seguia reportando achados que o time acreditava ter
 * suprimido. Configuração inválida agora falha alto.
 */
async function readOptionalJsonFile(path: string, fallback: unknown, describe: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if (isFileNotFound(err)) return fallback;
    throw new Error(`Não foi possível ler ${describe} em "${path}": ${(err as Error).message}`);
  }

  try {
    // O retorno é `unknown` de propósito: tipar isto como a forma esperada seria uma mentira
    // sobre conteúdo que veio de um arquivo editado à mão, e dispensaria a validação seguinte.
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`${describe} em "${path}" não é um JSON válido: ${(err as Error).message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadConfig(path = "drift.config.json"): Promise<DriftConfig> {
  const config = await readOptionalJsonFile(path, {}, "o arquivo de configuração");
  if (!isPlainObject(config)) {
    throw new Error(`O arquivo de configuração em "${path}" precisa conter um objeto JSON.`);
  }
  return config;
}

export async function loadIgnoreList(path = "drift-ignore.json"): Promise<DriftIgnoreEntry[]> {
  const parsed = await readOptionalJsonFile(path, [], "a lista de exceções");
  if (!Array.isArray(parsed)) {
    throw new Error(`A lista de exceções em "${path}" precisa ser um array JSON.`);
  }
  return parsed as DriftIgnoreEntry[];
}

/**
 * Índice das exceções configuradas. Substitui a varredura linear da lista a cada achado
 * candidato, que era O(achados × exceções).
 */
export class IgnoreIndex {
  private readonly keys: ReadonlySet<string>;

  constructor(entries: readonly DriftIgnoreEntry[]) {
    this.keys = new Set(entries.map((entry) => IgnoreIndex.keyOf(entry.type, entry.subject)));
  }

  /**
   * NUL como separador: ao contrário de espaço ou "::", ele não pode ocorrer nem em um
   * DriftType nem em um subject, então a chave composta nunca fica ambígua.
   */
  private static keyOf(type: string, subject: string): string {
    return `${type}\u0000${subject}`;
  }

  has(type: string, subject: string): boolean {
    return this.keys.has(IgnoreIndex.keyOf(type, subject));
  }
}

export function isIgnored(ignoreList: readonly DriftIgnoreEntry[], type: string, subject: string): boolean {
  return new IgnoreIndex(ignoreList).has(type, subject);
}
