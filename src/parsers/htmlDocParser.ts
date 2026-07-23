import type { DocFacts } from "../core/types.js";
import type { ScanSource } from "../core/scanSource.js";
import { extractDocFactsFromText } from "./docParser.js";

const HTML_ENTITY_DECODINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#39;/gi, "'"],
  // `&amp;` fica por último: decodificá-lo antes transformaria `&amp;lt;` em `&lt;` e, na
  // passada seguinte, em `<` — dupla decodificação.
  [/&amp;/gi, "&"],
];

function stripHtml(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  for (const [pattern, replacement] of HTML_ENTITY_DECODINGS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * Trata páginas HTML exportadas de Confluence/Notion como fonte de documentação: remove as tags
 * e roda o mesmo extrator usado para Markdown sobre o texto resultante.
 */
export async function parseHtmlDocs(source: ScanSource): Promise<DocFacts> {
  const perFile = await source.collect<DocFacts>("htmlDoc", { extensions: ["html", "htm"] }, (file) => [
    extractDocFactsFromText(file.relPath, stripHtml(file.content)),
  ]);

  return {
    endpoints: perFile.flatMap((facts) => facts.endpoints),
    envVars: perFile.flatMap((facts) => facts.envVars),
  };
}
