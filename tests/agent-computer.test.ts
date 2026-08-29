import { createHash } from "node:crypto";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentBrowserHost } from "../src/main/agent-computer";
import { ComputerAccessService, RemoteActionOutcomeUnknownError } from "../src/main/computer-access";
import { agentComputerDeviceAssignments, MainController } from "../src/main/controller";
import { openRouterToolContent } from "../src/main/providers/openrouter-provider";
import { defaultPersistentState, StateStore } from "../src/main/state-store";
import type { Conversation } from "../src/shared/contracts";

function conversation(root: string, deviceId: string): Conversation {
  const now = Date.now();
  return {
    id: "agent-computer-chat",
    title: "Agent computer",
    instructions: "",
    provider: "openrouter",
    model: "test/model",
    reasoning: "low",
    sandboxMode: "read-only",
    allowCommands: false,
    projectMode: "project",
    workingDirectory: root,
    messages: [],
    queuedMessages: [],
    activities: [],
    selectedAgentIds: ["researcher"],
    agentRuns: [],
    crewCommunications: [],
    agentComputers: [{
      id: "agent-computer-researcher",
      conversationId: "agent-computer-chat",
      agentId: "researcher",
      agentName: "researcher",
      role: "specialist",
      status: "ready",
      isolation: "isolated-browser",
      deviceId,
      deviceName: "Test computer",
      workspaceRoot: root,
      actions: [],
      evidence: [],
      createdAt: now,
      updatedAt: now,
    }],
    status: "idle",
    unreadCount: 0,
    lastViewedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

describe("agent computer execution", () => {
  test("pins the lead to the selected device and spreads later seats only when enabled", () => {
    const devices = [
      { id: "local", name: "Local", platform: "darwin", kind: "local" as const, status: "online" as const, root: "/local", capabilities: ["files" as const], lastSeenAt: 2 },
      { id: "vm-a", name: "VM A", platform: "linux", kind: "remote" as const, status: "online" as const, root: "/runner", capabilities: ["files" as const], lastSeenAt: 2 },
      { id: "vm-b", name: "VM B", platform: "linux", kind: "remote" as const, status: "offline" as const, root: "/runner", capabilities: ["files" as const], lastSeenAt: 1 },
    ];
    expect(agentComputerDeviceAssignments(devices, "vm-a", false, 3).map((device) => device.id)).toEqual(["vm-a", "vm-a", "vm-a"]);
    expect(agentComputerDeviceAssignments(devices, "vm-a", true, 5).map((device) => device.id)).toEqual(["vm-a", "local", "vm-a", "local", "vm-a"]);
  });

  test("attributes isolated browsing, audit, and captured evidence to the exact agent seat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-agent-computer-"));
    const evidencePath = join(directory, "frame.png");
    const statePath = join(directory, "state.json");
    await writeFile(evidencePath, Buffer.from("frozen-frame"));
    const store = new StateStore(statePath, directory);
    const state = defaultPersistentState(directory);
    state.computerAccess.grants.browser = "allow";
    state.computerAccess.networkAllowlist = ["1.1.1.1"];
    state.conversations = [conversation(directory, state.computerAccess.localDeviceId)];
    state.activeConversationId = state.conversations[0]!.id;
    await store.save(state);

    let observedPendingIntent = false;
    const browser: AgentBrowserHost = {
      available: true,
      browse: async (request) => {
        const persisted = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8")) as { computerAccess?: { auditLog?: Array<{ status?: string; action?: string }> } };
        observedPendingIntent = persisted.computerAccess?.auditLog?.some((entry) => entry.action === "browse_url" && entry.status === "pending") === true;
        return {
          output: "Title: Example\nURL: https://example.com/\n\nEvidence",
          currentUrl: request.url,
          pageTitle: "Example",
          evidencePath,
          evidenceSha256: "16169ce36ec800a720cbd326be4406b16f2107cc7fba393869b32f7d7952af65",
        };
      },
      importEvidence: async (pathname) => ({ evidencePath: pathname, evidenceSha256: "16169ce36ec800a720cbd326be4406b16f2107cc7fba393869b32f7d7952af65" }),
      removeEvidence: async (pathname) => { await unlink(pathname).catch(() => undefined); },
      disposeSession: () => undefined,
      disposeAll: () => undefined,
    };
    const controller = new MainController(store, directory, "test", undefined, browser);
    await controller.initialize();
    const invoke = controller as unknown as {
      executeComputerTool(
        conversationId: string,
        name: "browse_url",
        args: Record<string, unknown>,
        options: { readOnly: boolean; agentComputer: { agentId: string; agentName: string; threadId: string } },
      ): Promise<string>;
    };

    await expect(invoke.executeComputerTool("agent-computer-chat", "browse_url", { url: "https://1.1.1.1/" }, {
      readOnly: true,
      agentComputer: { agentId: "researcher", agentName: "researcher", threadId: "thread-researcher" },
    })).resolves.toMatchObject({ output: expect.stringContaining("Evidence") });

    const snapshot = controller.snapshot();
    const computer = snapshot.conversations[0]?.agentComputers?.[0];
    expect(computer).toMatchObject({
      agentName: "researcher",
      status: "ready",
      currentUrl: "https://1.1.1.1/",
      pageTitle: "Example",
      actions: [{ action: "browse_url", status: "completed" }],
      evidence: [{ kind: "browser", title: "Example" }],
    });
    expect(snapshot.computerAccess.auditLog[0]).toMatchObject({
      agentComputerId: computer?.id,
      agentName: "researcher",
      action: "browse_url",
      status: "completed",
      argumentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(observedPendingIntent).toBe(true);
    await expect(controller.getAgentComputerEvidenceData(computer!.evidence[0]!.id)).resolves.toContain("data:image/png;base64,");
    const internals = controller as unknown as { state: { conversations: Conversation[] } };
    const storedConversation = internals.state.conversations[0]!;
    storedConversation.messages.push({
      id: "archived-turn", role: "user", content: "Inspect the page", provider: "openrouter", createdAt: Date.now(),
      crew: {
        agentRuns: [], communications: [], tasks: [], meetings: [], activities: [],
        agentComputers: structuredClone(storedConversation.agentComputers ?? []), updatedAt: Date.now(),
      },
    });
    storedConversation.agentComputers = [];
    await expect(controller.getAgentComputerEvidenceData(computer!.evidence[0]!.id)).resolves.toContain("data:image/png;base64,");
    await writeFile(evidencePath, "tampered-frame");
    await expect(controller.getAgentComputerEvidenceData(computer!.evidence[0]!.id)).rejects.toThrow(/integrity check/);
    await controller.deleteConversation("agent-computer-chat");
    await expect(readFile(evidencePath)).rejects.toThrow();
  });

  test("attaches the owned screen artifact after the host temporary capture is removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-owned-screen-"));
    const temporaryPath = join(directory, "temporary.png");
    const ownedPath = join(directory, "owned.png");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(temporaryPath, png);
    const store = new StateStore(join(directory, "state.json"), directory);
    const state = defaultPersistentState(directory);
    state.computerAccess.grants.screen = "allow";
    state.conversations = [conversation(directory, state.computerAccess.localDeviceId)];
    state.activeConversationId = state.conversations[0]!.id;
    await store.save(state);
    const computerAccess = new ComputerAccessService({
      host: {
        permissionStatus: () => "granted",
        requestPermission: async () => "granted",
        execute: async () => `Captured the current display to ${temporaryPath}`,
      },
    });
    const browser: AgentBrowserHost = {
      available: true,
      browse: async () => { throw new Error("Not used"); },
      importEvidence: async (pathname) => {
        const bytes = await readFile(pathname);
        await writeFile(ownedPath, bytes);
        await unlink(pathname);
        return { evidencePath: ownedPath, evidenceSha256: createHash("sha256").update(bytes).digest("hex") };
      },
      removeEvidence: async () => undefined,
      disposeSession: () => undefined,
      disposeAll: () => undefined,
    };
    const controller = new MainController(store, directory, "test", computerAccess, browser);
    await controller.initialize();
    const invoke = controller as unknown as {
      executeComputerTool(conversationId: string, name: "capture_screen", args: Record<string, unknown>, options: { readOnly: boolean; agentComputer: { agentId: string; agentName: string } }): Promise<{ output: string; attachmentPath?: string }>;
    };

    const result = await invoke.executeComputerTool("agent-computer-chat", "capture_screen", {}, {
      readOnly: true,
      agentComputer: { agentId: "researcher", agentName: "researcher" },
    });
    await expect(readFile(temporaryPath)).rejects.toThrow();
    expect(result.attachmentPath).toBe(ownedPath);
    expect(result.output).toBe("Captured the current display.");
    const content = await openRouterToolContent("capture_screen", result);
    expect(content).toEqual(expect.arrayContaining([
      { type: "image_url", imageUrl: { url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" } },
    ]));
  });

  test("turns a remote OpenRouter browser action into a cloud desktop frame", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-cloud-browser-"));
    const evidencePath = join(directory, "cloud-owned.png");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const sha256 = createHash("sha256").update(png).digest("hex");
    const store = new StateStore(join(directory, "state.json"), directory);
    const state = defaultPersistentState(directory);
    state.computerAccess.enabled = true;
    state.computerAccess.grants.browser = "allow";
    state.computerAccess.networkAllowlist = ["1.1.1.1"];
    state.computerAccess.remoteDevices.push({
      id: "cloud-browser-device",
      name: "Grokky Cloud Sandbox",
      platform: "cloudflare-linux",
      endpoint: "https://sandbox.example.com",
      root: "/workspace",
      encryptedToken: "sealed",
      capabilities: ["files", "commands", "browser", "screen", "automation"],
      lastSeenAt: Date.now(),
      revoked: false,
    });
    state.computerAccess.activeDeviceId = "cloud-browser-device";
    const chat = conversation(directory, "cloud-browser-device");
    chat.agentComputers![0]!.isolation = "cloud-browser";
    state.conversations = [chat];
    state.activeConversationId = chat.id;
    await store.save(state);
    const computerAccess = new ComputerAccessService();
    computerAccess.execute = async () => ({
      output: "Opened example.com in the cloud browser.",
      visualArtifact: {
        mimeType: "image/png",
        dataBase64: png.toString("base64"),
        sha256,
        currentUrl: "https://example.com/",
        pageTitle: "Example Domain",
        width: 1280,
        height: 800,
        liveViewUrl: "https://live.browser.run/ui/view?token=ephemeral-test-token",
      },
    });
    const browser: AgentBrowserHost = {
      available: true,
      browse: async () => { throw new Error("unused"); },
      importEvidence: async () => { throw new Error("unused"); },
      storeEvidence: async (bytes) => {
        await writeFile(evidencePath, bytes);
        return { evidencePath, evidenceSha256: createHash("sha256").update(bytes).digest("hex") };
      },
      removeEvidence: async () => undefined,
      disposeSession: () => undefined,
      disposeAll: () => undefined,
    };
    const controller = new MainController(store, directory, "test", computerAccess, browser);
    await controller.initialize();
    const invoke = controller as unknown as {
      executeComputerTool(conversationId: string, name: "browse_url", args: Record<string, unknown>, options: { readOnly: boolean; agentComputer: { agentId: string; agentName: string } }): Promise<{ output: string; attachmentPath?: string }>;
    };
    const result = await invoke.executeComputerTool(chat.id, "browse_url", { url: "https://1.1.1.1/" }, {
      readOnly: true,
      agentComputer: { agentId: "researcher", agentName: "researcher" },
    });
    expect(result).toMatchObject({ output: expect.stringContaining("Opened example.com"), attachmentPath: evidencePath });
    expect(controller.snapshot().conversations[0]?.agentComputers?.[0]).toMatchObject({
      isolation: "cloud-browser",
      currentUrl: "https://example.com/",
      pageTitle: "Example Domain",
      evidence: [{ kind: "browser", localPath: evidencePath, sha256 }],
    });
    expect(controller.snapshot().agentComputerLiveViews).toEqual({
      "agent-computer-researcher": "https://live.browser.run/ui/view?token=ephemeral-test-token",
    });
    expect(await readFile(join(directory, "state.json"), "utf8")).not.toContain("ephemeral-test-token");
    await expect(controller.getAgentComputerEvidenceData(controller.snapshot().conversations[0]!.agentComputers![0]!.evidence[0]!.id)).resolves.toContain(png.toString("base64"));
  });

  test("keeps Codex seats on the actual local SDK host and labels their policy boundary honestly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-codex-seat-"));
    const store = new StateStore(join(directory, "state.json"), directory);
    const state = defaultPersistentState(directory);
    const chat = conversation(directory, state.computerAccess.localDeviceId);
    chat.provider = "codex";
    chat.model = "gpt-5.6-sol";
    chat.agentComputers = [];
    state.computerAccess.remoteDevices.push({
      id: "remote-online", name: "Remote VM", platform: "linux", endpoint: "http://127.0.0.1:4747", root: "/runner",
      encryptedToken: Buffer.from("test-token").toString("base64"), capabilities: ["files"], lastSeenAt: Date.now(), revoked: false,
    });
    state.computerAccess.activeDeviceId = "remote-online";
    state.settings.spreadAgentComputers = true;
    state.conversations = [chat];
    state.activeConversationId = chat.id;
    await store.save(state);
    const browser: AgentBrowserHost = {
      available: true,
      browse: async () => { throw new Error("unused"); },
      importEvidence: async () => { throw new Error("unused"); },
      removeEvidence: async () => undefined,
      disposeSession: () => undefined,
      disposeAll: () => undefined,
    };
    const controller = new MainController(store, directory, "test", undefined, browser);
    await controller.initialize();
    const internals = controller as unknown as {
      state: { conversations: Conversation[] };
      initializeAgentComputers(conversation: Conversation, agents: Array<{ id: string; name: string; description: string; developerInstructions: string; scope: "built-in"; builtIn: true }>): void;
    };
    const internalChat = internals.state.conversations[0]!;
    internals.initializeAgentComputers(internalChat, [{ id: "builtin:explorer", name: "explorer", description: "Inspect", developerInstructions: "Read only", scope: "built-in", builtIn: true }]);
    expect(internalChat.agentComputers).toHaveLength(2);
    expect(internalChat.agentComputers?.every((seat) => seat.deviceId === state.computerAccess.localDeviceId && seat.isolation === "policy-session")).toBe(true);
  });

  test("records an inconclusive remote receipt as outcome unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-unknown-remote-outcome-"));
    const store = new StateStore(join(directory, "state.json"), directory);
    const state = defaultPersistentState(directory);
    state.computerAccess.grants.files = "allow";
    state.conversations = [conversation(directory, state.computerAccess.localDeviceId)];
    state.activeConversationId = state.conversations[0]!.id;
    await store.save(state);
    const computerAccess = new ComputerAccessService();
    computerAccess.execute = async () => { throw new RemoteActionOutcomeUnknownError("Receipt lost; external outcome is unknown"); };
    const browser: AgentBrowserHost = {
      available: false,
      browse: async () => { throw new Error("unused"); },
      importEvidence: async () => { throw new Error("unused"); },
      removeEvidence: async () => undefined,
      disposeSession: () => undefined,
      disposeAll: () => undefined,
    };
    const controller = new MainController(store, directory, "test", computerAccess, browser);
    await controller.initialize();
    const invoke = controller as unknown as {
      executeComputerTool(conversationId: string, name: "read_file", args: Record<string, unknown>, options: { readOnly: boolean; agentComputer: { agentId: string; agentName: string } }): Promise<unknown>;
    };
    await expect(invoke.executeComputerTool("agent-computer-chat", "read_file", { path: "README.md" }, {
      readOnly: true,
      agentComputer: { agentId: "researcher", agentName: "researcher" },
    })).rejects.toBeInstanceOf(RemoteActionOutcomeUnknownError);
    expect(controller.snapshot().conversations[0]?.agentComputers?.[0]?.actions.at(-1)).toMatchObject({ status: "indeterminate" });
    expect(controller.snapshot().computerAccess.auditLog[0]).toMatchObject({ status: "indeterminate" });
  });

  test("does not delete evidence still referenced by archived computer history when trimming seats", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-archived-seat-evidence-"));
    const archivedPath = join(directory, "archived.png");
    const orphanPath = join(directory, "orphan.png");
    await writeFile(archivedPath, "archived");
    await writeFile(orphanPath, "orphan");
    const store = new StateStore(join(directory, "state.json"), directory);
    const state = defaultPersistentState(directory);
    const chat = conversation(directory, state.computerAccess.localDeviceId);
    const template = chat.agentComputers![0]!;
    chat.agentComputers = Array.from({ length: 40 }, (_, index) => ({
      ...structuredClone(template),
      id: `seat-${index}`,
      agentId: `agent-${index}`,
      agentName: `agent-${index}`,
      evidence: index < 2 ? [{
        id: `evidence-${index}`,
        kind: "screen" as const,
        title: `Frame ${index}`,
        source: "screen",
        localPath: index === 0 ? archivedPath : orphanPath,
        sha256: createHash("sha256").update(index === 0 ? "archived" : "orphan").digest("hex"),
        mimeType: "image/png" as const,
        createdAt: Date.now(),
      }] : [],
    }));
    chat.messages.push({
      id: "archived-turn", role: "user", content: "Earlier turn", provider: "openrouter", createdAt: Date.now(),
      crew: { agentRuns: [], communications: [], tasks: [], meetings: [], activities: [], agentComputers: [structuredClone(chat.agentComputers![0]!)], updatedAt: Date.now() },
    });
    state.conversations = [chat];
    state.activeConversationId = chat.id;
    await store.save(state);
    const removed: string[] = [];
    const browser: AgentBrowserHost = {
      available: true,
      browse: async () => { throw new Error("unused"); },
      importEvidence: async () => { throw new Error("unused"); },
      removeEvidence: async (pathname) => { removed.push(pathname); },
      disposeSession: () => undefined,
      disposeAll: () => undefined,
    };
    const controller = new MainController(store, directory, "test", undefined, browser);
    await controller.initialize();
    const internals = controller as unknown as {
      state: { conversations: Conversation[] };
      initializeAgentComputers(conversation: Conversation, agents: Array<{ id: string; name: string; description: string; developerInstructions: string; scope: "built-in"; builtIn: true }>): void;
    };
    internals.initializeAgentComputers(internals.state.conversations[0]!, [{ id: "builtin:new", name: "new", description: "New seat", developerInstructions: "Read only", scope: "built-in", builtIn: true }]);
    expect(removed).toContain(orphanPath);
    expect(removed).not.toContain(archivedPath);
    await expect(readFile(archivedPath)).resolves.toBeTruthy();
  });

  test("archives only the computers from the turn that just completed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-turn-scoped-computers-"));
    const store = new StateStore(join(directory, "state.json"), directory);
    const state = defaultPersistentState(directory);
    const chat = conversation(directory, state.computerAccess.localDeviceId);
    const firstSeat = { ...structuredClone(chat.agentComputers![0]!), id: "seat-turn-one", agentName: "turn-one-agent" };
    chat.agentComputers = [firstSeat];
    chat.messages = [{ id: "turn-one", role: "user", content: "First turn", provider: "openrouter", createdAt: 1 }];
    chat.lastRunOutcome = "delivered";
    state.conversations = [chat];
    state.activeConversationId = chat.id;
    await store.save(state);
    const browser: AgentBrowserHost = {
      available: false,
      browse: async () => { throw new Error("unused"); },
      importEvidence: async () => { throw new Error("unused"); },
      removeEvidence: async () => undefined,
      disposeSession: () => undefined,
      disposeAll: () => undefined,
    };
    const controller = new MainController(store, directory, "test", undefined, browser);
    await controller.initialize();
    const internals = controller as unknown as {
      state: { conversations: Conversation[] };
      beginRun(conversation: Conversation, text: string, attachments?: []): Promise<void>;
      executeRun(conversationId: string, text: string, attachments: [], controller: AbortController): Promise<void>;
    };
    internals.executeRun = async () => undefined;
    const internalChat = internals.state.conversations[0]!;
    await internals.beginRun(internalChat, "Second turn");
    expect(internalChat.messages[0]?.crew?.agentComputers.map((seat) => seat.id)).toEqual(["seat-turn-one"]);
    expect(internalChat.agentComputers).toEqual([]);

    const secondSeat = { ...structuredClone(firstSeat), id: "seat-turn-two", agentName: "turn-two-agent" };
    internalChat.agentComputers = [secondSeat];
    internalChat.status = "idle";
    internalChat.lastRunOutcome = "delivered";
    await internals.beginRun(internalChat, "Third turn");
    expect(internalChat.messages[1]?.crew?.agentComputers.map((seat) => seat.id)).toEqual(["seat-turn-two"]);
    expect(internalChat.messages[1]?.crew?.agentComputers.some((seat) => seat.id === "seat-turn-one")).toBe(false);
    expect(internalChat.agentComputers).toEqual([]);
  });

  test("waits for unique current and archived computer seats to tear down exactly once at app shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-shutdown-seats-"));
    const store = new StateStore(join(directory, "state.json"), directory);
    const computerAccess = new ComputerAccessService();
    const disposedRemote: string[] = [];
    computerAccess.disposeSeat = async (_state, _deviceId, _conversationId, agentComputerId) => {
      disposedRemote.push(agentComputerId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const disposedLocal: string[] = [];
    let disposeAllCount = 0;
    const browser: AgentBrowserHost = {
      available: false,
      browse: async () => { throw new Error("unused"); },
      importEvidence: async () => { throw new Error("unused"); },
      removeEvidence: async () => undefined,
      disposeSession: (sessionId) => { disposedLocal.push(sessionId); },
      disposeAll: () => { disposeAllCount += 1; },
    };
    const controller = new MainController(store, directory, "test", computerAccess, browser);
    await controller.initialize();
    const internals = controller as unknown as { state: { conversations: Conversation[] } };
    const chat = internals.state.conversations[0]!;
    const template = conversation(directory, "sandbox-shutdown").agentComputers![0]!;
    const current = { ...structuredClone(template), id: "seat-current", conversationId: chat.id };
    const archived = { ...structuredClone(template), id: "seat-archived", conversationId: chat.id };
    chat.agentComputers = [current];
    chat.messages = [{
      id: "turn-with-seats",
      role: "user",
      content: "Run with seats",
      provider: "openrouter",
      createdAt: Date.now(),
      crew: {
        agentRuns: [], communications: [], tasks: [], meetings: [], activities: [],
        agentComputers: [structuredClone(current), archived],
        updatedAt: Date.now(),
      },
    }];
    const firstShutdown = controller.shutdown();
    const secondShutdown = controller.shutdown();
    expect(firstShutdown).toBe(secondShutdown);
    await firstShutdown;
    expect(disposedRemote.sort()).toEqual(["seat-archived", "seat-current"]);
    expect(disposedLocal.sort()).toEqual(["seat-archived", "seat-current"]);
    expect(disposeAllCount).toBe(1);
  });
});
