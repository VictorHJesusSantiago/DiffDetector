import { escapeHtml, escapeXml } from "./html.js";
import type { ScanReport } from "./types.js";

export type ReportFormat = "text" | "json" | "markdown" | "html" | "csv" | "junit";

export function exportReport(report: ScanReport, format: ReportFormat): string {
  switch (format) {
    case "json":
      return exportJson(report);
    case "markdown":
      return exportMarkdown(report);
    case "html":
      return exportHtml(report);
    case "csv":
      return exportCsv(report);
    case "junit":
      return exportJunit(report);
    case "text":
    default:
      return exportText(report);
  }
}

function exportJson(report: ScanReport): string {
  return JSON.stringify(report, null, 2);
}

function exportText(report: ScanReport): string {
  const lines: string[] = [];
  lines.push(`=== Relatório de Drift — ${report.createdAt} ===`);
  lines.push(`Código: ${report.codeDir}  |  Docs: ${report.docsDir}`);
  lines.push(
    `Endpoints: ${report.totalCodeEndpoints} no código, ${report.totalDocEndpoints} na doc.  Env vars: ${report.totalCodeEnvVars} no código, ${report.totalDocEnvVars} na doc.`,
  );
  lines.push(`Cobertura de documentação: ${report.coverageScore}%`);
  if (report.findings.length === 0) {
    lines.push("\nNenhum drift encontrado. Documentação sincronizada com o código.");
    return lines.join("\n");
  }
  lines.push(`\n${report.findings.length} problema(s) de drift encontrado(s):\n`);
  for (const finding of report.findings) {
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.type} — ${finding.subject}`);
    lines.push(`  ${finding.message}`);
    for (const ref of finding.docRefs) lines.push(`  doc: ${ref.file}:${ref.line} -> "${ref.context}"`);
    for (const ref of finding.codeRefs) lines.push(`  code: ${ref.file}:${ref.line}`);
    lines.push("");
  }
  return lines.join("\n");
}

function escapeMarkdownCell(value: string): string {
  // Além do pipe (que quebraria a coluna), quebras de linha encerrariam a linha da tabela.
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function exportMarkdown(report: ScanReport): string {
  const lines: string[] = [];
  lines.push(`# Relatório de Drift de Documentação`);
  lines.push("");
  lines.push(`- **Data:** ${report.createdAt}`);
  lines.push(`- **Código:** \`${report.codeDir}\``);
  lines.push(`- **Docs:** \`${report.docsDir}\``);
  lines.push(`- **Cobertura de documentação:** ${report.coverageScore}%`);
  lines.push(`- **Endpoints:** ${report.totalCodeEndpoints} no código / ${report.totalDocEndpoints} na doc`);
  lines.push(`- **Env vars:** ${report.totalCodeEnvVars} no código / ${report.totalDocEnvVars} na doc`);
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("Nenhum drift encontrado. Documentação sincronizada com o código.");
    return lines.join("\n");
  }

  lines.push(`## Achados (${report.findings.length})`);
  lines.push("");
  lines.push("| Severidade | Tipo | Assunto | Mensagem |");
  lines.push("| --- | --- | --- | --- |");
  for (const finding of report.findings) {
    lines.push(
      `| ${finding.severity} | ${finding.type} | \`${escapeMarkdownCell(finding.subject)}\` | ${escapeMarkdownCell(finding.message)} |`,
    );
  }
  return lines.join("\n");
}

const REPORT_STYLES = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fff; --border: #ddd; --head: #f4f4f4;
          --alta: #fdecea; --media: #fff8e1; --baixa: #f1f8f4; --muted: #555; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #ececec; --bg: #131313; --border: #3a3a3a; --head: #1f1f1f;
            --alta: #4a1d18; --media: #4a3c12; --baixa: #17361f; --muted: #b0b0b0; }
  }
  body { font-family: system-ui, sans-serif; margin: 2rem; color: var(--fg); background: var(--bg); }
  .table-scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid var(--border); padding: 0.5rem 0.75rem; text-align: left; font-size: 0.9rem; }
  th { background: var(--head); }
  caption { text-align: left; padding-bottom: 0.5rem; color: var(--muted); }
  tr.sev-alta { background: var(--alta); }
  tr.sev-media { background: var(--media); }
  tr.sev-baixa { background: var(--baixa); }
  .summary { display: flex; gap: 1.5rem; flex-wrap: wrap; margin: 1rem 0; padding: 0; list-style: none; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; }
`;

function exportHtml(report: ScanReport): string {
  const rows = report.findings
    .map(
      (finding) => `<tr class="sev-${escapeHtml(finding.severity)}">
  <td>${escapeHtml(finding.severity)}</td>
  <td>${escapeHtml(finding.type)}</td>
  <td><code>${escapeHtml(finding.subject)}</code></td>
  <td>${escapeHtml(finding.message)}</td>
</tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório de Drift — ${escapeHtml(report.createdAt)}</title>
<style>${REPORT_STYLES}</style>
</head>
<body>
  <h1>Relatório de Drift de Documentação</h1>
  <p>${escapeHtml(report.createdAt)} — <code>${escapeHtml(report.codeDir)}</code> vs <code>${escapeHtml(report.docsDir)}</code></p>
  <ul class="summary">
    <li class="card"><strong>${report.coverageScore}%</strong><br>cobertura de docs</li>
    <li class="card"><strong>${report.totalCodeEndpoints}/${report.totalDocEndpoints}</strong><br>endpoints (código/doc)</li>
    <li class="card"><strong>${report.totalCodeEnvVars}/${report.totalDocEnvVars}</strong><br>env vars (código/doc)</li>
    <li class="card"><strong>${report.findings.length}</strong><br>achados de drift</li>
  </ul>
  <div class="table-scroll">
  <table>
    <caption>Achados de drift, ordenados por severidade</caption>
    <thead><tr><th scope="col">Severidade</th><th scope="col">Tipo</th><th scope="col">Assunto</th><th scope="col">Mensagem</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">Nenhum drift encontrado.</td></tr>'}</tbody>
  </table>
  </div>
</body>
</html>`;
}

function exportCsv(report: ScanReport): string {
  const header = "severity,type,subject,message";
  const rows = report.findings.map(
    (finding) =>
      `${finding.severity},${finding.type},${csvEscape(finding.subject)},${csvEscape(finding.message)}`,
  );
  return [header, ...rows].join("\n");
}

/**
 * Campos que começam com =, +, - ou @ são interpretados como fórmula por Excel/Sheets ao abrir
 * o CSV. Como subject e message carregam texto vindo do repositório escaneado, o prefixo é
 * neutralizado antes da citação (CSV injection).
 */
function csvEscape(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(neutralized)) return `"${neutralized.replace(/"/g, '""')}"`;
  return neutralized;
}

/**
 * Caracteres de controle não são representáveis em XML 1.0 nem quando escapados: um único byte
 * desses vindo de um arquivo escaneado deixa o relatório JUnit inteiro ilegível para o CI.
 */
// eslint-disable-next-line no-control-regex -- a regra existe para pegar controle acidental; aqui eles sao o alvo
const XML_CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function stripXmlControlChars(value: string): string {
  return value.replace(XML_CONTROL_CHARS_RE, " ");
}

function exportJunit(report: ScanReport): string {
  const testcases = report.findings
    .map((finding) => {
      const message = escapeXml(stripXmlControlChars(finding.message));
      return `    <testcase classname="${escapeXml(finding.type)}" name="${escapeXml(finding.subject)}">
      <failure message="${message}" type="${escapeXml(finding.severity)}">${message}</failure>
    </testcase>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="doc-drift-detector" tests="${report.findings.length}" failures="${report.findings.length}" timestamp="${escapeXml(report.createdAt)}">
${testcases}
</testsuite>`;
}
