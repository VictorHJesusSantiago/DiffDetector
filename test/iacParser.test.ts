import { describe, expect, it } from "vitest";
import { parseTerraformVariables, parseKubernetesEnvVars, parseCiCdEnvVars } from "../src/parsers/iacParser.js";

const DIR = "test/fixtures/iac/code";

describe("parseTerraformVariables", () => {
  it("extrai variáveis declaradas em .tf", async () => {
    const vars = await parseTerraformVariables(DIR);
    expect(vars.map((v) => v.name).sort()).toEqual(["API_KEY", "DB_HOST"]);
  });
});

describe("parseKubernetesEnvVars", () => {
  it("extrai env de containers e chaves de ConfigMap", async () => {
    const vars = await parseKubernetesEnvVars(DIR);
    const names = vars.map((v) => v.name).sort();
    expect(names).toEqual(["FEATURE_FLAG_X", "LOG_LEVEL", "REDIS_HOST"]);
  });
});

describe("parseCiCdEnvVars", () => {
  it("extrai secrets referenciados e variáveis do bloco env em GitHub Actions", async () => {
    const vars = await parseCiCdEnvVars(DIR);
    const names = vars.map((v) => v.name).sort();
    expect(names).toEqual(["DEPLOY_TOKEN", "NPM_TOKEN"]);
  });
});
