import { describe, expect, it } from "vitest";
import { parseDocsDirectory } from "../src/parsers/docParser.js";

describe("parseDocsDirectory", () => {
  it("extrai endpoints e variáveis de ambiente citados no Markdown", async () => {
    const facts = await parseDocsDirectory("test/fixtures/docs");

    expect(facts.endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", path: "/api/users/:id" }),
        expect.objectContaining({ method: "POST", path: "/api/users" }),
        expect.objectContaining({ method: "DELETE", path: "/api/users/:id/legacy" }),
      ]),
    );

    const envNames = facts.envVars.map((e) => e.name).sort();
    expect(envNames).toEqual(["DATABASE_URL", "LEGACY_CACHE_HOST", "PORT"]);
  });
});
