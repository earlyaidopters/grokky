import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultOpenRouterCredentialCandidates, isUsableOpenRouterKey, parseEnvValue } from "../src/main/credentials";
import { agentsForRun } from "../src/main/agent-selection";
import { runCodex } from "../src/main/providers/codex-provider";
import { runOpenRouter } from "../src/main/providers/openrouter-provider";
import type { ProviderEvent } from "../src/main/providers/types";
import type { AgentDefinition, AppSettings, Conversation, ProviderId } from "../src/shared/contracts";
import { computerProviderContext } from "./provider-fixtures";

async function credential(): Promise<string> {
  if (isUsableOpenRouterKey(process.env.OPENROUTER_API_KEY)) return process.env.OPENROUTER_API_KEY;
  for (const pathname of [process.env.GROKKY_OPENROUTER_CREDENTIAL_PATH, ...defaultOpenRouterCredentialCandidates(homedir())].filter((value): value is string => Boolean(value))) {
    const key = await readFile(pathname, "utf8").then((source) => parseEnvValue(source, "OPENROUTER_API_KEY")).catch(() => undefined);
    if (isUsableOpenRouterKey(key)) return key;
  }
  throw new Error("No OpenRouter credential found");
}

describe.skipIf(process.env.GROKKY_LIVE_PROVIDER_UX !== "1")("live conversational delegation with no picker selection", () => {
  test.each<ProviderId>(["openrouter", "codex"])("%s starts two agents and returns two attributed reports", async (provider) => {
    const workspace = await mkdtemp(join(tmpdir(), "grokky-provider-ux-"));
    const conversation: Conversation = {
      id: `ux-${provider}`, title: "Provider UX smoke", instructions: "", provider,
      model: provider === "codex" ? "gpt-5.6-sol" : "openai/gpt-5.2", reasoning: "low",
      sandboxMode: "read-only", allowCommands: false, projectMode: "none", workingDirectory: workspace,
      messages: [], queuedMessages: [], activities: [], selectedAgentIds: [], agentRuns: [], crewCommunications: [],
      status: "running", unreadCount: 0, lastViewedAt: 1, createdAt: 1, updatedAt: 1,
    };
    const settings: AppSettings = { defaultWorkingDirectory: workspace, recentWorkingDirectories: [], openRouterCredentialPath: "", theme: "dark", multiAgentEnabled: true, maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: false };
    const catalog: AgentDefinition[] = [
      { id: "a", name: "explorer", description: "Suggest creative names", developerInstructions: "Return one short fictional gardening club name", scope: "built-in", builtIn: true },
      { id: "b", name: "worker", description: "Independently suggest another name", developerInstructions: "Return one short fictional gardening club name", scope: "built-in", builtIn: true },
    ];
    const prompt = "Please spin up two agents to independently suggest one name each for a fictional gardening club. Wait for both and attribute each suggestion. This is text-only: do not use files, commands, browser, web search, or external tools.";
    const events: ProviderEvent[] = [];
    const start = Date.now();
    const context = { conversation, settings, agents: agentsForRun(catalog, conversation, settings, prompt), prompt, signal: new AbortController().signal, ...computerProviderContext(conversation), onEvent: (event: ProviderEvent) => { events.push(event); } };
    if (provider === "codex") await runCodex(context);
    else await runOpenRouter({ ...context, apiKey: await credential() });
    const orchestration = events.flatMap((event) => event.type === "orchestration" ? [event.event] : []);
    const reports = orchestration.flatMap((event) => event.receiverThreads).filter((thread) => thread.status === "completed");
    const final = events.find((event) => event.type === "final");
    const evidence = { provider, model: conversation.model, elapsedMs: Date.now() - start, selectedAgentIds: conversation.selectedAgentIds, orchestration, final: final?.type === "final" ? final.text : "" };
    await mkdir("output/provider-ux-2026-09-08", { recursive: true });
    await writeFile(`output/provider-ux-2026-09-08/${provider}.json`, JSON.stringify(evidence, null, 2));
    expect(new Set(reports.map((thread) => thread.threadId)).size).toBeGreaterThanOrEqual(2);
    expect(final?.type === "final" ? final.text.length : 0).toBeGreaterThan(10);
    expect(conversation.selectedAgentIds).toEqual([]);
  }, 240_000);
});

describe.skipIf(process.env.GROKKY_LIVE_PROPOSAL_UX !== "1")("live reviewed one-time role", () => {
  test.each<ProviderId>(["openrouter", "codex"])("%s runs the reviewed custom role and receives its report", async (provider) => {
    const { proposalFromRequest } = await import("../src/shared/agent-proposals");
    const workspace = await mkdtemp(join(tmpdir(), "grokky-role-ux-"));
    const proposal = proposalFromRequest("Create a new interface specialist named interface_reviewer", [], "live-role-fixture");
    const agent: AgentDefinition = { ...proposal.draft, developerInstructions: "Suggest one clear accessible label for a button that opens application settings. Use only supplied text. Report to the lead.", id: `task:${proposal.id}`, builtIn: false };
    const conversation: Conversation = {
      id: `role-${provider}`, title: "Reviewed role smoke", instructions: "", provider,
      model: provider === "codex" ? "gpt-5.6-sol" : "openai/gpt-5.2", reasoning: "low", sandboxMode: "read-only",
      allowCommands: false, projectMode: "none", workingDirectory: workspace, messages: [], queuedMessages: [], activities: [],
      selectedAgentIds: [agent.id], pendingAgent: agent, agentRuns: [], crewCommunications: [], status: "running",
      unreadCount: 0, lastViewedAt: 1, createdAt: 1, updatedAt: 1,
    };
    const settings: AppSettings = { defaultWorkingDirectory: workspace, recentWorkingDirectories: [], openRouterCredentialPath: "", theme: "dark", multiAgentEnabled: true, maxAgentThreads: 1, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: false };
    const events: ProviderEvent[] = [];
    const prompt = "Delegate to the selected interface_reviewer to suggest one clear label for a button that opens application settings. Wait for its report, then attribute the suggestion. Do not use files, commands, browser, web search, or external tools.";
    const context = { conversation, settings, agents: agentsForRun([agent], conversation, settings, prompt), prompt, signal: AbortSignal.timeout(180_000), ...computerProviderContext(conversation), onEvent: (event: ProviderEvent) => { events.push(event); } };
    const start = Date.now();
    if (provider === "codex") await runCodex(context); else await runOpenRouter({ ...context, apiKey: await credential() });
    const orchestration = events.flatMap(event => event.type === "orchestration" ? [event.event] : []);
    const reports = orchestration.flatMap(event => event.receiverThreads).filter(thread => thread.status === "completed");
    const final = events.find(event => event.type === "final");
    await mkdir("output/provider-proposal-0.1.7", { recursive: true });
    await writeFile(`output/provider-proposal-0.1.7/${provider}.json`, JSON.stringify({ provider, model: conversation.model, elapsedMs: Date.now() - start, orchestration, final: final?.type === "final" ? final.text : "" }, null, 2));
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(orchestration)).toContain("interface_reviewer");
    expect(final?.type === "final" ? final.text.length : 0).toBeGreaterThan(5);
  }, 200_000);
});
