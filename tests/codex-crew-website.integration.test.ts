import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCodex } from "../src/main/providers/codex-provider";
import type { ProviderEvent } from "../src/main/providers/types";
import type { AgentDefinition, AppSettings, Conversation } from "../src/shared/contracts";
import { computerProviderContext } from "./provider-fixtures";

const live = process.env.GROKKY_LIVE_CODEX_CREW_WEBSITE === "1";

describe.skipIf(!live)("live staged Codex website crew", () => {
  test("builds first, tests second, and records the user-visible experience", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grokky-staged-site-"));
    const tracePath = process.env.GROKKY_CREW_TRACE_PATH || join(tmpdir(), "grokky-staged-crew-trace.json");
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 420_000);
    const conversation: Conversation = {
      id: "staged-website-smoke",
      title: "Staged website smoke",
      provider: "codex",
      model: process.env.GROKKY_CODEX_SMOKE_MODEL || "gpt-5.6-sol",
      reasoning: "medium",
      sandboxMode: "workspace-write",
      allowCommands: true,
      projectMode: "project",
      workingDirectory: workspace,
      messages: [],
      activities: [],
      selectedAgentIds: ["builtin:explorer", "builtin:worker", "personal:tester"],
      agentRuns: [],
      crewCommunications: [],
      status: "running",
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const agents: AgentDefinition[] = [
      { id: "builtin:explorer", name: "explorer", description: "Inspect the empty workspace and identify constraints.", developerInstructions: "Read only and report concise evidence.", scope: "built-in", builtIn: true, sandboxMode: "read-only" },
      { id: "builtin:worker", name: "worker", description: "Own implementation and verification of the website.", developerInstructions: "Own every file change and report concrete verification.", scope: "built-in", builtIn: true, sandboxMode: "workspace-write" },
      { id: "personal:tester", name: "tester", description: "Test the completed site after implementation is ready.", developerInstructions: "Inspect and test only after the worker reports completion.", scope: "personal", builtIn: false, sandboxMode: "read-only", model: "gpt-5.6-terra", reasoning: "high" },
    ];
    const settings: AppSettings = {
      defaultWorkingDirectory: workspace,
      recentWorkingDirectories: [workspace],
      openRouterCredentialPath: "",
      theme: "dark",
      multiAgentEnabled: true,
      maxAgentThreads: 3,
      defaultSubagentModel: "",
      defaultSubagentReasoning: "",
      interruptAgentMessage: true,
      connectorsEnabled: false,
      webSearchEnabled: false,
    };
    const trace: Array<Record<string, unknown>> = [];
    const record = (event: ProviderEvent) => {
      const atMs = Date.now() - startedAt;
      if (event.type === "orchestration") {
        trace.push({
          atMs,
          type: event.type,
          tool: event.event.tool,
          status: event.event.status,
          threads: event.event.receiverThreads.map((thread) => ({ name: thread.name, status: thread.status, hasReport: Boolean(thread.message) })),
        });
      } else if (event.type === "activity") {
        trace.push({ atMs, type: event.type, kind: event.activity.kind, label: event.activity.label, status: event.activity.status });
      } else if (event.type === "final") {
        trace.push({ atMs, type: event.type, characters: event.text.length });
      } else {
        trace.push({ atMs, type: event.type });
      }
    };

    try {
      await runCodex({
        conversation,
        settings,
        agents,
        prompt: [
          "Build a polished but compact one-page website for a fictional independent coffee studio and verify the result.",
          "Use plain HTML, CSS, and JavaScript with no dependencies, network calls, generated images, or persistent server.",
          "Create index.html, styles.css, and script.js. Include a strong hero, services, selected work, contact section, responsive navigation, visible keyboard focus, and reduced-motion support.",
          "The worker must own implementation. The tester must inspect the stable files after the worker sends IMPLEMENTATION_READY.",
          "Verify the file references and important accessibility states with local commands, then return a concise final summary.",
        ].join(" "),
        signal: controller.signal,
        ...computerProviderContext(conversation),
        onEvent: async (event) => { record(event); },
      });
    } finally {
      clearTimeout(timeout);
      await writeFile(tracePath, `${JSON.stringify({ workspace, elapsedMs: Date.now() - startedAt, trace }, null, 2)}\n`);
    }

    const orchestration = trace.filter((entry) => entry.type === "orchestration");
    const firstThreadEvent = (name: string, status?: string) => orchestration.find((entry) => (
      Array.isArray(entry.threads)
      && entry.threads.some((thread) => typeof thread === "object" && thread !== null
        && (thread as { name?: string }).name === name
        && (!status || (thread as { status?: string }).status === status))
    ));
    const workerStarted = firstThreadEvent("worker", "running");
    const workerCompleted = firstThreadEvent("worker", "completed");
    const testerStarted = firstThreadEvent("tester", "running");
    const testerCompleted = firstThreadEvent("tester", "completed");
    const final = trace.find((entry) => entry.type === "final");

    expect(workerStarted).toBeTruthy();
    expect(workerCompleted).toBeTruthy();
    expect(testerStarted).toBeTruthy();
    expect(testerCompleted).toBeTruthy();
    expect((testerStarted?.atMs as number)).toBeLessThan(workerCompleted?.atMs as number);
    expect(final).toBeTruthy();
    expect(await readFile(join(workspace, "index.html"), "utf8")).toContain("styles.css");
    expect(await readFile(join(workspace, "index.html"), "utf8")).toContain("script.js");
    expect(await readFile(join(workspace, "styles.css"), "utf8")).toMatch(/prefers-reduced-motion/);
    console.log(`grokky-staged-crew-trace:${tracePath}`);
    console.log(`grokky-staged-crew-workspace:${workspace}`);
    console.log(`grokky-staged-crew-elapsed-ms:${Date.now() - startedAt}`);
  }, 450_000);
});
