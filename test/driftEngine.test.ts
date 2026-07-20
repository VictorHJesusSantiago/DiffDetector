import { describe, expect, it } from "vitest";
import { runScan } from "../src/core/scanner.js";

describe("runScan (integração parsers + motor de drift)", () => {
  it("detecta endpoints/env vars removidos e não documentados a partir das fixtures", async () => {
    const report = await runScan({ codeDir: "test/fixtures/code", docsDir: "test/fixtures/docs" });

    const byType = (type: string) => report.findings.filter((f) => f.type === type).map((f) => f.subject);

    expect(byType("ENDPOINT_REMOVIDO")).toEqual(["DELETE /api/users/:id/legacy"]);
    expect(byType("ENDPOINT_NAO_DOCUMENTADO")).toEqual(["DELETE /api/users/:id/sessions"]);
    expect(byType("ENV_VAR_REMOVIDA")).toEqual(["LEGACY_CACHE_HOST"]);
    expect(byType("ENV_VAR_NAO_DOCUMENTADA")).toEqual(["FEATURE_NEW_CHECKOUT"]);

    // GET /api/users/:id e POST /api/users e DATABASE_URL/PORT existem em ambos → sem drift para eles
    expect(report.findings).toHaveLength(4);
  });

  it("não reporta drift quando código e docs estão sincronizados", async () => {
    const report = await runScan({ codeDir: "test/fixtures/code-sync", docsDir: "test/fixtures/docs-sync" });
    expect(report.findings).toHaveLength(0);
  });
});
