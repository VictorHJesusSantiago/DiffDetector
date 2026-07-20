import { describe, expect, it } from "vitest";
import { exportReport } from "../src/core/exporters.js";
import type { ScanReport } from "../src/core/types.js";

const report: ScanReport = {
  createdAt: "2026-07-09T00:00:00.000Z",
  codeDir: "src",
  docsDir: "docs",
  totalCodeEndpoints: 1,
  totalDocEndpoints: 0,
  totalCodeEnvVars: 0,
  totalDocEnvVars: 0,
  coverageScore: 0,
  findings: [
    {
      type: "ENDPOINT_NAO_DOCUMENTADO",
      severity: "media",
      subject: "GET /x",
      message: "não documentado",
      docRefs: [],
      codeRefs: [{ file: "a.js", line: 3 }],
    },
  ],
};

describe("exportReport", () => {
  it("gera JSON válido", () => {
    const output = exportReport(report, "json");
    expect(JSON.parse(output).findings).toHaveLength(1);
  });

  it("gera Markdown com tabela", () => {
    const output = exportReport(report, "markdown");
    expect(output).toContain("| Severidade | Tipo | Assunto | Mensagem |");
    expect(output).toContain("GET /x");
  });

  it("gera HTML válido com a linha do achado", () => {
    const output = exportReport(report, "html");
    expect(output).toContain("<html");
    expect(output).toContain("GET /x");
  });

  it("gera CSV com cabeçalho", () => {
    const output = exportReport(report, "csv");
    expect(output.split("\n")[0]).toBe("severity,type,subject,message");
  });

  it("gera JUnit XML com testsuite", () => {
    const output = exportReport(report, "junit");
    expect(output).toContain("<testsuite");
    expect(output).toContain("GET /x");
  });
});
