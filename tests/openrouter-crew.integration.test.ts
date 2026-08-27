import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultOpenRouterCredentialCandidates, isUsableOpenRouterKey, parseEnvValue } from "../src/main/credentials";
import { runOpenRouter } from "../src/main/providers/openrouter-provider";
import type { AgentDefinition, AppSettings, Conversation } from "../src/shared/contracts";
import type { ProviderEvent } from "../src/main/providers/types";
import { computerProviderContext } from "./provider-fixtures";

const live = process.env.GROKKY_LIVE_OPENROUTER_CREW === "1";

async function credential(): Promise<string> {
  const candidates = defaultOpenRouterCredentialCandidates(homedir());
  if (isUsableOpenRouterKey(process.env.OPENROUTER_API_KEY)) return process.env.OPENROUTER_API_KEY;
  for (const pathname of candidates) {
    const key = await readFile(pathname, "utf8").then((source) => parseEnvValue(source, "OPENROUTER_API_KEY")).catch(() => undefined);
    if (isUsableOpenRouterKey(key)) return key;
  }
  throw new Error("No OpenRouter credential found");
}

describe.skipIf(!live)("live OpenRouter crew", () => {
  test("runs two selected specialists and consolidates their results", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grokky-openrouter-crew-"));
    await writeFile(join(workspace, "README.md"), "The two verification words are kiwi and mango.\n");
    const now = Date.now();
    const conversation: Conversation = {
      id: "crew-smoke",
      title: "Crew smoke",
      instructions: "",
      provider: "openrouter",
      model: process.env.GROKKY_OPENROUTER_SMOKE_MODEL || "google/gemini-3.1-flash-lite",
      reasoning: "low",
      sandboxMode: "read-only",
      allowCommands: false,
      projectMode: "project",
      workingDirectory: workspace,
      messages: [{ id: "user", role: "user", content: "Read README.md", createdAt: now, provider: "openrouter" }],
      queuedMessages: [],
      activities: [],
      selectedAgentIds: ["a", "b"],
      agentRuns: [],
      crewCommunications: [],
      status: "running",
      unreadCount: 0,
      lastViewedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const agents: AgentDefinition[] = [
      { id: "a", name: "word_scout", description: "Reads the requested file and reports its words.", developerInstructions: "Use read_file and report the exact two words.", scope: "project", builtIn: false, sandboxMode: "read-only" },
      { id: "b", name: "fact_checker", description: "Checks a scout's result against workspace evidence.", developerInstructions: "Read the evidence yourself and report the exact two words.", scope: "project", builtIn: false, sandboxMode: "read-only" },
    ];
    const settings: AppSettings = { defaultWorkingDirectory: workspace, recentWorkingDirectories: [workspace], openRouterCredentialPath: "", theme: "dark", multiAgentEnabled: true, maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, connectorsEnabled: true, webSearchEnabled: false };
    const events: ProviderEvent[] = [];
    await runOpenRouter({
      conversation,
      settings,
      agents,
      prompt: "Read README.md and reply with a concise sentence containing both verification words.",
      signal: new AbortController().signal,
      apiKey: await credential(),
      ...computerProviderContext(conversation),
      onEvent: async (event) => { events.push(event); },
    });
    const orchestration = events.filter((event) => event.type === "orchestration");
    expect(orchestration).toHaveLength(4);
    expect(JSON.stringify(orchestration)).toContain("word_scout");
    expect(JSON.stringify(orchestration)).toContain("fact_checker");
    const final = events.find((event) => event.type === "final");
    expect(final?.type === "final" ? final.text.toLowerCase() : "").toContain("kiwi");
    expect(final?.type === "final" ? final.text.toLowerCase() : "").toContain("mango");
  }, 180_000);
});
