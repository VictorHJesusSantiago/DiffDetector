import { describe, expect, it } from "vitest";
import { levenshteinDistance } from "../src/core/levenshtein.js";

describe("levenshteinDistance", () => {
  it("retorna 0 para strings iguais", () => {
    expect(levenshteinDistance("/users/:id", "/users/:id")).toBe(0);
  });

  it("calcula a distância de edição corretamente", () => {
    expect(levenshteinDistance("/users/:id", "/user/:id")).toBe(1);
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });
});
