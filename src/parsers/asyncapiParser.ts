import { parse as parseYaml } from "yaml";
import type { ExtraDocResource } from "../core/types.js";
import type { ScanSource } from "../core/scanSource.js";

const ASYNCAPI_BASENAME_RE = /asyncapi.*\.(ya?ml|json)$/i;

interface AsyncApiDoc {
  channels?: Record<string, unknown>;
}

/** Trata specs AsyncAPI (.yaml/.yml/.json com bloco "channels") como documentação de tópicos/eventos assíncronos. */
export async function parseAsyncApiChannels(source: ScanSource): Promise<ExtraDocResource[]> {
  return source.collect<ExtraDocResource>("asyncapi", { basenamePattern: ASYNCAPI_BASENAME_RE }, (file) => {
    let parsed: unknown;
    try {
      parsed = file.relPath.endsWith(".json") ? JSON.parse(file.content) : parseYaml(file.content);
    } catch {
      // Spec malformado: nada a extrair.
      return [];
    }
    const doc = parsed as AsyncApiDoc | null | undefined;
    if (!doc?.channels || typeof doc.channels !== "object") return [];

    return Object.keys(doc.channels).map((channelName) => ({
      kind: "QUEUE_TOPICO" as const,
      subject: channelName,
      file: file.relPath,
      line: 1,
      context: `canal AsyncAPI: ${channelName}`,
    }));
  });
}
