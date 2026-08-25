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
});
