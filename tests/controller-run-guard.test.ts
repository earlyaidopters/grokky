import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { classifyRunOutcome, MainController } from "../src/main/controller";
import { StateStore } from "../src/main/state-store";
import { requiresDevelopmentCommands, requiresProjectDirectory } from "../src/shared/run-preflight";
import { requireMessagePriority, validateConversationPatch } from "../src/shared/validation";
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
  });

  test("recognizes local project work without blocking ordinary advice", () => {
    expect(requiresProjectDirectory("Build a beautiful website and spin it up on localhost")).toBe(true);
    expect(requiresProjectDirectory("Fix the authentication bug in this repository")).toBe(true);
    expect(requiresProjectDirectory("Help me write a business plan")).toBe(false);
  });

  test("recognizes work that needs development commands", () => {
    expect(requiresDevelopmentCommands("Build the site and spin it up on localhost")).toBe(true);
    expect(requiresDevelopmentCommands("Install dependencies and run the test suite")).toBe(true);
    expect(requiresDevelopmentCommands("Explain this component")).toBe(false);
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
});

describe("run outcome classification", () => {
  test("marks an unconfirmed crew as blocked", () => {
    expect(classifyRunOutcome(conversation({ selectedAgentIds: ["explorer"] }), 1)).toBe("blocked");
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
