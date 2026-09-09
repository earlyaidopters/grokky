import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
afterEach(() => vi.unstubAllGlobals());

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


test.each([
  "spin up agents to reserah the best apple mac mini right now",
  "Research Apple Mac mini models",
  "reserah Apple Mac mini models",
  "Recommend a computer for video editing",
  "Compare the best web browsers",
  "Research current Macs. Do not use your computer.",
  "Search the web for Mac mini reviews",
])("routes ordinary research to web search: %s", (prompt) => {
  expect(shouldRunSeparateWebResearch(prompt, true, true)).toBe(true);
});

function researchFixture() {
  const browser = computerProviderContext(conversation);
  browser.computerAccess.enabled = true;
  browser.computerAccess.grants = { files: "allow", commands: "allow", browser: "allow", screen: "allow", automation: "allow", external: "allow" };
  const executeTool = vi.fn(async () => ({ output: "Page opened", browserObservation: undefined }));
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Verified Mac comparison: [Apple](https://www.apple.com/mac-mini/).", annotations: [{ type: "url_citation", url_citation: { url: "https://www.apple.com/mac-mini/", title: "Apple Mac mini" } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.01, server_tool_use_details: { web_search_requests: 1 } },
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const events: ProviderEvent[] = [];
  return { ...browser, executeTool, fetch, events, onEvent: (event: ProviderEvent) => { events.push(event); } };
}
const browseCall = { choices: [{ message: { content: "", toolCalls: [{ id: "browse", type: "function", function: { name: "browse_url", arguments: JSON.stringify({ url: "https://www.apple.com/mac-mini/" }) } }] } }] };

test("ordinary delegated research shares audited sources and blocks a specialist's unrequested computer call", async () => {
  const fixture = researchFixture();
  const delegation = delegate("explorer");
  delegation.choices[0]!.message.toolCalls[0]!.function.arguments = JSON.stringify({ agent: "explorer", task: "Use your computer to open Apple's website and compare Mac mini models", constraints: "Use live research", expecting: "A cited comparison" });
  mocks.send.mockResolvedValueOnce(delegation).mockResolvedValueOnce(browseCall)
    .mockResolvedValueOnce(answer("Verified Mac comparison: [Apple](https://www.apple.com/mac-mini/)."))
    .mockResolvedValueOnce(answer("The explorer compared the models using [Apple](https://www.apple.com/mac-mini/)."));
  await runOpenRouter({ conversation, settings: { ...settings, webSearchEnabled: true }, agents: catalog.slice(0, 1), prompt: "spin up agents to reserah the best apple mac mini right now", signal: new AbortController().signal, apiKey: "fixture", ...fixture });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(fixture.executeTool).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledTimes(4);
  for (const [request] of mocks.send.mock.calls) {
    expect((request.chatRequest.tools ?? []).map((tool: any) => tool.function?.name)).not.toEqual(expect.arrayContaining(["browse_url"]));
    expect(JSON.stringify(request.chatRequest.messages)).toContain("https://www.apple.com/mac-mini/");
    expect(JSON.stringify(request.chatRequest.messages)).not.toContain("This is an end-to-end interactive browser task");
  }
  expect(JSON.stringify(mocks.send.mock.calls[2]![0].chatRequest.messages)).toContain("Computer use is unavailable for this research request");
  expect(fixture.events.some(e => e.type === "orchestration" && e.event.tool === "wait" && e.event.status === "completed")).toBe(true);
});

test.each(["browse_url", "capture_screen", "run_command"])("disabling search does not replace research with %s", async (name) => {
  const fixture = researchFixture();
  const attempted = structuredClone(browseCall);
  attempted.choices[0]!.message.toolCalls[0]!.function.name = name;
  mocks.send.mockResolvedValueOnce(attempted).mockResolvedValueOnce(answer("Enable web search for current sources."));
  await runOpenRouter({ conversation: { ...conversation, sandboxMode: "workspace-write", allowCommands: true }, settings, agents: [], prompt: "Research the best computer right now", signal: new AbortController().signal, apiKey: "fixture", ...fixture });
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(fixture.executeTool).not.toHaveBeenCalled();
  expect(mocks.send.mock.calls[0]![0].chatRequest.tools.map((tool: any) => tool.function?.name)).not.toContain(name);
  expect(JSON.stringify(mocks.send.mock.calls[1]![0].chatRequest.messages)).toContain("Computer use is unavailable for this research request");
});

test("explicit computer research still executes browser tools without a separate web search", async () => {
  const fixture = researchFixture();
  mocks.send.mockResolvedValueOnce(browseCall).mockResolvedValueOnce(answer("Opened Apple's page."));
  await runOpenRouter({ conversation, settings: { ...settings, webSearchEnabled: true }, agents: [], prompt: "Use your computer to research Apple's current Mac mini on its website", signal: new AbortController().signal, apiKey: "fixture", ...fixture });
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(fixture.executeTool).toHaveBeenCalledTimes(1);
  expect(fixture.executeTool.mock.calls[0]).toEqual(expect.arrayContaining(["browse_url"]));
});

test("failed web research stops with an error instead of opening the cloud browser", async () => {
  const fixture = researchFixture();
  fixture.fetch.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Search unavailable" } }), { status: 503 }));
  await expect(runOpenRouter({ conversation, settings: { ...settings, webSearchEnabled: true }, agents: catalog, prompt: "Research Mac mini models", signal: new AbortController().signal, apiKey: "fixture", ...fixture })).rejects.toThrow("Search unavailable");
  expect(fixture.executeTool).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});


test.each(["Compare these two paragraphs", "Suggest the best name for a fictional gardening club", "Tell me a story", "Do not use browser or web search"])("does not turn text-only work into live research: %s", (prompt) => {
  expect(shouldRunSeparateWebResearch(prompt, true, true)).toBe(false);
});
