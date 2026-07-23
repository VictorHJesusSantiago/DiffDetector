import type { DriftFinding, DriftSeverity, DriftType, ScanReport } from "../core/types.js";
import { getDefaultExecutor, type QueryExecutor, type TransactionalExecutor } from "./queryExecutor.js";

export interface StoredFinding extends DriftFinding {
  id: number;
  scanId: number;
  status: "aberto" | "resolvido";
  firstSeenScanId: number;
  resolvedAt: string | null;
}

export interface SaveScanResult {
  scanId: number;
  newFindings: DriftFinding[];
  resolvedFindings: StoredFinding[];
  persistedFindings: StoredFinding[];
}

export interface ScanWithFindings {
  scan: Record<string, unknown>;
  findings: StoredFinding[];
}

interface FindingRow {
  id: number;
  scan_id: number;
  type: string;
  severity: string;
  subject: string;
  message: string;
  doc_refs: unknown;
  code_refs: unknown;
  status: string;
  first_seen_scan_id: number;
  resolved_at: Date | string | null;
}

const FINDING_COLUMNS =
  "id, scan_id, type, severity, subject, message, doc_refs, code_refs, status, first_seen_scan_id, resolved_at";

/**
 * Severidade é armazenada como texto em português; `ORDER BY severity DESC` ordenava em ordem
 * alfabética reversa (media, baixa, alta), colocando os achados críticos por último.
 */
const SEVERITY_ORDER_SQL = `CASE severity WHEN 'alta' THEN 3 WHEN 'media' THEN 2 WHEN 'baixa' THEN 1 ELSE 0 END`;

const COLUMNS_PER_FINDING = 8;
/** Postgres aceita no máximo 65535 parâmetros por statement; o lote fica bem abaixo disso. */
const INSERT_BATCH_SIZE = 500;

/** Chave do advisory lock que serializa a reconciliação entre scans concorrentes. */
const RECONCILIATION_LOCK_KEY = 8_142_037;

function findingKey(finding: Pick<DriftFinding, "type" | "subject">): string {
  return `${finding.type}\u0000${finding.subject}`;
}

/**
 * Persistência e reconciliação do histórico de scans.
 *
 * Recebe o executor por construtor (DIP): em produção é o pool do Postgres, nos testes é um
 * fake em memória — o que permite exercitar a reconciliação (novo/resolvido/first_seen) sem
 * depender de um banco no ambiente local.
 */
export class ScanRepository {
  constructor(private readonly executor: TransactionalExecutor = getDefaultExecutor()) {}

  /**
   * Persiste um relatório e reconcilia com os findings "abertos" do scan anterior: os que
   * desapareceram viram `resolvido`; os que persistem mantêm o `first_seen_scan_id` original,
   * preservando o histórico de quando o drift começou.
   *
   * A transação toma um advisory lock antes de ler o scan anterior. Sem ele, dois scans
   * simultâneos (hook de pre-commit + pipeline de CI) liam ambos o mesmo "scan anterior" sob
   * READ COMMITTED e reconciliavam contra um estado já obsoleto.
   */
  async saveScan(report: ScanReport): Promise<SaveScanResult> {
    return this.executor.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [RECONCILIATION_LOCK_KEY]);

      const scanId = await insertScan(tx, report);
      const previousByKey = await loadPreviousOpenFindings(tx, scanId);

      const newFindings: DriftFinding[] = [];
      const firstSeenByIndex = report.findings.map((finding) => {
        const prior = previousByKey.get(findingKey(finding));
        if (!prior) newFindings.push(finding);
        return prior ? prior.first_seen_scan_id : scanId;
      });

      const insertedIds = await insertFindings(tx, scanId, report.findings, firstSeenByIndex);
      const persistedFindings: StoredFinding[] = report.findings.map((finding, index) => ({
        ...finding,
        id: insertedIds[index],
        scanId,
        status: "aberto",
        firstSeenScanId: firstSeenByIndex[index],
        resolvedAt: null,
      }));

      const currentKeys = new Set(report.findings.map(findingKey));
      const disappeared = [...previousByKey].filter(([key]) => !currentKeys.has(key)).map(([, row]) => row);
      const resolvedFindings = await resolveFindings(tx, disappeared);

      return { scanId, newFindings, resolvedFindings, persistedFindings };
    });
  }

  async getLatestScan(): Promise<ScanWithFindings | null> {
    const scanResult = await this.executor.query(`SELECT * FROM scans ORDER BY id DESC LIMIT 1`);
    const scan = scanResult.rows.at(0);
    if (!scan) return null;
    return { scan, findings: await this.loadFindingsOfScan(Number(scan.id)) };
  }

  async getScanById(id: number): Promise<ScanWithFindings | null> {
    const scanResult = await this.executor.query(`SELECT * FROM scans WHERE id = $1`, [id]);
    const scan = scanResult.rows.at(0);
    if (!scan) return null;
    return { scan, findings: await this.loadFindingsOfScan(id) };
  }

  async getScanHistory(limit = 20): Promise<Record<string, unknown>[]> {
    const result = await this.executor.query(`SELECT * FROM scans ORDER BY id DESC LIMIT $1`, [limit]);
    return result.rows;
  }

  async getScanHistoryWithOpenFindingsCount(
    limit = 100,
  ): Promise<Array<Record<string, unknown> & { open_findings: number }>> {
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT s.*, COUNT(f.id) FILTER (WHERE f.status = 'aberto') AS open_findings
       FROM scans s
       LEFT JOIN findings f ON f.scan_id = s.id
       GROUP BY s.id
       ORDER BY s.id DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({ ...row, open_findings: Number(row.open_findings) }));
  }

  private async loadFindingsOfScan(scanId: number): Promise<StoredFinding[]> {
    const result = await this.executor.query<FindingRow>(
      `SELECT ${FINDING_COLUMNS} FROM findings
       WHERE scan_id = $1
       ORDER BY ${SEVERITY_ORDER_SQL} DESC, subject ASC`,
      [scanId],
    );
    return result.rows.map(toStoredFinding);
  }
}

async function insertScan(tx: QueryExecutor, report: ScanReport): Promise<number> {
  const result = await tx.query<{ id: number }>(
    `INSERT INTO scans (created_at, code_dir, docs_dir, total_code_endpoints, total_doc_endpoints, total_code_env_vars, total_doc_env_vars)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      report.createdAt,
      report.codeDir,
      report.docsDir,
      report.totalCodeEndpoints,
      report.totalDocEndpoints,
      report.totalCodeEnvVars,
      report.totalDocEnvVars,
    ],
  );
  return result.rows[0].id;
}

async function loadPreviousOpenFindings(tx: QueryExecutor, scanId: number): Promise<Map<string, FindingRow>> {
  const result = await tx.query<FindingRow>(
    `SELECT ${FINDING_COLUMNS} FROM findings
     WHERE scan_id = (SELECT id FROM scans WHERE id < $1 ORDER BY id DESC LIMIT 1)
       AND status = 'aberto'`,
    [scanId],
  );

  const byKey = new Map<string, FindingRow>();
  for (const row of result.rows) {
    byKey.set(findingKey({ type: row.type as DriftType, subject: row.subject }), row);
  }
  return byKey;
}

/**
 * Insere todos os findings em lotes multi-linha. Antes era um INSERT por achado dentro do
 * laço: um relatório com 500 achados custava 500 round-trips dentro de uma única transação,
 * com o lock de escrita segurado durante todos eles.
 */
async function insertFindings(
  tx: QueryExecutor,
  scanId: number,
  findings: readonly DriftFinding[],
  firstSeenByIndex: readonly number[],
): Promise<number[]> {
  const ids: number[] = [];

  for (let start = 0; start < findings.length; start += INSERT_BATCH_SIZE) {
    const batch = findings.slice(start, start + INSERT_BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders = batch.map((finding, offset) => {
      const base = offset * COLUMNS_PER_FINDING;
      values.push(
        scanId,
        finding.type,
        finding.severity,
        finding.subject,
        finding.message,
        JSON.stringify(finding.docRefs),
        JSON.stringify(finding.codeRefs),
        firstSeenByIndex[start + offset],
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, 'aberto', $${base + 8})`;
    });

    const result = await tx.query<{ id: number }>(
      `INSERT INTO findings (scan_id, type, severity, subject, message, doc_refs, code_refs, status, first_seen_scan_id)
       VALUES ${placeholders.join(", ")} RETURNING id`,
      values,
    );
    // O Postgres devolve as linhas de RETURNING na ordem de inserção do VALUES multi-linha.
    ids.push(...result.rows.map((row) => row.id));
  }

  return ids;
}

async function resolveFindings(tx: QueryExecutor, rows: readonly FindingRow[]): Promise<StoredFinding[]> {
  if (rows.length === 0) return [];

  const result = await tx.query<{ id: number; resolved_at: Date | string }>(
    `UPDATE findings SET status = 'resolvido', resolved_at = now() WHERE id = ANY($1::bigint[]) RETURNING id, resolved_at`,
    [rows.map((row) => row.id)],
  );

  const resolvedAtById = new Map(result.rows.map((row) => [Number(row.id), toIsoString(row.resolved_at)]));
  return rows.map((row) => ({
    ...toStoredFinding(row),
    status: "resolvido" as const,
    resolvedAt: resolvedAtById.get(Number(row.id)) ?? new Date().toISOString(),
  }));
}

function toIsoString(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toStoredFinding(row: FindingRow): StoredFinding {
  return {
    id: Number(row.id),
    scanId: Number(row.scan_id),
    type: row.type as DriftType,
    severity: row.severity as DriftSeverity,
    subject: row.subject,
    message: row.message,
    docRefs: (row.doc_refs ?? []) as DriftFinding["docRefs"],
    codeRefs: (row.code_refs ?? []) as DriftFinding["codeRefs"],
    status: row.status === "resolvido" ? "resolvido" : "aberto",
    firstSeenScanId: Number(row.first_seen_scan_id),
    resolvedAt: toIsoString(row.resolved_at),
  };
}

// As bordas (CLI e API) continuam consumindo funções, sem precisar montar o repositório: a
// instância padrão é criada sob demanda para que nenhum comando que não toca o banco abra pool.
let defaultRepository: ScanRepository | undefined;

function repository(): ScanRepository {
  defaultRepository ??= new ScanRepository();
  return defaultRepository;
}

export const saveScan = (report: ScanReport): Promise<SaveScanResult> => repository().saveScan(report);
export const getLatestScan = (): Promise<ScanWithFindings | null> => repository().getLatestScan();
export const getScanById = (id: number): Promise<ScanWithFindings | null> => repository().getScanById(id);
export const getScanHistory = (limit?: number): Promise<Record<string, unknown>[]> =>
  repository().getScanHistory(limit);
export const getScanHistoryWithOpenFindingsCount = (
  limit?: number,
): Promise<Array<Record<string, unknown> & { open_findings: number }>> =>
  repository().getScanHistoryWithOpenFindingsCount(limit);
