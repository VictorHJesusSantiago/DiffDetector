import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { ExtraCodeResource, ExtraDocResource } from "../core/types.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/**
 * Varre os arquivos Markdown de `docsDir` procurando por menções textuais (entre crases ou
 * como palavra isolada) dos subjects passados em `resources`. Usado para decidir se um
 * recurso extra do código (GraphQL, gRPC, fila, CLI, WebSocket, tabela, role) foi documentado,
 * sem precisar de um parser de doc dedicado por tipo de recurso.
 */
export async function findDocMentions(docsDir: string, resources: ExtraCodeResource[]): Promise<ExtraDocResource[]> {
  if (resources.length === 0) return [];

  const uniqueSubjects = [...new Set(resources.map((r) => r.subject))];
  const files = await fg("**/*.{md,mdx}", { cwd: docsDir, ignore: DEFAULT_IGNORE });

  const kindsBySubject = new Map<string, Set<ExtraCodeResource["kind"]>>();
  for (const r of resources) {
    const set = kindsBySubject.get(r.subject) ?? new Set();
    set.add(r.kind);
    kindsBySubject.set(r.subject, set);
  }

  const mentions: ExtraDocResource[] = [];
  for (const relFile of files) {
    let content: string;
    try {
      content = await readFile(`${docsDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    for (const subject of uniqueSubjects) {
      const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:\`${escaped}\`|\\b${escaped}\\b)`, "g");
      for (const match of content.matchAll(re)) {
        for (const kind of kindsBySubject.get(subject) ?? []) {
          mentions.push({
            kind,
            subject,
            file: relFile,
            line: lineOf(content, match.index ?? 0),
            context: content.split("\n")[lineOf(content, match.index ?? 0) - 1]?.trim().slice(0, 200) ?? "",
          });
        }
      }
    }
  }
  return mentions;
}
