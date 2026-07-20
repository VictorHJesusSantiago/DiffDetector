import { readFile } from "node:fs/promises";

export interface WorkspaceProject {
  name: string;
  codeDir: string;
  docsDir: string;
}

export interface WorkspaceConfig {
  projects: WorkspaceProject[];
}

/**
 * Lê um arquivo de workspace (ex.: drift.workspace.json) que descreve múltiplos pares
 * codeDir/docsDir — útil para monorepos com vários serviços, cada um com seu próprio runbook.
 */
export async function loadWorkspace(path: string): Promise<WorkspaceConfig> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as WorkspaceConfig;
  if (!Array.isArray(parsed.projects)) {
    throw new Error(`Arquivo de workspace inválido: "projects" precisa ser um array em ${path}`);
  }
  return parsed;
}
