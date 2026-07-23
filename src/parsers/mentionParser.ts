import type { ExtraCodeResource, ExtraDocResource, ExtraResourceKind } from "../core/types.js";
import type { ScanSource } from "../core/scanSource.js";

interface SubjectMatcher {
  readonly subject: string;
  readonly kinds: readonly ExtraResourceKind[];
  readonly pattern: RegExp;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pré-compila um matcher por subject distinto. Antes, a RegExp era reconstruída dentro do laço
 * de arquivos (arquivos × subjects compilações); agora é compilada uma vez por subject.
 */
function buildMatchers(resources: readonly ExtraCodeResource[]): SubjectMatcher[] {
  const kindsBySubject = new Map<string, Set<ExtraResourceKind>>();
  for (const resource of resources) {
    const kinds = kindsBySubject.get(resource.subject) ?? new Set<ExtraResourceKind>();
    kinds.add(resource.kind);
    kindsBySubject.set(resource.subject, kinds);
  }

  return [...kindsBySubject].map(([subject, kinds]) => ({
    subject,
    kinds: [...kinds],
    pattern: new RegExp(`(?:\`${escapeRegExp(subject)}\`|\\b${escapeRegExp(subject)}\\b)`),
  }));
}

/**
 * Varre os arquivos Markdown procurando menções textuais (entre crases ou como palavra isolada)
 * dos subjects passados em `resources`. Usado para decidir se um recurso extra do código
 * (GraphQL, gRPC, fila, CLI, WebSocket, tabela, role) foi documentado, sem precisar de um
 * parser de doc dedicado por tipo de recurso.
 *
 * Só a primeira menção de cada (arquivo, subject, kind) é registrada: o consumidor pergunta
 * "está documentado?", não "quantas vezes aparece?".
 *
 * Não usa o cache de parsing porque o resultado depende de `resources`, que varia entre scans —
 * uma entrada de cache indexada só por (parser, arquivo) devolveria menções de uma lista de
 * subjects antiga.
 */
export async function findDocMentions(
  source: ScanSource,
  resources: readonly ExtraCodeResource[],
): Promise<ExtraDocResource[]> {
  if (resources.length === 0) return [];

  const matchers = buildMatchers(resources);
  const mentions: ExtraDocResource[] = [];

  for (const entry of source.select({ extensions: ["md", "mdx"] })) {
    const file = await source.read(entry);
    if (!file) continue;

    for (const matcher of matchers) {
      const match = matcher.pattern.exec(file.content);
      if (!match) continue;
      for (const kind of matcher.kinds) {
        mentions.push({
          kind,
          subject: matcher.subject,
          file: file.relPath,
          line: file.lines.lineAt(match.index),
          context: file.lines.contextAt(match.index),
        });
      }
    }
  }

  return mentions;
}
