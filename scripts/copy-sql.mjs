import { cp, mkdir } from "node:fs/promises";

/**
 * Copia os arquivos .sql para dist/. O tsc só emite JavaScript: sem este passo, `dist/db/
 * migrations/` não existe e o binário publicado (`drift scan` com persistência) falha ao
 * tentar ler as migrações — falha que não aparecia em desenvolvimento porque `npm run cli`
 * executa `src/` via tsx.
 */
await mkdir("dist/db/migrations", { recursive: true });
await cp("src/db/migrations", "dist/db/migrations", { recursive: true });
console.log("SQL copiado para dist/db/migrations");
