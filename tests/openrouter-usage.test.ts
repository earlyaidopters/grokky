import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runOpenRouter } from "../src/main/providers/openrouter-provider";
import type { ProviderEvent } from "../src/main/providers/types";
import type { AppSettings, Conversation } from "../src/shared/contracts";
import { computerProviderContext } from "./provider-fixtures";

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter usage accounting", () => {
  test("emits billable web-research usage when citation verification fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grokky-openrouter-usage-"));
    const now = Date.now();
    const conversation: Conversation = {
      id: "usage-test", title: "Usage test", instructions: "", provider: "openrouter", model: "test/model", reasoning: "low",
      sandboxMode: "read-only", allowCommands: false, projectMode: "project", workingDirectory: workspace,
      messages: [], queuedMessages: [], activities: [], selectedAgentIds: [], agentRuns: [], crewCommunications: [],
      status: "running", unreadCount: 0, lastViewedAt: now, createdAt: now, updatedAt: now,
    };
    const settings: AppSettings = {
      defaultWorkingDirectory: workspace, recentWorkingDirectories: [workspace], openRouterCredentialPath: "", theme: "dark",
      multiAgentEnabled: false, maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "",
      interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: true,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Unverified result", annotations: [] } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.01, server_tool_use_details: { web_search_requests: 1 } },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const events: ProviderEvent[] = [];

    await expect(runOpenRouter({
      conversation, settings, agents: [], prompt: "Search the current web for the source", signal: new AbortController().signal,
      apiKey: "test-key", ...computerProviderContext(conversation), onEvent: (event) => { events.push(event); },
    })).rejects.toThrow(/no auditable web search/i);

    expect(events.findLast((event) => event.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 20, outputTokens: 6, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0.02 },
    });
  });
});
