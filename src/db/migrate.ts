import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { getDefaultExecutor, type QueryExecutor, type TransactionalExecutor } from "./queryExecutor.js";
import { closePool } from "./pool.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(currentDir, "migrations");
const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Chave do advisory lock que impede duas instâncias de migrarem ao mesmo tempo. */
const MIGRATION_LOCK_KEY = 8_142_038;

/**
 * Versão que descreve o schema como ele era antes das migrações versionadas. Bancos que já
 * têm as tabelas mas não têm `schema_migrations` recebem esta versão como baseline: marcada
 * como aplicada, sem reexecução.
 */
const BASELINE_VERSION = "0001";

export interface Migration {
  version: string;
  name: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  baselined: boolean;
}

export async function loadMigrations(directory = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = await readdir(directory);
  const migrations: Migration[] = [];

  for (const name of files.sort()) {
    const match = MIGRATION_FILE_RE.exec(name);
    if (!match) {
      if (name.endsWith(".sql")) {
        throw new Error(
          `Migração "${name}" não segue o padrão NNNN_descricao_em_snake_case.sql — renomeie antes de aplicar.`,
        );
      }
      continue;
    }
    migrations.push({ version: match[1], name, sql: await readFile(join(directory, name), "utf-8") });
  }

  const versions = migrations.map((migration) => migration.version);
  const duplicated = versions.find((version, index) => versions.indexOf(version) !== index);
  if (duplicated) {
    throw new Error(`Existem duas migrações com a versão ${duplicated}. Cada versão precisa ser única.`);
  }

  return migrations;
}

async function ensureControlTable(executor: QueryExecutor): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function tableExists(executor: QueryExecutor, table: string): Promise<boolean> {
  const result = await executor.query<{ existe: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS existe`, [table]);
  return result.rows[0]?.existe === true;
}

async function appliedVersions(executor: QueryExecutor): Promise<Set<string>> {
  const result = await executor.query<{ version: string }>(`SELECT version FROM schema_migrations`);
  return new Set(result.rows.map((row) => row.version));
}

/**
 * Aplica as migrações pendentes, em ordem, cada uma na sua própria transação.
 *
 * O advisory lock é tomado antes de qualquer leitura do estado: sem ele, duas instâncias
 * subindo ao mesmo tempo (réplicas de um deploy, ou CI e desenvolvedor) leem a mesma lista de
 * pendências e tentam aplicar a mesma migração duas vezes.
 *
 * Substitui o `schema.sql` executado por inteiro a cada chamada, que só conseguia criar objetos
 * novos: qualquer ALTER em tabela existente era silenciosamente ignorado pelo `IF NOT EXISTS`,
 * e não havia como saber em que versão um banco estava.
 */
export async function migrate(executor: TransactionalExecutor = getDefaultExecutor()): Promise<MigrationResult> {
  const migrations = await loadMigrations();

  return executor.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [MIGRATION_LOCK_KEY]);

    const hadControlTable = await tableExists(tx, "schema_migrations");
    await ensureControlTable(tx);

    let baselined = false;
    if (!hadControlTable && (await tableExists(tx, "scans"))) {
      // Banco pré-existente, criado pelo schema.sql antigo: registra a baseline em vez de
      // reexecutar o DDL inicial.
      await tx.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        BASELINE_VERSION,
        "0001_schema_inicial.sql (baseline)",
      ]);
      baselined = true;
    }

    const already = await appliedVersions(tx);
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of migrations) {
      if (already.has(migration.version)) {
        skipped.push(migration.name);
        continue;
      }
      await tx.query(migration.sql);
      await tx.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [
        migration.version,
        migration.name,
      ]);
      applied.push(migration.name);
    }

    return { applied, skipped, baselined };
  });
}

/** Versões já aplicadas, para diagnóstico (`drift db-status`). */
export async function migrationStatus(
  executor: TransactionalExecutor = getDefaultExecutor(),
): Promise<{ version: string; name: string; appliedAt: string | null; pending: boolean }[]> {
  const migrations = await loadMigrations();
  if (!(await tableExists(executor, "schema_migrations"))) {
    return migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      appliedAt: null,
      pending: true,
    }));
  }

  const result = await executor.query<{ version: string; applied_at: Date | string }>(
    `SELECT version, applied_at FROM schema_migrations`,
  );
  const appliedAtByVersion = new Map(
    result.rows.map((row) => [
      row.version,
      row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
    ]),
  );

  return migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    appliedAt: appliedAtByVersion.get(migration.version) ?? null,
    pending: !appliedAtByVersion.has(migration.version),
  }));
}

/** True quando este módulo foi executado diretamente (e não importado por outro módulo). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
}

if (isEntryPoint()) {
  migrate()
    .then((result) => {
      if (result.baselined) {
        console.log("Banco pré-existente detectado: versão 0001 registrada como baseline.");
      }
      if (result.applied.length === 0) {
        console.log("Nenhuma migração pendente.");
      } else {
        console.log(`Migrações aplicadas: ${result.applied.join(", ")}`);
      }
    })
    .catch((err: unknown) => {
      console.error("Falha na migração:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
