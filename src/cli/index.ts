#!/usr/bin/env node
import { watch, type FSWatcher } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { runScan } from "../core/scanner.js";
import {
  saveScan,
  getLatestScan,
  getScanHistory,
  getScanById,
  getScanHistoryWithOpenFindingsCount,
} from "../db/repository.js";
import { migrate } from "../db/migrate.js";
import { closePool } from "../db/pool.js";
import { exportReport, type ReportFormat } from "../core/exporters.js";
import { diffFindings } from "../core/scanDiff.js";
import { calculateCoverageScore } from "../core/driftEngine.js";
import { generateDocStub } from "../core/stubGenerator.js";
import { generatePreCommitHook } from "../core/hookGenerator.js";
import { loadWorkspace } from "../core/workspace.js";
import { generateDashboardHtml, type DashboardScanRow } from "../core/dashboard.js";
import type { DriftFinding, ScanReport } from "../core/types.js";

const WATCH_DEBOUNCE_MS = 300;
const MAX_LIMIT = 1000;
const REPORT_FORMATS: ReportFormat[] = ["text", "json", "markdown", "html", "csv", "junit"];

const program = new Command();

program
  .name("drift")
  .description("Detector de drift entre documentação e sistema real (código/infraestrutura).");

/** Valida na fronteira: um `--limit abc` virava `LIMIT NaN` e estourava no driver do Postgres. */
function parsePositiveInteger(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new InvalidArgumentError(`precisa ser um inteiro entre 1 e ${MAX_LIMIT}.`);
  }
  return parsed;
}

function parseReportFormat(raw: string): ReportFormat {
  if (!REPORT_FORMATS.includes(raw as ReportFormat)) {
    throw new InvalidArgumentError(`precisa ser um de: ${REPORT_FORMATS.join(", ")}.`);
  }
  return raw as ReportFormat;
}

function addFormatOption(cmd: Command, description = "Formato do relatório"): Command {
  return cmd.option("--format <formato>", `${description}: ${REPORT_FORMATS.join("|")}`, parseReportFormat, "text");
}

function addScanOptions(cmd: Command): Command {
  return addFormatOption(cmd)
    .requiredOption("--code <dir>", "Diretório raiz do código-fonte")
    .requiredOption("--docs <dir>", "Diretório raiz da documentação (README/runbooks/wiki em Markdown)")
    .option("--no-save", "Não persistir o resultado no banco de dados")
    .option("--fail-on-drift", "Sai com código de erro 1 se houver qualquer drift encontrado")
    .option("--out <arquivo>", "Escreve o relatório formatado em um arquivo em vez de stdout")
    .option("--verbose", "Mostra quais arquivos foram escaneados e detalhes de execução")
    .option("--cache", "Usa cache de parsing por arquivo (.drift-cache.json) para acelerar scans repetidos")
    .option("--no-extra-sources", "Desliga parsers extras (.env.example, OpenAPI, Dockerfile/compose)")
    .option("--config <arquivo>", "Caminho do drift.config.json", "drift.config.json")
    .option("--ignore-file <arquivo>", "Caminho do drift-ignore.json", "drift-ignore.json");
}

interface ScanCommandOptions {
  code: string;
  docs: string;
  format: ReportFormat;
  out?: string;
  save?: boolean;
  failOnDrift?: boolean;
  verbose?: boolean;
  cache?: boolean;
  extraSources?: boolean;
  config: string;
  ignoreFile: string;
}

function toRunScanOptions(opts: ScanCommandOptions) {
  return {
    codeDir: opts.code,
    docsDir: opts.docs,
    useExtraSources: opts.extraSources !== false,
    useCache: !!opts.cache,
    configPath: opts.config,
    ignorePath: opts.ignoreFile,
  };
}

addScanOptions(program.command("scan"))
  .description("Executa um scan comparando código e documentação, imprime o relatório e persiste no Postgres.")
  .action(async (opts: ScanCommandOptions) => {
    if (opts.verbose) console.error(`[verbose] escaneando código em "${opts.code}" e docs em "${opts.docs}"...`);

    const report = await runScan(toRunScanOptions(opts));
    await emitReport(report, opts.format, opts.out);

    if (opts.save !== false) {
      try {
        await migrate();
        const result = await saveScan(report);
        console.error(`\nScan #${result.scanId} salvo no banco de dados.`);
        if (result.newFindings.length > 0) {
          console.error(`Novos problemas de drift desde o último scan: ${result.newFindings.length}`);
        }
        if (result.resolvedFindings.length > 0) {
          console.error(`Problemas resolvidos desde o último scan: ${result.resolvedFindings.length}`);
        }
      } finally {
        await closePool();
      }
    }

    if (opts.failOnDrift && report.findings.length > 0) {
      process.exitCode = 1;
    }
  });

addScanOptions(program.command("watch"))
  .description("Reroda o scan automaticamente sempre que arquivos em --code ou --docs mudam.")
  .action(async (opts: ScanCommandOptions) => {
    console.error(`Observando "${opts.code}" e "${opts.docs}"... (Ctrl+C para sair)`);

    let running = false;
    let pending = false;

    /**
     * Nunca rejeita: é disparado por `setTimeout`, onde uma rejeição não teria quem a capture
     * e derrubaria o processo (unhandled rejection) por algo tão banal quanto um diretório
     * removido no meio da edição. Um scan que falha vira uma mensagem e a observação continua.
     */
    const runOnce = async (): Promise<void> => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        const report = await runScan(toRunScanOptions(opts));
        console.clear();
        await emitReport(report, opts.format, opts.out);
      } catch (err) {
        console.error("Falha no scan:", err instanceof Error ? err.message : err);
      } finally {
        running = false;
        if (pending) {
          pending = false;
          void runOnce();
        }
      }
    };

    await runOnce();

    let debounce: NodeJS.Timeout | undefined;
    const trigger = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void runOnce(), WATCH_DEBOUNCE_MS);
    };

    const watchers: FSWatcher[] = [
      watch(opts.code, { recursive: true }, trigger),
      watch(opts.docs, { recursive: true }, trigger),
    ];

    process.once("SIGINT", () => {
      clearTimeout(debounce);
      for (const watcher of watchers) watcher.close();
      process.exit(0);
    });
  });

addFormatOption(program.command("scan-workspace"))
  .description("Roda um scan para cada par codeDir/docsDir descrito em um arquivo de workspace (monorepos).")
  .requiredOption("--workspace <arquivo>", "Caminho do drift.workspace.json")
  .option("--fail-on-drift", "Sai com código de erro 1 se qualquer projeto tiver drift")
  .action(async (opts: { workspace: string; format: ReportFormat; failOnDrift?: boolean }) => {
    const workspace = await loadWorkspace(opts.workspace);
    let anyDrift = false;
    for (const project of workspace.projects) {
      console.error(`\n### Projeto: ${project.name} ###`);
      const report = await runScan({ codeDir: project.codeDir, docsDir: project.docsDir });
      console.log(exportReport(report, opts.format));
      if (report.findings.length > 0) anyDrift = true;
    }
    if (opts.failOnDrift && anyDrift) process.exitCode = 1;
  });

program
  .command("stub")
  .description("Gera um stub de Markdown com os endpoints/env vars ainda não documentados.")
  .requiredOption("--code <dir>", "Diretório raiz do código-fonte")
  .requiredOption("--docs <dir>", "Diretório raiz da documentação")
  .action(async (opts: { code: string; docs: string }) => {
    const report = await runScan({ codeDir: opts.code, docsDir: opts.docs });
    console.log(generateDocStub(report.findings));
  });

program
  .command("init-hook")
  .description("Gera um hook de pre-commit local (.git/hooks/pre-commit) que bloqueia commits com drift.")
  .requiredOption("--code <dir>", "Diretório raiz do código-fonte")
  .requiredOption("--docs <dir>", "Diretório raiz da documentação")
  .option("--git-dir <dir>", "Caminho do diretório .git", ".git")
  .action(async (opts: { code: string; docs: string; gitDir: string }) => {
    const script = generatePreCommitHook(opts.code, opts.docs);
    const hookPath = join(opts.gitDir, "hooks", "pre-commit");
    await mkdir(dirname(hookPath), { recursive: true });
    await writeFile(hookPath, script, "utf-8");
    try {
      await chmod(hookPath, 0o755);
    } catch {
      // chmod pode não ser suportado (ex.: Windows) — o arquivo ainda é válido para WSL/Git Bash.
    }
    console.log(`Hook de pre-commit escrito em ${hookPath}`);
  });

program
  .command("diff")
  .description("Compara os achados de dois scans salvos no banco de dados.")
  .argument("<scanIdA>", "id do scan mais antigo", parsePositiveInteger)
  .argument("<scanIdB>", "id do scan mais novo", parsePositiveInteger)
  .action(async (scanIdA: number, scanIdB: number) => {
    try {
      const [older, newer] = await Promise.all([getScanById(scanIdA), getScanById(scanIdB)]);
      if (!older || !newer) {
        console.error("Um dos scans informados não foi encontrado.");
        process.exitCode = 1;
        return;
      }
      const diff = diffFindings(older.findings, newer.findings);
      console.log(`Diff entre scan #${scanIdA} e scan #${scanIdB}`);
      console.log(`\n+ Novos (${diff.added.length}):`);
      for (const finding of diff.added) console.log(`  [${finding.severity}] ${finding.type} — ${finding.subject}`);
      console.log(`\n- Resolvidos/desaparecidos (${diff.removed.length}):`);
      for (const finding of diff.removed) console.log(`  [${finding.severity}] ${finding.type} — ${finding.subject}`);
      console.log(`\n= Inalterados (${diff.unchanged.length})`);
    } finally {
      await closePool();
    }
  });

program
  .command("dashboard")
  .description("Gera um dashboard HTML estático (local, sem servidor) com o histórico de achados abertos por scan.")
  .option("--out <arquivo>", "Arquivo de saída", "drift-dashboard.html")
  .option("--limit <n>", "Quantidade de scans a incluir", parsePositiveInteger, 100)
  .action(async (opts: { out: string; limit: number }) => {
    try {
      const rows = (await getScanHistoryWithOpenFindingsCount(opts.limit)) as unknown as DashboardScanRow[];
      await writeFile(opts.out, generateDashboardHtml(rows), "utf-8");
      console.log(`Dashboard escrito em ${opts.out} (abra diretamente no navegador).`);
    } finally {
      await closePool();
    }
  });

program
  .command("history")
  .description("Lista o histórico de scans salvos no banco de dados.")
  .option("--limit <n>", "Quantidade de scans a listar", parsePositiveInteger, 20)
  .action(async (opts: { limit: number }) => {
    try {
      const scans = await getScanHistory(opts.limit);
      if (scans.length === 0) {
        console.log("Nenhum scan encontrado.");
        return;
      }
      for (const row of scans) {
        const scan = toScanSummary(row);
        console.log(
          `#${scan.id} | ${scan.createdAt} | código=${scan.codeDir} docs=${scan.docsDir} | ` +
            `endpoints(code/doc)=${scan.codeEndpoints}/${scan.docEndpoints} ` +
            `env(code/doc)=${scan.codeEnvVars}/${scan.docEnvVars}`,
        );
      }
    } finally {
      await closePool();
    }
  });

addFormatOption(program.command("latest"))
  .description("Mostra o relatório do último scan salvo no banco de dados.")
  .action(async (opts: { format: ReportFormat }) => {
    try {
      const result = await getLatestScan();
      if (!result) {
        console.log("Nenhum scan encontrado. Rode `drift scan` primeiro.");
        return;
      }
      console.log(exportReport(toReport(result), opts.format));
    } finally {
      await closePool();
    }
  });

interface ScanSummary {
  id: string;
  createdAt: string;
  codeDir: string;
  docsDir: string;
  codeEndpoints: string;
  docEndpoints: string;
  codeEnvVars: string;
  docEnvVars: string;
}

/**
 * Converte uma linha do banco (colunas dinâmicas, tipadas como `unknown`) na forma exibida
 * pelo comando `history`. Interpolar `unknown` direto em template literal produz "[object
 * Object]" quando a coluna não é escalar, então a conversão é explícita.
 */
function toScanSummary(row: Record<string, unknown>): ScanSummary {
  const text = (value: unknown): string => {
    if (value === null || value === undefined) return "-";
    if (typeof value === "object") return value instanceof Date ? value.toISOString() : JSON.stringify(value);
    return `${value as string | number | boolean}`;
  };
  return {
    id: text(row.id),
    createdAt: text(row.created_at),
    codeDir: text(row.code_dir),
    docsDir: text(row.docs_dir),
    codeEndpoints: text(row.total_code_endpoints),
    docEndpoints: text(row.total_doc_endpoints),
    codeEnvVars: text(row.total_code_env_vars),
    docEnvVars: text(row.total_doc_env_vars),
  };
}

/**
 * Reconstrói um `ScanReport` a partir das linhas persistidas. A cobertura é recalculada pela
 * mesma função usada pelo motor de drift — antes havia uma segunda implementação da fórmula
 * aqui na CLI, que precisaria ser mantida em sincronia com a original manualmente.
 */
function toReport(result: { scan: Record<string, unknown>; findings: DriftFinding[] }): ScanReport {
  const totalCodeEndpoints = Number(result.scan.total_code_endpoints);
  const totalCodeEnvVars = Number(result.scan.total_code_env_vars);
  return {
    createdAt: String(result.scan.created_at),
    codeDir: String(result.scan.code_dir),
    docsDir: String(result.scan.docs_dir),
    totalCodeEndpoints,
    totalDocEndpoints: Number(result.scan.total_doc_endpoints),
    totalCodeEnvVars,
    totalDocEnvVars: Number(result.scan.total_doc_env_vars),
    findings: result.findings,
    coverageScore: calculateCoverageScore(totalCodeEndpoints + totalCodeEnvVars, result.findings),
  };
}

async function emitReport(report: ScanReport, format: ReportFormat, outFile?: string): Promise<void> {
  const output = exportReport(report, format);
  if (outFile) {
    await writeFile(outFile, output, "utf-8");
    console.error(`Relatório (${format}) escrito em ${outFile}`);
  } else {
    console.log(output);
  }
}

program.parseAsync(process.argv).catch(async (err) => {
  console.error("Erro:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
  // Sem isso, uma falha depois de o pool ter sido aberto mantém o processo vivo por conta das
  // conexões ociosas, e o exit code nunca chega a ser observado por quem chamou a CLI.
  await closePool().catch(() => {});
});
