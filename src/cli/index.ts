#!/usr/bin/env node
import { watch } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { Command } from "commander";
import { runScan } from "../core/scanner.js";
import { saveScan, getLatestScan, getScanHistory, getScanById, getScanHistoryWithOpenFindingsCount } from "../db/repository.js";
import { migrate } from "../db/migrate.js";
import { closePool } from "../db/pool.js";
import { exportReport, type ReportFormat } from "../core/exporters.js";
import { diffFindings } from "../core/scanDiff.js";
import { generateDocStub } from "../core/stubGenerator.js";
import { generatePreCommitHook } from "../core/hookGenerator.js";
import { loadWorkspace } from "../core/workspace.js";
import { generateDashboardHtml, type DashboardScanRow } from "../core/dashboard.js";
import type { DriftFinding, ScanReport } from "../core/types.js";

const program = new Command();

program
  .name("drift")
  .description("Detector de drift entre documentação e sistema real (código/infraestrutura).");

function addScanOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--code <dir>", "Diretório raiz do código-fonte")
    .requiredOption("--docs <dir>", "Diretório raiz da documentação (README/runbooks/wiki em Markdown)")
    .option("--no-save", "Não persistir o resultado no banco de dados")
    .option("--fail-on-drift", "Sai com código de erro 1 se houver qualquer drift encontrado")
    .option("--format <formato>", "text|json|markdown|html|csv|junit", "text")
    .option("--out <arquivo>", "Escreve o relatório formatado em um arquivo em vez de stdout")
    .option("--verbose", "Mostra quais arquivos foram escaneados e detalhes de execução")
    .option("--cache", "Usa cache de parsing por arquivo (.drift-cache.json) para acelerar scans repetidos")
    .option("--no-extra-sources", "Desliga parsers extras (.env.example, OpenAPI, Dockerfile/compose)")
    .option("--config <arquivo>", "Caminho do drift.config.json", "drift.config.json")
    .option("--ignore-file <arquivo>", "Caminho do drift-ignore.json", "drift-ignore.json");
}

addScanOptions(program.command("scan"))
  .description("Executa um scan comparando código e documentação, imprime o relatório e persiste no Postgres.")
  .action(async (opts) => {
    if (opts.verbose) console.error(`[verbose] escaneando código em "${opts.code}" e docs em "${opts.docs}"...`);

    const report = await runScan({
      codeDir: opts.code,
      docsDir: opts.docs,
      useExtraSources: opts.extraSources !== false,
      useCache: !!opts.cache,
      configPath: opts.config,
      ignorePath: opts.ignoreFile,
    });

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
  .action(async (opts) => {
    console.error(`Observando "${opts.code}" e "${opts.docs}"... (Ctrl+C para sair)`);

    let running = false;
    let pending = false;

    const runOnce = async () => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        const report = await runScan({
          codeDir: opts.code,
          docsDir: opts.docs,
          useExtraSources: opts.extraSources !== false,
          useCache: !!opts.cache,
          configPath: opts.config,
          ignorePath: opts.ignoreFile,
        });
        console.clear();
        await emitReport(report, opts.format, opts.out);
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
      debounce = setTimeout(runOnce, 300);
    };

    watch(opts.code, { recursive: true }, trigger);
    watch(opts.docs, { recursive: true }, trigger);
  });

program
  .command("scan-workspace")
  .description("Roda um scan para cada par codeDir/docsDir descrito em um arquivo de workspace (monorepos).")
  .requiredOption("--workspace <arquivo>", "Caminho do drift.workspace.json")
  .option("--format <formato>", "text|json|markdown|html|csv|junit", "text")
  .option("--fail-on-drift", "Sai com código de erro 1 se qualquer projeto tiver drift")
  .action(async (opts) => {
    const workspace = await loadWorkspace(opts.workspace);
    let anyDrift = false;
    for (const project of workspace.projects) {
      console.error(`\n### Projeto: ${project.name} ###`);
      const report = await runScan({ codeDir: project.codeDir, docsDir: project.docsDir });
      console.log(exportReport(report, opts.format as ReportFormat));
      if (report.findings.length > 0) anyDrift = true;
    }
    if (opts.failOnDrift && anyDrift) process.exitCode = 1;
  });

program
  .command("stub")
  .description("Gera um stub de Markdown com os endpoints/env vars ainda não documentados.")
  .requiredOption("--code <dir>", "Diretório raiz do código-fonte")
  .requiredOption("--docs <dir>", "Diretório raiz da documentação")
  .action(async (opts) => {
    const report = await runScan({ codeDir: opts.code, docsDir: opts.docs });
    console.log(generateDocStub(report.findings));
  });

program
  .command("init-hook")
  .description("Gera um hook de pre-commit local (.git/hooks/pre-commit) que bloqueia commits com drift.")
  .requiredOption("--code <dir>", "Diretório raiz do código-fonte")
  .requiredOption("--docs <dir>", "Diretório raiz da documentação")
  .option("--git-dir <dir>", "Caminho do diretório .git", ".git")
  .action(async (opts) => {
    const script = generatePreCommitHook(opts.code, opts.docs);
    const hookPath = `${opts.gitDir}/hooks/pre-commit`;
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
  .argument("<scanIdA>", "id do scan mais antigo")
  .argument("<scanIdB>", "id do scan mais novo")
  .action(async (scanIdA, scanIdB) => {
    try {
      const [a, b] = await Promise.all([getScanById(Number(scanIdA)), getScanById(Number(scanIdB))]);
      if (!a || !b) {
        console.error("Um dos scans informados não foi encontrado.");
        process.exitCode = 1;
        return;
      }
      const diff = diffFindings(a.findings, b.findings);
      console.log(`Diff entre scan #${scanIdA} e scan #${scanIdB}`);
      console.log(`\n+ Novos (${diff.added.length}):`);
      for (const f of diff.added) console.log(`  [${f.severity}] ${f.type} — ${f.subject}`);
      console.log(`\n- Resolvidos/desaparecidos (${diff.removed.length}):`);
      for (const f of diff.removed) console.log(`  [${f.severity}] ${f.type} — ${f.subject}`);
      console.log(`\n= Inalterados (${diff.unchanged.length})`);
    } finally {
      await closePool();
    }
  });

program
  .command("dashboard")
  .description("Gera um dashboard HTML estático (local, sem servidor) com o histórico de achados abertos por scan.")
  .option("--out <arquivo>", "Arquivo de saída", "drift-dashboard.html")
  .option("--limit <n>", "Quantidade de scans a incluir", "100")
  .action(async (opts) => {
    try {
      const rows = (await getScanHistoryWithOpenFindingsCount(Number(opts.limit))) as unknown as DashboardScanRow[];
      const html = generateDashboardHtml(rows);
      await writeFile(opts.out, html, "utf-8");
      console.log(`Dashboard escrito em ${opts.out} (abra diretamente no navegador).`);
    } finally {
      await closePool();
    }
  });

program
  .command("history")
  .description("Lista o histórico de scans salvos no banco de dados.")
  .option("--limit <n>", "Quantidade de scans a listar", "20")
  .action(async (opts) => {
    try {
      const scans = await getScanHistory(Number(opts.limit));
      if (scans.length === 0) {
        console.log("Nenhum scan encontrado.");
        return;
      }
      for (const scan of scans) {
        console.log(
          `#${scan.id} | ${scan.created_at} | código=${scan.code_dir} docs=${scan.docs_dir} | endpoints(code/doc)=${scan.total_code_endpoints}/${scan.total_doc_endpoints} env(code/doc)=${scan.total_code_env_vars}/${scan.total_doc_env_vars}`,
        );
      }
    } finally {
      await closePool();
    }
  });

program
  .command("latest")
  .description("Mostra o relatório do último scan salvo no banco de dados.")
  .option("--format <formato>", "text|json|markdown|html|csv|junit", "text")
  .action(async (opts) => {
    try {
      const result = await getLatestScan();
      if (!result) {
        console.log("Nenhum scan encontrado. Rode `drift scan` primeiro.");
        return;
      }
      const pseudoReport: ScanReport = {
        createdAt: String(result.scan.created_at),
        codeDir: String(result.scan.code_dir),
        docsDir: String(result.scan.docs_dir),
        totalCodeEndpoints: Number(result.scan.total_code_endpoints),
        totalDocEndpoints: Number(result.scan.total_doc_endpoints),
        totalCodeEnvVars: Number(result.scan.total_code_env_vars),
        totalDocEnvVars: Number(result.scan.total_doc_env_vars),
        findings: result.findings as unknown as DriftFinding[],
        coverageScore: computeCoverageFromRow(result),
      };
      console.log(exportReport(pseudoReport, opts.format as ReportFormat));
    } finally {
      await closePool();
    }
  });

function computeCoverageFromRow(result: { scan: Record<string, unknown>; findings: { type: string }[] }): number {
  const total = Number(result.scan.total_code_endpoints) + Number(result.scan.total_code_env_vars);
  if (total === 0) return 100;
  const undocumented = result.findings.filter(
    (f) => f.type === "ENDPOINT_NAO_DOCUMENTADO" || f.type === "ENV_VAR_NAO_DOCUMENTADA",
  ).length;
  return Math.round(((total - undocumented) / total) * 100);
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

program.parseAsync(process.argv).catch((err) => {
  console.error("Erro:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
