import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCodex } from "../src/main/providers/codex-provider";
import type { ProviderEvent } from "../src/main/providers/types";
import type { AgentDefinition, AppSettings, Conversation } from "../src/shared/contracts";
import { computerProviderContext } from "./provider-fixtures";

const live = process.env.GROKKY_LIVE_CODEX_PROVIDER === "1";

describe.skipIf(!live)("live Codex provider crew", () => {
  test("emits named child-thread states and one final coordinator answer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grokky-codex-provider-"));
    await writeFile(join(workspace, "README.md"), "The provider verification phrase is silver otter.\n");
    const now = Date.now();
    const conversation: Conversation = {
      id: "codex-provider-smoke",
      title: "Codex provider smoke",
      provider: "codex",
      model: process.env.GROKKY_CODEX_SMOKE_MODEL || "gpt-5.6-luna",
      reasoning: "low",
      sandboxMode: "read-only",
      allowCommands: false,
      workingDirectory: workspace,
      messages: [],
      activities: [],
      selectedAgentIds: ["builtin:explorer", "builtin:worker"],
      agentRuns: [],
      crewCommunications: [],
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    const agents: AgentDefinition[] = [
      { id: "builtin:explorer", name: "explorer", description: "Read the requested evidence.", developerInstructions: "Read only and report exact evidence.", scope: "built-in", builtIn: true, sandboxMode: "read-only" },
      { id: "builtin:worker", name: "worker", description: "Independently verify the requested evidence.", developerInstructions: "Read only and report exact evidence.", scope: "built-in", builtIn: true, sandboxMode: "read-only" },
    ];
    const settings: AppSettings = { defaultWorkingDirectory: workspace, openRouterCredentialPath: "", theme: "dark", multiAgentEnabled: true, maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: false };
    const events: ProviderEvent[] = [];
    await runCodex({
      conversation,
      settings,
      agents,
      prompt: "Have both selected roles independently read README.md. Wait for both, then reply with only the exact provider verification phrase.",
      signal: new AbortController().signal,
      ...computerProviderContext(conversation),
      onEvent: async (event) => { events.push(event); },
    });
    const orchestration = events.filter((event) => event.type === "orchestration");
    expect(orchestration.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(orchestration)).toContain("explorer");
    expect(JSON.stringify(orchestration)).toContain("worker");
    const finals = events.filter((event) => event.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.type === "final" ? finals[0].text.toLowerCase() : "").toBe("silver otter");
  }, 180_000);
});
