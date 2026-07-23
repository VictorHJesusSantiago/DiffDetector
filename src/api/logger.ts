import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SERVICE_NAME = "doc-drift-detector";

/**
 * Campos permitidos em um registro de log. A lista é fechada de propósito: interpolação livre
 * é como PII (caminhos de usuário, conteúdo de arquivo, tokens) acaba vazando para o log
 * agregado. Quem precisar de um campo novo o acrescenta aqui, e essa adição é revisável.
 */
export interface LogFields {
  requestId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  scanId?: number;
  jobId?: string;
  event?: string;
  error?: string;
  count?: number;
}

interface RequestContext {
  requestId: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

function configuredLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

/**
 * Log estruturado em uma linha JSON por evento, em stdout (12-Factor XI). Erros vão para
 * stderr para que a separação relatório/diagnóstico do resto do projeto seja preservada.
 */
function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;

  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    requestId: requestContext.getStore()?.requestId,
    ...fields,
  };

  const line = JSON.stringify(record, (_key, value: unknown) => (value === undefined ? undefined : value));
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};

/** Executa `work` com um requestId associado, propagado a todo log emitido dentro dele. */
export function withRequestId<T>(requestId: string, work: () => T): T {
  return requestContext.run({ requestId }, work);
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
