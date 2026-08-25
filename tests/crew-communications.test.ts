import { describe, expect, test } from "vitest";
import { communicationsFromOrchestrationEvent, mergeCrewCommunications } from "../src/main/crew-communications";
import type { AgentRun, OrchestrationEvent } from "../src/shared/contracts";

const runs: AgentRun[] = [
  { id: "explorer", operationId: "spawn-a", threadId: "child-a", name: "explorer", task: "Trace the renderer", status: "working", createdAt: 1, updatedAt: 1 },
  { id: "reviewer", operationId: "spawn-b", threadId: "child-b", name: "reviewer", task: "Verify the result", status: "working", createdAt: 1, updatedAt: 1 },
];

function event(patch: Partial<OrchestrationEvent>): OrchestrationEvent {
  return {
    operationId: "operation",
    tool: "spawn_agent",
    senderThreadId: "lead",
    senderName: "Grokky lead",
    receiverThreads: [],
    status: "completed",
    ...patch,
  };
}

describe("crew communication ledger", () => {
  test("records an exact lead assignment", () => {
    const entries = communicationsFromOrchestrationEvent(event({
      receiverThreads: [{ threadId: "child-a", name: "explorer", status: "pending_init" }],
      prompt: "Trace the renderer and cite the relevant component.",
    }), runs, 20);

    expect(entries).toEqual([expect.objectContaining({
      kind: "assignment",
      senderName: "Grokky lead",
      receiverName: "explorer",
      content: "Trace the renderer and cite the relevant component.",
      createdAt: 20,
    })]);
  });

  test("reverses the route when a specialist reports to the lead", () => {
    const entries = communicationsFromOrchestrationEvent(event({
      tool: "wait",
      receiverThreads: [{ threadId: "child-a", name: "explorer", status: "completed", message: "The state mapper drops keyed completion values." }],
    }), runs, 30);

    expect(entries).toEqual([expect.objectContaining({
      kind: "report",
      senderThreadId: "child-a",
      senderName: "explorer",
      receiverThreadId: "lead",
      receiverName: "Grokky lead",
      content: "The state mapper drops keyed completion values.",
    })]);
  });

  test("records a real specialist direct message without inventing a report", () => {
    const entries = communicationsFromOrchestrationEvent(event({
      operationId: "message-1",
      tool: "send_message",
      senderThreadId: "child-a",
      senderName: "explorer",
      receiverThreads: [{ threadId: "child-b", name: "reviewer", status: "working" }],
      prompt: "Please verify the parser against the raw event fixture.",
    }), runs, 40);

    expect(entries).toEqual([expect.objectContaining({
      kind: "message",
      senderName: "explorer",
      receiverName: "reviewer",
      content: "Please verify the parser against the raw event fixture.",
    })]);
  });

  test("updates an existing exchange while preserving its first timestamp", () => {
    const first = communicationsFromOrchestrationEvent(event({
      status: "running",
      receiverThreads: [{ threadId: "child-a", name: "explorer", status: "pending_init" }],
      prompt: "Trace the renderer.",
    }), runs, 50);
    const completed = communicationsFromOrchestrationEvent(event({
      receiverThreads: [{ threadId: "child-a", name: "explorer", status: "working" }],
      prompt: "Trace the renderer.",
    }), runs, 60);

    expect(mergeCrewCommunications(first, completed)).toEqual([expect.objectContaining({ status: "completed", createdAt: 50 })]);
  });
});
