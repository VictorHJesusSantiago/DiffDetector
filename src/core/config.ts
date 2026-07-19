import { readFile } from "node:fs/promises";
import type { DriftConfig, DriftIgnoreEntry } from "./types.js";

export const DEFAULT_CONFIG: Required<Pick<DriftConfig, "renameDetectionMaxDistance">> = {
  renameDetectionMaxDistance: 3,
};

export async function loadConfig(path = "drift.config.json"): Promise<DriftConfig> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as DriftConfig;
  } catch {
    return {};
  }
}

export async function loadIgnoreList(path = "drift-ignore.json"): Promise<DriftIgnoreEntry[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DriftIgnoreEntry[];
  } catch {
    return [];
  }
}

export function isIgnored(
  ignoreList: DriftIgnoreEntry[],
  type: string,
  subject: string,
): boolean {
  return ignoreList.some((entry) => entry.type === type && entry.subject === subject);
}
