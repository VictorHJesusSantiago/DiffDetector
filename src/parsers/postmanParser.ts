import type { DocEndpointRef, HttpMethod } from "../core/types.js";
import type { ScanSource } from "../core/scanSource.js";
import { normalizePath } from "./codeParser.js";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
const POSTMAN_BASENAME_RE = /\.postman_collection\.json$/i;

interface PostmanUrl {
  raw?: string;
  path?: string[];
}

interface PostmanRequest {
  method?: string;
  url?: PostmanUrl | string;
}

interface PostmanItem {
  name?: string;
  request?: PostmanRequest;
  item?: PostmanItem[];
}

interface PostmanCollection {
  info?: { name?: string };
  item?: PostmanItem[];
}

function extractPath(url: PostmanRequest["url"]): string | null {
  if (!url) return null;
  if (typeof url === "string") {
    try {
      return new URL(url).pathname;
    } catch {
      // URL relativa (sem esquema): usa o valor como caminho.
      return url.startsWith("/") ? url : `/${url}`;
    }
  }
  if (url.path) return `/${url.path.join("/")}`;
  if (url.raw) {
    try {
      return new URL(url.raw).pathname;
    } catch {
      // `raw` pode conter variáveis do Postman ({{baseUrl}}) e não formar uma URL válida.
      return null;
    }
  }
  return null;
}

function walkItems(items: PostmanItem[] | undefined, relPath: string, out: DocEndpointRef[]): void {
  for (const item of items ?? []) {
    if (item.request) {
      const method = (item.request.method ?? "").toUpperCase() as HttpMethod;
      const path = extractPath(item.request.url);
      if (HTTP_METHODS.includes(method) && path) {
        out.push({
          method,
          path: normalizePath(path),
          file: relPath,
          line: 1,
          context: `${item.name ?? ""} (Postman Collection)`,
        });
      }
    }
    if (item.item) walkItems(item.item, relPath, out);
  }
}

/** Trata Postman Collections (.postman_collection.json) como fonte de endpoints documentados. */
export async function parsePostmanCollections(source: ScanSource): Promise<DocEndpointRef[]> {
  return source.collect<DocEndpointRef>("postman", { basenamePattern: POSTMAN_BASENAME_RE }, (file) => {
    let collection: PostmanCollection;
    try {
      collection = JSON.parse(file.content) as PostmanCollection;
    } catch {
      // Collection malformada: nada a extrair.
      return [];
    }
    const refs: DocEndpointRef[] = [];
    walkItems(collection.item, file.relPath, refs);
    return refs;
  });
}
