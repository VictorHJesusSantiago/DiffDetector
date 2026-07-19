import express from "express";
import "dotenv/config";
import { runScan } from "../core/scanner.js";
import { saveScan, getLatestScan, getScanHistory, getScanById } from "../db/repository.js";
import { migrate } from "../db/migrate.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Dispara um novo scan comparando um diretório de código com um diretório de docs,
// persiste o resultado e retorna o relatório com o diff em relação ao scan anterior.
app.post("/scans", async (req, res) => {
  const { codeDir, docsDir } = req.body ?? {};
  if (typeof codeDir !== "string" || typeof docsDir !== "string") {
    res.status(400).json({ error: "codeDir e docsDir são obrigatórios (strings)." });
    return;
  }

  try {
    const report = await runScan({ codeDir, docsDir });
    await migrate();
    const result = await saveScan(report);
    res.status(201).json({
      scanId: result.scanId,
      report,
      newFindings: result.newFindings,
      resolvedFindings: result.resolvedFindings,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Erro desconhecido" });
  }
});

app.get("/scans", async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  try {
    const scans = await getScanHistory(limit);
    res.json({ scans });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Erro desconhecido" });
  }
});

app.get("/scans/latest", async (_req, res) => {
  try {
    const result = await getLatestScan();
    if (!result) {
      res.status(404).json({ error: "Nenhum scan encontrado." });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Erro desconhecido" });
  }
});

app.get("/scans/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "id inválido" });
    return;
  }
  try {
    const result = await getScanById(id);
    if (!result) {
      res.status(404).json({ error: "Scan não encontrado." });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Erro desconhecido" });
  }
});

const PORT = Number(process.env.PORT ?? 3000);

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  app.listen(PORT, () => {
    console.log(`Doc Drift Detector API rodando em http://localhost:${PORT}`);
  });
}

export default app;
