import { Pool } from "pg";
import "dotenv/config";

const CONNECTION_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
const STATEMENT_TIMEOUT_MS = 60_000;
const MAX_CLIENTS = 10;

/**
 * String de conexão vinda exclusivamente do ambiente (12-Factor III).
 *
 * A versão anterior tinha `postgres://postgres:postgres@localhost:5432/drift_detector` como
 * valor padrão embutido no código: uma credencial versionada no repositório, e um comportamento
 * inseguro por omissão — em produção, esquecer de definir DATABASE_URL não falhava, apenas
 * tentava conectar silenciosamente em outro lugar. A ausência da variável agora é um erro.
 */
function requireConnectionString(): string {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL não está definida. Copie .env.example para .env e ajuste a string de conexão, " +
        "ou rode o comando com --no-save para não persistir o scan.",
    );
  }
  return connectionString;
}

let instance: Pool | undefined;

/** Pool criado sob demanda: comandos que não tocam o banco nunca abrem conexão. */
export function getPool(): Pool {
  if (!instance) {
    instance = new Pool({
      connectionString: requireConnectionString(),
      max: MAX_CLIENTS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    // Um erro em cliente ocioso (queda do servidor, rede) emite 'error' no pool; sem listener,
    // o Node encerra o processo com uncaught exception.
    instance.on("error", (err) => {
      console.error("[db] erro em cliente ocioso do pool:", err.message);
    });
  }
  return instance;
}

export async function closePool(): Promise<void> {
  if (!instance) return;
  const closing = instance;
  instance = undefined;
  await closing.end();
}
