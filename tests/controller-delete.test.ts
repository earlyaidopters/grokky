import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MainController } from "../src/main/controller";
import { defaultPersistentState, StateStore } from "../src/main/state-store";
import type { Conversation } from "../src/shared/contracts";

function conversation(id: string, title: string, workingDirectory: string, updatedAt: number): Conversation {
  return {
    id,
    title,
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    sandboxMode: "workspace-write",
    allowCommands: false,
    workingDirectory,
    messages: [{ id: `${id}:message`, role: "user", content: title, createdAt: updatedAt, provider: "codex" }],
    activities: [],
    selectedAgentIds: [],
    agentRuns: [],
    crewCommunications: [],
    status: "idle",
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("conversation deletion", () => {
  test("removes the chat from disk, changes the active chat, and keeps one empty session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-delete-"));
    const pathname = join(directory, "conversations.json");
    const store = new StateStore(pathname, directory);
    const state = defaultPersistentState(directory);
    state.conversations = [conversation("first-chat", "First chat", directory, 2), conversation("second-chat", "Second chat", directory, 1)];
    state.activeConversationId = "first-chat";
    await store.save(state);

    const controller = new MainController(store, directory, "test");
    await controller.initialize();
    await controller.deleteConversation("first-chat");

    const afterFirstDelete = await store.load();
    expect(afterFirstDelete.conversations.map((item) => item.id)).toEqual(["second-chat"]);
    expect(afterFirstDelete.activeConversationId).toBe("second-chat");

    await controller.deleteConversation("second-chat");
    const afterLastDelete = await store.load();
    expect(afterLastDelete.conversations).toHaveLength(1);
    expect(afterLastDelete.conversations[0]?.title).toBe("New session");
    expect(afterLastDelete.activeConversationId).toBe(afterLastDelete.conversations[0]?.id);
  });
});
