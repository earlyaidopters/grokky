import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCodex } from "../src/main/providers/codex-provider";
import type { ProviderEvent } from "../src/main/providers/types";
import type { AppSettings, Conversation } from "../src/shared/contracts";
import { computerProviderContext } from "./provider-fixtures";

const live = process.env.GROKKY_LIVE_CODEX_WEB === "1";

describe.skipIf(!live)("live Codex web search", () => {
  test("performs a real web search and returns the consulted official source", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grokky-codex-web-"));
    const now = Date.now();
    const conversation: Conversation = {
      id: "codex-web-smoke",
      title: "Codex web smoke",
      provider: "codex",
      model: process.env.GROKKY_CODEX_SMOKE_MODEL || "gpt-5.6-luna",
      reasoning: "low",
      sandboxMode: "read-only",
      allowCommands: false,
      workingDirectory: workspace,
      messages: [],
      activities: [],
      selectedAgentIds: [],
      agentRuns: [],
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    const settings: AppSettings = {
      defaultWorkingDirectory: workspace,
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
    await runCodex({
      conversation,
      settings,
      agents: [],
      prompt: "Use live web search to find the official OpenAI GPT-5.6 Sol model page. Return its developers.openai.com URL and state whether that page lists Web search as supported.",
      signal: new AbortController().signal,
      ...computerProviderContext(conversation),
      onEvent: async (event) => { events.push(event); },
    });

    expect(events.some((event) => event.type === "activity" && event.activity.label === "Web search")).toBe(true);
    const final = events.find((event) => event.type === "final");
    const text = final?.type === "final" ? final.text : "";
    expect(text).toContain("developers.openai.com");
    expect(text.toLowerCase()).toContain("web search");
  }, 180_000);
});
