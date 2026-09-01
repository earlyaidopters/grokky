import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { MainController } from "../src/main/controller";
import { extractGeneratedArtifacts } from "../src/main/generated-artifacts";
import { McpRuntime } from "../src/main/mcp-runtime";
import {
  MIN_ROUTINE_INTERVAL_MINUTES,
  ROUTINE_GRACE_MS,
  advancePastMissedOccurrences,
  isMissedRoutineWindow,
  nextRoutineOccurrence,
  normalizeRoutineSchedule,
} from "../src/main/routines";
import { selectToolsForPrompt, type SelectableTool } from "../src/main/tool-selection";
import { StateStore } from "../src/main/state-store";
import type { Conversation, Routine, RoutineRun } from "../src/shared/contracts";

describe("durable routines", () => {
  test("enforces a safe interval floor and advances past missed runs without replay", () => {
    expect(() => normalizeRoutineSchedule({ kind: "interval", minutes: MIN_ROUTINE_INTERVAL_MINUTES - 1 })).toThrow(/between 15 minutes/);
    const scheduledFor = 1_000;
    const step = 60 * 60_000;
    const now = scheduledFor + step * 3 + 30_000;
    expect(advancePastMissedOccurrences({ schedule: { kind: "interval", minutes: 60 }, nextRunAt: scheduledFor }, now)).toBe(scheduledFor + step * 4);
    expect(isMissedRoutineWindow(scheduledFor, scheduledFor + ROUTINE_GRACE_MS)).toBe(false);
    expect(isMissedRoutineWindow(scheduledFor, scheduledFor + ROUTINE_GRACE_MS + 1)).toBe(true);
  });

  test("schedules the next selected local weekday strictly after the current time", () => {
    const after = new Date(2026, 8, 1, 10, 0, 0, 0);
    const next = new Date(nextRoutineOccurrence({ kind: "daily", time: "09:30", weekdays: [after.getDay()] }, after.getTime()));
    expect(next.getTime()).toBeGreaterThan(after.getTime());
    expect(next.getDay()).toBe(after.getDay());
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  test("records a stale occurrence as skipped and moves to the next window", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-routine-skip-"));
    const controller = new MainController(new StateStore(join(home, "state.json"), home), home, "test");
    await controller.initialize();
    try {
      const conversationId = controller.snapshot().conversations[0]!.id;
      await controller.createRoutine({ conversationId, name: "Pulse", instruction: "Report the pulse", schedule: { kind: "interval", minutes: 60 }, enabled: true });
      const internals = controller as unknown as { state: { routines: Array<{ nextRunAt: number }> }; tickRoutines(): Promise<void> };
      internals.state.routines[0]!.nextRunAt = Date.now() - ROUTINE_GRACE_MS - 1_000;
      await internals.tickRoutines();
      const snapshot = controller.snapshot();
      expect(snapshot.routineRuns).toMatchObject([{ status: "skipped", detail: expect.stringMatching(/not replayed/) }]);
      expect(snapshot.routines[0]!.nextRunAt).toBeGreaterThan(Date.now());
      expect(snapshot.conversations[0]!.messages).toEqual([]);
    } finally {
      await controller.shutdown();
    }
  });

  test("never inherits temporary approvals in an unattended run", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-routine-approval-"));
    const controller = new MainController(new StateStore(join(home, "state.json"), home), home, "test");
    await controller.initialize();
    try {
      const conversation = controller.snapshot().conversations[0]!;
      const internals = controller as unknown as {
        state: { conversations: Conversation[] };
        pendingApprovals: unknown[];
        authorizeComputerTool(conversation: Conversation, capability: "external", action: string, target: string, computer: undefined, unattended: boolean): Promise<boolean>;
      };
      await expect(internals.authorizeComputerTool(internals.state.conversations[0]!, "external", "mcp__mail__send", "mail/send", undefined, true)).rejects.toThrow(/Always allow/);
      expect(internals.pendingApprovals).toHaveLength(0);
      expect(controller.snapshot().computerAccess.auditLog.at(-1)).toMatchObject({ capability: "external", decision: "denied", status: "failed" });
      expect(conversation.status).toBe("idle");
    } finally {
      await controller.shutdown();
    }
  });

  test("switches off a routine after ten consecutive failures", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-routine-fatigue-"));
    const controller = new MainController(new StateStore(join(home, "state.json"), home), home, "test");
    await controller.initialize();
    try {
      const conversationId = controller.snapshot().conversations[0]!.id;
      await controller.createRoutine({ conversationId, name: "Fragile pulse", instruction: "Report the pulse", schedule: { kind: "interval", minutes: 60 }, enabled: true });
      const internals = controller as unknown as {
        state: { routines: Routine[] };
        recordRoutineFailure(routine: Routine, run: RoutineRun): Promise<void>;
      };
      const routine = internals.state.routines[0]!;
      for (let failure = 1; failure <= 10; failure += 1) {
        const now = Date.now();
        await internals.recordRoutineFailure(routine, {
          id: `failure-${failure}`,
          routineId: routine.id,
          conversationId,
          scheduledFor: now,
          status: "failed",
          detail: `Failure ${failure}`,
          finishedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      const snapshot = controller.snapshot();
      expect(snapshot.routines[0]).toMatchObject({ enabled: false, consecutiveFailures: 10 });
      expect(snapshot.attention.filter((item) => item.status === "open")).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: "warning", title: "Fragile pulse needs attention", detail: "Failure 10" }),
        expect.objectContaining({ severity: "critical", title: "Fragile pulse was switched off" }),
      ]));
    } finally {
      await controller.shutdown();
    }
  });
});

describe("generated workspace views", () => {
  test("extracts strict artifacts and leaves the human answer clean", () => {
    const result = extractGeneratedArtifacts([
      "Here is the scorecard.",
      "```grokky-artifact",
      JSON.stringify({ kind: "metrics", title: "Launch pulse", items: [{ label: "Ready", value: 7, status: "complete" }] }),
      "```",
    ].join("\n"), 123);
    expect(result.text).toBe("Here is the scorecard.");
    expect(result.artifacts).toMatchObject([{ kind: "metrics", title: "Launch pulse", items: [{ label: "Ready", value: 7, status: "complete" }], createdAt: 123 }]);
  });

  test("drops malformed artifact payloads instead of leaking renderer syntax", () => {
    const result = extractGeneratedArtifacts("Answer\n```grokky-artifact\n{not json}\n```\nDone");
    expect(result.text).toBe("Answer\n\nDone");
    expect(result.artifacts).toEqual([]);
  });
});

describe("bounded tool selection", () => {
  const tools: SelectableTool[] = [
    ...Array.from({ length: 6 }, (_, index) => ({ name: `workspace_${index}`, group: "workspace" as const })),
    ...Array.from({ length: 6 }, (_, index) => ({ name: `browser_${index}`, group: "browser" as const })),
    ...Array.from({ length: 6 }, (_, index) => ({ name: `external_${index}`, group: "external" as const })),
    { name: "finish", group: "completion" },
  ];

  test("offers only already-granted tools relevant to an explicit intent", () => {
    const selection = selectToolsForPrompt(tools, "Read my Gmail and summarize today's email", 12);
    expect(selection.reason).toBe("selected");
    expect(selection.offered.map((tool) => tool.group)).toEqual([
      "external", "external", "external", "external", "external", "external", "completion",
    ]);
    expect(selection.granted).toBe(tools.length);
  });

  test("fails open when the prompt gives no reliable selection signal", () => {
    const selection = selectToolsForPrompt(tools, "Help me think through this", 12);
    expect(selection.reason).toBe("nothing-chosen");
    expect(selection.offered).toHaveLength(tools.length);
  });
});

describe("OpenRouter MCP runtime", () => {
  test("discovers and calls an enabled stdio tool without exposing its config", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-mcp-runtime-"));
    const configDirectory = join(home, ".codex");
    await mkdir(configDirectory, { recursive: true });
    const serverPath = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
    await writeFile(join(configDirectory, "config.toml"), [
      "[mcp_servers.smoke]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(serverPath)}]`,
      "enabled = true",
      "",
    ].join("\n"));
    const runtime = new McpRuntime(home, "test");
    try {
      const listed = await runtime.listTools();
      expect(listed.errors).toEqual([]);
      expect(listed.tools).toMatchObject([{ name: "mcp__smoke__echo", serverId: "smoke", toolName: "echo", readOnly: true, destructive: false, openWorld: false }]);
      expect(await runtime.callTool("mcp__smoke__echo", { text: "hello" })).toBe("echo:hello");
      expect(JSON.stringify(listed.tools)).not.toContain(process.execPath);
      expect(JSON.stringify(listed.tools)).not.toContain(serverPath);
    } finally {
      await runtime.close();
    }
  });
});
