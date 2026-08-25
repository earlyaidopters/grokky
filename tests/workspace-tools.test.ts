import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { executeWorkspaceTool, resolveWorkspacePath } from "../src/main/workspace-tools";

describe("workspace tools", () => {
  test("rejects traversal and credential files", () => {
    expect(() => resolveWorkspacePath("/tmp/work", "../outside.txt")).toThrow(/leaves/);
    expect(() => resolveWorkspacePath("/tmp/work", ".env.local")).toThrow(/Credential/);
    expect(() => resolveWorkspacePath("/tmp/work", "secrets/private.pem")).toThrow(/Credential/);
  });

  test("creates and uniquely edits a workspace file", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-tools-"));
    await executeWorkspaceTool({ root, mode: "workspace-write", allowCommands: false, name: "create_file", args: { path: "notes.txt", content: "alpha beta" } });
    await executeWorkspaceTool({ root, mode: "workspace-write", allowCommands: false, name: "edit_file", args: { path: "notes.txt", old_text: "beta", new_text: "gamma" } });
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("alpha gamma");
  });

  test("keeps write tools off in read-only mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-tools-"));
    await writeFile(join(root, "notes.txt"), "hello");
    await expect(executeWorkspaceTool({ root, mode: "read-only", allowCommands: false, name: "edit_file", args: { path: "notes.txt", old_text: "hello", new_text: "bye" } })).rejects.toThrow(/read-only/);
  });

  test("blocks unapproved commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-tools-"));
    await expect(executeWorkspaceTool({ root, mode: "workspace-write", allowCommands: false, name: "run_command", args: { command: "pwd" } })).rejects.toThrow(/disabled/);
    await expect(executeWorkspaceTool({ root, mode: "workspace-write", allowCommands: true, name: "run_command", args: { command: "curl https://example.com" } })).rejects.toThrow(/allowlist|blocked/);
  });
});
