import { describe, expect, it } from "vitest";
import { compareFacts } from "../src/core/driftEngine.js";
import type { CodeFacts, DocFacts } from "../src/core/types.js";

const codeFacts: CodeFacts = {
  endpoints: [{ method: "GET", path: "/x", file: "a.js", line: 1 }],
  envVars: [],
};
const docFacts: DocFacts = { endpoints: [], envVars: [] };

describe("compareFacts — config e ignore list", () => {
  it("aplica severidade customizada via config", () => {
    const report = compareFacts(codeFacts, docFacts, "code", "docs", {
      config: { severityOverrides: { ENDPOINT_NAO_DOCUMENTADO: "alta" } },
    });
    expect(report.findings[0].severity).toBe("alta");
  });

  it("desliga um tipo de achado via disabledTypes", () => {
    const report = compareFacts(codeFacts, docFacts, "code", "docs", {
      config: { disabledTypes: ["ENDPOINT_NAO_DOCUMENTADO"] },
    });
    expect(report.findings).toHaveLength(0);
  });

  it("ignora um achado específico via ignoreList", () => {
    const report = compareFacts(codeFacts, docFacts, "code", "docs", {
      ignoreList: [{ type: "ENDPOINT_NAO_DOCUMENTADO", subject: "GET /x" }],
    });
    expect(report.findings).toHaveLength(0);
  });
});
