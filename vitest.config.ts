import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // O CLI é um adaptador fino sobre `runScan`, exercitado manualmente e pelo smoke test do
      // CI; o núcleo (parsers, motor, persistência, API) entra no gate.
      exclude: ["src/cli/**"],
      // Gate por catraca: subir conforme a cobertura sobe, nunca descer. Os valores ficam um
      // pouco abaixo do atual para tolerar variação de execução sem virar teatro.
      thresholds: {
        lines: 88,
        functions: 88,
        branches: 76,
        statements: 86,
      },
    },
  },
});
