import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatMessage } from "../shared/contracts";

const browserIntent = /\b(?:browser|browse|navigate|visit|website|web\s?page|site|open\s+(?:the\s+)?(?:page|link|url)|go\s+to|check\s+(?:the\s+)?site)\b/i;
const urlCandidate = /https?:\/\/[^\s<>"']+/gi;
const safeThreadId = /^[a-zA-Z0-9-]{8,100}$/;

function trimUrlCandidate(value: string): string {
  return value.replace(/[),.;!?\]}]+$/g, "");
}

function originsIn(text: string): string[] {
  const origins: string[] = [];
  for (const match of text.matchAll(urlCandidate)) {
    try {
      const url = new URL(trimUrlCandidate(match[0]));
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      origins.push(url.origin);
    } catch {
      // Ignore malformed URL-like text. The browser runtime will validate the final target too.
    }
  }
  return origins;
}

export function browserOriginsForRequest(prompt: string, messages: ChatMessage[]): string[] {
  if (!browserIntent.test(prompt)) return [];
  const current = originsIn(prompt);
  const historical = current.length
    ? []
    : messages.slice(-12).reverse().flatMap((message) => originsIn(message.content));
  return [...new Set([...current, ...historical])].slice(0, 8);
}

interface BrowserOriginState {
  allowed: string[];
  denied: string[];
}

function parseTomlArray(source: string, key: "allowed" | "denied"): string[] {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*(\\[[^\\n]*\\])\\s*$`, "m"));
  if (!match) return [];
  try {
    const value = JSON.parse(match[1]!) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseOriginState(source: string): BrowserOriginState {
  return {
    allowed: parseTomlArray(source, "allowed"),
    denied: parseTomlArray(source, "denied"),
  };
}

function renderOriginState(state: BrowserOriginState): string {
  const lines = ["[origins]"];
  if (state.allowed.length) lines.push(`allowed = ${JSON.stringify(state.allowed)}`);
  if (state.denied.length) lines.push(`denied = ${JSON.stringify(state.denied)}`);
  return `${lines.join("\n")}\n`;
}

export async function allowBrowserOriginsForThread(
  threadId: string,
  origins: string[],
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
): Promise<void> {
  if (!safeThreadId.test(threadId)) throw new Error("Invalid Codex thread ID");
  const approved = [...new Set(origins.map((origin) => new URL(origin).origin))].sort();
  if (!approved.length) return;
  const pathname = join(codexHome, "browser", "sessions", `${threadId}.toml`);
  let existing = "";
  try {
    existing = await readFile(pathname, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const state = parseOriginState(existing);
  const allowed = [...new Set([...state.allowed, ...approved])].sort();
  const denied = state.denied.filter((origin) => !approved.includes(origin)).sort();
  if (JSON.stringify(allowed) === JSON.stringify([...state.allowed].sort())
    && JSON.stringify(denied) === JSON.stringify([...state.denied].sort())) return;
  await mkdir(dirname(pathname), { recursive: true });
  const temporary = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, renderOriginState({ allowed, denied }), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, pathname);
}
