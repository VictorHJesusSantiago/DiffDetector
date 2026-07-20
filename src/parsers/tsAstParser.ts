import ts from "typescript";
import type { CodeEndpoint, CodeEnvVar, HttpMethod } from "../core/types.js";
import { normalizePath } from "./codeParser.js";

const HTTP_METHOD_NAMES = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
// Mesma restrição de receptor do parser por regex, para não confundir chamadas genéricas
// (ex.: cache.get("chave"), Map.get(x)) com definições de rota.
const ROUTER_RECEIVER_RE = /\b(app|router|api|server|fastify)\b/i;

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * Parser AST real (via `typescript` compiler API) para .js/.jsx/.ts/.tsx. Ao contrário do
 * `codeParser.ts` (baseado em regex), este caminha pela árvore sintática de verdade, então não
 * é enganado por strings dentro de comentários, template literals multilinha ou formatação
 * incomum. Usado como fonte primária para esses arquivos; o parser por regex continua servindo
 * de fallback/comparação e cobrindo linguagens sem suporte de AST (Python etc.).
 */
export function parseWithAst(
  relFile: string,
  content: string,
): { endpoints: CodeEndpoint[]; envVars: CodeEnvVar[] } {
  const endpoints: CodeEndpoint[] = [];
  const envVars: CodeEnvVar[] = [];

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(relFile, content, ts.ScriptTarget.Latest, true, scriptKindFor(relFile));
  } catch {
    return { endpoints, envVars };
  }

  const lineOf = (pos: number): number => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text.toLowerCase();
      const receiverText = node.expression.expression.getText(sourceFile);
      if (HTTP_METHOD_NAMES.has(methodName) && ROUTER_RECEIVER_RE.test(receiverText)) {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isStringLiteralLike(firstArg)) {
          endpoints.push({
            method: methodName.toUpperCase() as HttpMethod,
            path: normalizePath(firstArg.text),
            file: relFile,
            line: lineOf(node.getStart(sourceFile)),
          });
        }
      }

      // fastify.route({ method: 'GET', url: '/x' })
      if (methodName === "route" && ROUTER_RECEIVER_RE.test(receiverText)) {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
          let routeMethod: string | undefined;
          let routePath: string | undefined;
          for (const prop of firstArg.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
            if (prop.name.text === "method" && ts.isStringLiteralLike(prop.initializer)) {
              routeMethod = prop.initializer.text.toLowerCase();
            }
            if ((prop.name.text === "url" || prop.name.text === "path") && ts.isStringLiteralLike(prop.initializer)) {
              routePath = prop.initializer.text;
            }
          }
          if (routeMethod && routePath && HTTP_METHOD_NAMES.has(routeMethod)) {
            endpoints.push({
              method: routeMethod.toUpperCase() as HttpMethod,
              path: normalizePath(routePath),
              file: relFile,
              line: lineOf(node.getStart(sourceFile)),
            });
          }
        }
      }
    }

    // process.env.X
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "env"
    ) {
      const name = node.name.text;
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
        envVars.push({ name, file: relFile, line: lineOf(node.getStart(sourceFile)) });
      }
    }

    // process.env['X']
    if (
      ts.isElementAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "env" &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      const name = node.argumentExpression.text;
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
        envVars.push({ name, file: relFile, line: lineOf(node.getStart(sourceFile)) });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { endpoints, envVars };
}
