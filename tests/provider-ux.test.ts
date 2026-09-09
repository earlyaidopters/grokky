import { beforeEach, expect, test, vi } from "vitest";
import { agentsForRun } from "../src/main/agent-selection";
import { requiresDevelopmentCommands, requiresProjectDirectory, requestsAgentDelegation, requestsBrowserWorkflow } from "../src/shared/run-preflight";
import type { AgentDefinition, AppSettings, Conversation } from "../src/shared/contracts";
import type { ProviderEvent } from "../src/main/providers/types";
import { computerProviderContext } from "./provider-fixtures";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@openrouter/sdk", () => ({ OpenRouter: class { chat = { send: mocks.send }; } }));
import { runOpenRouter, shouldRunSeparateWebResearch } from "../src/main/providers/openrouter-provider";

export const conversation: Conversation = {
  id: "ux", title: "Provider UX", instructions: "", provider: "openrouter", model: "openai/gpt-5.2", reasoning: "low",
  sandboxMode: "read-only", allowCommands: false, projectMode: "none", workingDirectory: "/tmp", messages: [], queuedMessages: [],
  activities: [], selectedAgentIds: [], agentRuns: [], crewCommunications: [], status: "running", unreadCount: 0, lastViewedAt: 1, createdAt: 1, updatedAt: 1,
};
export const settings: AppSettings = { defaultWorkingDirectory: "/tmp", recentWorkingDirectories: [], openRouterCredentialPath: "", theme: "dark", multiAgentEnabled: true, maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: false };
const catalog: AgentDefinition[] = [
  { id: "a", name: "explorer", description: "Explore ideas", developerInstructions: "Offer ideas", scope: "built-in", builtIn: true },
  { id: "b", name: "tester", description: "Test assumptions", developerInstructions: "Check assumptions", scope: "personal", builtIn: false },
  { id: "c", name: "gardener", description: "Gardening clubs", developerInstructions: "Suggest a club name", scope: "personal", builtIn: false },
];
beforeEach(() => mocks.send.mockReset());

test("agent requests do not demand a project or development commands", () => {
  const prompt = "Please spin up two agents to name a fictional gardening club. This is text-only: do not use files, commands, browser, web search, or external tools.";
  expect(requiresDevelopmentCommands(prompt)).toBe(false);
  expect(requiresProjectDirectory(prompt)).toBe(false);
  expect(requestsAgentDelegation(prompt)).toBe(true);
  expect(requestsBrowserWorkflow(prompt)).toBe(false);
  expect(shouldRunSeparateWebResearch(prompt, true, true)).toBe(false);
  expect(requestsBrowserWorkflow("Do not use files, but use the browser to inspect this page.")).toBe(true);
  expect(requiresDevelopmentCommands("Spin up the server")).toBe(true);
  expect(requestsAgentDelegation("Do not spawn agents.")).toBe(false);
});

test("per-run discovery respects explicit picks, global disable, native selection and thread limits", () => {
  const prompt = "Spin up two agents including gardener to name a gardening club";
  expect(agentsForRun(catalog, conversation, settings, prompt).map((a) => a.name)).toEqual(["gardener", "explorer"]);
  expect(agentsForRun(catalog, { ...conversation, selectedAgentIds: ["b"] }, settings, prompt).map((a) => a.id)).toEqual(["b"]);
  expect(agentsForRun(catalog, conversation, { ...settings, multiAgentEnabled: false }, prompt)).toEqual([]);
  expect(agentsForRun(catalog, { ...conversation, provider: "codex" }, settings, prompt)).toEqual([]);
  expect(agentsForRun(catalog, conversation, settings, "Explain what agents are")).toEqual([]);
  expect(agentsForRun(catalog, conversation, settings, "Ask gardener to suggest a club name")[0]?.name).toBe("gardener");
  expect(agentsForRun(catalog, conversation, settings, "Do not ask gardener to do this")).toEqual([]);
  expect(conversation.selectedAgentIds).toEqual([]);
});

const answer = (content: string) => ({ choices: [{ message: { content } }] });
const delegate = (agent: string) => ({ choices: [{ message: { content: "", toolCalls: [{ id: agent, type: "function", function: { name: "delegate_to_agent", arguments: JSON.stringify({ agent, task: "Suggest one club name", constraints: "Text only", expecting: "One name" }) } }] } }] });

test("strict OpenRouter model can delegate twice and attribute both reports", async () => {
  mocks.send.mockResolvedValueOnce(delegate("explorer"))
    .mockResolvedValueOnce(answer("Green Shoots"))
    .mockResolvedValueOnce(delegate("tester"))
    .mockResolvedValueOnce(answer("Seed Society"))
    .mockResolvedValueOnce(answer("The agents proposed Green Shoots and Seed Society."));
  const events: ProviderEvent[] = [];
  await runOpenRouter({ conversation, settings, agents: catalog.slice(0, 2), prompt: "Spin up two agents to suggest names. Do not use files, commands, browser, web search, or external tools.", signal: new AbortController().signal, apiKey: "fixture", ...computerProviderContext(conversation), onEvent: (event) => { events.push(event); } });
  const request = mocks.send.mock.calls[0]![0].chatRequest;
  const tool = request.tools.find((tool: any) => tool.function.name === "delegate_to_agent");
  expect(tool.function.strict).toBe(true);
  expect(tool.function.parameters.required.sort()).toEqual(Object.keys(tool.function.parameters.properties).sort());
  expect(JSON.stringify(request.messages)).not.toContain("This is an end-to-end interactive browser task");
  const orchestration = events.filter((event) => event.type === "orchestration");
  expect(orchestration).toHaveLength(4);
  expect(JSON.stringify(orchestration)).toContain("Green Shoots");
  expect(JSON.stringify(orchestration)).toContain("Seed Society");
  expect(events.filter((event) => event.type === "final")).toHaveLength(1);
});

test("a negative browser request finishes without a fabricated browser completion gate", async () => {
  mocks.send.mockResolvedValueOnce(answer("Seed Society"));
  const browser = computerProviderContext(conversation);
  browser.computerAccess.remoteDevices.push({ id: "cloud-ux", name: "Cloud", platform: "cloudflare-linux", endpoint: "https://sandbox.example.com", root: "/workspace", encryptedToken: "fixture", capabilities: ["browser", "screen", "automation"], lastSeenAt: Date.now(), revoked: false, protocolVersion: 2, browserTools: ["inspect_page", "click_element", "fill_field"] });
  browser.computerAccess.activeDeviceId = "cloud-ux";
  const events: ProviderEvent[] = [];
  await runOpenRouter({ conversation, settings, agents: [], prompt: "Suggest a gardening club name. Do not use files, commands, browser, web search, or external tools.", signal: new AbortController().signal, apiKey: "fixture", ...browser, onEvent: (event) => { events.push(event); } });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mocks.send.mock.calls[0]![0])).not.toContain("complete_browser_task");
  expect(events.some((event) => event.type === "final" && event.text === "Seed Society")).toBe(true);
});
