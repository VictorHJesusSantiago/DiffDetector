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
  for (const f of report.findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.type} — ${f.subject}`);
    lines.push(`  ${f.message}`);
    for (const ref of f.docRefs) lines.push(`  doc: ${ref.file}:${ref.line} -> "${ref.context}"`);
    for (const ref of f.codeRefs) lines.push(`  code: ${ref.file}:${ref.line}`);
    lines.push("");
  }
  return lines.join("\n");
}

function exportMarkdown(report: ScanReport): string {
  const lines: string[] = [];
  lines.push(`# Relatório de Drift de Documentação`);
  lines.push("");
  lines.push(`- **Data:** ${report.createdAt}`);
  lines.push(`- **Código:** \`${report.codeDir}\``);
  lines.push(`- **Docs:** \`${report.docsDir}\``);
  lines.push(`- **Cobertura de documentação:** ${report.coverageScore}%`);
  lines.push(
    `- **Endpoints:** ${report.totalCodeEndpoints} no código / ${report.totalDocEndpoints} na doc`,
  );
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
  for (const f of report.findings) {
    lines.push(`| ${f.severity} | ${f.type} | \`${f.subject}\` | ${f.message.replace(/\|/g, "\\|")} |`);
  }
  return lines.join("\n");
}

function exportHtml(report: ScanReport): string {
  const rows = report.findings
    .map(
      (f) => `<tr class="sev-${f.severity}">
  <td>${escapeHtml(f.severity)}</td>
  <td>${escapeHtml(f.type)}</td>
  <td><code>${escapeHtml(f.subject)}</code></td>
  <td>${escapeHtml(f.message)}</td>
</tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<title>Relatório de Drift — ${escapeHtml(report.createdAt)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #ddd; padding: 0.5rem 0.75rem; text-align: left; font-size: 0.9rem; }
  th { background: #f4f4f4; }
  tr.sev-alta { background: #fdecea; }
  tr.sev-media { background: #fff8e1; }
  tr.sev-baixa { background: #f1f8f4; }
  .summary { display: flex; gap: 1.5rem; flex-wrap: wrap; margin: 1rem 0; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 0.75rem 1rem; }
</style>
</head>
<body>
  <h1>Relatório de Drift de Documentação</h1>
  <p>${escapeHtml(report.createdAt)} — <code>${escapeHtml(report.codeDir)}</code> vs <code>${escapeHtml(report.docsDir)}</code></p>
  <div class="summary">
    <div class="card"><strong>${report.coverageScore}%</strong><br>cobertura de docs</div>
    <div class="card"><strong>${report.totalCodeEndpoints}/${report.totalDocEndpoints}</strong><br>endpoints (código/doc)</div>
    <div class="card"><strong>${report.totalCodeEnvVars}/${report.totalDocEnvVars}</strong><br>env vars (código/doc)</div>
    <div class="card"><strong>${report.findings.length}</strong><br>achados de drift</div>
  </div>
  <table>
    <thead><tr><th>Severidade</th><th>Tipo</th><th>Assunto</th><th>Mensagem</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">Nenhum drift encontrado.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

function exportCsv(report: ScanReport): string {
  const header = "severity,type,subject,message";
  const rows = report.findings.map(
    (f) => `${f.severity},${f.type},${csvEscape(f.subject)},${csvEscape(f.message)}`,
  );
  return [header, ...rows].join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function exportJunit(report: ScanReport): string {
  const testcases = report.findings
    .map(
      (f) => `    <testcase classname="${escapeXml(f.type)}" name="${escapeXml(f.subject)}">
      <failure message="${escapeXml(f.message)}" type="${escapeXml(f.severity)}">${escapeXml(f.message)}</failure>
    </testcase>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="doc-drift-detector" tests="${report.findings.length}" failures="${report.findings.length}" timestamp="${report.createdAt}">
${testcases}
</testsuite>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(value: string): string {
  return escapeHtml(value).replace(/'/g, "&apos;");
}
