import { parse as parseYaml } from "yaml";
import type { CodeEnvVar } from "../core/types.js";
import type { ScanSource } from "../core/scanSource.js";

const DOCKERFILE_ENV_RE = /^\s*(?:ENV|ARG)\s+([A-Z][A-Z0-9_]*)(?:[\s=].*)?$/gm;
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const DOCKERFILE_BASENAME_RE = /^Dockerfile(\..+)?$/;
const COMPOSE_BASENAME_RE = /^(docker-)?compose.*\.ya?ml$/i;

interface ComposeFile {
  services?: Record<string, { environment?: string[] | Record<string, unknown> } | null>;
}

/**
 * Extrai variáveis de ambiente declaradas em Dockerfiles (ENV/ARG) e em docker-compose.yml
 * (services.<svc>.environment), tratando-as como "fatos reais do sistema" — o mesmo papel
 * que process.env.X tem no código de aplicação.
 */
export async function parseDockerInfra(source: ScanSource): Promise<CodeEnvVar[]> {
  const [fromDockerfiles, fromCompose] = await Promise.all([
    source.collect<CodeEnvVar>("dockerfile", { basenamePattern: DOCKERFILE_BASENAME_RE }, (file) => {
      const envVars: CodeEnvVar[] = [];
      for (const match of file.content.matchAll(DOCKERFILE_ENV_RE)) {
        envVars.push({ name: match[1], file: file.relPath, line: file.lines.lineAt(match.index) });
      }
      return envVars;
    }),

    source.collect<CodeEnvVar>("compose", { basenamePattern: COMPOSE_BASENAME_RE }, (file) => {
      let raw: unknown;
      try {
        raw = parseYaml(file.content);
      } catch {
        // Compose malformado: nada a extrair, e não é problema deste programa reportar.
        return [];
      }
      const parsed = raw as ComposeFile | null | undefined;
      if (!parsed?.services || typeof parsed.services !== "object") return [];

      const envVars: CodeEnvVar[] = [];
      for (const service of Object.values(parsed.services)) {
        const env = service?.environment;
        if (!env) continue;
        const names = Array.isArray(env) ? env.map((entry) => String(entry).split("=")[0].trim()) : Object.keys(env);
        for (const name of names) {
          if (ENV_VAR_NAME_RE.test(name)) envVars.push({ name, file: file.relPath, line: 1 });
        }
      }
      return envVars;
    }),
  ]);

  return [...fromDockerfiles, ...fromCompose];
}
