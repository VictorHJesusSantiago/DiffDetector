import { parseCodeDirectory } from "../parsers/codeParser.js";
import { listDocFiles, parseDocsDirectory } from "../parsers/docParser.js";
import { parseEnvExampleFiles } from "../parsers/envExampleParser.js";
import { parseOpenApiSpecs } from "../parsers/openapiParser.js";
import { parseDockerInfra } from "../parsers/dockerInfraParser.js";
import { parseMultiLangRoutes } from "../parsers/multiLangRouteParser.js";
import { parseAllExtraResources } from "../parsers/extraResourceParser.js";
import { findDocMentions } from "../parsers/mentionParser.js";
import { parseTerraformVariables, parseKubernetesEnvVars, parseCiCdEnvVars } from "../parsers/iacParser.js";
import { parsePostmanCollections } from "../parsers/postmanParser.js";
import { parseAsyncApiChannels } from "../parsers/asyncapiParser.js";
import { parseJsDocRoutes } from "../parsers/jsdocParser.js";
import { parseHtmlDocs } from "../parsers/htmlDocParser.js";
import { parseCodeDependencies, parseDocDependencies } from "../parsers/dependencyParser.js";
import { compareFacts } from "./driftEngine.js";
import { loadConfig, loadIgnoreList } from "./config.js";
import { ParseCache } from "./parseCache.js";
import { ScanSource } from "./scanSource.js";
import type { CodeEnvVar, DocEnvVarRef, ScanReport } from "./types.js";

/** Teto padrão de duração de um scan. Ver `ScanTimeoutError`. */
export const DEFAULT_SCAN_TIMEOUT_MS = 120_000;

/**
 * Um scan excedeu o tempo máximo permitido.
 *
 * Sem esse limite, um diretório patológico (árvore gigantesca, arquivo de centenas de MB,
 * regex quadrática sobre conteúdo hostil) prendia a requisição HTTP e o event loop
 * indefinidamente, sem nenhuma forma de recuperação além de reiniciar o processo.
 */
export class ScanTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`O scan excedeu o tempo limite de ${timeoutMs} ms e foi interrompido.`);
    this.name = "ScanTimeoutError";
  }
}

export interface RunScanOptions {
  codeDir: string;
  docsDir: string;
  /** Ativa parsers extras: .env.example, OpenAPI, Docker/Terraform/K8s/CI-CD, GraphQL/gRPC/filas/etc. Default: true. */
  useExtraSources?: boolean;
  /** Ativa cache de parsing por arquivo (persistido em .drift-cache.json). Default: false. */
  useCache?: boolean;
  configPath?: string;
  ignorePath?: string;
  /** Tempo máximo do scan em milissegundos. 0 ou negativo desliga o limite. */
  timeoutMs?: number;
  /** Cancelamento externo, combinado com o timeout interno. */
  signal?: AbortSignal;
}

/**
 * Acrescenta apenas as variáveis cujo nome ainda não apareceu, preservando a primeira
 * ocorrência (a de origem mais confiável). Substitui o idioma
 * `novas.filter(r => !atuais.some(e => e.name === r.name))`, que era O(n × m).
 */
function appendNewNames<T extends { name: string }>(target: T[], candidates: readonly T[]): void {
  const seen = new Set(target.map((item) => item.name));
  for (const candidate of candidates) {
    if (seen.has(candidate.name)) continue;
    seen.add(candidate.name);
    target.push(candidate);
  }
}

/**
 * Combina o timeout interno com um `AbortSignal` externo opcional, devolvendo o sinal
 * resultante e a função de limpeza — sem ela, o timer manteria o processo vivo depois de um
 * scan rápido (`unref` resolveria o processo travado, mas não o timer acumulado no `--watch`).
 */
function createScanSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timers: NodeJS.Timeout[] = [];

  const abortFromExternal = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", abortFromExternal, { once: true });
  }

  if (timeoutMs > 0) {
    timers.push(setTimeout(() => controller.abort(new ScanTimeoutError(timeoutMs)), timeoutMs));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const timer of timers) clearTimeout(timer);
      external?.removeEventListener("abort", abortFromExternal);
    },
  };
}

export async function runScan(opts: RunScanOptions): Promise<ScanReport> {
  const {
    codeDir,
    docsDir,
    useExtraSources = true,
    useCache = false,
    configPath,
    ignorePath,
    timeoutMs = DEFAULT_SCAN_TIMEOUT_MS,
    signal: externalSignal,
  } = opts;

  const { signal, dispose } = createScanSignal(timeoutMs, externalSignal);
  try {
    return await executeScan({ codeDir, docsDir, useExtraSources, useCache, configPath, ignorePath }, signal);
  } catch (err) {
    // O AbortSignal propaga a razão do abort; um scan interrompido por tempo precisa chegar ao
    // chamador como ScanTimeoutError, e não como o AbortError genérico do runtime.
    if (signal.aborted && signal.reason instanceof ScanTimeoutError) throw signal.reason;
    throw err;
  } finally {
    dispose();
  }
}

async function executeScan(
  opts: Required<Pick<RunScanOptions, "codeDir" | "docsDir" | "useExtraSources" | "useCache">> &
    Pick<RunScanOptions, "configPath" | "ignorePath">,
  signal: AbortSignal,
): Promise<ScanReport> {
  const { codeDir, docsDir, useExtraSources, useCache, configPath, ignorePath } = opts;

  const cache = useCache ? new ParseCache() : undefined;
  if (cache) await cache.load();

  // Uma travessia por raiz, compartilhada por todos os parsers daquele lado. Quando código e
  // documentação estão no mesmo diretório (caso comum: `--code . --docs .`), a mesma fonte é
  // reutilizada e a árvore é percorrida uma única vez no scan inteiro.
  const codeSource = await ScanSource.create(codeDir, { cache, signal });
  const docsSource =
    docsDir === codeDir ? codeSource : await ScanSource.create(docsDir, { cache, signal });

  const [codeFacts, parsedDocFacts, config, ignoreList, multiLangEndpoints] = await Promise.all([
    parseCodeDirectory(codeSource),
    parseDocsDirectory(docsSource),
    loadConfig(configPath),
    loadIgnoreList(ignorePath),
    parseMultiLangRoutes(codeSource),
  ]);

  const docFiles = listDocFiles(docsSource);

  // Cópias locais: os fatos devolvidos pelos parsers são tratados como imutáveis pelo scanner.
  const codeEndpoints = [...codeFacts.endpoints, ...multiLangEndpoints];
  const codeEnvVars: CodeEnvVar[] = [...codeFacts.envVars];
  const docEndpoints = [...parsedDocFacts.endpoints];
  const docEnvVars: DocEnvVarRef[] = [...parsedDocFacts.envVars];

  let extraCodeResources: Awaited<ReturnType<typeof parseAllExtraResources>> = [];
  let extraDocResources: Awaited<ReturnType<typeof findDocMentions>> = [];
  let codeDependencies: Awaited<ReturnType<typeof parseCodeDependencies>> = [];
  let docDependencies: Awaited<ReturnType<typeof parseDocDependencies>> = [];

  if (useExtraSources) {
    const [
      envExampleRefs,
      openApiRefs,
      dockerEnvVars,
      terraformVars,
      k8sEnvVars,
      cicdEnvVars,
      postmanRefs,
      asyncApiRefs,
      jsDocRefs,
      htmlDocFacts,
      extraResources,
      deps,
      docDeps,
    ] = await Promise.all([
      parseEnvExampleFiles(codeSource),
      parseOpenApiSpecs(docsSource),
      parseDockerInfra(codeSource),
      parseTerraformVariables(codeSource),
      parseKubernetesEnvVars(codeSource),
      parseCiCdEnvVars(codeSource),
      parsePostmanCollections(docsSource),
      parseAsyncApiChannels(docsSource),
      parseJsDocRoutes(codeSource),
      parseHtmlDocs(docsSource),
      parseAllExtraResources(codeSource),
      parseCodeDependencies(codeSource),
      parseDocDependencies(docsSource),
    ]);

    appendNewNames(docEnvVars, envExampleRefs);
    appendNewNames(docEnvVars, htmlDocFacts.envVars);
    docEndpoints.push(...openApiRefs, ...postmanRefs, ...jsDocRefs, ...htmlDocFacts.endpoints);

    appendNewNames(codeEnvVars, [...dockerEnvVars, ...terraformVars, ...k8sEnvVars, ...cicdEnvVars]);

    extraCodeResources = extraResources;
    extraDocResources = [...(await findDocMentions(docsSource, extraResources)), ...asyncApiRefs];
    codeDependencies = deps;
    docDependencies = docDeps;
  }

  signal.throwIfAborted();
  if (cache) await cache.save();

  return compareFacts(
    { endpoints: codeEndpoints, envVars: codeEnvVars },
    { endpoints: docEndpoints, envVars: docEnvVars },
    codeDir,
    docsDir,
    {
      config,
      ignoreList,
      docFiles,
      extraCodeResources,
      extraDocResources,
      codeDependencies,
      docDependencies,
    },
  );
}
