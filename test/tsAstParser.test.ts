import { describe, expect, it } from "vitest";
import { parseWithAst } from "../src/parsers/tsAstParser.js";

describe("parseWithAst", () => {
  it("extrai endpoints e env vars via AST real, ignorando chamadas .get() de receptores não-router", () => {
    const content = `
      import express from "express";
      const app = express();

      // comentário com "app.post('/nao/deveria/aparecer')" não deve virar endpoint
      app.get("/api/orders", (req, res) => res.json([]));

      const cache = new Map();
      cache.get("chave-qualquer"); // não é rota — não deve ser detectado

      const token = process.env.API_TOKEN;
      const secret = process.env["APP_SECRET"];
    `;

    const facts = parseWithAst("app.ts", content);

    expect(facts.endpoints).toEqual([
      expect.objectContaining({ method: "GET", path: "/api/orders" }),
    ]);
    expect(facts.envVars.map((e) => e.name).sort()).toEqual(["API_TOKEN", "APP_SECRET"]);
  });

  it("extrai fastify.route({ method, url }) via AST", () => {
    const content = `
      fastify.route({
        method: 'POST',
        url: '/api/webhooks/:id',
        handler: async () => {}
      });
    `;
    const facts = parseWithAst("routes.ts", content);
    expect(facts.endpoints).toEqual([
      expect.objectContaining({ method: "POST", path: "/api/webhooks/:id" }),
    ]);
  });
});
