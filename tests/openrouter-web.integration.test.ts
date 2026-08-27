import { readFile, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultOpenRouterCredentialCandidates, isUsableOpenRouterKey, parseEnvValue } from "../src/main/credentials";
import { runOpenRouter } from "../src/main/providers/openrouter-provider";
import type { ProviderEvent } from "../src/main/providers/types";
import type { AppSettings, Conversation } from "../src/shared/contracts";
import { computerProviderContext } from "./provider-fixtures";

const live = process.env.GROKKY_LIVE_OPENROUTER_WEB === "1";

async function credential(): Promise<string> {
  const candidates = defaultOpenRouterCredentialCandidates(homedir());
  if (isUsableOpenRouterKey(process.env.OPENROUTER_API_KEY)) return process.env.OPENROUTER_API_KEY;
  for (const pathname of candidates) {
    const key = await readFile(pathname, "utf8").then((source) => parseEnvValue(source, "OPENROUTER_API_KEY")).catch(() => undefined);
    if (isUsableOpenRouterKey(key)) return key;
  }
  throw new Error("No OpenRouter credential found");
}

describe.skipIf(!live)("live OpenRouter web search", () => {
  test("uses the server tool and returns the consulted official source", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grokky-openrouter-web-"));
    const now = Date.now();
    const conversation: Conversation = {
      id: "openrouter-web-smoke",
      title: "OpenRouter web smoke",
      instructions: "",
      provider: "openrouter",
      model: process.env.GROKKY_OPENROUTER_SMOKE_MODEL || "google/gemini-3.1-flash-lite",
      reasoning: "low",
      sandboxMode: "read-only",
      allowCommands: false,
      projectMode: "project",
      workingDirectory: workspace,
      messages: [],
      queuedMessages: [],
      activities: [],
      selectedAgentIds: [],
      agentRuns: [],
      crewCommunications: [],
      status: "running",
      unreadCount: 0,
      lastViewedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const settings: AppSettings = {
      defaultWorkingDirectory: workspace,
      recentWorkingDirectories: [workspace],
      openRouterCredentialPath: "",
      theme: "dark",
      multiAgentEnabled: false,
      maxAgentThreads: 2,
      defaultSubagentModel: "",
      defaultSubagentReasoning: "",
      interruptAgentMessage: true,
      connectorsEnabled: false,
      webSearchEnabled: true,
    };
    const events: ProviderEvent[] = [];
    await runOpenRouter({
      conversation,
      settings,
      agents: [],
      prompt: "Use live web search to find the official OpenAI GPT-5.6 Sol model page. Return its developers.openai.com URL and state whether that page lists Web search as supported.",
      signal: new AbortController().signal,
      apiKey: await credential(),
      ...computerProviderContext(conversation),
      onEvent: async (event) => { events.push(event); },
    });

    if (process.env.GROKKY_DEBUG_EVENTS === "1") console.log(JSON.stringify(events, null, 2));

    expect(events.some((event) => event.type === "activity" && event.activity.label.startsWith("Live web search"))).toBe(true);
    const final = events.find((event) => event.type === "final");
    const text = final?.type === "final" ? final.text : "";
    expect(text).toContain("developers.openai.com");
    expect(text.toLowerCase()).toContain("web search");
  }, 180_000);
});
