import { describe, expect, it } from "vitest";
import { parseCodeDirectory } from "../src/parsers/codeParser.js";

describe("parseCodeDirectory", () => {
  it("extrai endpoints e variáveis de ambiente do código Express", async () => {
    const facts = await parseCodeDirectory("test/fixtures/code");

    expect(facts.endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", path: "/api/users/:id" }),
        expect.objectContaining({ method: "POST", path: "/api/users" }),
        expect.objectContaining({ method: "DELETE", path: "/api/users/:id/sessions" }),
      ]),
    );
    expect(facts.endpoints).toHaveLength(3);

    const envNames = facts.envVars.map((e) => e.name).sort();
    expect(envNames).toEqual(["DATABASE_URL", "FEATURE_NEW_CHECKOUT", "PORT"]);
  });
});
