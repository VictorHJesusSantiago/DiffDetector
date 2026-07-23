import type { ExtraCodeResource, ExtraResourceKind } from "../core/types.js";
import type { ScanSource, SourceFile } from "../core/scanSource.js";

const EXTRA_RESOURCE_EXCLUDED_DIRS = ["vendor"];

/** GraphQL: extrai campos de `type Query { ... }` e `type Mutation { ... }` de arquivos .graphql/.gql (SDL). */
export async function parseGraphQLOperations(source: ScanSource): Promise<ExtraCodeResource[]> {
  return source.collect<ExtraCodeResource>(
    "graphql",
    { extensions: ["graphql", "gql"], excludeDirectories: EXTRA_RESOURCE_EXCLUDED_DIRS },
    (file) => {
      const resources: ExtraCodeResource[] = [];
      const blockRe = /type\s+(Query|Mutation)\s*\{([^}]*)\}/g;
      for (const block of file.content.matchAll(blockRe)) {
        const typeName = block[1];
        const fieldRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([^)]*\))?\s*:/gm;
        for (const field of block[2].matchAll(fieldRe)) {
          resources.push({
            kind: "GRAPHQL_OPERATION",
            subject: `${typeName}.${field[1]}`,
            file: file.relPath,
            line: file.lines.lineAt(block.index + field.index),
          });
        }
      }
      return resources;
    },
  );
}

/** gRPC/Protobuf: extrai `rpc MethodName(...)` de dentro de blocos `service X { ... }` em .proto. */
export async function parseGrpcMethods(source: ScanSource): Promise<ExtraCodeResource[]> {
  return source.collect<ExtraCodeResource>(
    "grpc",
    { extensions: ["proto"], excludeDirectories: EXTRA_RESOURCE_EXCLUDED_DIRS },
    (file) => {
      const resources: ExtraCodeResource[] = [];
      const serviceRe = /service\s+(\w+)\s*\{([^}]*)\}/g;
      for (const service of file.content.matchAll(serviceRe)) {
        const serviceName = service[1];
        const rpcRe = /rpc\s+(\w+)\s*\(/g;
        for (const rpc of service[2].matchAll(rpcRe)) {
          resources.push({
            kind: "GRPC_METHOD",
            subject: `${serviceName}.${rpc[1]}`,
            file: file.relPath,
            line: file.lines.lineAt(service.index + rpc.index),
          });
        }
      }
      return resources;
    },
  );
}

function collectByPatterns(
  file: SourceFile,
  kind: ExtraResourceKind,
  patterns: readonly RegExp[],
  transform: (captured: string) => string = (value) => value,
  skip: (captured: string) => boolean = () => false,
): ExtraCodeResource[] {
  const resources: ExtraCodeResource[] = [];
  for (const pattern of patterns) {
    for (const match of file.content.matchAll(pattern)) {
      if (skip(match[1])) continue;
      resources.push({
        kind,
        subject: transform(match[1]),
        file: file.relPath,
        line: file.lines.lineAt(match.index),
      });
    }
  }
  return resources;
}

const QUEUE_PATTERNS = [
  /\.(?:send|publish|produce|sendToQueue|subscribe)\s*\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g,
  /(?:topic|queue|channel)\s*[:=]\s*['"]([a-zA-Z0-9_.-]+)['"]/gi,
];

/** Filas: nomes de tópicos/filas literais em chamadas comuns de Kafka/RabbitMQ/SQS. */
export async function parseQueueTopics(source: ScanSource): Promise<ExtraCodeResource[]> {
  const resources = await source.collect<ExtraCodeResource>(
    "queue",
    { extensions: ["js", "ts", "jsx", "tsx", "py", "java", "go"], excludeDirectories: EXTRA_RESOURCE_EXCLUDED_DIRS },
    (file) => collectByPatterns(file, "QUEUE_TOPICO", QUEUE_PATTERNS),
  );
  return dedupe(resources);
}

const CLI_PATTERNS = [
  /\.command\s*\(\s*['"]([a-zA-Z0-9_: -]+)['"]/g, // commander (JS/TS)
  /@(?:click\.)?command\s*\(\s*(?:name\s*=\s*)?['"]([a-zA-Z0-9_-]+)['"]/g, // click (Python)
  /add_parser\s*\(\s*['"]([a-zA-Z0-9_-]+)['"]/g, // argparse subparsers (Python)
  /(?:var|&)?\s*\w+\s*=\s*&cobra\.Command\{\s*Use:\s*"([a-zA-Z0-9_ -]+)"/g, // cobra (Go)
];

/** CLI: subcomandos definidos com commander/click/argparse/cobra. */
export async function parseCliCommands(source: ScanSource): Promise<ExtraCodeResource[]> {
  const resources = await source.collect<ExtraCodeResource>(
    "cli",
    { extensions: ["js", "ts", "py", "go"], excludeDirectories: EXTRA_RESOURCE_EXCLUDED_DIRS },
    (file) => collectByPatterns(file, "CLI_COMANDO", CLI_PATTERNS, (captured) => captured.split(" ")[0]),
  );
  return dedupe(resources);
}

const WEBSOCKET_PATTERNS = [/\b(?:socket|io|ws|channel)\.on\s*\(\s*['"]([a-zA-Z0-9_:.-]+)['"]/g];
const WEBSOCKET_BUILTINS = new Set(["connection", "disconnect", "connect", "error", "close", "message", "open"]);

/** WebSocket: eventos registrados via `socket.on('evento', ...)` / `io.on('evento', ...)`. */
export async function parseWebSocketEvents(source: ScanSource): Promise<ExtraCodeResource[]> {
  const resources = await source.collect<ExtraCodeResource>(
    "websocket",
    { extensions: ["js", "ts", "jsx", "tsx"], excludeDirectories: EXTRA_RESOURCE_EXCLUDED_DIRS },
    (file) =>
      collectByPatterns(file, "WEBSOCKET_EVENTO", WEBSOCKET_PATTERNS, undefined, (captured) =>
        WEBSOCKET_BUILTINS.has(captured),
      ),
  );
  return dedupe(resources);
}

const SQL_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([a-zA-Z0-9_]+)["'`]?/gi;
const PRISMA_MODEL_RE = /^\s*model\s+(\w+)\s*\{/gm;
const TYPEORM_ENTITY_RE = /@Entity\s*\(\s*['"]([a-zA-Z0-9_]+)['"]\s*\)/g;

/** Tabelas de banco: migrations SQL (`CREATE TABLE x`), Prisma (`model X {`), TypeORM (`@Entity('x')`). */
export async function parseDbTables(source: ScanSource): Promise<ExtraCodeResource[]> {
  const resources = await source.collect<ExtraCodeResource>(
    "dbTables",
    { extensions: ["sql", "prisma", "ts", "js"], excludeDirectories: EXTRA_RESOURCE_EXCLUDED_DIRS },
    (file) => {
      if (file.relPath.endsWith(".sql")) return collectByPatterns(file, "TABELA_BANCO", [SQL_TABLE_RE]);
      if (file.relPath.endsWith(".prisma")) return collectByPatterns(file, "TABELA_BANCO", [PRISMA_MODEL_RE]);
      return collectByPatterns(file, "TABELA_BANCO", [TYPEORM_ENTITY_RE]);
    },
  );
  return dedupe(resources);
}

const ROLE_PATTERNS = [
  /@RequireRole\s*\(\s*['"]([a-zA-Z0-9_-]+)['"]/g,
  /requireRole\s*\(\s*['"]([a-zA-Z0-9_-]+)['"]/g,
  /@PreAuthorize\s*\(\s*"hasRole\(['"]([a-zA-Z0-9_-]+)['"]\)"\s*\)/g,
  /@(?:role_required|roles_required)\s*\(\s*['"]([a-zA-Z0-9_-]+)['"]/g,
];

/** Roles/permissões usadas em middlewares/decorators de autorização. */
export async function parseRoles(source: ScanSource): Promise<ExtraCodeResource[]> {
  const resources = await source.collect<ExtraCodeResource>(
    "roles",
    { extensions: ["js", "ts", "jsx", "tsx", "java", "py"], excludeDirectories: EXTRA_RESOURCE_EXCLUDED_DIRS },
    (file) => collectByPatterns(file, "ROLE_PERMISSAO", ROLE_PATTERNS),
  );
  return dedupe(resources);
}

function dedupe(items: readonly ExtraCodeResource[]): ExtraCodeResource[] {
  const map = new Map<string, ExtraCodeResource>();
  for (const item of items) {
    // NUL como separador da chave composta: não pode ocorrer nem em `kind` nem em `subject`,
    // então a chave nunca fica ambígua. Subjects contêm espaços, pontos e `::`.
    const key = `${item.kind}\u0000${item.subject}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

export async function parseAllExtraResources(source: ScanSource): Promise<ExtraCodeResource[]> {
  const results = await Promise.all([
    parseGraphQLOperations(source),
    parseGrpcMethods(source),
    parseQueueTopics(source),
    parseCliCommands(source),
    parseWebSocketEvents(source),
    parseDbTables(source),
    parseRoles(source),
  ]);
  return results.flat();
}

export type { ExtraResourceKind };
