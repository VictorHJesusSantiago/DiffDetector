import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { DocEnvVarRef } from "../core/types.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];
const ENV_LINE_RE = /^\s*([A-Z][A-Z0-9_]*)\s*=/;

/**
 * Trata .env.example/.env.sample como documentação: a intenção de um .env.example
 * é justamente comunicar "essas são as variáveis que este serviço espera".
 */
export async function parseEnvExampleFiles(rootDir: string): Promise<DocEnvVarRef[]> {
  const files = await fg(["**/.env.example", "**/.env.sample", "**/.env.dist"], {
    cwd: rootDir,
    ignore: DEFAULT_IGNORE,
    absolute: false,
    dot: true,
  });

  const refs: DocEnvVarRef[] = [];
  for (const relFile of files) {
    let content: string;
    try {
      content = await readFile(`${rootDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    lines.forEach((lineText, idx) => {
      const match = ENV_LINE_RE.exec(lineText);
      if (!match) return;
      refs.push({
        name: match[1],
        file: relFile,
        line: idx + 1,
        context: lineText.trim().slice(0, 200),
      });
    });
  }
  return refs;
}
