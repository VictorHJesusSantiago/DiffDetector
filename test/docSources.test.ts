import { describe, expect, it } from "vitest";
import { parsePostmanCollections } from "../src/parsers/postmanParser.js";
import { parseAsyncApiChannels } from "../src/parsers/asyncapiParser.js";
import { parseJsDocRoutes } from "../src/parsers/jsdocParser.js";
import { parseHtmlDocs } from "../src/parsers/htmlDocParser.js";

const CODE_DIR = "test/fixtures/docsources/code";
const DOCS_DIR = "test/fixtures/docsources/docs";

describe("parsePostmanCollections", () => {
  it("extrai endpoints de uma collection, incluindo itens aninhados em pastas", async () => {
    const refs = await parsePostmanCollections(DOCS_DIR);
    const keys = refs.map((r) => `${r.method} ${r.path}`).sort();
    expect(keys).toEqual(["GET /api/orders", "POST /api/orders"]);
  });
});

describe("parseAsyncApiChannels", () => {
  it("extrai canais como tópicos de fila documentados", async () => {
    const refs = await parseAsyncApiChannels(DOCS_DIR);
    expect(refs.map((r) => r.subject).sort()).toEqual(["order.cancelled", "order.created"]);
    expect(refs.every((r) => r.kind === "QUEUE_TOPICO")).toBe(true);
  });
});

describe("parseJsDocRoutes", () => {
  it("extrai rotas documentadas via comentário @route embutido no código", async () => {
    const refs = await parseJsDocRoutes(CODE_DIR);
    expect(refs).toEqual([expect.objectContaining({ method: "GET", path: "/api/internal/status" })]);
  });
});

describe("parseHtmlDocs", () => {
  it("extrai endpoints e env vars de HTML exportado (Confluence/Notion)", async () => {
    const facts = await parseHtmlDocs(DOCS_DIR);
    expect(facts.endpoints).toEqual([expect.objectContaining({ method: "GET", path: "/api/legacy-report" })]);
    expect(facts.envVars.map((e) => e.name)).toContain("LEGACY_REPORT_TOKEN");
  });
});
