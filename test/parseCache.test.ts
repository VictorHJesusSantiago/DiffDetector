import { afterEach, describe, expect, it } from "vitest";
import { unlink } from "node:fs/promises";
import { parseCodeDirectory } from "../src/parsers/codeParser.js";
import { ParseCache } from "../src/core/parseCache.js";

const CACHE_PATH = "test/.tmp-drift-cache.json";

afterEach(async () => {
  await unlink(CACHE_PATH).catch(() => {});
});

describe("ParseCache", () => {
  it("reaproveita fatos de arquivos não modificados entre duas chamadas", async () => {
    const cache1 = new ParseCache(CACHE_PATH);
    await cache1.load();
    const first = await parseCodeDirectory("test/fixtures/code", cache1);
    await cache1.save();
    expect(cache1.misses).toBeGreaterThan(0);
    expect(cache1.hits).toBe(0);

    const cache2 = new ParseCache(CACHE_PATH);
    await cache2.load();
    const second = await parseCodeDirectory("test/fixtures/code", cache2);
    await cache2.save();

    expect(cache2.hits).toBeGreaterThan(0);
    expect(second.endpoints).toEqual(first.endpoints);
    expect(second.envVars).toEqual(first.envVars);
  });
});
