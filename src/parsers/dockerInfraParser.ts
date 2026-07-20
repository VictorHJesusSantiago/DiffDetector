import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import type { CodeEnvVar } from "../core/types.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];
const DOCKERFILE_ENV_RE = /^\s*(?:ENV|ARG)\s+([A-Z][A-Z0-9_]*)(?:[\s=].*)?$/gm;

interface ComposeFile {
  services?: Record<string, { environment?: string[] | Record<string, unknown> }>;
}

/**
 * Extrai variáveis de ambiente declaradas em Dockerfiles (ENV/ARG) e em docker-compose.yml
 * (services.<svc>.environment), tratando-as como "fatos reais do sistema" — o mesmo papel
 * que process.env.X tem no código de aplicação.
 */
export async function parseDockerInfra(rootDir: string): Promise<CodeEnvVar[]> {
  const [dockerfiles, composeFiles] = await Promise.all([
    fg(["**/Dockerfile", "**/Dockerfile.*"], { cwd: rootDir, ignore: DEFAULT_IGNORE, absolute: false }),
    fg(["**/docker-compose*.yml", "**/docker-compose*.yaml", "**/compose*.yml", "**/compose*.yaml"], {
      cwd: rootDir,
      ignore: DEFAULT_IGNORE,
      absolute: false,
    }),
  ]);

  const envVars: CodeEnvVar[] = [];

  for (const relFile of dockerfiles) {
    let content: string;
    try {
      content = await readFile(`${rootDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    for (const match of content.matchAll(DOCKERFILE_ENV_RE)) {
      const line = content.slice(0, match.index ?? 0).split("\n").length;
      envVars.push({ name: match[1], file: relFile, line });
    }
  }

  for (const relFile of composeFiles) {
    let content: string;
    try {
      content = await readFile(`${rootDir}/${relFile}`, "utf-8");
    } catch {
      continue;
    }
    let parsed: ComposeFile | undefined;
    try {
      parsed = parseYaml(content) as ComposeFile;
    } catch {
      continue;
    }
    if (!parsed?.services) continue;
    for (const service of Object.values(parsed.services)) {
      const env = service.environment;
      if (!env) continue;
      if (Array.isArray(env)) {
        for (const entry of env) {
          const name = String(entry).split("=")[0].trim();
          if (/^[A-Z][A-Z0-9_]*$/.test(name)) envVars.push({ name, file: relFile, line: 1 });
        }
      } else {
        for (const name of Object.keys(env)) {
          if (/^[A-Z][A-Z0-9_]*$/.test(name)) envVars.push({ name, file: relFile, line: 1 });
        }
      }
    }
  }

  return envVars;
}
