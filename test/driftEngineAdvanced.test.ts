import { describe, expect, it } from "vitest";
import { runScan } from "../src/core/scanner.js";

describe("runScan — detecções avançadas", () => {
  it("detecta quase-drift (renomeação), método divergente e documentação órfã", async () => {
    const report = await runScan({
      codeDir: "test/fixtures/drift-features/code",
      docsDir: "test/fixtures/drift-features/docs",
      useExtraSources: false,
    });

    const rename = report.findings.find((f) => f.type === "ENDPOINT_POSSIVELMENTE_RENOMEADO");
    expect(rename).toBeDefined();
    expect(rename?.subject).toContain("GET /api/users/:id");
    expect(rename?.subject).toContain("GET /api/user/:id");

    const methodMismatch = report.findings.find((f) => f.type === "METODO_DIVERGENTE");
    expect(methodMismatch).toBeDefined();
    expect(methodMismatch?.subject).toContain("/api/login");

    const orphan = report.findings.find((f) => f.type === "DOCUMENTACAO_ORFA");
    expect(orphan).toBeDefined();
    expect(orphan?.subject).toBe("CHANGELOG.md");

    expect(report.coverageScore).toBeGreaterThanOrEqual(0);
    expect(report.coverageScore).toBeLessThanOrEqual(100);
  });
});
