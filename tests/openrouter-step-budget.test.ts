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

  test("uses semantic recovery feedback and a completion gate for interactive browser tasks", async () => {
    const ref = "el-abcdefgh12345678";
    for (let index = 0; index < 2; index += 1) {
      mocks.send.mockResolvedValueOnce({
        choices: [{ message: { content: "", toolCalls: [{ id: `browser-${index}`, type: "function", function: { name: "click_element", arguments: JSON.stringify({ ref }) } }] } }],
      });
    }
    mocks.send.mockResolvedValueOnce({
      choices: [{ message: { content: "", toolCalls: [{ id: "gate", type: "function", function: { name: "complete_browser_task", arguments: JSON.stringify({ status: "blocked", summary: "The date control did not advance.", evidence: ["Two semantic clicks produced no page change."] }) } }] } }],
    });
    mocks.send.mockResolvedValueOnce({ choices: [{ message: { content: "I could not complete the date selection; the control remained unchanged after recovery." } }] });

    const now = Date.now();
    const conversation: Conversation = {
      id: "semantic-browser-budget", title: "Semantic browser", instructions: "", provider: "openrouter", model: "test/model", reasoning: "low",
      sandboxMode: "workspace-write", allowCommands: false, projectMode: "project", workingDirectory: "/tmp/grokky-semantic-browser",
      messages: [], queuedMessages: [], activities: [], selectedAgentIds: [], agentRuns: [], crewCommunications: [],
      agentComputers: [{ agentId: "grokky-lead", agentName: "Grokky lead", deviceId: "sandbox-semantic-v2" }] as Conversation["agentComputers"],
      status: "running", unreadCount: 0, lastViewedAt: now, createdAt: now, updatedAt: now,
    };
    const settings: AppSettings = {
      defaultWorkingDirectory: conversation.workingDirectory, recentWorkingDirectories: [], openRouterCredentialPath: "", theme: "dark",
      multiAgentEnabled: false, maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "",
      interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: false,
    };
    const computerAccess = defaultComputerAccess();
    computerAccess.remoteDevices.push({
      id: "sandbox-semantic-v2", name: "Cloud browser", platform: "cloudflare-linux", endpoint: "https://sandbox.example.com", root: "/workspace",
      encryptedToken: "sealed", capabilities: ["browser", "screen", "automation"], lastSeenAt: now, revoked: false, protocolVersion: 2,
      browserTools: ["inspect_page", "click_element", "fill_field", "press_key", "select_option", "scroll_page", "wait_for"],
    });
    computerAccess.activeDeviceId = "sandbox-semantic-v2";
    const executed: string[] = [];
    let finalText = "";

    await runOpenRouter({
      conversation, settings, agents: [], prompt: "Use the browser and click the date picker end to end.", images: [],
      readImageDataUrl: async () => { throw new Error("No image fixture is configured"); }, signal: new AbortController().signal,
      computerAccess, approvedBrowserOrigins: [], apiKey: "test-key", onEvent: (event) => { if (event.type === "final") finalText = event.text; },
      executeTool: async (name) => {
        executed.push(name);
        return {
          output: "The semantic click had no effect.",
          browserObservation: {
            snapshotId: "page-1234567890abcdef", fingerprint: "a".repeat(64), url: "https://example.com/flights", title: "Flights",
            viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0, maxY: 1200 }, dialogs: 0, elements: [], visibleText: "Choose dates", truncated: false,
          },
          browserOutcome: {
            effect: "no_effect", beforeFingerprint: "a".repeat(64), afterFingerprint: "a".repeat(64), changes: ["No observable page change"],
          },
        };
      },
    });

    expect(finalText).toContain("could not complete");
    expect(executed).toEqual(["click_element", "click_element"]);
    const recoveryRequest = mocks.send.mock.calls[2]?.[0]?.chatRequest;
    expect(JSON.stringify(recoveryRequest.messages)).toContain("exact action repeated without progress");
    expect(recoveryRequest.tools.map((tool: { function?: { name?: string } }) => tool.function?.name)).toContain("complete_browser_task");
  });

  test("rejects a premature browser final until current-page evidence is gated", async () => {
    mocks.send.mockResolvedValueOnce({ choices: [{ message: { content: "Done." } }] });
    mocks.send.mockResolvedValueOnce({ choices: [{ message: { content: "", toolCalls: [{ id: "inspect", type: "function", function: { name: "inspect_page", arguments: "{}" } }] } }] });
    mocks.send.mockResolvedValueOnce({ choices: [{ message: { content: "", toolCalls: [{ id: "complete", type: "function", function: { name: "complete_browser_task", arguments: JSON.stringify({ status: "complete", summary: "Results are visible.", evidence: ["The current page shows the requested result list."] }) } }] } }] });
    mocks.send.mockResolvedValueOnce({ choices: [{ message: { content: "The requested result list is now visible and verified." } }] });

    const now = Date.now();
    const conversation = {
      id: "completion-gate-test", title: "Completion gate", instructions: "", provider: "openrouter", model: "test/model", reasoning: "low",
      sandboxMode: "workspace-write", allowCommands: false, projectMode: "project", workingDirectory: "/tmp/grokky-gate", messages: [], queuedMessages: [], activities: [],
      selectedAgentIds: [], agentRuns: [], crewCommunications: [], agentComputers: [{ agentId: "grokky-lead", agentName: "Grokky lead", deviceId: "sandbox-gate-v2" }] as Conversation["agentComputers"],
      status: "running", unreadCount: 0, lastViewedAt: now, createdAt: now, updatedAt: now,
    } as Conversation;
    const settings = {
      defaultWorkingDirectory: conversation.workingDirectory, recentWorkingDirectories: [], openRouterCredentialPath: "", theme: "dark", multiAgentEnabled: false,
      maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: false,
    } as AppSettings;
    const computerAccess = defaultComputerAccess();
    computerAccess.remoteDevices.push({
      id: "sandbox-gate-v2", name: "Cloud browser", platform: "cloudflare-linux", endpoint: "https://sandbox.example.com", root: "/workspace", encryptedToken: "sealed",
      capabilities: ["browser", "automation"], lastSeenAt: now, revoked: false, protocolVersion: 2, browserTools: ["inspect_page", "click_element", "fill_field"],
    });
    computerAccess.activeDeviceId = "sandbox-gate-v2";
    let finalText = "";
    await runOpenRouter({
      conversation, settings, agents: [], prompt: "Use the browser to navigate to the result page.", images: [], apiKey: "test-key", computerAccess,
      approvedBrowserOrigins: [], signal: new AbortController().signal, onEvent: (event) => { if (event.type === "final") finalText = event.text; }, readImageDataUrl: async () => "",
      executeTool: async () => ({
        output: "Current results page inspected.",
        browserObservation: { snapshotId: "page-fedcba0987654321", fingerprint: "b".repeat(64), url: "https://example.com/results", title: "Results", viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0, maxY: 0 }, dialogs: 0, elements: [], visibleText: "Results", truncated: false },
        browserOutcome: { effect: "already_satisfied", beforeFingerprint: "b".repeat(64), afterFingerprint: "b".repeat(64), changes: ["Requested result is already visible"] },
      }),
    });
    expect(finalText).toContain("verified");
    expect(mocks.send).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(mocks.send.mock.calls[1]?.[0]?.chatRequest.messages)).toContain("not gated yet");
  });
});
