export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface CodeEndpoint {
  method: HttpMethod;
  path: string; // normalizado, ex: /users/:id
  file: string;
  line: number;
}

export interface CodeEnvVar {
  name: string;
  file: string;
  line: number;
}

export interface CodeFacts {
  endpoints: CodeEndpoint[];
  envVars: CodeEnvVar[];
}

export interface DocEndpointRef {
  method: HttpMethod;
  path: string;
  file: string;
  line: number;
  context: string; // trecho da linha para o relatório
}

export interface DocEnvVarRef {
  name: string;
  file: string;
  line: number;
  context: string;
}

export interface DocFacts {
  endpoints: DocEndpointRef[];
  envVars: DocEnvVarRef[];
}

/**
 * Tipos de recurso "extra" além de endpoint/env var: operações GraphQL, métodos gRPC,
 * tópicos de fila, comandos de CLI, eventos de WebSocket, tabelas de banco, roles/permissões.
 * Modelados de forma genérica para não precisar de um DriftType dedicado por tipo de recurso.
 */
export type ExtraResourceKind =
  | "GRAPHQL_OPERATION"
  | "GRPC_METHOD"
  | "QUEUE_TOPICO"
  | "CLI_COMANDO"
  | "WEBSOCKET_EVENTO"
  | "TABELA_BANCO"
  | "ROLE_PERMISSAO";

export interface ExtraCodeResource {
  kind: ExtraResourceKind;
  subject: string;
  file: string;
  line: number;
}

export interface ExtraDocResource {
  kind: ExtraResourceKind;
  subject: string;
  file: string;
  line: number;
  context: string;
}

export interface DependencyRef {
  name: string;
  version: string;
  file: string;
  line: number;
  context?: string;
}

export type DriftType =
  | "ENDPOINT_REMOVIDO" // documentado, mas não existe mais no código
  | "ENDPOINT_NAO_DOCUMENTADO" // existe no código, mas não está na doc
  | "ENV_VAR_REMOVIDA" // documentada, mas não existe mais no código
  | "ENV_VAR_NAO_DOCUMENTADA" // existe no código, mas não está na doc
  | "ENDPOINT_POSSIVELMENTE_RENOMEADO" // quase-drift: path parecido (Levenshtein) porém não idêntico
  | "METODO_DIVERGENTE" // mesmo path, método HTTP documentado difere do método real
  | "DOCUMENTACAO_ORFA" // arquivo de doc que não referencia nenhum endpoint/env existente
  | "RECURSO_NAO_DOCUMENTADO" // recurso extra (GraphQL/gRPC/fila/CLI/WS/tabela/role) sem menção na doc
  | "DEPENDENCIA_DIVERGENTE" // versão de dependência citada na doc diverge da versão real
  | "DOCUMENTACAO_DUPLICADA"; // mesmo endpoint documentado com conteúdo conflitante em arquivos diferentes

export type DriftSeverity = "alta" | "media" | "baixa";

export interface DriftFinding {
  type: DriftType;
  severity: DriftSeverity;
  subject: string; // ex: "GET /users/:id" ou "DATABASE_URL"
  message: string;
  docRefs: Array<{ file: string; line: number; context: string }>;
  codeRefs: Array<{ file: string; line: number }>;
}

export interface ScanReport {
  scanId?: number;
  createdAt: string;
  codeDir: string;
  docsDir: string;
  totalCodeEndpoints: number;
  totalDocEndpoints: number;
  totalCodeEnvVars: number;
  totalDocEnvVars: number;
  findings: DriftFinding[];
  coverageScore: number; // % de endpoints+env vars do código que estão documentados (0-100)
}

export interface DriftConfig {
  /** Sobrescreve a severidade padrão de um tipo de achado. */
  severityOverrides?: Partial<Record<DriftType, DriftSeverity>>;
  /** Distância máxima de Levenshtein para considerar dois paths como "possível renomeação". */
  renameDetectionMaxDistance?: number;
  /** Desliga tipos de detecção inteiros (ex.: ["DOCUMENTACAO_ORFA"]). */
  disabledTypes?: DriftType[];
}

export interface DriftIgnoreEntry {
  type: DriftType;
  subject: string;
  reason?: string;
}

