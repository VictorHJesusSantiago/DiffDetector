const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapa texto para interpolação em HTML, incluindo aspas simples e duplas — os relatórios são
 * gerados a partir de conteúdo lido de repositórios de terceiros (nomes de arquivo, trechos de
 * linha, caminhos vindos da API), ou seja, entrada não confiável renderizada em um documento
 * que alguém vai abrir no navegador.
 */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}

/** Escapa texto para interpolação em XML (JUnit), com as mesmas garantias. */
export function escapeXml(value: unknown): string {
  return escapeHtml(value).replace(/&#39;/g, "&apos;");
}
