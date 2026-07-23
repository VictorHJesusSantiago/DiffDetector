export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}

/**
 * Distância de edição limitada: devolve a distância exata quando ela é `<= maxDistance`, ou
 * `maxDistance + 1` quando comprovadamente maior. A detecção de renomeação compara cada
 * endpoint documentado órfão contra todos os endpoints do código — O(docs × código × L²) na
 * versão irrestrita. Como só interessa saber se a distância cabe em um limite pequeno
 * (padrão 3), dois cortes eliminam quase todo esse trabalho:
 *
 * 1. diferença de comprimento maior que o limite já implica distância maior (cota inferior);
 * 2. se o menor valor de uma linha inteira da matriz já excede o limite, nenhuma linha
 *    seguinte pode voltar a caber nele (os valores são monotonicamente não decrescentes).
 */
export function levenshteinWithin(a: string, b: string, maxDistance: number): number {
  const exceeded = maxDistance + 1;
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return exceeded;
  if (a.length === 0) return b.length <= maxDistance ? b.length : exceeded;
  if (b.length === 0) return a.length <= maxDistance ? a.length : exceeded;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDistance) return exceeded;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length] <= maxDistance ? prev[b.length] : exceeded;
}
