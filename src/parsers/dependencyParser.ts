import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { DependencyRef } from "../core/types.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Lê dependências declaradas em package.json e requirements.txt (nome + versão real). */
export async function parseCodeDependencies(codeDir: string): Promise<DependencyRef[]> {
  const deps: DependencyRef[] = [];

  const packageJsonFiles = await fg("**/package.json", { cwd: codeDir, ignore: DEFAULT_IGNORE });
  for (const relFile of packageJsonFiles) {
    let raw: string;
    try {
      raw = await readFile(`${codeDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      deps.push({ name, version, file: relFile, line: 1 });
    }
  }

  const requirementsFiles = await fg("**/requirements*.txt", { cwd: codeDir, ignore: DEFAULT_IGNORE });
  const reqRe = /^([a-zA-Z0-9_.\-]+)\s*==\s*([a-zA-Z0-9_.\-]+)/;
  for (const relFile of requirementsFiles) {
    let raw: string;
    try {
      raw = await readFile(`${codeDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    raw.split("\n").forEach((lineText, idx) => {
      const match = reqRe.exec(lineText.trim());
      if (match) deps.push({ name: match[1], version: match[2], file: relFile, line: idx + 1 });
    });
  }

  return deps;
}

/** Varre Markdown à procura de menções "nome vX.Y.Z" / "nome@X.Y.Z" — versões citadas na documentação. */
export async function parseDocDependencies(docsDir: string): Promise<DependencyRef[]> {
  const files = await fg("**/*.{md,mdx}", { cwd: docsDir, ignore: DEFAULT_IGNORE });
  const deps: DependencyRef[] = [];
  const re = /\b([a-zA-Z][a-zA-Z0-9_.\-]{1,50})[@\s]v?(\d+\.\d+(?:\.\d+)?)\b/g;

  for (const relFile of files) {
    let content: string;
    try {
      content = await readFile(`${docsDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    for (const match of content.matchAll(re)) {
      const line = content.slice(0, match.index ?? 0).split("\n").length;
      deps.push({
        name: match[1],
        version: match[2],
        file: relFile,
        line,
        context: content.split("\n")[line - 1]?.trim().slice(0, 200),
      });
    }
  }
  return deps;
}
