import { pool } from "./pool.js";
import type { DriftFinding, ScanReport } from "../core/types.js";

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

function findingKey(f: Pick<DriftFinding, "type" | "subject">): string {
  return `${f.type}::${f.subject}`;
}

/**
 * Persiste um relatório de scan e reconcilia com o findings "abertos" do scan anterior:
 * findings que desapareceram são marcados como resolvidos; os que continuam existindo
 * mantêm o first_seen_scan_id original para preservar o histórico de quando o drift começou.
 */
export async function saveScan(report: ScanReport): Promise<SaveScanResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const scanInsert = await client.query<{ id: number }>(
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
    const scanId = scanInsert.rows[0].id;

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
    }

    const previousOpen = await client.query<FindingRow>(
      `SELECT f.* FROM findings f
       INNER JOIN (SELECT id FROM scans WHERE id < $1 ORDER BY id DESC LIMIT 1) prev ON f.scan_id = prev.id
       WHERE f.status = 'aberto'`,
      [scanId],
    );

    const previousByKey = new Map<string, (typeof previousOpen.rows)[number]>();
    for (const row of previousOpen.rows) {
      previousByKey.set(findingKey({ type: row.type as DriftFinding["type"], subject: row.subject }), row);
    }

    const currentKeys = new Set(report.findings.map(findingKey));
    const persistedFindings: StoredFinding[] = [];
    const newFindings: DriftFinding[] = [];

    for (const finding of report.findings) {
      const key = findingKey(finding);
      const prior = previousByKey.get(key);
      const firstSeenScanId = prior ? prior.first_seen_scan_id : scanId;
      if (!prior) newFindings.push(finding);

      const insert = await client.query(
        `INSERT INTO findings (scan_id, type, severity, subject, message, doc_refs, code_refs, status, first_seen_scan_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'aberto', $8) RETURNING id`,
        [
          scanId,
          finding.type,
          finding.severity,
          finding.subject,
          finding.message,
          JSON.stringify(finding.docRefs),
          JSON.stringify(finding.codeRefs),
          firstSeenScanId,
        ],
      );

      persistedFindings.push({
        ...finding,
        id: insert.rows[0].id,
        scanId,
        status: "aberto",
        firstSeenScanId,
        resolvedAt: null,
      });
    }

    const resolvedFindings: StoredFinding[] = [];
    for (const [key, row] of previousByKey) {
      if (currentKeys.has(key)) continue;
      await client.query(`UPDATE findings SET status = 'resolvido', resolved_at = now() WHERE id = $1`, [row.id]);
      resolvedFindings.push({
        id: row.id,
        scanId: row.scan_id,
        type: row.type as DriftFinding["type"],
        severity: row.severity as DriftFinding["severity"],
        subject: row.subject,
        message: row.message,
        docRefs: row.doc_refs as DriftFinding["docRefs"],
        codeRefs: row.code_refs as DriftFinding["codeRefs"],
        status: "resolvido",
        firstSeenScanId: row.first_seen_scan_id,
        resolvedAt: new Date().toISOString(),
      });
    }

    await client.query("COMMIT");
    return { scanId, newFindings, resolvedFindings, persistedFindings };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getLatestScan(): Promise<{ scan: Record<string, unknown>; findings: StoredFinding[] } | null> {
  const scanResult = await pool.query(`SELECT * FROM scans ORDER BY id DESC LIMIT 1`);
  if (scanResult.rowCount === 0) return null;
  const scan = scanResult.rows[0];
  const findingsResult = await pool.query(
    `SELECT * FROM findings WHERE scan_id = $1 ORDER BY severity DESC, subject ASC`,
    [scan.id],
  );
  return { scan, findings: findingsResult.rows.map(mapFindingRow) };
}

export async function getScanHistory(limit = 20): Promise<Record<string, unknown>[]> {
  const result = await pool.query(`SELECT * FROM scans ORDER BY id DESC LIMIT $1`, [limit]);
  return result.rows;
}

export async function getScanHistoryWithOpenFindingsCount(limit = 100): Promise<
  Array<Record<string, unknown> & { open_findings: number }>
> {
  const result = await pool.query(
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

export async function getScanById(id: number): Promise<{ scan: Record<string, unknown>; findings: StoredFinding[] } | null> {
  const scanResult = await pool.query(`SELECT * FROM scans WHERE id = $1`, [id]);
  if (scanResult.rowCount === 0) return null;
  const findingsResult = await pool.query(
    `SELECT * FROM findings WHERE scan_id = $1 ORDER BY severity DESC, subject ASC`,
    [id],
  );
  return { scan: scanResult.rows[0], findings: findingsResult.rows.map(mapFindingRow) };
}

function mapFindingRow(row: any): StoredFinding {
  return {
    id: row.id,
    scanId: row.scan_id,
    type: row.type,
    severity: row.severity,
    subject: row.subject,
    message: row.message,
    docRefs: row.doc_refs,
    codeRefs: row.code_refs,
    status: row.status,
    firstSeenScanId: row.first_seen_scan_id,
    resolvedAt: row.resolved_at,
  };
}
