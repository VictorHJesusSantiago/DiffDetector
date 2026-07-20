import { describe, expect, it } from "vitest";
import { compareFacts } from "../src/core/driftEngine.js";
import type { CodeFacts, DocFacts } from "../src/core/types.js";

describe("compareFacts — documentação duplicada/conflitante", () => {
  it("detecta o mesmo endpoint documentado em dois arquivos com descrições diferentes", () => {
    const codeFacts: CodeFacts = {
      endpoints: [{ method: "GET", path: "/api/status", file: "app.js", line: 1 }],
      envVars: [],
    };
    const docFacts: DocFacts = {
      endpoints: [
        { method: "GET", path: "/api/status", file: "README.md", line: 3, context: "GET /api/status retorna 200 sempre" },
        { method: "GET", path: "/api/status", file: "RUNBOOK.md", line: 10, context: "GET /api/status requer autenticação" },
      ],
      envVars: [],
    };

    const report = compareFacts(codeFacts, docFacts, "code", "docs");
    const finding = report.findings.find((f) => f.type === "DOCUMENTACAO_DUPLICADA");
    expect(finding).toBeDefined();
    expect(finding?.docRefs).toHaveLength(2);
  });

  it("não sinaliza duplicidade quando o texto é idêntico nos dois arquivos", () => {
    const codeFacts: CodeFacts = {
      endpoints: [{ method: "GET", path: "/api/status", file: "app.js", line: 1 }],
      envVars: [],
    };
    const docFacts: DocFacts = {
      endpoints: [
        { method: "GET", path: "/api/status", file: "README.md", line: 3, context: "mesmo texto" },
        { method: "GET", path: "/api/status", file: "RUNBOOK.md", line: 10, context: "mesmo texto" },
      ],
      envVars: [],
    };

    const report = compareFacts(codeFacts, docFacts, "code", "docs");
    expect(report.findings.find((f) => f.type === "DOCUMENTACAO_DUPLICADA")).toBeUndefined();
  });
});
