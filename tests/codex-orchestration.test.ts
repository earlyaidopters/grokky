import { describe, expect, test } from "vitest";
import { orchestrationFromThreadEvent } from "../src/main/providers/codex-provider";
import { createCodexRolloutParseState, orchestrationFromRolloutRecord } from "../src/main/providers/codex-rollout-observer";

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

describe("Codex Sol rollout collaboration mapping", () => {
  const agents = [{
    id: "builtin:explorer",
    name: "explorer",
    description: "Trace the renderer and report evidence.",
    developerInstructions: "Read only",
    scope: "built-in" as const,
    builtIn: true,
  }];

  test("maps a confirmed v2 child thread and its final report", () => {
    const state = createCodexRolloutParseState();
    expect(orchestrationFromRolloutRecord({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call_1",
        arguments: JSON.stringify({ agent_type: "explorer", task_name: "trace_renderer", message: "encrypted" }),
      },
    }, "root_1", agents, state)).toEqual([]);

    expect(orchestrationFromRolloutRecord({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "SubAgentActivity", id: "call_1", kind: "started", agent_thread_id: "child_1", agent_path: "/root/trace_renderer" },
      },
    }, "root_1", agents, state)).toEqual([{
      operationId: "call_1",
      tool: "spawn_agent",
      senderThreadId: "root_1",
      senderName: "Grokky lead",
      receiverThreads: [{ threadId: "child_1", name: "explorer", status: "running" }],
      prompt: "Trace the renderer and report evidence.",
      status: "running",
    }]);

    expect(orchestrationFromRolloutRecord({
      type: "response_item",
      payload: {
        type: "agent_message",
        id: "message_1",
        author: "/root/trace_renderer",
        recipient: "/root",
        content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/trace_renderer\nPayload:\nFound the renderer." }],
      },
    }, "root_1", agents, state)).toEqual([{
      operationId: "message_1",
      tool: "wait",
      senderThreadId: "root_1",
      senderName: "Grokky lead",
      receiverThreads: [{ threadId: "child_1", name: "explorer", status: "completed", message: "Found the renderer." }],
      status: "completed",
    }]);
  });

  test("ignores encrypted intermediate child messages and duplicate starts", () => {
    const state = createCodexRolloutParseState();
    orchestrationFromRolloutRecord({ type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "call_1", arguments: "{}" } }, "root_1", agents, state);
    const started = { type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", id: "call_1", kind: "started", agent_thread_id: "child_1", agent_path: "/root/task" } } };
    expect(orchestrationFromRolloutRecord(started, "root_1", agents, state)).toHaveLength(1);
    expect(orchestrationFromRolloutRecord(started, "root_1", agents, state)).toEqual([]);
    expect(orchestrationFromRolloutRecord({
      type: "response_item",
      payload: { type: "agent_message", id: "message_1", author: "/root/task", content: [{ type: "encrypted_content", encrypted_content: "ciphertext" }] },
    }, "root_1", agents, state)).toEqual([]);
  });
});
