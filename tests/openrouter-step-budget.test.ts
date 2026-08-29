import { beforeEach, describe, expect, test, vi } from "vitest";
import { defaultComputerAccess } from "../src/main/state-store";
import type { ProviderEvent } from "../src/main/providers/types";
import type { AppSettings, Conversation } from "../src/shared/contracts";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@openrouter/sdk", () => ({
  OpenRouter: class {
    chat = { send: mocks.send };
  },
}));

import { runOpenRouter } from "../src/main/providers/openrouter-provider";

beforeEach(() => mocks.send.mockReset());

describe("OpenRouter bounded tool runs", () => {
  test("forces a tools-disabled final answer after the default action budget", async () => {
    for (let index = 0; index < 12; index += 1) {
      mocks.send.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            toolCalls: [{ id: `call-${index}`, type: "function", function: { name: "list_files", arguments: "{}" } }],
          },
        }],
      });
    }
    mocks.send.mockResolvedValueOnce({ choices: [{ message: { content: "The bounded run completed with an honest final answer." } }] });

    const now = Date.now();
    const conversation: Conversation = {
      id: "step-budget-test", title: "Step budget", instructions: "", provider: "openrouter", model: "test/model", reasoning: "low",
      sandboxMode: "read-only", allowCommands: false, projectMode: "project", workingDirectory: "/tmp/grokky-step-budget",
      messages: [], queuedMessages: [], activities: [], selectedAgentIds: [], agentRuns: [], crewCommunications: [],
      status: "running", unreadCount: 0, lastViewedAt: now, createdAt: now, updatedAt: now,
    };
    const settings: AppSettings = {
      defaultWorkingDirectory: conversation.workingDirectory, recentWorkingDirectories: [], openRouterCredentialPath: "", theme: "dark",
      multiAgentEnabled: false, maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "",
      interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: false,
    };
    const events: ProviderEvent[] = [];

    await runOpenRouter({
      conversation,
      settings,
      agents: [],
      prompt: "Inspect the workspace until the bounded action budget is exhausted.",
      images: [],
      readImageDataUrl: async () => { throw new Error("No image fixture is configured"); },
      signal: new AbortController().signal,
      computerAccess: defaultComputerAccess(),
      approvedBrowserOrigins: [],
      executeTool: async () => ({ output: "tool completed" }),
      onEvent: (event) => { events.push(event); },
      apiKey: "test-key",
    });

    expect(mocks.send).toHaveBeenCalledTimes(13);
    const finalRequest = mocks.send.mock.calls[12]?.[0]?.chatRequest;
    expect(finalRequest).toMatchObject({ toolChoice: "none" });
    expect(finalRequest.tools).toBeUndefined();
    expect(finalRequest.messages.at(-1)?.content).toContain("Do not call any more tools");
    expect(events.findLast((event) => event.type === "final")).toEqual({
      type: "final",
      text: "The bounded run completed with an honest final answer.",
    });
  });
});
