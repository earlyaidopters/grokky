import { expect, test, vi } from "vitest";
import { HandoffGate } from "../src/main/handoff-gate";
import { defaultComputerAccess } from "../src/main/state-store";
import type { AppSettings, Conversation } from "../src/shared/contracts";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@openrouter/sdk", () => ({ OpenRouter: class { chat = { send: mocks.send }; } }));
import { runOpenRouter } from "../src/main/providers/openrouter-provider";

test("discards a model response across takeover and requires new observation before input", async () => {
  const gate = new HandoffGate();
  const response = (name: string, args = {}) => ({ choices: [{ message: { content: "", toolCalls: [{ id: name + mocks.send.mock.calls.length, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  mocks.send.mockImplementationOnce(async () => {
    await gate.takeover(); await gate.resume("Keep my selection");
    return response("click_element", { ref: "el-oldreference123" });
  });
  mocks.send.mockImplementationOnce(async () => response("click_element", { ref: "el-oldreference123" }));
  mocks.send.mockImplementationOnce(async () => response("inspect_page"));
  mocks.send.mockImplementationOnce(async () => response("click_element", { ref: "el-newreference123" }));
  mocks.send.mockImplementationOnce(async () => response("complete_browser_task", { status: "complete", summary: "Selection retained", evidence: ["Current page confirms the selected option"] }));
  mocks.send.mockResolvedValueOnce({ choices: [{ message: { content: "Your selection is retained." } }] });
  const now = Date.now();
  const conversation = { id: "handoff-provider", title: "Handoff", instructions: "", provider: "openrouter", model: "test/model", reasoning: "low", sandboxMode: "workspace-write", allowCommands: false, projectMode: "project", workingDirectory: "/tmp/grokky-handoff", messages: [], queuedMessages: [], activities: [], selectedAgentIds: [], agentRuns: [], crewCommunications: [], agentComputers: [{ agentId: "grokky-lead", agentName: "Grokky lead", deviceId: "cloud-handoff", id: "seat-handoff", conversationId: "handoff-provider", role: "lead", status: "working", isolation: "cloud-browser", deviceName: "Cloud", workspaceRoot: "/workspace", actions: [], evidence: [], createdAt: now, updatedAt: now }], status: "running", unreadCount: 0, lastViewedAt: now, createdAt: now, updatedAt: now } as Conversation;
  const settings = { defaultWorkingDirectory: conversation.workingDirectory, recentWorkingDirectories: [], openRouterCredentialPath: "", theme: "dark", multiAgentEnabled: false, maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: false } as AppSettings;
  const computerAccess = defaultComputerAccess();
  computerAccess.remoteDevices.push({ id: "cloud-handoff", name: "Cloud", platform: "cloudflare-linux", endpoint: "https://sandbox.example.com", root: "/workspace", encryptedToken: "sealed", capabilities: ["browser", "screen", "automation"], lastSeenAt: now, revoked: false, protocolVersion: 2, browserTools: ["inspect_page", "click_element", "fill_field"] });
  computerAccess.activeDeviceId = "cloud-handoff";
  const executed: string[] = [];
  const requests: string[] = [];
  let final = "";
  await runOpenRouter({ conversation, settings, agents: [], prompt: "Use the browser to click the selected option.", images: [], readImageDataUrl: async () => "", signal: new AbortController().signal, computerAccess, approvedBrowserOrigins: [], apiKey: "test-key", controlCheckpoint: () => gate.checkpoint(), onEvent: (event) => { if (event.type === "final") final = event.text; }, executeTool: async (name, args) => {
    executed.push(name); requests.push(JSON.stringify(args));
    return { output: "Selection confirmed", browserObservation: { snapshotId: "page-1234567890abcdef", fingerprint: "a".repeat(64), url: "https://example.com/options", title: "Options", viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0, maxY: 0 }, dialogs: 0, elements: [], visibleText: "Selection confirmed", truncated: false }, browserOutcome: { effect: "changed", beforeFingerprint: "b".repeat(64), afterFingerprint: "a".repeat(64), changes: ["Selection confirmed"] } };
  } });
  expect(executed).toEqual(["inspect_page", "click_element"]);
  expect(requests.join()).not.toContain("oldreference");
  expect(final).toBe("Your selection is retained.");
  expect(mocks.send).toHaveBeenCalledTimes(6);
  expect(JSON.stringify(mocks.send.mock.calls[1]?.[0]?.chatRequest.messages)).toContain("Keep my selection");
});
