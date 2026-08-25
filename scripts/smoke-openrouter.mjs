import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenRouter } from "@openrouter/sdk";

function parseKey(source) {
  for (const rawLine of source.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value;
  }
}

const candidates = [
  process.env.GROKKY_OPENROUTER_ENV_FILE,
  join(homedir(), ".config", "grokky", ".env"),
].filter(Boolean);
const usable = (value) => typeof value === "string" && /^sk-or-v1-[A-Za-z0-9_-]{24,}$/.test(value.trim()) && !/replace|example|your[_-]?key/i.test(value);
let apiKey = usable(process.env.OPENROUTER_API_KEY) ? process.env.OPENROUTER_API_KEY : undefined;
for (const pathname of candidates) {
  if (apiKey) break;
  const candidate = await readFile(pathname, "utf8").then(parseKey).catch(() => undefined);
  if (usable(candidate)) apiKey = candidate;
}
if (!apiKey) throw new Error("No OpenRouter credential was found for the smoke test");

const client = new OpenRouter({ apiKey, appTitle: "Grokky smoke test", timeoutMs: 120_000 });
const response = await client.chat.send({
  chatRequest: {
    model: process.env.GROKKY_OPENROUTER_SMOKE_MODEL || "google/gemini-3.1-flash-lite",
    messages: [{ role: "user", content: "Reply with exactly: grokky-openrouter-ok" }],
    stream: false,
    maxCompletionTokens: 64,
  },
}, { timeoutMs: 120_000, headers: { Authorization: `Bearer ${apiKey}` } });
const answer = response.choices[0]?.message.content;
if (typeof answer !== "string" || answer.trim() !== "grokky-openrouter-ok") throw new Error(`Unexpected OpenRouter smoke response: ${String(answer || "<empty>")}`);
console.log("grokky-openrouter-ok");
