import { readFile } from "node:fs/promises";

/**
 * Diretórios que nenhum parser deve varrer: dependências instaladas, saídas de build e
 * metadados de VCS. Fonte única de verdade — antes cada parser declarava a sua própria lista,
 * com valores divergentes, o que fazia um parser enxergar `dist/` e outro não sobre o mesmo
 * repositório (achados assimétricos e falsos positivos).
 */
export const SCAN_IGNORE_GLOBS: readonly string[] = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/.terraform/**",
];

/** Saídas de build específicas de linguagens compiladas (Java/Rust/.NET). */
export const COMPILED_OUTPUT_IGNORE_GLOBS: readonly string[] = ["**/target/**", "**/bin/**", "**/obj/**"];

/**
 * Junta um diretório raiz com um caminho relativo vindo do fast-glob (que sempre usa "/"),
 * sem duplicar nem omitir o separador. Substitui a concatenação manual `${dir}/${rel}`, que
 * produzia "dir//arquivo" quando o diretório era informado com barra final.
 */
export function joinScanPath(rootDir: string, relativePath: string): string {
  const normalizedRoot = rootDir.replace(/[\\/]+$/, "");
  return normalizedRoot.length === 0 ? relativePath : `${normalizedRoot}/${relativePath}`;
}

/**
 * Lê um arquivo de texto, devolvendo null quando ele não pode ser lido (removido entre o glob
 * e a leitura, permissão negada, binário ilegível). Parsers varrem repositórios de terceiros,
 * onde arquivos ilegíveis são esperados e não devem abortar o scan inteiro.
 */
export async function readTextFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}
