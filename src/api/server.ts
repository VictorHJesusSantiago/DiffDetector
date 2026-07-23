import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import "dotenv/config";
import { ScanRootNotAllowedError, ScanRootPolicy } from "../core/scanRoots.js";
import { getLatestScan, getScanHistory, getScanById } from "../db/repository.js";
import { migrate } from "../db/migrate.js";
import { closePool } from "../db/pool.js";
import { logger, withRequestId } from "./logger.js";
import { metrics } from "./metrics.js";
import { RateLimiter } from "./rateLimit.js";
import { QueueFullError, ScanJobQueue } from "./scanJobs.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 200;
const JSON_BODY_LIMIT = "64kb";
const SHUTDOWN_GRACE_MS = 15_000;
const MILLIS_PER_SECOND = 1000;

const scanRootPolicy = ScanRootPolicy.fromEnvironment();
const scanQueue = new ScanJobQueue();

/**
 * Limites configuráveis por ambiente: o valor adequado depende de quantos clientes legítimos
 * existem e de quão caro é um scan naquele repositório — não há número universal, e um limite
 * fixo no código força quem opera a escolher entre recompilar ou desligar a proteção.
 */
function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Padrão: rajada de 10, taxa sustentada de 1 requisição a cada 2 s por cliente. */
const generalLimiter = new RateLimiter({
  capacity: numberFromEnv("DRIFT_RATE_LIMIT_CAPACITY", 10),
  refillPerSecond: numberFromEnv("DRIFT_RATE_LIMIT_REFILL_PER_SECOND", 0.5),
});

/** Scan é caro: padrão de rajada de 3, uma a cada 10 s. */
const scanLimiter = new RateLimiter({
  capacity: numberFromEnv("DRIFT_SCAN_RATE_LIMIT_CAPACITY", 3),
  refillPerSecond: numberFromEnv("DRIFT_SCAN_RATE_LIMIT_REFILL_PER_SECOND", 0.1),
});

export const app = express();
app.disable("x-powered-by");
app.use(correlationId);
app.use(securityHeaders);
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(requireApiToken);
app.use(rateLimit(generalLimiter));

/**
 * Correlação de ponta a ponta: aceita o `X-Request-Id` do cliente ou gera um, devolve no
 * cabeçalho da resposta e o propaga via AsyncLocalStorage para que todo log emitido durante a
 * requisição o carregue sem precisar passar o id de função em função.
 *
 * Também é onde a métrica RED é registrada — no encerramento da resposta, com a rota no padrão
 * registrado (`/scans/:id`), nunca o caminho concreto, para não explodir a cardinalidade.
 */
function correlationId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  const requestId = incoming && /^[\w-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", requestId);

  const startedAt = process.hrtime.bigint();
  withRequestId(requestId, () => {
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const route = routeLabelOf(req);
      metrics.observe({ method: req.method, route, status: res.statusCode }, durationMs / MILLIS_PER_SECOND);
      logger.info("requisição atendida", {
        requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    });
    next();
  });
}

/**
 * Rótulo de rota para a métrica: o padrão registrado (`/scans/:id`), nunca o caminho concreto.
 * `req.route` não é tipado pelos @types do Express, por isso a narrowing explícita.
 */
function routeLabelOf(req: Request): string {
  const registered: unknown = (req as { route?: unknown }).route;
  if (registered && typeof registered === "object" && "path" in registered) {
    const { path } = registered;
    if (typeof path === "string") return `${req.baseUrl}${path}`;
  }
  return normalizeUnmatchedPath(req.path);
}

/** Caminhos sem rota registrada viram um rótulo único, para não vazarem cardinalidade. */
function normalizeUnmatchedPath(path: string): string {
  return path === "/health" || path === "/metrics" ? path : "desconhecida";
}

/**
 * Cabeçalhos de segurança mínimos, escritos à mão para não introduzir dependência nova.
 * A API só devolve JSON e texto de métricas, então a CSP pode ser máximamente restritiva.
 */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  // timingSafeEqual exige comprimentos iguais; comparar o tamanho antes vaza só o tamanho.
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/** Rotas abertas: liveness e métricas precisam responder sem credencial de aplicação. */
const UNAUTHENTICATED_PATHS = new Set(["/health"]);

/**
 * Autenticação por token compartilhado, ativada quando `DRIFT_API_TOKEN` está definida.
 *
 * A API dispara varreduras do sistema de arquivos do host e expõe todo o histórico de scans;
 * sem token ela só deve ficar acessível em loopback.
 */
function requireApiToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.DRIFT_API_TOKEN?.trim();
  if (!expected || UNAUTHENTICATED_PATHS.has(req.path)) {
    next();
    return;
  }

  const header = req.header("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!provided || !safeEquals(provided, expected)) {
    logger.warn("autenticação recusada", { event: "auth.recusada", method: req.method, route: req.path });
    sendProblem(res, 401, "nao-autenticado", "Credenciais ausentes ou inválidas.");
    return;
  }
  next();
}

function clientIdOf(req: Request): string {
  // Sem proxy confiável configurado, `req.ip` é o peer real. Não usamos X-Forwarded-For: é
  // forjável, e confiar nele permitiria burlar o limite trocando o cabeçalho a cada requisição.
  return req.ip ?? "desconhecido";
}

function rateLimit(limiter: RateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (UNAUTHENTICATED_PATHS.has(req.path)) {
      next();
      return;
    }

    const decision = limiter.check(clientIdOf(req));
    res.setHeader("X-RateLimit-Limit", String(limiter.limit));
    res.setHeader("X-RateLimit-Remaining", String(decision.remaining));

    if (!decision.allowed) {
      res.setHeader("Retry-After", String(decision.retryAfterSeconds));
      logger.warn("limite de requisições excedido", { event: "ratelimit.excedido", route: req.path });
      sendProblem(res, 429, "limite-excedido", "Muitas requisições. Tente novamente depois do intervalo indicado.");
      return;
    }
    next();
  };
}

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

/**
 * Adapta um handler assíncrono para a assinatura síncrona que o Express espera.
 *
 * O Express 4 não conhece Promises: passar um `async (req, res) => …` direto faz qualquer
 * rejeição não tratada dentro do handler virar um unhandled rejection do processo — a
 * requisição fica pendurada até o timeout do cliente e, em Node 20, o processo pode ser
 * derrubado. Aqui toda rejeição vira uma resposta 500 em Problem Details.
 */
function asyncRoute(handler: AsyncHandler) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        logger.error("erro após o início da resposta", {
          event: "erro.pos_resposta",
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
        res.end();
        return;
      }
      handleUnexpected(res, err, "Falha ao processar a requisição.");
    });
  };
}

/** Resposta de erro no formato Problem Details (RFC 7807). */
function sendProblem(res: Response, status: number, type: string, detail: string): void {
  res.status(status).type("application/problem+json").json({
    type: `https://github.com/doc-drift-detector/problems/${type}`,
    title: type,
    status,
    detail,
  });
}

function parseLimit(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", fila: { pendentes: scanQueue.queuedCount, executando: scanQueue.runningCount } });
});

app.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4").send(metrics.render());
});

/**
 * Aceita um scan e devolve 202 com o Location do job.
 *
 * A versão anterior era síncrona: a conexão HTTP ficava aberta durante toda a varredura, e não
 * havia teto de quantas podiam estar em voo. Operação cara e de duração imprevisível não cabe
 * em requisição síncrona — o cliente acompanha o progresso em GET /scans/jobs/:id.
 */
app.post(
  "/scans",
  rateLimit(scanLimiter),
  asyncRoute(async (req, res) => {
    const { codeDir, docsDir } = (req.body ?? {}) as { codeDir?: unknown; docsDir?: unknown };
    if (typeof codeDir !== "string" || typeof docsDir !== "string" || !codeDir.trim() || !docsDir.trim()) {
      sendProblem(res, 400, "requisicao-invalida", "codeDir e docsDir são obrigatórios e devem ser strings não vazias.");
      return;
    }

    let allowedCodeDir: string;
    let allowedDocsDir: string;
    try {
      [allowedCodeDir, allowedDocsDir] = await Promise.all([
        scanRootPolicy.assertAllowedResolvingLinks(codeDir),
        scanRootPolicy.assertAllowedResolvingLinks(docsDir),
      ]);
    } catch (err) {
      if (!(err instanceof ScanRootNotAllowedError)) throw err;
      logger.warn("diretório fora das raízes permitidas", { event: "scan.diretorio_negado" });
      sendProblem(res, 403, "diretorio-nao-permitido", err.message);
      return;
    }

    try {
      const job = scanQueue.submit({ codeDir: allowedCodeDir, docsDir: allowedDocsDir });
      res.status(202)
        .location(`/scans/jobs/${job.id}`)
        .json({ jobId: job.id, status: job.status, acompanhar: `/scans/jobs/${job.id}` });
    } catch (err) {
      if (!(err instanceof QueueFullError)) throw err;
      res.setHeader("Retry-After", "30");
      sendProblem(res, 503, "fila-cheia", err.message);
    }
  }),
);

app.get("/scans/jobs/:id", (req, res) => {
  const job = scanQueue.get(req.params.id);
  if (!job) {
    sendProblem(res, 404, "job-nao-encontrado", "Job não encontrado ou já expirado.");
    return;
  }

  if (job.status === "concluido") {
    res.json({
      jobId: job.id,
      status: job.status,
      scanId: job.scanId,
      report: job.report,
      newFindings: job.newFindings,
      resolvedFindings: job.resolvedFindings,
    });
    return;
  }

  if (job.status === "falhou") {
    sendProblem(res, 500, "scan-falhou", job.error ?? "O scan falhou.");
    return;
  }

  // Ainda em andamento: 200 com o estado, e um Retry-After para orientar o polling.
  res.setHeader("Retry-After", "2");
  res.json({ jobId: job.id, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt });
});

app.get(
  "/scans",
  asyncRoute(async (req, res) => {
    const limit = parseLimit(req.query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    if (limit === null) {
      sendProblem(res, 400, "parametro-invalido", `limit deve ser um inteiro entre 1 e ${MAX_HISTORY_LIMIT}.`);
      return;
    }
    res.json({ scans: await getScanHistory(limit) });
  }),
);

app.get(
  "/scans/latest",
  asyncRoute(async (_req, res) => {
    const result = await getLatestScan();
    if (!result) {
      sendProblem(res, 404, "scan-nao-encontrado", "Nenhum scan encontrado.");
      return;
    }
    res.json(result);
  }),
);

app.get(
  "/scans/:id",
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      sendProblem(res, 400, "parametro-invalido", "id deve ser um inteiro positivo.");
      return;
    }
    const result = await getScanById(id);
    if (!result) {
      sendProblem(res, 404, "scan-nao-encontrado", "Scan não encontrado.");
      return;
    }
    res.json(result);
  }),
);

app.use((_req, res) => {
  sendProblem(res, 404, "rota-nao-encontrada", "Rota não encontrada.");
});

/**
 * Detalhes internos (stack traces, caminhos do host, mensagens do Postgres) ficam no log e
 * nunca no corpo da resposta — a versão original devolvia `err.message` ao cliente, expondo
 * estrutura interna a quem provocasse o erro (OWASP A05).
 */
function handleUnexpected(res: Response, err: unknown, detail: string): void {
  logger.error("erro não tratado", {
    event: "erro.nao_tratado",
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });
  if (err instanceof Error && err.stack) logger.debug(err.stack);
  sendProblem(res, 500, "erro-interno", detail);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
}

/**
 * As migrações são aplicadas uma única vez na inicialização. Antes, `migrate()` era chamado
 * dentro do handler de POST /scans: DDL a cada requisição.
 */
export async function start(port = Number(process.env.PORT ?? DEFAULT_PORT)): Promise<void> {
  const migration = await migrate();
  if (migration.applied.length > 0) {
    logger.info("migrações aplicadas", { event: "db.migrado", count: migration.applied.length });
  }

  const server = app.listen(port, () => {
    logger.info("API iniciada", { event: "api.iniciada" });
    console.log(`Doc Drift Detector API rodando em http://localhost:${port}`);
    if (!process.env.DRIFT_API_TOKEN) {
      logger.warn("DRIFT_API_TOKEN não definida: a API está sem autenticação; exponha apenas em loopback.", {
        event: "api.sem_autenticacao",
      });
    }
    logger.info(`raízes permitidas para scan: ${scanRootPolicy.allowedRoots.join(", ")}`, {
      event: "api.raizes_permitidas",
    });
  });

  // Encerramento gracioso (12-Factor IX): para de aceitar conexões, deixa as requisições em voo
  // e os scans em andamento terminarem, e só então fecha o pool.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} recebido, encerrando`, { event: "api.encerrando" });

    const forceExit = setTimeout(() => {
      logger.error("encerramento forçado após o período de graça", { event: "api.encerramento_forcado" });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    server.close(() => {
      void scanQueue
        .drain()
        .then(() => closePool())
        .finally(() => {
          clearTimeout(forceExit);
          logger.info("encerramento concluído", { event: "api.encerrada" });
        });
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (isEntryPoint()) {
  start().catch((err: unknown) => {
    console.error("Falha ao iniciar a API:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

export default app;
