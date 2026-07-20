import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { ExtraCodeResource, ExtraResourceKind } from "../core/types.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/vendor/**"];

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

/** GraphQL: extrai campos de `type Query { ... }` e `type Mutation { ... }` de arquivos .graphql/.gql (SDL). */
export async function parseGraphQLOperations(codeDir: string): Promise<ExtraCodeResource[]> {
  const files = await fg("**/*.{graphql,gql}", { cwd: codeDir, ignore: DEFAULT_IGNORE });
  const resources: ExtraCodeResource[] = [];
  for (const relFile of files) {
    const content = await readSafe(`${codeDir}/${relFile}`);
    if (!content) continue;
    const blockRe = /type\s+(Query|Mutation)\s*\{([^}]*)\}/g;
    for (const block of content.matchAll(blockRe)) {
      const typeName = block[1];
      const body = block[2];
      const fieldRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([^)]*\))?\s*:/gm;
      for (const field of body.matchAll(fieldRe)) {
        resources.push({
          kind: "GRAPHQL_OPERATION",
          subject: `${typeName}.${field[1]}`,
          file: relFile,
          line: lineOf(content, (block.index ?? 0) + (field.index ?? 0)),
        });
      }
    }
  }
  return resources;
}

/** gRPC/Protobuf: extrai `rpc MethodName(...)` de dentro de blocos `service X { ... }` em .proto. */
export async function parseGrpcMethods(codeDir: string): Promise<ExtraCodeResource[]> {
  const files = await fg("**/*.proto", { cwd: codeDir, ignore: DEFAULT_IGNORE });
  const resources: ExtraCodeResource[] = [];
  for (const relFile of files) {
    const content = await readSafe(`${codeDir}/${relFile}`);
    if (!content) continue;
    const serviceRe = /service\s+(\w+)\s*\{([^}]*)\}/g;
    for (const service of content.matchAll(serviceRe)) {
      const serviceName = service[1];
      const body = service[2];
      const rpcRe = /rpc\s+(\w+)\s*\(/g;
      for (const rpc of body.matchAll(rpcRe)) {
        resources.push({
          kind: "GRPC_METHOD",
          subject: `${serviceName}.${rpc[1]}`,
          file: relFile,
          line: lineOf(content, (service.index ?? 0) + (rpc.index ?? 0)),
        });
      }
    }
  }
  return resources;
}

/** Filas: nomes de tópicos/filas literais em chamadas comuns de Kafka/RabbitMQ/SQS. */
export async function parseQueueTopics(codeDir: string): Promise<ExtraCodeResource[]> {
  const files = await fg("**/*.{js,ts,jsx,tsx,py,java,go}", { cwd: codeDir, ignore: DEFAULT_IGNORE });
  const resources: ExtraCodeResource[] = [];
  const patterns = [
    /\.(?:send|publish|produce|sendToQueue|subscribe)\s*\(\s*['"]([a-zA-Z0-9_.\-]+)['"]/g,
    /(?:topic|queue|channel)\s*[:=]\s*['"]([a-zA-Z0-9_.\-]+)['"]/gi,
  ];
  for (const relFile of files) {
    const content = await readSafe(`${codeDir}/${relFile}`);
    if (!content) continue;
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        resources.push({
          kind: "QUEUE_TOPICO",
          subject: match[1],
          file: relFile,
          line: lineOf(content, match.index ?? 0),
        });
      }
    }
  }
  return dedupe(resources);
}

/** CLI: subcomandos definidos com commander/click/argparse/cobra. */
export async function parseCliCommands(codeDir: string): Promise<ExtraCodeResource[]> {
  const files = await fg("**/*.{js,ts,py,go}", { cwd: codeDir, ignore: DEFAULT_IGNORE });
  const resources: ExtraCodeResource[] = [];
  const patterns = [
    /\.command\s*\(\s*['"]([a-zA-Z0-9_\-: ]+)['"]/g, // commander (JS/TS)
    /@(?:click\.)?command\s*\(\s*(?:name\s*=\s*)?['"]([a-zA-Z0-9_\-]+)['"]/g, // click (Python)
    /add_parser\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]/g, // argparse subparsers (Python)
    /(?:var|&)?\s*\w+\s*=\s*&cobra\.Command\{\s*Use:\s*"([a-zA-Z0-9_\- ]+)"/g, // cobra (Go)
  ];
  for (const relFile of files) {
    const content = await readSafe(`${codeDir}/${relFile}`);
    if (!content) continue;
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        resources.push({
          kind: "CLI_COMANDO",
          subject: match[1].split(" ")[0],
          file: relFile,
          line: lineOf(content, match.index ?? 0),
        });
      }
    }
  }
  return dedupe(resources);
}

/** WebSocket: eventos registrados via `socket.on('evento', ...)` / `io.on('evento', ...)`. */
export async function parseWebSocketEvents(codeDir: string): Promise<ExtraCodeResource[]> {
  const files = await fg("**/*.{js,ts,jsx,tsx}", { cwd: codeDir, ignore: DEFAULT_IGNORE });
  const resources: ExtraCodeResource[] = [];
  const re = /\b(?:socket|io|ws|channel)\.on\s*\(\s*['"]([a-zA-Z0-9_\-:.]+)['"]/g;
  const builtins = new Set(["connection", "disconnect", "connect", "error", "close", "message", "open"]);
  for (const relFile of files) {
    const content = await readSafe(`${codeDir}/${relFile}`);
    if (!content) continue;
    for (const match of content.matchAll(re)) {
      if (builtins.has(match[1])) continue;
      resources.push({
        kind: "WEBSOCKET_EVENTO",
        subject: match[1],
        file: relFile,
        line: lineOf(content, match.index ?? 0),
      });
    }
  }
  return dedupe(resources);
}

/** Tabelas de banco: migrations SQL (`CREATE TABLE x`), Prisma (`model X {`), TypeORM (`@Entity('x')`). */
export async function parseDbTables(codeDir: string): Promise<ExtraCodeResource[]> {
  const files = await fg("**/*.{sql,prisma,ts,js}", { cwd: codeDir, ignore: DEFAULT_IGNORE });
  const resources: ExtraCodeResource[] = [];
  for (const relFile of files) {
    const content = await readSafe(`${codeDir}/${relFile}`);
    if (!content) continue;

    if (relFile.endsWith(".sql")) {
      const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([a-zA-Z0-9_]+)["'`]?/gi;
      for (const match of content.matchAll(re)) {
        resources.push({ kind: "TABELA_BANCO", subject: match[1], file: relFile, line: lineOf(content, match.index ?? 0) });
      }
    } else if (relFile.endsWith(".prisma")) {
      const re = /^\s*model\s+(\w+)\s*\{/gm;
      for (const match of content.matchAll(re)) {
        resources.push({ kind: "TABELA_BANCO", subject: match[1], file: relFile, line: lineOf(content, match.index ?? 0) });
      }
    } else {
      const re = /@Entity\s*\(\s*['"]([a-zA-Z0-9_]+)['"]\s*\)/g;
      for (const match of content.matchAll(re)) {
        resources.push({ kind: "TABELA_BANCO", subject: match[1], file: relFile, line: lineOf(content, match.index ?? 0) });
      }
    }
  }
  return dedupe(resources);
}

/** Roles/permissões usadas em middlewares/decorators de autorização. */
export async function parseRoles(codeDir: string): Promise<ExtraCodeResource[]> {
  const files = await fg("**/*.{js,ts,jsx,tsx,java,py}", { cwd: codeDir, ignore: DEFAULT_IGNORE });
  const resources: ExtraCodeResource[] = [];
  const patterns = [
    /@RequireRole\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]/g,
    /requireRole\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]/g,
    /@PreAuthorize\s*\(\s*"hasRole\(['"]([a-zA-Z0-9_\-]+)['"]\)"\s*\)/g,
    /@(?:role_required|roles_required)\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]/g,
  ];
  for (const relFile of files) {
    const content = await readSafe(`${codeDir}/${relFile}`);
    if (!content) continue;
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        resources.push({ kind: "ROLE_PERMISSAO", subject: match[1], file: relFile, line: lineOf(content, match.index ?? 0) });
      }
    }
  }
  return dedupe(resources);
}

function dedupe(items: ExtraCodeResource[]): ExtraCodeResource[] {
  const map = new Map<string, ExtraCodeResource>();
  for (const item of items) {
    const key = `${item.kind}::${item.subject}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

export async function parseAllExtraResources(codeDir: string): Promise<ExtraCodeResource[]> {
  const results = await Promise.all([
    parseGraphQLOperations(codeDir),
    parseGrpcMethods(codeDir),
    parseQueueTopics(codeDir),
    parseCliCommands(codeDir),
    parseWebSocketEvents(codeDir),
    parseDbTables(codeDir),
    parseRoles(codeDir),
  ]);
  return results.flat();
}

export type { ExtraResourceKind };
