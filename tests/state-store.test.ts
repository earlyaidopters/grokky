import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { defaultPersistentState, noProjectDirectory, StateStore } from "../src/main/state-store";

describe("StateStore", () => {
  test("writes private, valid JSON and reads it back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-state-"));
    const pathname = join(directory, "state.json");
    const store = new StateStore(pathname, directory);
    const state = defaultPersistentState(directory);
    state.settings.theme = "dark";
    state.settings.accentPalette = "electric-blue";
    state.computerAccess.remoteDevices.push({
      id: "sandbox-12345678",
      name: "Cloud seat",
      platform: "cloudflare-linux",
      endpoint: "https://sandbox.example",
      root: "/workspace",
      encryptedToken: "sealed-token",
      capabilities: ["files", "commands"],
      lastSeenAt: 123,
      revoked: false,
      tokenEpoch: 7,
    });
    await store.save(state);
    expect(JSON.parse(await readFile(pathname, "utf8")).settings.theme).toBe("dark");
    expect(JSON.parse(await readFile(pathname, "utf8")).settings.accentPalette).toBe("electric-blue");
    expect((await store.load()).settings.theme).toBe("dark");
    expect((await store.load()).settings.accentPalette).toBe("electric-blue");
    expect((await store.load()).computerAccess).toMatchObject({ enabled: true, grants: { files: "allow", commands: "ask" } });
    expect((await store.load()).computerAccess.remoteDevices[0]).toMatchObject({ id: "sandbox-12345678", tokenEpoch: 7 });
  });

  test("recovers from unreadable state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-state-"));
    const store = new StateStore(join(directory, "missing.json"), directory);
    expect((await store.load()).conversations).toEqual([]);
  });

  test("migrates old conversations and removes the benign skills budget notice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-state-"));
    const pathname = join(directory, "state.json");
    await writeFile(pathname, JSON.stringify({
      version: 1,
      activeConversationId: "old-chat",
      settings: { defaultWorkingDirectory: directory, multiAgentEnabled: true, maxAgentThreads: 99 },
      conversations: [{
        id: "old-chat",
        title: "Old chat",
        instructions: "  Persistent QA purpose  ",
        workingDirectory: directory,
        messages: [{
          id: "image-message",
          role: "user",
          content: "",
          attachments: [{ id: "attachment-one", name: "reference.png", mimeType: "image/png", size: 128, localPath: join(directory, "reference.png") }],
          crew: {
            agentRuns: [{ id: "historic-child", operationId: "historic-spawn", threadId: "historic-thread", name: "explorer", task: "Historic task", status: "completed", result: "Historic evidence", createdAt: 1, updatedAt: 2 }],
            communications: [], tasks: [], meetings: [], activities: [], lastRunOutcome: "delivered", updatedAt: 2,
          },
          createdAt: 2,
          provider: "codex",
        }],
        queuedMessages: [
          { id: "queued-one", content: "Follow up after the current turn", priority: "normal", createdAt: 3 },
          { id: "bad", content: "", priority: "priority", createdAt: 4 },
        ],
        activities: [{ id: "notice", detail: "Skill descriptions were shortened to fit the skills context budget." }],
        usage: {},
        agentRuns: [{ id: "child", operationId: "spawn", threadId: "thread", name: "tester", task: "Old interrupted work", status: "working", createdAt: 1, updatedAt: 2 }],
        crewCommunications: [{ id: "report", operationId: "wait", tool: "wait", kind: "report", senderThreadId: "thread", senderName: "tester", receiverThreadId: "lead", receiverName: "Grokky lead", content: "Stored report", status: "completed", createdAt: 2 }],
        agentComputers: [{
          id: "agent-computer-old",
          conversationId: "old-chat",
          agentId: "tester",
          agentName: "tester",
          role: "specialist",
          status: "working",
          isolation: "isolated-browser",
          deviceId: "local-old",
          deviceName: "Test Mac",
          workspaceRoot: directory,
          actions: [{ id: "action-old", capability: "browser", action: "browse_url", target: "https://example.com", status: "running", createdAt: 1, updatedAt: 2 }],
          evidence: [{ id: "evidence-old", kind: "browser", title: "Example", source: "https://example.com", mimeType: "image/png", localPath: join(directory, "evidence.png"), createdAt: 2 }],
          createdAt: 1,
          updatedAt: 2,
        }],
        createdAt: 1,
        updatedAt: 2,
        unreadCount: 3,
        lastViewedAt: 1,
      }],
    }));
    const state = await new StateStore(pathname, directory).load();
    expect(state.conversations[0]).toMatchObject({ instructions: "Persistent QA purpose", messages: [{ id: "image-message", content: "", attachments: [{ name: "reference.png", mimeType: "image/png" }], crew: { agentRuns: [{ name: "explorer", status: "completed", result: "Historic evidence" }], lastRunOutcome: "delivered" } }], queuedMessages: [{ id: "queued-one", priority: "normal" }], unreadCount: 3, lastViewedAt: 1, projectMode: "none", workingDirectory: noProjectDirectory(directory), selectedAgentIds: [], agentRuns: [{ name: "tester", status: "stopped" }], crewCommunications: [{ content: "Stored report" }], activities: [] });
    expect(state.settings).toMatchObject({ defaultWorkingDirectory: noProjectDirectory(directory), recentWorkingDirectories: [], accentPalette: "lime", maxAgentThreads: 8, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, webSearchEnabled: true });
    expect(state.computerAccess.activeDeviceId).toBe(state.computerAccess.localDeviceId);
    expect(state.conversations[0]?.agentComputers).toMatchObject([{
      agentName: "tester",
      status: "stopped",
      isolation: "isolated-browser",
      actions: [{ status: "indeterminate" }],
      evidence: [{ title: "Example" }],
    }]);
    expect(state.conversations[0]?.usage).toBeUndefined();
  });

  test("normalizes persisted usage before it reaches the renderer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-state-"));
    const pathname = join(directory, "state.json");
    await writeFile(pathname, JSON.stringify({
      version: 2,
      settings: defaultPersistentState(directory).settings,
      conversations: [{
        id: "usage-chat", title: "Usage", workingDirectory: directory, messages: [],
        usage: { inputTokens: 12.9, outputTokens: 4.2, reasoningTokens: -5, costUsd: -1 },
        createdAt: 1, updatedAt: 2,
      }],
    }));
    const state = await new StateStore(pathname, directory).load();
    expect(state.conversations[0]?.usage).toEqual({ inputTokens: 12, outputTokens: 4, reasoningTokens: 0, costUsd: 0 });
  });
});
