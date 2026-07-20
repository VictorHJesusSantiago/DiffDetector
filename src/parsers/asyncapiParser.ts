import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import type { ExtraDocResource } from "../core/types.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

interface AsyncApiDoc {
  channels?: Record<string, unknown>;
}

/** Trata specs AsyncAPI (.yaml/.yml/.json com bloco "channels") como documentação de tópicos/eventos assíncronos. */
export async function parseAsyncApiChannels(docsDir: string): Promise<ExtraDocResource[]> {
  const files = await fg(["**/*asyncapi*.{yaml,yml,json}"], { cwd: docsDir, ignore: DEFAULT_IGNORE, caseSensitiveMatch: false });
  const refs: ExtraDocResource[] = [];
  for (const relFile of files) {
    let raw: string;
    try {
      raw = await readFile(`${docsDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    let doc: AsyncApiDoc | undefined;
    try {
      doc = relFile.endsWith(".json") ? JSON.parse(raw) : (parseYaml(raw) as AsyncApiDoc);
    } catch {
      continue;
    }
    if (!doc?.channels) continue;
    for (const channelName of Object.keys(doc.channels)) {
      refs.push({
        kind: "QUEUE_TOPICO",
        subject: channelName,
        file: relFile,
        line: 1,
        context: `canal AsyncAPI: ${channelName}`,
      });
    }
  }
  return refs;
}
