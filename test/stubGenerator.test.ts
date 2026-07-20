import { describe, expect, it } from "vitest";
import { generateDocStub } from "../src/core/stubGenerator.js";
import type { DriftFinding } from "../src/core/types.js";

describe("generateDocStub", () => {
  it("gera stub para endpoints e env vars não documentados", () => {
    const findings: DriftFinding[] = [
      {
        type: "ENDPOINT_NAO_DOCUMENTADO",
        severity: "media",
        subject: "GET /x",
        message: "",
        docRefs: [],
        codeRefs: [{ file: "a.js", line: 1 }],
      },
      {
        type: "ENV_VAR_NAO_DOCUMENTADA",
        severity: "baixa",
        subject: "FOO_BAR",
        message: "",
        docRefs: [],
        codeRefs: [{ file: "b.js", line: 2 }],
      },
    ];
    const stub = generateDocStub(findings);
    expect(stub).toContain("## Endpoints");
    expect(stub).toContain("`GET /x`");
    expect(stub).toContain("## Variáveis de ambiente");
    expect(stub).toContain("`FOO_BAR`");
  });

  it("retorna mensagem neutra quando não há pendências", () => {
    expect(generateDocStub([])).toBe("Nenhum endpoint ou variável de ambiente pendente de documentação.");
  });
});
