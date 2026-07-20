import fg from "fast-glob";
import { parseCodeDirectory } from "../parsers/codeParser.js";
import { parseDocsDirectory } from "../parsers/docParser.js";
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
import type { ScanReport } from "./types.js";

export interface RunScanOptions {
  codeDir: string;
  docsDir: string;
  /** Ativa parsers extras: .env.example, OpenAPI, Docker/Terraform/K8s/CI-CD, GraphQL/gRPC/filas/etc. Default: true. */
  useExtraSources?: boolean;
  /** Ativa cache de parsing por arquivo (persistido em .drift-cache.json). Default: false. */
  useCache?: boolean;
  configPath?: string;
  ignorePath?: string;
}

export async function runScan(opts: RunScanOptions): Promise<ScanReport> {
  const { codeDir, docsDir, useExtraSources = true, useCache = false, configPath, ignorePath } = opts;

  const cache = useCache ? new ParseCache() : undefined;
  if (cache) await cache.load();

  const [codeFacts, docFacts, config, ignoreList, multiLangEndpoints] = await Promise.all([
    parseCodeDirectory(codeDir, cache),
    parseDocsDirectory(docsDir),
    loadConfig(configPath),
    loadIgnoreList(ignorePath),
    parseMultiLangRoutes(codeDir),
  ]);
  codeFacts.endpoints.push(...multiLangEndpoints);

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
      parseEnvExampleFiles(codeDir),
      parseOpenApiSpecs(docsDir),
      parseDockerInfra(codeDir),
      parseTerraformVariables(codeDir),
      parseKubernetesEnvVars(codeDir),
      parseCiCdEnvVars(codeDir),
      parsePostmanCollections(docsDir),
      parseAsyncApiChannels(docsDir),
      parseJsDocRoutes(codeDir),
      parseHtmlDocs(docsDir),
      parseAllExtraResources(codeDir),
      parseCodeDependencies(codeDir),
      parseDocDependencies(docsDir),
    ]);

    docFacts.envVars.push(...envExampleRefs.filter((r) => !docFacts.envVars.some((e) => e.name === r.name)));
    docFacts.endpoints.push(...openApiRefs, ...postmanRefs, ...jsDocRefs, ...htmlDocFacts.endpoints);
    docFacts.envVars.push(...htmlDocFacts.envVars.filter((r) => !docFacts.envVars.some((e) => e.name === r.name)));

    const infraEnvVars = [...dockerEnvVars, ...terraformVars, ...k8sEnvVars, ...cicdEnvVars];
    codeFacts.envVars.push(...infraEnvVars.filter((r) => !codeFacts.envVars.some((e) => e.name === r.name)));

    extraCodeResources = extraResources;
    extraDocResources = [...(await findDocMentions(docsDir, extraResources)), ...asyncApiRefs];
    codeDependencies = deps;
    docDependencies = docDeps;
  }

  const docFiles = await fg("**/*.{md,mdx}", {
    cwd: docsDir,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });

  if (cache) await cache.save();

  return compareFacts(codeFacts, docFacts, codeDir, docsDir, {
    config,
    ignoreList,
    docFiles,
    extraCodeResources,
    extraDocResources,
    codeDependencies,
    docDependencies,
  });
}
