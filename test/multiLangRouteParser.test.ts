import { describe, expect, it } from "vitest";
import { parseMultiLangRoutes } from "../src/parsers/multiLangRouteParser.js";

describe("parseMultiLangRoutes", () => {
  it("extrai endpoints de Java/Spring, Go, Ruby, PHP, C# e Rust", async () => {
    const endpoints = await parseMultiLangRoutes("test/fixtures/multilang/code");
    const keys = endpoints.map((e) => `${e.method} ${e.path}`).sort();

    expect(keys).toEqual(
      [
        "GET /api/health",
        "GET /api/invoices",
        "GET /api/legacy",
        "GET /api/orders",
        "GET /api/ping",
        "GET /api/products",
        "GET /api/users/:id",
        "POST /api/invoices",
        "POST /api/orders",
        "POST /api/products",
        "POST /api/users",
      ].sort(),
    );
  });
});
