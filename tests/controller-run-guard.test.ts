import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { classifyRunOutcome, MainController, reconcileInterruptedConversation } from "../src/main/controller";
import { StateStore } from "../src/main/state-store";
import { requiresDevelopmentCommands, requiresInteractiveBrowser, requiresProjectDirectory } from "../src/shared/run-preflight";
import { requireMessagePriority, validateConversationPatch, validateSettingsPatch } from "../src/shared/validation";
import type { Conversation } from "../src/shared/contracts";

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation",
    title: "Run guard",
    instructions: "",
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    sandboxMode: "workspace-write",
    allowCommands: true,
    projectMode: "project",
    workingDirectory: "/tmp/project",
    messages: [],
    queuedMessages: [],
    activities: [],
    selectedAgentIds: [],
    agentRuns: [],
    crewCommunications: [],
    status: "idle",
    unreadCount: 0,
    lastViewedAt: 2,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

describe("run preflight", () => {
  test("validates session identity and follow-up priority", () => {
    expect(validateConversationPatch({ title: "  Release operator  ", instructions: "Own packaging QA." })).toEqual({ title: "Release operator", instructions: "Own packaging QA." });
    expect(() => validateConversationPatch({ title: "" })).toThrow("Invalid session name");
    expect(requireMessagePriority(undefined)).toBe("normal");
    expect(requireMessagePriority("priority")).toBe("priority");
    expect(() => requireMessagePriority("urgent")).toThrow("Invalid message priority");
    expect(validateSettingsPatch({ spreadAgentComputers: true })).toEqual({ spreadAgentComputers: true });
    expect(() => validateSettingsPatch({ spreadAgentComputers: "yes" })).toThrow("Invalid agent computer distribution setting");
  });

  test("recognizes local project work without blocking ordinary advice", () => {
    expect(requiresProjectDirectory("Build a beautiful website and spin it up on localhost")).toBe(true);
    expect(requiresProjectDirectory("Fix the authentication bug in this repository")).toBe(true);
    expect(requiresProjectDirectory("Help me write a business plan")).toBe(false);
  });

  test("recognizes work that needs development commands", () => {
    expect(requiresDevelopmentCommands("Build the site and spin it up on localhost")).toBe(true);
    expect(requiresDevelopmentCommands("Install dependencies and run the test suite")).toBe(true);
    expect(requiresDevelopmentCommands("Read README.md. Do not edit files or run tests.")).toBe(false);
    expect(requiresDevelopmentCommands("Avoid npm and never start the development server.")).toBe(false);
    expect(requiresDevelopmentCommands("Do not edit files. Run the test suite.")).toBe(true);
    expect(requiresDevelopmentCommands("Explain this component")).toBe(false);
  });

  test("recognizes interactive browser control without confusing it with web research", () => {
    expect(requiresInteractiveBrowser("Use your computer to go on promptadvisers.com and explore it")).toBe(true);
    expect(requiresInteractiveBrowser("Open https://example.com and click the Learn more link")).toBe(true);
    expect(requiresInteractiveBrowser("Summarize what promptadvisers.com does")).toBe(false);
    expect(requiresInteractiveBrowser("Do not open promptadvisers.com in a browser")).toBe(false);
  });

  test("routes an explicit Codex browser-control request to the online Grokky cloud computer", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-browser-route-"));
    const controller = new MainController(new StateStore(join(home, "state.json"), home), home, "test");
    await controller.initialize();
    const internals = controller as unknown as {
      state: ReturnType<typeof controller.snapshot> & { computerAccess: ReturnType<typeof controller.snapshot>["computerAccess"] & { remoteDevices: Array<Record<string, unknown>> } };
      statuses: Array<{ id: "codex" | "openrouter"; ready: boolean; label: string; source: string; detail: string }>;
      routeInteractiveBrowserRequest(conversation: Conversation, prompt: string): void;
    };
    const active = internals.state.conversations[0]!;
    internals.state.computerAccess.remoteDevices = [{
      id: "cloud-browser",
      name: "Grokky Cloud Sandbox",
      platform: "linux",
      endpoint: "https://sandbox.example",
      root: "/workspace",
      encryptedToken: "sealed",
      capabilities: ["files", "commands", "browser", "screen", "automation"],
      lastSeenAt: Date.now(),
      revoked: false,
    }];
    internals.statuses = [
      { id: "codex", ready: true, label: "ready", source: "test", detail: "ready" },
      { id: "openrouter", ready: true, label: "ready", source: "test", detail: "ready" },
    ];

    internals.routeInteractiveBrowserRequest(active, "Use your computer to go on promptadvisers.com and explore it");

    expect(active).toMatchObject({ provider: "openrouter", model: "openai/gpt-5.2", allowCommands: false });
    expect(internals.state.computerAccess.activeDeviceId).toBe("cloud-browser");
  });

  test("blocks an expensive project crew run before dispatch and remembers a selected project", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-run-guard-"));
    const project = join(home, "projects", "site");
    await mkdir(project, { recursive: true });
    const store = new StateStore(join(home, "state.json"), home);
    const controller = new MainController(store, home, "test");
    await controller.initialize();
    const first = controller.snapshot().conversations[0]!;

    await expect(controller.sendMessage(first.id, "Build a beautiful website and spin it up on localhost")).rejects.toThrow("Choose a project folder");
    expect(controller.snapshot().conversations[0]).toMatchObject({ status: "idle", messages: [], agentRuns: [] });

    await controller.updateConversation(first.id, { workingDirectory: project, projectMode: "project" });
    await expect(controller.sendMessage(first.id, "Build a beautiful website and spin it up on localhost")).rejects.toThrow("Choose Full access");
    expect(controller.snapshot().settings.recentWorkingDirectories).toEqual([project]);

    const secondId = await controller.createConversation();
    expect(controller.snapshot().conversations.find((item) => item.id === secondId)).toMatchObject({ projectMode: "project", workingDirectory: project });
  });

  test("drops late provider events after cancellation or run replacement", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-late-event-"));
    const controller = new MainController(new StateStore(join(home, "state.json"), home), home, "test");
    await controller.initialize();
    const conversationId = controller.snapshot().conversations[0]!.id;
    const stale = new AbortController();
    const current = new AbortController();
    const internals = controller as unknown as {
      runs: Map<string, AbortController>;
      applyProviderEvent(conversationId: string, event: { type: "final"; text: string } | { type: "usage"; usage: { inputTokens: number; outputTokens: number } }, controller: AbortController): Promise<void>;
    };
    internals.runs.set(conversationId, current);
    stale.abort();
    await internals.applyProviderEvent(conversationId, { type: "final", text: "Late stale answer" }, stale);
    await internals.applyProviderEvent(conversationId, { type: "usage", usage: { inputTokens: 999, outputTokens: 999 } }, stale);
    expect(controller.snapshot().conversations[0]).toMatchObject({ messages: [] });
    expect(controller.snapshot().conversations[0]?.usage).toBeUndefined();
  });

  test("restores provider-specific Codex continuity after an OpenRouter round trip", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-provider-thread-"));
    const controller = new MainController(new StateStore(join(home, "state.json"), home), home, "test");
    await controller.initialize();
    const conversationId = controller.snapshot().conversations[0]!.id;
    const internals = controller as unknown as {
      applyProviderEvent(conversationId: string, event: { type: "thread"; threadId: string }): Promise<void>;
    };

    await internals.applyProviderEvent(conversationId, { type: "thread", threadId: "codex-thread" });
    await controller.updateConversation(conversationId, { provider: "openrouter" });
    expect(controller.snapshot().conversations[0]).toMatchObject({ provider: "openrouter", providerThreadIds: { codex: "codex-thread" } });
    expect(controller.snapshot().conversations[0]?.threadId).toBeUndefined();

    await internals.applyProviderEvent(conversationId, { type: "thread", threadId: "openrouter-session" });
    await controller.updateConversation(conversationId, { provider: "codex" });
    expect(controller.snapshot().conversations[0]).toMatchObject({ provider: "codex", threadId: "codex-thread" });
  });

  test("deleting a conversation denies and resolves its pending computer approvals", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-delete-approval-"));
    const controller = new MainController(new StateStore(join(home, "state.json"), home), home, "test");
    await controller.initialize();
    const conversationId = controller.snapshot().conversations[0]!.id;
    let decision = "unresolved";
    const internals = controller as unknown as {
      pendingApprovals: Array<Record<string, unknown>>;
      approvalResolvers: Map<string, (value: string) => void>;
    };
    internals.pendingApprovals.push({ id: "approval-delete", conversationId });
    internals.approvalResolvers.set("approval-delete", (value) => { decision = value; });

    await controller.deleteConversation(conversationId);
    expect(decision).toBe("deny");
    expect(internals.approvalResolvers.size).toBe(0);
    expect(internals.pendingApprovals).toHaveLength(0);
  });

  test("allowing an agent run grants every non-blocked computer capability for that run", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-run-approval-"));
    const controller = new MainController(new StateStore(join(home, "state.json"), home), home, "test");
    await controller.initialize();
    const conversationId = controller.snapshot().conversations[0]!.id;
    await controller.setComputerCapability("commands", "blocked");
    const internals = controller as unknown as {
      pendingApprovals: Array<Record<string, unknown>>;
      sessionComputerGrants: Map<string, Set<string>>;
    };
    internals.pendingApprovals.push({
      id: "approval-run",
      conversationId,
      agentComputerId: "computer-lead",
      deviceId: "cloud-device",
      deviceName: "Grokky Cloud Sandbox",
      agentId: "grokky-lead",
      agentName: "Grokky lead",
      capability: "browser",
      action: "browse url",
      target: "https://example.com/",
      createdAt: Date.now(),
    });

    await controller.resolveComputerApproval("approval-run", "allow-session");

    expect([...internals.sessionComputerGrants.values()][0]).toEqual(new Set(["files", "browser", "screen", "automation"]));
  });

  test("turning multi-agent off clears retained crew selections", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-disable-crew-"));
    const controller = new MainController(new StateStore(join(home, "state.json"), home), home, "test");
    await controller.initialize();
    const conversationId = controller.snapshot().conversations[0]!.id;
    await controller.updateConversation(conversationId, { selectedAgentIds: ["builtin:explorer"] });
    await controller.updateSettings({ multiAgentEnabled: false });
    expect(controller.snapshot().conversations[0]?.selectedAgentIds).toEqual([]);
  });
});

describe("run outcome classification", () => {
  test("reconciles a priority-interrupted turn before it is archived", () => {
    const current = conversation({
      status: "running",
      lastRunOutcome: undefined,
      agentRuns: [{ id: "child", operationId: "spawn", threadId: "thread", name: "explorer", task: "Inspect", status: "working", createdAt: 1, updatedAt: 1 }],
      agentTasks: [{ id: "task", operationId: "spawn", fromThreadId: "lead", fromName: "Lead", toThreadId: "thread", toName: "explorer", title: "Inspect", instructions: "Inspect", acceptanceCriteria: [], status: "working", createdAt: 1, updatedAt: 1 }],
      agentMeetings: [{ id: "meeting", title: "Review", agenda: "Agree", participantThreadIds: ["thread"], participantNames: ["explorer"], status: "live", contributions: [], decisions: [], actionItems: [], createdAt: 1, updatedAt: 1 }],
    });
    reconcileInterruptedConversation(current, { aborted: true, continuing: true, error: new Error("cancelled"), now: 10 });
    expect(current).toMatchObject({
      status: "idle",
      lastRunOutcome: "stopped",
      error: undefined,
      agentRuns: [{ status: "stopped" }],
      agentTasks: [{ status: "stopped" }],
      agentMeetings: [{ status: "incomplete" }],
    });
  });

  test("marks an unconfirmed crew as blocked", () => {
    expect(classifyRunOutcome(conversation({ selectedAgentIds: ["explorer"] }), 1)).toBe("blocked");
  });

  test("does not require retained crew selections when multi-agent execution is disabled", () => {
    expect(classifyRunOutcome(conversation({
      selectedAgentIds: ["explorer"],
      messages: [{ id: "answer", role: "assistant", content: "Here is the requested answer.", createdAt: 2, provider: "openrouter" }],
    }), 0)).toBe("delivered");
  });

  test("marks a non-productive blocker response as blocked", () => {
    expect(classifyRunOutcome(conversation({
      messages: [{ id: "answer", role: "assistant", content: "No files were changed. I need a project folder to proceed.", createdAt: 2, provider: "codex" }],
    }), 0)).toBe("blocked");
  });

  test("does not call a silent run delivered by reusing an older assistant response", () => {
    expect(classifyRunOutcome(conversation({
      activities: [{ id: "file", kind: "files", label: "Updated 1 file", status: "completed", createdAt: 4 }],
      messages: [
        { id: "first-user", role: "user", content: "Build the site", createdAt: 1, provider: "codex" },
        { id: "first-answer", role: "assistant", content: "Built the site.", createdAt: 2, provider: "codex" },
        { id: "follow-up", role: "user", content: "Why is it blank?", createdAt: 3, provider: "codex" },
      ],
    }), 0)).toBe("blocked");
  });

  test("marks completed file work as delivered", () => {
    expect(classifyRunOutcome(conversation({
      activities: [{ id: "file", kind: "files", label: "Updated 1 file", status: "completed", createdAt: 2 }],
      messages: [{ id: "answer", role: "assistant", content: "Implemented and verified the fix.", createdAt: 3, provider: "codex" }],
    }), 0)).toBe("delivered");
  });
});
