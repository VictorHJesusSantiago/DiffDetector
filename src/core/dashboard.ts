import { escapeHtml } from "./html.js";

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

const CHART_WIDTH = 800;
const CHART_HEIGHT = 260;
const CHART_PADDING = 40;
const POINT_RADIUS = 4;

interface ChartPoint {
  x: number;
  y: number;
  row: DashboardScanRow;
}

function buildPoints(rows: readonly DashboardScanRow[]): ChartPoint[] {
  const maxFindings = Math.max(1, ...rows.map((row) => row.open_findings));
  const plotWidth = CHART_WIDTH - CHART_PADDING * 2;
  const plotHeight = CHART_HEIGHT - CHART_PADDING * 2;
  const stepX = rows.length > 1 ? plotWidth / (rows.length - 1) : 0;

  return rows.map((row, index) => ({
    x: CHART_PADDING + index * stepX,
    y: CHART_HEIGHT - CHART_PADDING - (row.open_findings / maxFindings) * plotHeight,
    row,
  }));
}

const DASHBOARD_STYLES = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fff; --border: #ddd; --head: #f4f4f4; --muted: #555; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #ececec; --bg: #131313; --border: #3a3a3a; --head: #1f1f1f; --muted: #b0b0b0; }
  }
  body { font-family: system-ui, sans-serif; margin: 2rem; color: var(--fg); background: var(--bg); }
  h1 { margin-bottom: 0.25rem; }
  .subtitle { color: var(--muted); margin-top: 0; }
  .table-scroll, .chart-scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
  th, td { border: 1px solid var(--border); padding: 0.4rem 0.7rem; text-align: left; font-size: 0.85rem; }
  th { background: var(--head); }
  caption { text-align: left; padding-bottom: 0.5rem; color: var(--muted); }
  svg { border: 1px solid var(--border); border-radius: 8px; margin-top: 1rem; max-width: 100%; }
`;

/**
 * Gera um dashboard HTML estático (sem servidor, sem CDN, sem JS externo) com a série
 * histórica de achados abertos por scan, usando um <svg> desenhado inline. Pode ser aberto
 * diretamente no navegador a partir do disco.
 */
export function generateDashboardHtml(rows: readonly DashboardScanRow[]): string {
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  const points = buildPoints(ordered);

  const polylinePoints = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const circles = points
    .map(
      (point) =>
        `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${POINT_RADIUS}" fill="#e63946">
          <title>Scan #${escapeHtml(point.row.id)} (${escapeHtml(point.row.created_at)}) — ${escapeHtml(point.row.open_findings)} achados abertos</title>
        </circle>`,
    )
    .join("\n");

  const rowsHtml = ordered
    .slice()
    .reverse()
    .map(
      (row) => `<tr>
  <td>#${escapeHtml(row.id)}</td>
  <td>${escapeHtml(row.created_at)}</td>
  <td>${escapeHtml(row.open_findings)}</td>
  <td>${escapeHtml(row.total_code_endpoints)}/${escapeHtml(row.total_doc_endpoints)}</td>
  <td>${escapeHtml(row.total_code_env_vars)}/${escapeHtml(row.total_doc_env_vars)}</td>
</tr>`,
    )
    .join("\n");

  const chartSummary = `Série histórica de ${ordered.length} scan(s); o gráfico repete os dados da tabela abaixo.`;

  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard de Drift de Documentação</title>
<style>${DASHBOARD_STYLES}</style>
</head>
<body>
  <h1>Dashboard de Drift de Documentação</h1>
  <p class="subtitle">Achados abertos por scan (histórico local, gerado sem servidor/cloud)</p>
  <div class="chart-scroll">
  <svg width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="${escapeHtml(chartSummary)}">
    <line x1="${CHART_PADDING}" y1="${CHART_HEIGHT - CHART_PADDING}" x2="${CHART_WIDTH - CHART_PADDING}" y2="${CHART_HEIGHT - CHART_PADDING}" stroke="#8a8a8a" />
    <line x1="${CHART_PADDING}" y1="${CHART_PADDING}" x2="${CHART_PADDING}" y2="${CHART_HEIGHT - CHART_PADDING}" stroke="#8a8a8a" />
    <polyline points="${polylinePoints}" fill="none" stroke="#457b9d" stroke-width="2" />
    ${circles}
  </svg>
  </div>
  <div class="table-scroll">
  <table>
    <caption>Histórico de scans, do mais recente para o mais antigo</caption>
    <thead><tr><th scope="col">Scan</th><th scope="col">Data</th><th scope="col">Achados abertos</th><th scope="col">Endpoints (código/doc)</th><th scope="col">Env vars (código/doc)</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="5">Nenhum scan no histórico.</td></tr>'}</tbody>
  </table>
  </div>
</body>
</html>`;
}
