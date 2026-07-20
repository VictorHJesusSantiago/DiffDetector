import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, closePool } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  const sql = await readFile(join(__dirname, "schema.sql"), "utf-8");
  await pool.query(sql);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  migrate()
    .then(() => {
      console.log("Migração concluída com sucesso.");
    })
    .catch((err) => {
      console.error("Falha na migração:", err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
