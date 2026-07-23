import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Configuração com informação de tipos (`projectService`): sem ela, as regras que de fato
 * pegam bugs — `no-floating-promises`, `no-misused-promises`, `await-thenable` — não podem
 * funcionar, porque dependem de saber o que é uma Promise. Foi exatamente uma promise solta
 * (`setTimeout(runOnce, 300)` no comando `watch`) que derrubava o processo.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "test/fixtures/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.test.json, e não tsconfig.json: o primeiro inclui `test/`, que o segundo
        // exclui. Lintar apenas `src/` deixaria a suíte de testes sem nenhuma checagem.
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-floating-promises": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Falhar alto é uma convenção deste repositório: um catch que descarta o erro precisa
      // dizer por escrito por que aquele caso é normal.
      "no-empty": ["error", { allowEmptyCatch: false }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Os arquivos de configuração e os scripts de build não fazem parte do programa TypeScript.
    files: ["eslint.config.js", "vitest.config.ts", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Preserva o `parserOptions` de disableTypeChecked (que desliga o projeto de tipos) e
      // apenas acrescenta os globais do Node — sobrescrever o objeto inteiro reativaria a
      // exigência de projeto e voltaria a dar erro de parsing nestes arquivos.
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { console: "readonly", process: "readonly" },
    },
  },
);
