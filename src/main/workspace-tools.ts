import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SandboxMode } from "../shared/contracts";

const excludedDirectories = new Set([".git", "node_modules", "out", "release", "dist", "build", ".next", ".vinext"]);
const blockedNames = /^(?:\.env(?:\..*)?|auth\.json|credentials?(?:\..*)?|\.npmrc|\.netrc|id_[^.]+(?:\.pub)?)$/i;
const blockedExtensions = /\.(?:pem|key|p12|pfx)$/i;

function assertSafeName(pathname: string): void {
  const parts = pathname.split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => excludedDirectories.has(part))) throw new Error("That path is excluded from the workspace tools");
  if (parts.some((part) => blockedNames.test(part) || blockedExtensions.test(part))) {
    throw new Error("Credential and private-key files are never exposed to model tools");
  }
}

export function resolveWorkspacePath(root: string, pathname: string): string {
  if (!root) throw new Error("Choose a working directory first");
  if (!pathname || isAbsolute(pathname)) throw new Error("Tool paths must be relative to the workspace");
  assertSafeName(pathname);
  const target = resolve(root, pathname);
  const fromRoot = relative(resolve(root), target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("Path leaves the selected workspace");
  return target;
}

async function assertRegularFile(pathname: string): Promise<void> {
  const info = await lstat(pathname);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Only regular workspace files can be read or edited");
}

async function readableFiles(root: string, limit: number): Promise<string[]> {
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("The selected workspace is not a directory");
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (output.length >= limit) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (output.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      if (blockedNames.test(entry.name) || blockedExtensions.test(entry.name)) continue;
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) output.push(relative(root, fullPath));
    }
  }
  await visit(root);
  return output;
}

async function listFiles(root: string): Promise<string> {
  const output = await readableFiles(root, 240);
  return output.length ? output.join("\n") : "No readable files found.";
}

async function searchFiles(root: string, query: string): Promise<string> {
  if (!query || query.length > 500) throw new Error("Search query must be between 1 and 500 characters");
  const matches: string[] = [];
  for (const pathname of await readableFiles(root, 2_000)) {
    if (matches.length >= 60) break;
    const target = resolve(root, pathname);
    const info = await stat(target);
    if (info.size > 2_000_000) continue;
    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!line.includes(query)) continue;
      matches.push(`${pathname}:${index + 1}:${line.slice(0, 500)}`);
      if (matches.length >= 60) break;
    }
  }
  return matches.length ? matches.join("\n") : "No matches.";
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-40_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || (command === "rg" && code === 1)) resolvePromise(output.trim() || "No matches.");
      else reject(new Error(output.trim() || `${command} exited with status ${code ?? "unknown"}`));
    });
  });
}

function requireWrite(mode: SandboxMode): void {
  if (mode !== "workspace-write") throw new Error("This conversation is read-only");
}

const commandPrefixes = [
  "npm test", "npm run ", "npm exec ", "npx vitest", "node --test", "git status", "git diff", "git log", "rg ", "ls", "pwd", "find ",
];
const unsafeCommandText = /(?:^|\s)(?:rm|sudo|curl|wget|ssh|scp|nc|osascript|open|kill|launchctl)(?:\s|$)|[;&|<>`]|\$\(/;

function matchesCommandPrefix(command: string, prefix: string): boolean {
  return prefix.endsWith(" ")
    ? command.startsWith(prefix)
    : command === prefix || command.startsWith(`${prefix} `);
}

async function runAllowedCommand(root: string, command: string): Promise<string> {
  const trimmed = command.trim();
  if (!commandPrefixes.some((prefix) => matchesCommandPrefix(trimmed, prefix))) {
    throw new Error("Command is outside Grokky's allowlist");
  }
  if (unsafeCommandText.test(trimmed)) throw new Error("Shell operators, network commands, deletion, and system control are blocked");
  if (trimmed === "pwd") return resolve(root);
  if (process.platform === "win32") {
    return runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", trimmed], root, 120_000);
  }
  const shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  return runProcess(shell, ["-lc", trimmed], root, 120_000);
}

export type WorkspaceToolName = "list_files" | "search_files" | "read_file" | "create_file" | "edit_file" | "run_command";

export async function executeWorkspaceTool(options: {
  root: string;
  mode: SandboxMode;
  allowCommands: boolean;
  name: WorkspaceToolName;
  args: Record<string, unknown>;
}): Promise<string> {
  const { root, mode, allowCommands, name, args } = options;
  if (name === "list_files") return listFiles(root);
  if (name === "search_files") return searchFiles(root, String(args.query ?? ""));
  if (name === "read_file") {
    const target = resolveWorkspacePath(root, String(args.path ?? ""));
    await assertRegularFile(target);
    const content = await readFile(target, "utf8");
    return content.length > 100_000 ? `${content.slice(0, 100_000)}\n[truncated]` : content;
  }
  if (name === "create_file") {
    requireWrite(mode);
    const target = resolveWorkspacePath(root, String(args.path ?? ""));
    const content = String(args.content ?? "");
    if (content.length > 200_000) throw new Error("File content is too large");
    try {
      await lstat(target);
      throw new Error("File already exists; use edit_file instead");
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) throw error;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx" });
    return `Created ${relative(root, target)}`;
  }
  if (name === "edit_file") {
    requireWrite(mode);
    const target = resolveWorkspacePath(root, String(args.path ?? ""));
    await assertRegularFile(target);
    const before = String(args.old_text ?? "");
    const after = String(args.new_text ?? "");
    if (!before) throw new Error("old_text cannot be empty");
    const content = await readFile(target, "utf8");
    const first = content.indexOf(before);
    if (first < 0) throw new Error("old_text was not found");
    if (content.indexOf(before, first + before.length) >= 0) throw new Error("old_text is not unique; include more context");
    await writeFile(target, `${content.slice(0, first)}${after}${content.slice(first + before.length)}`);
    return `Updated ${relative(root, target)}`;
  }
  if (name === "run_command") {
    requireWrite(mode);
    if (!allowCommands) throw new Error("Commands are disabled for this conversation");
    return runAllowedCommand(root, String(args.command ?? ""));
  }
  throw new Error(`Unknown workspace tool: ${basename(name)}`);
}
