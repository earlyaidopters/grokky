import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { packagedCodexCandidate } from "../src/main/providers/codex-provider";

describe("packaged Codex runtime", () => {
  test("resolves the Apple Silicon executable", () => {
    expect(packagedCodexCandidate("/app/resources", "darwin", "arm64")).toBe(join(
      "/app/resources",
      "app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
    ));
  });

  test("resolves the Windows x64 executable", () => {
    expect(packagedCodexCandidate("C:\\app\\resources", "win32", "x64")).toBe(join(
      "C:\\app\\resources",
      "app.asar.unpacked/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    ));
  });

  test("rejects unsupported platforms and architectures", () => {
    expect(packagedCodexCandidate("/app/resources", "linux", "x64")).toBeUndefined();
    expect(packagedCodexCandidate("/app/resources", "darwin", "ia32")).toBeUndefined();
  });
});
