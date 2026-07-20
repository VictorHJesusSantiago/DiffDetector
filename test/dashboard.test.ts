import { describe, expect, it } from "vitest";
import { generateDashboardHtml, type DashboardScanRow } from "../src/core/dashboard.js";

describe("generateDashboardHtml", () => {
  it("gera HTML estático com SVG e tabela a partir do histórico de scans", () => {
    const rows: DashboardScanRow[] = [
      {
        id: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        code_dir: "src",
        docs_dir: "docs",
        total_code_endpoints: 5,
        total_doc_endpoints: 3,
        total_code_env_vars: 2,
        total_doc_env_vars: 2,
        open_findings: 4,
      },
      {
        id: 2,
        created_at: "2026-01-02T00:00:00.000Z",
        code_dir: "src",
        docs_dir: "docs",
        total_code_endpoints: 5,
        total_doc_endpoints: 5,
        total_code_env_vars: 2,
        total_doc_env_vars: 2,
        open_findings: 0,
      },
    ];

    const html = generateDashboardHtml(rows);
    expect(html).toContain("<svg");
    expect(html).toContain("Scan #1");
    expect(html).toContain("Scan #2");
    expect(html).toContain("#1");
    expect(html).toContain("#2");
  });

  it("lida com histórico vazio sem quebrar", () => {
    const html = generateDashboardHtml([]);
    expect(html).toContain("Nenhum scan no histórico.");
  });
});
