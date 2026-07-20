import type { DriftFinding } from "./types.js";

/**
 * Gera um stub de Markdown pronto para colar na documentação, a partir dos achados
 * ENDPOINT_NAO_DOCUMENTADO/ENV_VAR_NAO_DOCUMENTADA de um relatório. Não escreve em nenhum
 * arquivo automaticamente — apenas produz o texto para revisão humana.
 */
export function generateDocStub(findings: DriftFinding[]): string {
  const endpointFindings = findings.filter((f) => f.type === "ENDPOINT_NAO_DOCUMENTADO");
  const envFindings = findings.filter((f) => f.type === "ENV_VAR_NAO_DOCUMENTADA");

  if (endpointFindings.length === 0 && envFindings.length === 0) {
    return "Nenhum endpoint ou variável de ambiente pendente de documentação.";
  }

  const lines: string[] = [];

  if (endpointFindings.length > 0) {
    lines.push("## Endpoints");
    lines.push("");
    for (const f of endpointFindings) {
      lines.push(`- \`${f.subject}\` — TODO: descrever o que este endpoint faz.`);
      for (const ref of f.codeRefs) lines.push(`  <!-- implementado em ${ref.file}:${ref.line} -->`);
    }
    lines.push("");
  }

  if (envFindings.length > 0) {
    lines.push("## Variáveis de ambiente");
    lines.push("");
    for (const f of envFindings) {
      lines.push(`- \`${f.subject}\` — TODO: descrever o propósito desta variável.`);
      for (const ref of f.codeRefs) lines.push(`  <!-- usada em ${ref.file}:${ref.line} -->`);
    }
  }

  return lines.join("\n");
}
