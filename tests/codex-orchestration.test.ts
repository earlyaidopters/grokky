import { describe, expect, test } from "vitest";
import { orchestrationFromThreadEvent } from "../src/main/providers/codex-provider";

describe("Codex collaboration event mapping", () => {
  test("maps raw SDK spawn and wait events into inspectable crew state", () => {
    const agents = [{
      id: "builtin:explorer",
      name: "explorer",
      description: "Explore",
      developerInstructions: "Read only",
      scope: "built-in" as const,
      builtIn: true,
    }];
    const event = orchestrationFromThreadEvent({
      type: "item.completed",
      item: {
        id: "call_1",
        type: "collab_tool_call",
        tool: "wait",
        sender_thread_id: "parent_1",
        receiver_thread_ids: ["child_1"],
        agents_states: { child_1: { status: "completed", message: "Found the entry point." } },
        status: "completed",
      },
    }, agents);

    expect(event).toEqual({
      operationId: "call_1",
      tool: "wait",
      senderThreadId: "parent_1",
      receiverThreads: [{ threadId: "child_1", name: "explorer", status: "completed", message: "Found the entry point." }],
      status: "completed",
    });
  });

  test("ignores non-collaboration SDK items", () => {
    expect(orchestrationFromThreadEvent({ type: "item.completed", item: { type: "agent_message" } })).toBeNull();
  });

  test("maps the keyed child states emitted by the Codex runtime", () => {
    const agents = [{
      id: "builtin:reviewer",
      name: "reviewer",
      description: "Review",
      developerInstructions: "Report evidence",
      scope: "built-in" as const,
      builtIn: true,
    }];
    const event = orchestrationFromThreadEvent({
      type: "item.completed",
      item: {
        id: "exec_1",
        type: "collab_tool_call",
        tool: "wait",
        sender_thread_id: "lead_1",
        receiver_thread_ids: ["child_1"],
        receiver_agents: [{ thread_id: "child_1", agent_nickname: "Curie", agent_role: "reviewer" }],
        agents_states: { child_1: { completed: "Found the exact regression." } },
        status: "completed",
      },
    }, agents);

    expect(event?.receiverThreads).toEqual([{
      threadId: "child_1",
      name: "reviewer",
      status: "completed",
      message: "Found the exact regression.",
    }]);
  });

  test("preserves the runtime pending state from a spawn event", () => {
    const event = orchestrationFromThreadEvent({
      type: "item.completed",
      item: {
        id: "spawn_1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        sender_thread_id: "lead_1",
        receiver_thread_ids: ["child_1"],
        receiver_agents: [{ thread_id: "child_1", agent_role: "explorer" }],
        agents_states: { child_1: "pending_init" },
        prompt: "Trace the renderer.",
        status: "completed",
      },
    });

    expect(event?.receiverThreads).toEqual([{ threadId: "child_1", name: "explorer", status: "pending_init" }]);
  });
});
