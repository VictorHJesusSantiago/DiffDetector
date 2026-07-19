import type {
  CodeEndpoint,
  CodeFacts,
  DependencyRef,
  DocEndpointRef,
  DocFacts,
  DriftConfig,
  DriftFinding,
  DriftIgnoreEntry,
  DriftType,
  ExtraCodeResource,
  ExtraDocResource,
  ScanReport,
} from "./types.js";
import { levenshteinDistance } from "./levenshtein.js";
import { DEFAULT_CONFIG, isIgnored } from "./config.js";

function endpointKey(method: string, path: string): string {
  return `${method} ${path}`;
}

const DEFAULT_SEVERITY: Record<DriftType, DriftFinding["severity"]> = {
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

export function compareFacts(
  codeFacts: CodeFacts,
  docFacts: DocFacts,
  codeDir: string,
  docsDir: string,
  options: CompareOptions = {},
): ScanReport {
  const {
    config = {},
    ignoreList = [],
    docFiles = [],
    extraCodeResources = [],
    extraDocResources = [],
    codeDependencies = [],
    docDependencies = [],
  } = options;
  const disabled = new Set(config.disabledTypes ?? []);
  const findings: DriftFinding[] = [];

  const push = (type: DriftType, subject: string, message: string, docRefs: DriftFinding["docRefs"], codeRefs: DriftFinding["codeRefs"]) => {
    if (disabled.has(type)) return;
    if (isIgnored(ignoreList, type, subject)) return;
    const severity = config.severityOverrides?.[type] ?? DEFAULT_SEVERITY[type];
    findings.push({ type, severity, subject, message, docRefs, codeRefs });
  };

  const codeEndpointMap = new Map<string, CodeEndpoint[]>();
  for (const ep of codeFacts.endpoints) {
    const key = endpointKey(ep.method, ep.path);
    const list = codeEndpointMap.get(key) ?? [];
    list.push(ep);
    codeEndpointMap.set(key, list);
  }

  const docEndpointMap = new Map<string, DocEndpointRef[]>();
  for (const ep of docFacts.endpoints) {
    const key = endpointKey(ep.method, ep.path);
    const list = docEndpointMap.get(key) ?? [];
    list.push(ep);
    docEndpointMap.set(key, list);
  }

  // Detecta divergência de método no mesmo path (doc tem GET /x, código tem POST /x)
  const docPathsByPath = new Map<string, DocEndpointRef[]>();
  for (const ep of docFacts.endpoints) {
    const list = docPathsByPath.get(ep.path) ?? [];
    list.push(ep);
    docPathsByPath.set(ep.path, list);
  }
  const codePathsByPath = new Map<string, CodeEndpoint[]>();
  for (const ep of codeFacts.endpoints) {
    const list = codePathsByPath.get(ep.path) ?? [];
    list.push(ep);
    codePathsByPath.set(ep.path, list);
  }

  const methodMismatchSubjects = new Set<string>();
  for (const [path, docEps] of docPathsByPath) {
    const codeEps = codePathsByPath.get(path);
    if (!codeEps) continue;
    const docMethods = new Set(docEps.map((e) => e.method));
    const codeMethods = new Set(codeEps.map((e) => e.method));
    for (const docMethod of docMethods) {
      if (codeMethods.has(docMethod)) continue;
      // Path existe nos dois lados, mas com métodos diferentes — não é endpoint removido, é divergência.
      const docRefsForMethod = docEps.filter((e) => e.method === docMethod);
      const subject = `${path} (doc: ${docMethod}, código: ${[...codeMethods].join("/")})`;
      methodMismatchSubjects.add(endpointKey(docMethod, path));
      push(
        "METODO_DIVERGENTE",
        subject,
        `O caminho "${path}" está documentado com o método ${docMethod}, mas no código só existe com ${[...codeMethods].join(", ")}. A documentação pode estar usando o verbo HTTP errado.`,
        docRefsForMethod.map((r) => ({ file: r.file, line: r.line, context: r.context })),
        codeEps.map((r) => ({ file: r.file, line: r.line })),
      );
    }
  }

  // Endpoints documentados que não existem mais no código (excluindo os já cobertos por METODO_DIVERGENTE)
  const renameMaxDistance = config.renameDetectionMaxDistance ?? DEFAULT_CONFIG.renameDetectionMaxDistance;
  for (const [key, docRefs] of docEndpointMap) {
    if (codeEndpointMap.has(key)) continue;
    if (methodMismatchSubjects.has(key)) continue;

    const [docMethod, docPath] = splitKey(key);

    // Quase-drift: existe endpoint de mesmo método no código com path muito parecido
    const candidate = findClosestPath(docMethod, docPath, codeFacts.endpoints, renameMaxDistance);
    if (candidate) {
      push(
        "ENDPOINT_POSSIVELMENTE_RENOMEADO",
        `${key} → ${endpointKey(candidate.method, candidate.path)}`,
        `O endpoint documentado "${key}" não existe mais, mas há um endpoint muito parecido no código: "${endpointKey(candidate.method, candidate.path)}" (distância de edição: ${levenshteinDistance(docPath, candidate.path)}). Pode ter sido apenas renomeado — confira antes de reescrever a documentação do zero.`,
        docRefs.map((r) => ({ file: r.file, line: r.line, context: r.context })),
        [{ file: candidate.file, line: candidate.line }],
      );
      continue;
    }

    push(
      "ENDPOINT_REMOVIDO",
      key,
      `O endpoint "${key}" está documentado, mas não foi encontrado no código-fonte. A documentação pode estar desatualizada (endpoint removido ou renomeado).`,
      docRefs.map((r) => ({ file: r.file, line: r.line, context: r.context })),
      [],
    );
  }

  // Endpoints no código que não estão documentados
  for (const [key, codeRefs] of codeEndpointMap) {
    if (docEndpointMap.has(key)) continue;
    push(
      "ENDPOINT_NAO_DOCUMENTADO",
      key,
      `O endpoint "${key}" existe no código, mas não foi encontrado em nenhum documento. Considere documentá-lo.`,
      [],
      codeRefs.map((r) => ({ file: r.file, line: r.line })),
    );
  }

  const codeEnvMap = new Map<string, typeof codeFacts.envVars>();
  for (const ev of codeFacts.envVars) {
    const list = codeEnvMap.get(ev.name) ?? [];
    list.push(ev);
    codeEnvMap.set(ev.name, list);
  }

  const docEnvMap = new Map<string, typeof docFacts.envVars>();
  for (const ev of docFacts.envVars) {
    const list = docEnvMap.get(ev.name) ?? [];
    list.push(ev);
    docEnvMap.set(ev.name, list);
  }

  for (const [name, docRefs] of docEnvMap) {
    if (codeEnvMap.has(name)) continue;
    push(
      "ENV_VAR_REMOVIDA",
      name,
      `A variável de ambiente "${name}" está documentada, mas não é referenciada em lugar nenhum do código. Pode ter sido removida ou renomeada.`,
      docRefs.map((r) => ({ file: r.file, line: r.line, context: r.context })),
      [],
    );
  }

  for (const [name, codeRefs] of codeEnvMap) {
    if (docEnvMap.has(name)) continue;
    push(
      "ENV_VAR_NAO_DOCUMENTADA",
      name,
      `A variável de ambiente "${name}" é usada no código, mas não está documentada.`,
      [],
      codeRefs.map((r) => ({ file: r.file, line: r.line })),
    );
  }

  // Documentação órfã: arquivos de doc que não citam nenhum endpoint/env/recurso extra existentes no código
  if (docFiles.length > 0) {
    const referencedFiles = new Set<string>();
    for (const ep of docFacts.endpoints) referencedFiles.add(ep.file);
    for (const ev of docFacts.envVars) referencedFiles.add(ev.file);
    for (const ref of extraDocResources) referencedFiles.add(ref.file);
    for (const file of docFiles) {
      if (referencedFiles.has(file)) continue;
      push(
        "DOCUMENTACAO_ORFA",
        file,
        `O arquivo de documentação "${file}" não referencia nenhum endpoint ou variável de ambiente reconhecível. Pode estar completamente obsoleto ou fora do escopo detectável.`,
        [{ file, line: 1, context: "" }],
        [],
      );
    }
  }

  // Recursos extras (GraphQL, gRPC, filas, CLI, WebSocket, tabelas, roles) sem menção na doc.
  const mentionedByKind = new Map<string, Set<string>>();
  for (const ref of extraDocResources) {
    const set = mentionedByKind.get(ref.kind) ?? new Set<string>();
    set.add(ref.subject);
    mentionedByKind.set(ref.kind, set);
  }
  const codeExtraByKindSubject = new Map<string, ExtraCodeResource[]>();
  for (const res of extraCodeResources) {
    const key = `${res.kind}::${res.subject}`;
    const list = codeExtraByKindSubject.get(key) ?? [];
    list.push(res);
    codeExtraByKindSubject.set(key, list);
  }
  for (const [key, refs] of codeExtraByKindSubject) {
    const [kind, subject] = key.split("::");
    if (mentionedByKind.get(kind)?.has(subject)) continue;
    const label = KIND_LABEL[kind as ExtraCodeResource["kind"]];
    const participle = label.article === "A" ? "encontrada" : "encontrado";
    push(
      "RECURSO_NAO_DOCUMENTADO",
      `[${kind}] ${subject}`,
      `${label.article} ${label.noun} "${subject}" existe no código, mas não foi ${participle} em nenhum documento.`,
      [],
      refs.map((r) => ({ file: r.file, line: r.line })),
    );
  }

  // Dependências com versão divergente entre código e documentação.
  const codeDepMap = new Map<string, DependencyRef>();
  for (const dep of codeDependencies) codeDepMap.set(dep.name, dep);
  for (const docDep of docDependencies) {
    const codeDep = codeDepMap.get(docDep.name);
    if (!codeDep) continue;
    if (normalizeVersion(codeDep.version) === normalizeVersion(docDep.version)) continue;
    push(
      "DEPENDENCIA_DIVERGENTE",
      docDep.name,
      `A documentação cita "${docDep.name}" na versão ${docDep.version}, mas o código declara a versão ${codeDep.version}.`,
      [{ file: docDep.file, line: docDep.line, context: docDep.context ?? "" }],
      [{ file: codeDep.file, line: codeDep.line }],
    );
  }

  // Documentação duplicada/conflitante: mesmo endpoint descrito em arquivos diferentes com textos diferentes.
  const docEndpointsByKeyAllFiles = new Map<string, DocEndpointRef[]>();
  for (const ep of docFacts.endpoints) {
    const key = endpointKey(ep.method, ep.path);
    const list = docEndpointsByKeyAllFiles.get(key) ?? [];
    list.push(ep);
    docEndpointsByKeyAllFiles.set(key, list);
  }
  for (const [key, refs] of docEndpointsByKeyAllFiles) {
    const distinctFiles = new Set(refs.map((r) => r.file));
    const distinctContexts = new Set(refs.map((r) => r.context));
    if (distinctFiles.size < 2 || distinctContexts.size < 2) continue;
    push(
      "DOCUMENTACAO_DUPLICADA",
      key,
      `O endpoint "${key}" está documentado em ${distinctFiles.size} arquivos diferentes (${[...distinctFiles].join(", ")}) com descrições diferentes. Pode haver informação conflitante.`,
      refs.map((r) => ({ file: r.file, line: r.line, context: r.context })),
      [],
    );
  }

  findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const totalCodeSubjects = codeFacts.endpoints.length + codeFacts.envVars.length;
  const undocumented = findings.filter(
    (f) => f.type === "ENDPOINT_NAO_DOCUMENTADO" || f.type === "ENV_VAR_NAO_DOCUMENTADA",
  ).length;
  const coverageScore =
    totalCodeSubjects === 0 ? 100 : Math.round(((totalCodeSubjects - undocumented) / totalCodeSubjects) * 100);

  return {
    createdAt: new Date().toISOString(),
    codeDir,
    docsDir,
    totalCodeEndpoints: codeFacts.endpoints.length,
    totalDocEndpoints: docFacts.endpoints.length,
    totalCodeEnvVars: codeFacts.envVars.length,
    totalDocEnvVars: docFacts.envVars.length,
    findings,
    coverageScore,
  };
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf(" ");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function findClosestPath(
  method: string,
  docPath: string,
  codeEndpoints: CodeEndpoint[],
  maxDistance: number,
): CodeEndpoint | null {
  let best: CodeEndpoint | null = null;
  let bestDistance = Infinity;
  for (const ep of codeEndpoints) {
    if (ep.method !== method) continue;
    const distance = levenshteinDistance(docPath, ep.path);
    if (distance > 0 && distance <= maxDistance && distance < bestDistance) {
      best = ep;
      bestDistance = distance;
    }
  }
  return best;
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^[~^=vV]+/, "");
}

function severityRank(s: string): number {
  return s === "alta" ? 3 : s === "media" ? 2 : 1;
}
