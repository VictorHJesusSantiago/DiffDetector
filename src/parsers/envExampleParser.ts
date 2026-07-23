import type { DocEnvVarRef } from "../core/types.js";
import type { ScanSource } from "../core/scanSource.js";

const ENV_LINE_RE = /^\s*([A-Z][A-Z0-9_]*)\s*=/;
const ENV_EXAMPLE_BASENAMES = new Set([".env.example", ".env.sample", ".env.dist"]);
const MAX_CONTEXT_LENGTH = 200;

/**
 * Trata .env.example/.env.sample como documentação: a intenção de um .env.example
 * é justamente comunicar "essas são as variáveis que este serviço espera".
 */
export async function parseEnvExampleFiles(source: ScanSource): Promise<DocEnvVarRef[]> {
  return source.collect<DocEnvVarRef>(
    "envExample",
    { where: (entry) => ENV_EXAMPLE_BASENAMES.has(entry.basename), includeDotPaths: true },
    (file) => {
      const refs: DocEnvVarRef[] = [];
      file.content.split("\n").forEach((lineText, index) => {
        const match = ENV_LINE_RE.exec(lineText);
        if (!match) return;
        refs.push({
          name: match[1],
          file: file.relPath,
          line: index + 1,
          context: lineText.trim().slice(0, MAX_CONTEXT_LENGTH),
        });
      });
      return refs;
    },
  );
}
