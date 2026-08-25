import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_WRITING_STYLE_RULE } from "../src/main/writing-style";

const sourceExtensions = new Set([".css", ".html", ".ts", ".tsx"]);
const forbiddenPunctuation = String.fromCodePoint(0x2014);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const pathname = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(pathname);
    const dot = entry.name.lastIndexOf(".");
    return sourceExtensions.has(dot >= 0 ? entry.name.slice(dot) : "") ? [pathname] : [];
  }));
  return nested.flat();
}

describe("product writing style", () => {
  it("tells generated prose to avoid em dashes without rewriting literal text", () => {
    expect(PRODUCT_WRITING_STYLE_RULE).toContain("Do not use em dashes in prose");
    expect(PRODUCT_WRITING_STYLE_RULE).toContain("exact quotations, code, URLs, file contents");
  });

  it("keeps authored application source free of literal em dashes", async () => {
    const root = resolve("src");
    const offenders: string[] = [];
    for (const pathname of await sourceFiles(root)) {
      if ((await readFile(pathname, "utf8")).includes(forbiddenPunctuation)) {
        offenders.push(pathname.slice(root.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
