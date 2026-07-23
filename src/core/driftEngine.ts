import type {
  CodeEndpoint,
  CodeEnvVar,
  CodeFacts,
  DependencyRef,
  DocEndpointRef,
  DocEnvVarRef,
  DocFacts,
  DriftConfig,
  DriftFinding,
  DriftIgnoreEntry,
  DriftSeverity,
  DriftType,
  ExtraCodeResource,
  ExtraDocResource,
  ScanReport,
} from "./types.js";
import { levenshteinDistance, levenshteinWithin } from "./levenshtein.js";
import { DEFAULT_CONFIG, IgnoreIndex } from "./config.js";

const MAX_COVERAGE_PERCENT = 100;

function endpointKey(method: string, path: string): string {
  return `${method} ${path}`;
}

const DEFAULT_SEVERITY: Record<DriftType, DriftSeverity> = {
  ENDPOINT_REMOVIDO: "alta",
  ENV_VAR_REMOVIDA: "alta",
  METODO_DIVERGENTE: "alta",
  ENDPOINT_POSSIVELMENTE_RENOMEADO: "media",
  ENDPOINT_NAO_DOCUMENTADO: "media",
  DOCUMENTACAO_ORFA: "media",
  RECURSO_NAO_DOCUMENTADO: "baixa",
  DEPENDENCIA_DIVERGENTE: "media",
  DOCUMENTACAO_DUPLICADA: "media",
  ENV_VAR_NAO_DOCUMENTADA: "baixa",
};

const SEVERITY_RANK: Record<DriftSeverity, number> = { alta: 3, media: 2, baixa: 1 };

/** Tipos de achado que representam "existe no código e não está documentado". */
const UNDOCUMENTED_TYPES: ReadonlySet<DriftType> = new Set<DriftType>([
  "ENDPOINT_NAO_DOCUMENTADO",
  "ENV_VAR_NAO_DOCUMENTADA",
]);

const KIND_LABEL: Record<ExtraCodeResource["kind"], { article: string; noun: string }> = {
  GRAPHQL_OPERATION: { article: "A", noun: "operação GraphQL" },
  GRPC_METHOD: { article: "O", noun: "método gRPC" },
  QUEUE_TOPICO: { article: "O", noun: "tópico de fila" },
  CLI_COMANDO: { article: "O", noun: "comando de CLI" },
  WEBSOCKET_EVENTO: { article: "O", noun: "evento de WebSocket" },
  TABELA_BANCO: { article: "A", noun: "tabela de banco de dados" },
  ROLE_PERMISSAO: { article: "A", noun: "role/permissão" },
};

export interface CompareOptions {
  config?: DriftConfig;
  ignoreList?: DriftIgnoreEntry[];
  /** Caminho relativo dos arquivos de doc que existem, para checar órfãos (opcional). */
  docFiles?: string[];
  /** Recursos extras encontrados no código: GraphQL, gRPC, filas, CLI, WebSocket, tabelas, roles. */
  extraCodeResources?: ExtraCodeResource[];
  /** Menções desses recursos extras encontradas na documentação. */
  extraDocResources?: ExtraDocResource[];
  /** Dependências declaradas no código (package.json/requirements.txt). */
  codeDependencies?: DependencyRef[];
  /** Dependências/versões citadas na documentação. */
  docDependencies?: DependencyRef[];
}

/**
 * Tudo que uma regra de detecção pode consultar. Reunir isso em um único objeto permite que
 * cada regra seja uma função independente e testável, em vez de um trecho no meio de uma
 * função de 260 linhas: acrescentar um tipo de drift passou a ser acrescentar um item em
 * `DRIFT_RULES`, sem tocar nas regras existentes.
 */
interface DriftContext {
  readonly codeFacts: CodeFacts;
  readonly docFacts: DocFacts;
  readonly options: CompareOptions;
  readonly renameMaxDistance: number;
  readonly codeEndpointsByKey: ReadonlyMap<string, CodeEndpoint[]>;
  readonly docEndpointsByKey: ReadonlyMap<string, DocEndpointRef[]>;
  readonly codeEndpointsByPath: ReadonlyMap<string, CodeEndpoint[]>;
  readonly docEndpointsByPath: ReadonlyMap<string, DocEndpointRef[]>;
  readonly codeEnvVarsByName: ReadonlyMap<string, CodeEnvVar[]>;
  readonly docEnvVarsByName: ReadonlyMap<string, DocEnvVarRef[]>;
  /** Chaves "MÉTODO /caminho" já explicadas por METODO_DIVERGENTE — não são endpoint removido. */
  readonly methodMismatchKeys: Set<string>;
}

/** Emite um achado candidato; a supressão por config/ignore-list é aplicada pelo emissor. */
type EmitFinding = (
  type: DriftType,
  subject: string,
  message: string,
  docRefs: DriftFinding["docRefs"],
  codeRefs: DriftFinding["codeRefs"],
) => void;

interface DriftRule {
  readonly name: string;
  readonly detect: (context: DriftContext, emit: EmitFinding) => void;
}

function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const existing = map.get(keyOf(item));
    if (existing) existing.push(item);
    else map.set(keyOf(item), [item]);
  }
  return map;
}

function toDocRefs(refs: readonly { file: string; line: number; context?: string }[]): DriftFinding["docRefs"] {
  return refs.map((ref) => ({ file: ref.file, line: ref.line, context: ref.context ?? "" }));
}

function toCodeRefs(refs: readonly { file: string; line: number }[]): DriftFinding["codeRefs"] {
  return refs.map((ref) => ({ file: ref.file, line: ref.line }));
}

/**
 * Método HTTP documentado que não existe no código, mas cujo caminho existe: a doc usou o
 * verbo errado. Precisa rodar antes de ENDPOINT_REMOVIDO, que consome `methodMismatchKeys`.
 */
const detectMethodMismatch: DriftRule = {
  name: "METODO_DIVERGENTE",
  detect: (ctx, emit) => {
    for (const [path, docEndpoints] of ctx.docEndpointsByPath) {
      const codeEndpoints = ctx.codeEndpointsByPath.get(path);
      if (!codeEndpoints) continue;
      const codeMethods = new Set(codeEndpoints.map((endpoint) => endpoint.method));
      const docMethods = new Set(docEndpoints.map((endpoint) => endpoint.method));

      for (const docMethod of docMethods) {
        if (codeMethods.has(docMethod)) continue;
        const codeMethodList = [...codeMethods];
        ctx.methodMismatchKeys.add(endpointKey(docMethod, path));
        emit(
          "METODO_DIVERGENTE",
          `${path} (doc: ${docMethod}, código: ${codeMethodList.join("/")})`,
          `O caminho "${path}" está documentado com o método ${docMethod}, mas no código só existe com ${codeMethodList.join(", ")}. A documentação pode estar usando o verbo HTTP errado.`,
          toDocRefs(docEndpoints.filter((endpoint) => endpoint.method === docMethod)),
          toCodeRefs(codeEndpoints),
        );
      }
    }
  },
};

/** Endpoint documentado que sumiu do código — possivelmente apenas renomeado. */
const detectRemovedEndpoints: DriftRule = {
  name: "ENDPOINT_REMOVIDO",
  detect: (ctx, emit) => {
    for (const [key, docRefs] of ctx.docEndpointsByKey) {
      if (ctx.codeEndpointsByKey.has(key)) continue;
      if (ctx.methodMismatchKeys.has(key)) continue;

      const [docMethod, docPath] = splitEndpointKey(key);
      const candidate = findClosestPath(docMethod, docPath, ctx.codeFacts.endpoints, ctx.renameMaxDistance);

      if (candidate) {
        emit(
          "ENDPOINT_POSSIVELMENTE_RENOMEADO",
          `${key} → ${endpointKey(candidate.method, candidate.path)}`,
          `O endpoint documentado "${key}" não existe mais, mas há um endpoint muito parecido no código: "${endpointKey(candidate.method, candidate.path)}" (distância de edição: ${levenshteinDistance(docPath, candidate.path)}). Pode ter sido apenas renomeado — confira antes de reescrever a documentação do zero.`,
          toDocRefs(docRefs),
          toCodeRefs([candidate]),
        );
        continue;
      }

      emit(
        "ENDPOINT_REMOVIDO",
        key,
        `O endpoint "${key}" está documentado, mas não foi encontrado no código-fonte. A documentação pode estar desatualizada (endpoint removido ou renomeado).`,
        toDocRefs(docRefs),
        [],
      );
    }
  },
};

const detectUndocumentedEndpoints: DriftRule = {
  name: "ENDPOINT_NAO_DOCUMENTADO",
  detect: (ctx, emit) => {
    for (const [key, codeRefs] of ctx.codeEndpointsByKey) {
      if (ctx.docEndpointsByKey.has(key)) continue;
      emit(
        "ENDPOINT_NAO_DOCUMENTADO",
        key,
        `O endpoint "${key}" existe no código, mas não foi encontrado em nenhum documento. Considere documentá-lo.`,
        [],
        toCodeRefs(codeRefs),
      );
    }
  },
};

const detectEnvVarDrift: DriftRule = {
  name: "ENV_VAR",
  detect: (ctx, emit) => {
    for (const [name, docRefs] of ctx.docEnvVarsByName) {
      if (ctx.codeEnvVarsByName.has(name)) continue;
      emit(
        "ENV_VAR_REMOVIDA",
        name,
        `A variável de ambiente "${name}" está documentada, mas não é referenciada em lugar nenhum do código. Pode ter sido removida ou renomeada.`,
        toDocRefs(docRefs),
        [],
      );
    }

    for (const [name, codeRefs] of ctx.codeEnvVarsByName) {
      if (ctx.docEnvVarsByName.has(name)) continue;
      emit(
        "ENV_VAR_NAO_DOCUMENTADA",
        name,
        `A variável de ambiente "${name}" é usada no código, mas não está documentada.`,
        [],
        toCodeRefs(codeRefs),
      );
    }
  },
};

/** Arquivo de doc que não cita nenhum endpoint, env var ou recurso extra reconhecível. */
const detectOrphanDocs: DriftRule = {
  name: "DOCUMENTACAO_ORFA",
  detect: (ctx, emit) => {
    const docFiles = ctx.options.docFiles ?? [];
    if (docFiles.length === 0) return;

    const referencedFiles = new Set<string>();
    for (const endpoint of ctx.docFacts.endpoints) referencedFiles.add(endpoint.file);
    for (const envVar of ctx.docFacts.envVars) referencedFiles.add(envVar.file);
    for (const resource of ctx.options.extraDocResources ?? []) referencedFiles.add(resource.file);

    for (const file of docFiles) {
      if (referencedFiles.has(file)) continue;
      emit(
        "DOCUMENTACAO_ORFA",
        file,
        `O arquivo de documentação "${file}" não referencia nenhum endpoint ou variável de ambiente reconhecível. Pode estar completamente obsoleto ou fora do escopo detectável.`,
        [{ file, line: 1, context: "" }],
        [],
      );
    }
  },
};

/**
 * Recurso extra do código (GraphQL, gRPC, fila, CLI, WebSocket, tabela, role) sem menção na doc.
 *
 * O agrupamento é feito por par (kind, subject) em um Map aninhado, e não concatenando os dois
 * em uma string "kind::subject": subjects legitimamente contêm "::" (métodos gRPC e roles
 * qualificados, por exemplo), e o `split("::")` da versão anterior truncava o subject no
 * primeiro separador — o achado saía com o nome do recurso cortado e a supressão via
 * drift-ignore.json nunca casava com ele.
 */
const detectUndocumentedResources: DriftRule = {
  name: "RECURSO_NAO_DOCUMENTADO",
  detect: (ctx, emit) => {
    const codeResources = ctx.options.extraCodeResources ?? [];
    if (codeResources.length === 0) return;

    const mentionedByKind = new Map<string, Set<string>>();
    for (const mention of ctx.options.extraDocResources ?? []) {
      const subjects = mentionedByKind.get(mention.kind) ?? new Set<string>();
      subjects.add(mention.subject);
      mentionedByKind.set(mention.kind, subjects);
    }

    const byKind = groupBy(codeResources, (resource) => resource.kind);
    for (const [kind, resources] of byKind) {
      const mentioned = mentionedByKind.get(kind);
      const bySubject = groupBy(resources, (resource) => resource.subject);
      for (const [subject, refs] of bySubject) {
        if (mentioned?.has(subject)) continue;
        const label = KIND_LABEL[kind];
        const participle = label.article === "A" ? "encontrada" : "encontrado";
        emit(
          "RECURSO_NAO_DOCUMENTADO",
          `[${kind}] ${subject}`,
          `${label.article} ${label.noun} "${subject}" existe no código, mas não foi ${participle} em nenhum documento.`,
          [],
          toCodeRefs(refs),
        );
      }
    }
  },
};

const detectDependencyMismatch: DriftRule = {
  name: "DEPENDENCIA_DIVERGENTE",
  detect: (ctx, emit) => {
    const codeDependencies = ctx.options.codeDependencies ?? [];
    const docDependencies = ctx.options.docDependencies ?? [];
    if (codeDependencies.length === 0 || docDependencies.length === 0) return;

    const codeByName = new Map(codeDependencies.map((dep) => [dep.name, dep]));
    for (const docDep of docDependencies) {
      const codeDep = codeByName.get(docDep.name);
      if (!codeDep) continue;
      if (normalizeVersion(codeDep.version) === normalizeVersion(docDep.version)) continue;
      emit(
        "DEPENDENCIA_DIVERGENTE",
        docDep.name,
        `A documentação cita "${docDep.name}" na versão ${docDep.version}, mas o código declara a versão ${codeDep.version}.`,
        toDocRefs([docDep]),
        toCodeRefs([codeDep]),
      );
    }
  },
};

/** Mesmo endpoint descrito em arquivos diferentes com textos diferentes. */
const detectConflictingDocs: DriftRule = {
  name: "DOCUMENTACAO_DUPLICADA",
  detect: (ctx, emit) => {
    for (const [key, refs] of ctx.docEndpointsByKey) {
      const distinctFiles = new Set(refs.map((ref) => ref.file));
      const distinctContexts = new Set(refs.map((ref) => ref.context));
      if (distinctFiles.size < 2 || distinctContexts.size < 2) continue;
      emit(
        "DOCUMENTACAO_DUPLICADA",
        key,
        `O endpoint "${key}" está documentado em ${distinctFiles.size} arquivos diferentes (${[...distinctFiles].join(", ")}) com descrições diferentes. Pode haver informação conflitante.`,
        toDocRefs(refs),
        [],
      );
    }
  },
};

/**
 * Ordem significativa: `detectMethodMismatch` popula `methodMismatchKeys`, consumido por
 * `detectRemovedEndpoints` para não reportar duas vezes o mesmo caminho.
 */
const DRIFT_RULES: readonly DriftRule[] = [
  detectMethodMismatch,
  detectRemovedEndpoints,
  detectUndocumentedEndpoints,
  detectEnvVarDrift,
  detectOrphanDocs,
  detectUndocumentedResources,
  detectDependencyMismatch,
  detectConflictingDocs,
];

/**
 * Percentual de endpoints e variáveis de ambiente do código que estão documentados.
 * Exportado porque o mesmo cálculo precisa ser reproduzido sobre um scan lido do banco
 * (comando `latest`), onde só existem os totais persistidos e os achados.
 */
export function calculateCoverageScore(
  totalCodeSubjects: number,
  findings: readonly { type: string }[],
): number {
  if (totalCodeSubjects === 0) return MAX_COVERAGE_PERCENT;
  const undocumented = findings.filter((finding) => UNDOCUMENTED_TYPES.has(finding.type as DriftType)).length;
  const documented = Math.max(0, totalCodeSubjects - undocumented);
  return Math.round((documented / totalCodeSubjects) * MAX_COVERAGE_PERCENT);
}

export function compareFacts(
  codeFacts: CodeFacts,
  docFacts: DocFacts,
  codeDir: string,
  docsDir: string,
  options: CompareOptions = {},
): ScanReport {
  const { config = {}, ignoreList = [] } = options;
  const disabledTypes = new Set(config.disabledTypes ?? []);
  const ignoreIndex = new IgnoreIndex(ignoreList);
  const findings: DriftFinding[] = [];

  const emit: EmitFinding = (type, subject, message, docRefs, codeRefs) => {
    if (disabledTypes.has(type)) return;
    if (ignoreIndex.has(type, subject)) return;
    const severity = config.severityOverrides?.[type] ?? DEFAULT_SEVERITY[type];
    findings.push({ type, severity, subject, message, docRefs, codeRefs });
  };

  const context: DriftContext = {
    codeFacts,
    docFacts,
    options,
    renameMaxDistance: config.renameDetectionMaxDistance ?? DEFAULT_CONFIG.renameDetectionMaxDistance,
    codeEndpointsByKey: groupBy(codeFacts.endpoints, (ep) => endpointKey(ep.method, ep.path)),
    docEndpointsByKey: groupBy(docFacts.endpoints, (ep) => endpointKey(ep.method, ep.path)),
    codeEndpointsByPath: groupBy(codeFacts.endpoints, (ep) => ep.path),
    docEndpointsByPath: groupBy(docFacts.endpoints, (ep) => ep.path),
    codeEnvVarsByName: groupBy(codeFacts.envVars, (env) => env.name),
    docEnvVarsByName: groupBy(docFacts.envVars, (env) => env.name),
    methodMismatchKeys: new Set<string>(),
  };

  for (const rule of DRIFT_RULES) rule.detect(context, emit);

  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const totalCodeSubjects = codeFacts.endpoints.length + codeFacts.envVars.length;

  return {
    createdAt: new Date().toISOString(),
    codeDir,
    docsDir,
    totalCodeEndpoints: codeFacts.endpoints.length,
    totalDocEndpoints: docFacts.endpoints.length,
    totalCodeEnvVars: codeFacts.envVars.length,
    totalDocEnvVars: docFacts.envVars.length,
    findings,
    coverageScore: calculateCoverageScore(totalCodeSubjects, findings),
  };
}

function splitEndpointKey(key: string): [string, string] {
  const separatorIndex = key.indexOf(" ");
  return [key.slice(0, separatorIndex), key.slice(separatorIndex + 1)];
}

function findClosestPath(
  method: string,
  docPath: string,
  codeEndpoints: readonly CodeEndpoint[],
  maxDistance: number,
): CodeEndpoint | null {
  let best: CodeEndpoint | null = null;
  let bestDistance = Infinity;
  for (const endpoint of codeEndpoints) {
    if (endpoint.method !== method) continue;
    const distance = levenshteinWithin(docPath, endpoint.path, maxDistance);
    if (distance > 0 && distance <= maxDistance && distance < bestDistance) {
      best = endpoint;
      bestDistance = distance;
    }
  }
  return best;
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^[~^=vV]+/, "");
}
