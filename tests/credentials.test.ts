import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { defaultOpenRouterCredentialCandidates, isUsableOpenRouterKey, parseEnvValue } from "../src/main/credentials";

describe("credential parsing", () => {
  test("reads a quoted OpenRouter key without returning adjacent values", () => {
    const source = [
      "# local settings",
      "OTHER_KEY=not-this-one",
      "export OPENROUTER_API_KEY=\"sk-or-v1-test-value\"",
      "TRAILING=value",
    ].join("\n");
    expect(parseEnvValue(source, "OPENROUTER_API_KEY")).toBe("sk-or-v1-test-value");
  });

  test("ignores comments and missing values", () => {
    expect(parseEnvValue("# OPENROUTER_API_KEY=nope\nOTHER=1", "OPENROUTER_API_KEY")).toBeUndefined();
  });

  test("rejects inherited placeholder keys", () => {
    expect(isUsableOpenRouterKey("sk-or-REPLACE_ME")).toBe(false);
    expect(isUsableOpenRouterKey(`sk-or-v1-${"a".repeat(40)}`)).toBe(true);
  });

  test("uses portable default credential locations", () => {
    const previous = process.env.GROKKY_OPENROUTER_ENV_FILE;
    delete process.env.GROKKY_OPENROUTER_ENV_FILE;
    try {
      expect(defaultOpenRouterCredentialCandidates("/home/example")).toEqual([
        join("/home/example", ".config", "grokky", ".env"),
      ]);
    } finally {
      if (previous === undefined) delete process.env.GROKKY_OPENROUTER_ENV_FILE;
      else process.env.GROKKY_OPENROUTER_ENV_FILE = previous;
    }
  });
});
