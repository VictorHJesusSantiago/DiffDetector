export interface DashboardScanRow {
  id: number;
  created_at: string;
  code_dir: string;
  docs_dir: string;
  total_code_endpoints: number;
  total_doc_endpoints: number;
  total_code_env_vars: number;
  total_doc_env_vars: number;
  open_findings: number;
}

/**
 * Gera um dashboard HTML estático (sem servidor, sem CDN, sem JS externo) com a série
 * histórica de achados abertos por scan, usando um <svg> desenhado inline. Pode ser aberto
 * diretamente no navegador a partir do disco.
 */
export function generateDashboardHtml(rows: DashboardScanRow[]): string {
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  const width = 800;
  const height = 260;
  const padding = 40;

  const maxFindings = Math.max(1, ...ordered.map((r) => r.open_findings));
  const stepX = ordered.length > 1 ? (width - padding * 2) / (ordered.length - 1) : 0;

  const points = ordered.map((row, idx) => {
    const x = padding + idx * stepX;
    const y = height - padding - (row.open_findings / maxFindings) * (height - padding * 2);
    return { x, y, row };
  });

  const polylinePoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const circles = points
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#e63946">
          <title>Scan #${p.row.id} (${p.row.created_at}) — ${p.row.open_findings} achados abertos</title>
        </circle>`,
    )
    .join("\n");

  const rowsHtml = ordered
    .slice()
    .reverse()
    .map(
      (r) => `<tr>
  <td>#${r.id}</td>
  <td>${escapeHtml(r.created_at)}</td>
  <td>${r.open_findings}</td>
  <td>${r.total_code_endpoints}/${r.total_doc_endpoints}</td>
  <td>${r.total_code_env_vars}/${r.total_doc_env_vars}</td>
</tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<title>Dashboard de Drift de Documentação</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fff; }
  h1 { margin-bottom: 0.25rem; }
  .subtitle { color: #666; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.7rem; text-align: left; font-size: 0.85rem; }
  th { background: #f4f4f4; }
  svg { border: 1px solid #eee; border-radius: 8px; margin-top: 1rem; }
</style>
</head>
<body>
  <h1>Dashboard de Drift de Documentação</h1>
  <p class="subtitle">Achados abertos por scan (histórico local, gerado sem servidor/cloud)</p>
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#ccc" />
    <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#ccc" />
    <polyline points="${polylinePoints}" fill="none" stroke="#457b9d" stroke-width="2" />
    ${circles}
  </svg>
  <table>
    <thead><tr><th>Scan</th><th>Data</th><th>Achados abertos</th><th>Endpoints (código/doc)</th><th>Env vars (código/doc)</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="5">Nenhum scan no histórico.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
