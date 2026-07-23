import { randomUUID } from "node:crypto";
import { runScan, type RunScanOptions } from "../core/scanner.js";
import { saveScan } from "../db/repository.js";
import type { ScanReport } from "../core/types.js";
import type { DriftFinding } from "../core/types.js";
import { logger } from "./logger.js";

export type JobStatus = "pendente" | "executando" | "concluido" | "falhou";

export interface ScanJob {
  readonly id: string;
  status: JobStatus;
  readonly createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  scanId?: number;
  report?: ScanReport;
  newFindings?: DriftFinding[];
  resolvedFindings?: unknown[];
  /** Mensagem segura para o cliente — nunca detalhe interno. */
  error?: string;
}

export interface ScanJobQueueOptions {
  /** Jobs executando simultaneamente. Scan é I/O + CPU pesado; o padrão é conservador. */
  concurrency?: number;
  /** Jobs aguardando na fila. Acima disso, novas submissões são recusadas (load shedding). */
  maxQueued?: number;
  /** Tempo que um job concluído fica disponível para consulta antes de ser descartado. */
  retentionMs?: number;
  /** Injetável para teste; por padrão executa o scan real e persiste. */
  execute?: (options: RunScanOptions) => Promise<{ report: ScanReport; scanId?: number; newFindings: DriftFinding[]; resolvedFindings: unknown[] }>;
}

export class QueueFullError extends Error {
  constructor(readonly maxQueued: number) {
    super(`A fila de scans está cheia (${maxQueued} pendentes). Tente novamente em instantes.`);
    this.name = "QueueFullError";
  }
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;

async function runAndPersist(options: RunScanOptions) {
  const report = await runScan(options);
  const saved = await saveScan(report);
  return {
    report,
    scanId: saved.scanId,
    newFindings: saved.newFindings,
    resolvedFindings: saved.resolvedFindings,
  };
}

/**
 * Fila de scans com concorrência limitada e backpressure.
 *
 * `POST /scans` era síncrono: a requisição ficava aberta durante toda a varredura, sem limite
 * de quantas podiam estar em voo. Bastavam algumas chamadas simultâneas sobre diretórios
 * grandes para saturar o event loop e derrubar a latência de todas as demais rotas — uma
 * negação de serviço acidental a partir de uso legítimo.
 *
 * Agora a rota devolve 202 com Location e o trabalho acontece aqui, com teto de concorrência e
 * de fila. Quando a fila enche, novas submissões são recusadas explicitamente (503 + Retry-After)
 * em vez de acumular trabalho que ninguém vai conseguir atender — load shedding, não fila
 * infinita.
 */
export class ScanJobQueue {
  private readonly jobs = new Map<string, ScanJob>();
  private readonly waiting: { jobId: string; options: RunScanOptions }[] = [];
  private running = 0;

  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly retentionMs: number;
  private readonly execute: NonNullable<ScanJobQueueOptions["execute"]>;

  constructor(options: ScanJobQueueOptions = {}) {
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.execute = options.execute ?? runAndPersist;
  }

  submit(options: RunScanOptions): ScanJob {
    if (this.waiting.length >= this.maxQueued) throw new QueueFullError(this.maxQueued);

    const job: ScanJob = { id: randomUUID(), status: "pendente", createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    this.waiting.push({ jobId: job.id, options });
    logger.info("scan enfileirado", { jobId: job.id, event: "job.enfileirado", count: this.waiting.length });

    this.pump();
    return job;
  }

  get(jobId: string): ScanJob | undefined {
    return this.jobs.get(jobId);
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  get runningCount(): number {
    return this.running;
  }

  /** Aguarda a fila esvaziar — para encerramento gracioso e para os testes. */
  async drain(): Promise<void> {
    while (this.running > 0 || this.waiting.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) return;
      this.running++;
      void this.process(next.jobId, next.options);
    }
  }

  private async process(jobId: string, options: RunScanOptions): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.running--;
      return;
    }

    job.status = "executando";
    job.startedAt = new Date().toISOString();
    const startedAt = Date.now();

    try {
      const result = await this.execute(options);
      job.status = "concluido";
      job.report = result.report;
      job.scanId = result.scanId;
      job.newFindings = result.newFindings;
      job.resolvedFindings = result.resolvedFindings;
      logger.info("scan concluído", {
        jobId,
        scanId: result.scanId,
        event: "job.concluido",
        durationMs: Date.now() - startedAt,
        count: result.report.findings.length,
      });
    } catch (err) {
      job.status = "falhou";
      // A mensagem exposta ao cliente é a do erro apenas quando ele é de domínio conhecido
      // (timeout, diretório não permitido); qualquer outra coisa vira texto genérico, com o
      // detalhe indo só para o log.
      job.error = err instanceof Error && err.name.endsWith("Error") && isSafeToExpose(err) ? err.message : "O scan falhou.";
      logger.error("scan falhou", {
        jobId,
        event: "job.falhou",
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    } finally {
      job.finishedAt = new Date().toISOString();
      this.running--;
      this.scheduleCleanup(jobId);
      this.pump();
    }
  }

  private scheduleCleanup(jobId: string): void {
    // `unref` para que um job retido não impeça o processo de encerrar.
    setTimeout(() => this.jobs.delete(jobId), this.retentionMs).unref();
  }
}

const EXPOSABLE_ERROR_NAMES = new Set(["ScanTimeoutError", "ScanRootNotAllowedError"]);

function isSafeToExpose(err: Error): boolean {
  return EXPOSABLE_ERROR_NAMES.has(err.name);
}
