import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { DocEndpointRef, HttpMethod } from "../core/types.js";
import { normalizePath } from "./codeParser.js";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

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
      return url.startsWith("/") ? url : `/${url}`;
    }
  }
  if (url.path) return `/${url.path.join("/")}`;
  if (url.raw) {
    try {
      return new URL(url.raw).pathname;
    } catch {
      return null;
    }
  }
  return null;
}

function walkItems(items: PostmanItem[] | undefined, relFile: string, out: DocEndpointRef[]): void {
  for (const item of items ?? []) {
    if (item.request) {
      const method = (item.request.method ?? "").toUpperCase() as HttpMethod;
      const path = extractPath(item.request.url);
      if (HTTP_METHODS.includes(method) && path) {
        out.push({
          method,
          path: normalizePath(path),
          file: relFile,
          line: 1,
          context: `${item.name ?? ""} (Postman Collection)`,
        });
      }
    }
    if (item.item) walkItems(item.item, relFile, out);
  }
}

/** Trata Postman Collections (.postman_collection.json) como fonte de endpoints documentados. */
export async function parsePostmanCollections(docsDir: string): Promise<DocEndpointRef[]> {
  const files = await fg("**/*.postman_collection.json", { cwd: docsDir, ignore: DEFAULT_IGNORE });
  const refs: DocEndpointRef[] = [];
  for (const relFile of files) {
    let raw: string;
    try {
      raw = await readFile(`${docsDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    let collection: PostmanCollection;
    try {
      collection = JSON.parse(raw);
    } catch {
      continue;
    }
    walkItems(collection.item, relFile, refs);
  }
  return refs;
}
