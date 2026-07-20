import { describe, expect, it } from "vitest";
import { parseCodeDependencies, parseDocDependencies } from "../src/parsers/dependencyParser.js";
import { compareFacts } from "../src/core/driftEngine.js";

const CODE_DIR = "test/fixtures/deps/code";
const DOCS_DIR = "test/fixtures/deps/docs";

describe("parseCodeDependencies / parseDocDependencies", () => {
  it("lê dependências reais do package.json e versões citadas na doc", async () => {
    const codeDeps = await parseCodeDependencies(CODE_DIR);
    expect(codeDeps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "express", version: "4.19.2" }),
        expect.objectContaining({ name: "left-pad", version: "1.3.0" }),
      ]),
    );

    const docDeps = await parseDocDependencies(DOCS_DIR);
    expect(docDeps).toEqual(expect.arrayContaining([expect.objectContaining({ name: "express", version: "4.17.0" })]));
  });

  it("compareFacts sinaliza DEPENDENCIA_DIVERGENTE quando as versões não batem", async () => {
    const codeDeps = await parseCodeDependencies(CODE_DIR);
    const docDeps = await parseDocDependencies(DOCS_DIR);

    const report = compareFacts(
      { endpoints: [], envVars: [] },
      { endpoints: [], envVars: [] },
      CODE_DIR,
      DOCS_DIR,
      { codeDependencies: codeDeps, docDependencies: docDeps },
    );

    const finding = report.findings.find((f) => f.type === "DEPENDENCIA_DIVERGENTE");
    expect(finding).toBeDefined();
    expect(finding?.subject).toBe("express");
    expect(finding?.message).toContain("4.17.0");
    expect(finding?.message).toContain("4.19.2");
  });
});
