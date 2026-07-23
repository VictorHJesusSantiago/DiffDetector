const LINE_FEED = 10;
const MAX_CONTEXT_LENGTH = 200;

/**
 * Índice de posições de início de linha de um texto, para converter offset → número de linha
 * em O(log n) com busca binária.
 *
 * Substitui o idioma `content.slice(0, index).split("\n").length`, que era repetido em oito
 * parsers e custa O(n) por ocorrência: um arquivo de 1 MB com 5.000 matches fazia ~5 GB de
 * cópia de string. Com o índice, o custo é O(n) uma única vez na construção.
 */
export class LineIndex {
  private readonly lineStarts: number[];

  constructor(private readonly content: string) {
    const starts = [0];
    for (let offset = 0; offset < content.length; offset++) {
      if (content.charCodeAt(offset) === LINE_FEED) starts.push(offset + 1);
    }
    this.lineStarts = starts;
  }

  /** Número da linha (base 1) que contém o offset informado. */
  lineAt(offset: number): number {
    if (offset <= 0) return 1;
    const clamped = Math.min(offset, this.content.length);
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid] <= clamped) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }

  /** Texto bruto da linha (base 1), sem o terminador de linha. */
  textAt(line: number): string {
    // `.at()` em vez de índice: o TypeScript tipa `array[i]` como sempre definido, mas uma
    // linha fora dos limites é entrada perfeitamente possível vinda de dado externo.
    const start = this.lineStarts.at(line - 1);
    if (start === undefined || line < 1) return "";
    const end = this.lineStarts.at(line) ?? this.content.length;
    let text = this.content.slice(start, end);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    return text;
  }

  /** Trecho da linha que contém o offset, normalizado para exibição em relatórios. */
  contextAt(offset: number): string {
    return this.textAt(this.lineAt(offset)).trim().slice(0, MAX_CONTEXT_LENGTH);
  }
}
