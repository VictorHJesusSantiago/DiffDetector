import { describe, expect, it } from "vitest";
import { parseEnvExampleFiles } from "../src/parsers/envExampleParser.js";
import { parseOpenApiSpecs } from "../src/parsers/openapiParser.js";
import { parseDockerInfra } from "../src/parsers/dockerInfraParser.js";

const CODE_DIR = "test/fixtures/extra-sources/code";
const DOCS_DIR = "test/fixtures/extra-sources/docs";

describe("parseEnvExampleFiles", () => {
  it("extrai variáveis de .env.example", async () => {
    const refs = await parseEnvExampleFiles(CODE_DIR);
    expect(refs.map((r) => r.name).sort()).toEqual(["API_TOKEN", "DATABASE_URL"]);
  });
});

describe("parseOpenApiSpecs", () => {
  it("extrai endpoints de um spec OpenAPI YAML", async () => {
    const refs = await parseOpenApiSpecs(DOCS_DIR);
    const keys = refs.map((r) => `${r.method} ${r.path}`).sort();
    expect(keys).toEqual(["DELETE /api/orders/:id", "GET /api/orders", "POST /api/orders"]);
  });
});

describe("parseDockerInfra", () => {
  it("extrai env vars de Dockerfile e docker-compose.yml", async () => {
    const refs = await parseDockerInfra(CODE_DIR);
    const names = refs.map((r) => r.name).sort();
    expect(names).toEqual(["BUILD_ID", "CACHE_TTL_SECONDS", "NODE_ENV", "REDIS_URL"]);
  });
});
