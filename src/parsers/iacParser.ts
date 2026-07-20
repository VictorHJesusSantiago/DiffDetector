import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import type { CodeEnvVar } from "../core/types.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/.terraform/**"];

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

async function readSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** Terraform: `variable "X" { ... }` — tratado como configuração que a doc de infra deveria descrever. */
export async function parseTerraformVariables(rootDir: string): Promise<CodeEnvVar[]> {
  const files = await fg("**/*.tf", { cwd: rootDir, ignore: DEFAULT_IGNORE });
  const envVars: CodeEnvVar[] = [];
  const re = /variable\s+"([a-zA-Z0-9_\-]+)"\s*\{/g;
  for (const relFile of files) {
    const content = await readSafe(`${rootDir}/${relFile}`);
    if (!content) continue;
    for (const match of content.matchAll(re)) {
      envVars.push({ name: match[1].toUpperCase(), file: relFile, line: lineOf(content, match.index ?? 0) });
    }
  }
  return envVars;
}

interface K8sManifest {
  kind?: string;
  spec?: {
    template?: { spec?: { containers?: Array<{ env?: Array<{ name?: string }> }> } };
    containers?: Array<{ env?: Array<{ name?: string }> }>;
  };
  data?: Record<string, unknown>;
}

/** Kubernetes: `env: - name: X` em Deployments/Pods, e chaves de ConfigMap/Secret (`data:`). */
export async function parseKubernetesEnvVars(rootDir: string): Promise<CodeEnvVar[]> {
  const files = await fg("**/*.{yaml,yml}", {
    cwd: rootDir,
    ignore: [...DEFAULT_IGNORE, "**/docker-compose*.yml", "**/docker-compose*.yaml"],
  });
  const envVars: CodeEnvVar[] = [];
  for (const relFile of files) {
    const content = await readSafe(`${rootDir}/${relFile}`);
    if (!content) continue;
    let docs: K8sManifest[];
    try {
      docs = content
        .split(/^---\s*$/m)
        .map((chunk) => parseYaml(chunk) as K8sManifest)
        .filter((d): d is K8sManifest => !!d && typeof d === "object");
    } catch {
      continue;
    }
    for (const doc of docs) {
      if (!doc.kind) continue;
      const containers =
        doc.spec?.template?.spec?.containers ?? doc.spec?.containers ?? [];
      for (const container of containers) {
        for (const envEntry of container.env ?? []) {
          if (envEntry.name && /^[A-Z][A-Z0-9_]*$/.test(envEntry.name)) {
            envVars.push({ name: envEntry.name, file: relFile, line: 1 });
          }
        }
      }
      if ((doc.kind === "ConfigMap" || doc.kind === "Secret") && doc.data) {
        for (const key of Object.keys(doc.data)) {
          if (/^[A-Z][A-Z0-9_]*$/.test(key)) envVars.push({ name: key, file: relFile, line: 1 });
        }
      }
    }
  }
  return envVars;
}

/** CI/CD: variáveis/secrets referenciados em GitHub Actions (`${{ secrets.X }}`/`env:`) e GitLab CI (`variables:`). */
export async function parseCiCdEnvVars(rootDir: string): Promise<CodeEnvVar[]> {
  const files = await fg([".github/workflows/*.{yml,yaml}", "**/.gitlab-ci.yml"], {
    cwd: rootDir,
    ignore: DEFAULT_IGNORE,
    dot: true,
  });
  const envVars: CodeEnvVar[] = [];
  const secretsRe = /\$\{\{\s*secrets\.([A-Z][A-Z0-9_]*)\s*\}\}/g;
  const envBlockRe = /^\s*([A-Z][A-Z0-9_]*)\s*:/gm;

  for (const relFile of files) {
    const content = await readSafe(`${rootDir}/${relFile}`);
    if (!content) continue;
    for (const match of content.matchAll(secretsRe)) {
      envVars.push({ name: match[1], file: relFile, line: lineOf(content, match.index ?? 0) });
    }
    const envSectionMatch = content.match(/^\s*env:\s*\n((?:\s+[A-Z][A-Z0-9_]*:.*\n?)+)/m);
    if (envSectionMatch) {
      for (const match of envSectionMatch[1].matchAll(envBlockRe)) {
        envVars.push({ name: match[1], file: relFile, line: lineOf(content, (envSectionMatch.index ?? 0) + (match.index ?? 0)) });
      }
    }
  }
  return dedupeByName(envVars);
}

function dedupeByName(items: CodeEnvVar[]): CodeEnvVar[] {
  const map = new Map<string, CodeEnvVar>();
  for (const item of items) if (!map.has(item.name)) map.set(item.name, item);
  return [...map.values()];
}
