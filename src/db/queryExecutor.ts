import { getPool } from "./pool.js";

export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

/**
 * Contrato mínimo de execução de SQL de que o repositório precisa.
 *
 * Existe para inverter a dependência: antes `repository.ts` importava `getPool()` diretamente
 * (Service Locator), o que tornava impossível exercitar a reconciliação de achados sem um
 * Postgres de verdade — e o único teste que a cobria se auto-pulava, deixando a lógica mais
 * delicada do sistema sem cobertura efetiva no ambiente local.
 */
export interface QueryExecutor {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface TransactionalExecutor extends QueryExecutor {
  /** Executa `work` dentro de uma transação, com COMMIT no sucesso e ROLLBACK em qualquer erro. */
  transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}

/** Executor real, sobre o pool de conexões do `pg`. */
export class PoolExecutor implements TransactionalExecutor {
  async query<R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    const result = await getPool().query(sql, [...params]);
    return { rows: result.rows as R[], rowCount: result.rowCount };
  }

  async transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    const tx: QueryExecutor = {
      query: async <R>(sql: string, params: readonly unknown[] = []) => {
        const result = await client.query(sql, [...params]);
        return { rows: result.rows as R[], rowCount: result.rowCount };
      },
    };

    try {
      await client.query("BEGIN");
      const value = await work(tx);
      await client.query("COMMIT");
      return value;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        // O rollback pode falhar se a conexão já caiu; o erro original é o que importa.
      });
      throw err;
    } finally {
      client.release();
    }
  }
}

let defaultExecutor: TransactionalExecutor = new PoolExecutor();

export function getDefaultExecutor(): TransactionalExecutor {
  return defaultExecutor;
}

/** Troca o executor global — usado pelos testes; a aplicação usa sempre o padrão. */
export function setDefaultExecutor(executor: TransactionalExecutor): void {
  defaultExecutor = executor;
}
