import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Erro de política de acesso a diretórios: o caminho pedido está fora das raízes permitidas.
 * Tipado para que a camada HTTP responda 403 sem depender de casar a mensagem.
 */
export class ScanRootNotAllowedError extends Error {
  constructor(readonly requestedPath: string) {
    super(
      `O diretório "${requestedPath}" está fora das raízes permitidas para scan. ` +
        "Defina DRIFT_ALLOWED_ROOTS com os diretórios que podem ser escaneados.",
    );
    this.name = "ScanRootNotAllowedError";
  }
}

function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  // O sufixo garante que "/srv/apps-secretos" não seja aceito como filho de "/srv/apps".
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Política de quais diretórios do host podem ser escaneados por uma requisição HTTP.
 *
 * A API recebe `codeDir`/`docsDir` no corpo do POST /scans e os entrega direto ao sistema de
 * arquivos. Sem essa política, qualquer cliente conseguia apontar o scan para `/etc`, `~/.ssh`
 * ou o próprio diretório do serviço: o relatório devolve caminho, número de linha e o **trecho
 * da linha** de cada ocorrência encontrada, o que transforma o endpoint em leitura arbitrária
 * de arquivos do host (OWASP A01 combinado com Path Traversal).
 *
 * Configurada por `DRIFT_ALLOWED_ROOTS` (lista separada por vírgula ou por `path.delimiter`).
 * Sem configuração, o padrão é o diretório de trabalho do processo — seguro por omissão.
 */
export class ScanRootPolicy {
  private readonly roots: readonly string[];

  constructor(roots: readonly string[]) {
    this.roots = roots.map((root) => resolve(root));
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ScanRootPolicy {
    const configured = (env.DRIFT_ALLOWED_ROOTS ?? "")
      .split(/[,;:]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return new ScanRootPolicy(configured.length > 0 ? configured : [cwd]);
  }

  get allowedRoots(): readonly string[] {
    return this.roots;
  }

  /** Devolve o caminho absoluto canônico, ou lança se ele estiver fora das raízes permitidas. */
  assertAllowed(requestedPath: string): string {
    const absolute = resolve(requestedPath);
    if (!this.roots.some((root) => isInside(absolute, root))) {
      throw new ScanRootNotAllowedError(requestedPath);
    }
    return absolute;
  }

  /**
   * Como `assertAllowed`, mas resolvendo links simbólicos dos dois lados antes de comparar —
   * um symlink plantado dentro de uma raiz permitida apontaria para fora dela e passaria pela
   * checagem puramente textual.
   */
  async assertAllowedResolvingLinks(requestedPath: string): Promise<string> {
    const absolute = this.assertAllowed(requestedPath);
    const real = await realpathOrSelf(absolute);
    const realRoots = await Promise.all(this.roots.map(realpathOrSelf));
    if (!realRoots.some((root) => isInside(real, root))) {
      throw new ScanRootNotAllowedError(requestedPath);
    }
    return real;
  }
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Caminho inexistente: mantém a forma resolvida; o scan simplesmente não encontrará nada.
    return path;
  }
}
