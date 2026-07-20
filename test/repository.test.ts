import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { pool, closePool } from "../src/db/pool.js";
import { saveScan } from "../src/db/repository.js";
import type { ScanReport } from "../src/core/types.js";

let dbAvailable = true;

beforeAll(async () => {
  try {
    await migrate();
    await pool.query("DELETE FROM findings");
    await pool.query("DELETE FROM scans");
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM findings").catch(() => {});
    await pool.query("DELETE FROM scans").catch(() => {});
  }
  await closePool();
});

function makeReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    createdAt: new Date().toISOString(),
    codeDir: "test/fixtures/code",
    docsDir: "test/fixtures/docs",
    totalCodeEndpoints: 1,
    totalDocEndpoints: 1,
    totalCodeEnvVars: 1,
    totalDocEnvVars: 1,
    findings: [],
    ...overrides,
  };
}

describe("repository.saveScan (requer Postgres em DATABASE_URL)", () => {
  it("marca findings como resolvidos quando desaparecem no scan seguinte", async () => {
    if (!dbAvailable) {
      console.warn("Postgres indisponível — pulando teste de integração do repositório.");
      return;
    }

    const first = await saveScan(
      makeReport({
        findings: [
          {
            type: "ENDPOINT_REMOVIDO",
            severity: "alta",
            subject: "GET /api/old",
            message: "removido",
            docRefs: [{ file: "README.md", line: 1, context: "GET /api/old" }],
            codeRefs: [],
          },
        ],
      }),
    );
    expect(first.newFindings).toHaveLength(1);
    expect(first.resolvedFindings).toHaveLength(0);

    const second = await saveScan(makeReport({ findings: [] }));
    expect(second.resolvedFindings).toHaveLength(1);
    expect(second.resolvedFindings[0].subject).toBe("GET /api/old");
    expect(second.newFindings).toHaveLength(0);
  });
});
