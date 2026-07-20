import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { DocFacts } from "../core/types.js";
import { extractDocFactsFromText } from "./docParser.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/**
 * Trata páginas HTML exportadas de Confluence/Notion como fonte de documentação: remove as tags
 * e roda o mesmo extrator usado para Markdown sobre o texto resultante.
 */
export async function parseHtmlDocs(docsDir: string): Promise<DocFacts> {
  const files = await fg("**/*.{html,htm}", { cwd: docsDir, ignore: DEFAULT_IGNORE });
  const endpoints: DocFacts["endpoints"] = [];
  const envVars: DocFacts["envVars"] = [];

  for (const relFile of files) {
    let raw: string;
    try {
      raw = await readFile(`${docsDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    const text = stripHtml(raw);
    const facts = extractDocFactsFromText(relFile, text);
    endpoints.push(...facts.endpoints);
    envVars.push(...facts.envVars);
  }

  return { endpoints, envVars };
}
