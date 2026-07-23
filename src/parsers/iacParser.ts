import { parse as parseYaml } from "yaml";
import type { CodeEnvVar } from "../core/types.js";
import type { ScanSource } from "../core/scanSource.js";

const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const COMPOSE_BASENAME_RE = /^(docker-)?compose.*\.ya?ml$/i;

function parseYamlOrNull<T>(raw: string): T | null {
  try {
    return parseYaml(raw) as T;
  } catch {
    // YAML inválido é conteúdo de terceiro malformado, não erro de configuração deste programa.
    return null;
  }
}

/** Terraform: `variable "X" { ... }` — tratado como configuração que a doc de infra deveria descrever. */
export async function parseTerraformVariables(source: ScanSource): Promise<CodeEnvVar[]> {
  const re = /variable\s+"([a-zA-Z0-9_-]+)"\s*\{/g;
  return source.collect<CodeEnvVar>("terraform", { extensions: ["tf"] }, (file) => {
    const envVars: CodeEnvVar[] = [];
    for (const match of file.content.matchAll(re)) {
      envVars.push({ name: match[1].toUpperCase(), file: file.relPath, line: file.lines.lineAt(match.index) });
    }
    return envVars;
  });
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
export async function parseKubernetesEnvVars(source: ScanSource): Promise<CodeEnvVar[]> {
  return source.collect<CodeEnvVar>(
    "kubernetes",
    {
      extensions: ["yaml", "yml"],
      where: (entry) => !COMPOSE_BASENAME_RE.test(entry.basename),
    },
    (file) => {
      const envVars: CodeEnvVar[] = [];
      // Cada documento YAML é parseado isoladamente: um manifesto inválido no meio de um
      // arquivo multi-documento não pode descartar os manifestos válidos ao redor dele.
      const docs = file.content
        .split(/^---\s*$/m)
        .map((chunk) => parseYamlOrNull<K8sManifest>(chunk))
        .filter((doc): doc is K8sManifest => !!doc && typeof doc === "object");

      for (const doc of docs) {
        if (!doc.kind) continue;
        const containers = doc.spec?.template?.spec?.containers ?? doc.spec?.containers ?? [];
        for (const container of containers) {
          for (const envEntry of container.env ?? []) {
            if (envEntry.name && ENV_VAR_NAME_RE.test(envEntry.name)) {
              envVars.push({ name: envEntry.name, file: file.relPath, line: 1 });
            }
          }
        }
        if ((doc.kind === "ConfigMap" || doc.kind === "Secret") && doc.data) {
          for (const key of Object.keys(doc.data)) {
            if (ENV_VAR_NAME_RE.test(key)) envVars.push({ name: key, file: file.relPath, line: 1 });
          }
        }
      }
      return envVars;
    },
  );
}

const CI_PATH_RE = /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml)$/;
const SECRETS_RE = /\$\{\{\s*secrets\.([A-Z][A-Z0-9_]*)\s*\}\}/g;
const ENV_BLOCK_RE = /^\s*([A-Z][A-Z0-9_]*)\s*:/gm;

/** CI/CD: variáveis/secrets referenciados em GitHub Actions (`${{ secrets.X }}`/`env:`) e GitLab CI (`variables:`). */
export async function parseCiCdEnvVars(source: ScanSource): Promise<CodeEnvVar[]> {
  const envVars = await source.collect<CodeEnvVar>(
    "cicd",
    { pathPattern: CI_PATH_RE, includeDotPaths: true },
    (file) => {
      const found: CodeEnvVar[] = [];
      for (const match of file.content.matchAll(SECRETS_RE)) {
        found.push({ name: match[1], file: file.relPath, line: file.lines.lineAt(match.index) });
      }
      const envSection = /^\s*env:\s*\n((?:\s+[A-Z][A-Z0-9_]*:.*\n?)+)/m.exec(file.content);
      if (envSection) {
        for (const match of envSection[1].matchAll(ENV_BLOCK_RE)) {
          found.push({
            name: match[1],
            file: file.relPath,
            line: file.lines.lineAt(envSection.index + match.index),
          });
        }
      }
      return found;
    },
  );
  return dedupeByName(envVars);
}

function dedupeByName(items: readonly CodeEnvVar[]): CodeEnvVar[] {
  const map = new Map<string, CodeEnvVar>();
  for (const item of items) if (!map.has(item.name)) map.set(item.name, item);
  return [...map.values()];
}
