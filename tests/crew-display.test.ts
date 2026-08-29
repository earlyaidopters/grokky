import { describe, expect, it } from "vitest";
import type { AgentDefinition, Conversation, CrewCommunication } from "../src/shared/contracts";
import { crewRunsForDisplay, crewRunStage, groupCrewCommunications } from "../src/renderer/src/crew-display";

const agents: AgentDefinition[] = [
  { id: "builtin:explorer", name: "explorer", description: "Trace the code path", developerInstructions: "Read only", scope: "built-in", builtIn: true, icon: "cyan" },
  { id: "builtin:worker", name: "worker", description: "Implement the change", developerInstructions: "Make the fix", scope: "built-in", builtIn: true, icon: "coral" },
];

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation",
    title: "Crew test",
    instructions: "",
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    sandboxMode: "workspace-write",
    allowCommands: false,
    projectMode: "project",
    workingDirectory: "/tmp",
    messages: [],
    queuedMessages: [],
    activities: [],
    selectedAgentIds: agents.map((agent) => agent.id),
    agentRuns: [],
    crewCommunications: [],
    status: "running",
    unreadCount: 0,
    lastViewedAt: 2,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

describe("crew display state", () => {
  it("shows every selected agent immediately while delegation starts", () => {
    const runs = crewRunsForDisplay(conversation(), agents);
    expect(runs.map((run) => [run.name, run.status, run.icon])).toEqual([
      ["explorer", "starting", "cyan"],
      ["worker", "starting", "coral"],
    ]);
    expect(runs.every((run) => run.id.startsWith("unconfirmed:"))).toBe(true);
    expect(crewRunStage(conversation(), runs)).toBe("starting");
  });

  it("orders messages and groups only consecutive sends from the same speaker", () => {
    const communication = (id: string, senderThreadId: string, senderName: string, createdAt: number): CrewCommunication => ({
      id,
      operationId: id,
      tool: "send_message",
      kind: "message",
      senderThreadId,
      senderName,
      receiverThreadId: "lead",
      receiverName: "Grokky lead",
      content: id,
      status: "completed",
      createdAt,
    });
    const groups = groupCrewCommunications([
      communication("explorer-report", "explorer", "explorer", 30),
      communication("worker-assignment", "lead", "Grokky lead", 20),
      communication("explorer-assignment", "lead", "Grokky lead", 10),
      communication("worker-report", "worker", "worker", 40),
      communication("lead-followup", "lead", "Grokky lead", 50),
    ]);
    expect(groups.map((group) => [group.senderName, group.entries.map((entry) => entry.id)])).toEqual([
      ["Grokky lead", ["explorer-assignment", "worker-assignment"]],
      ["explorer", ["explorer-report"]],
      ["worker", ["worker-report"]],
      ["Grokky lead", ["lead-followup"]],
    ]);
  });

  it("keeps dependent specialists visible while confirmed work is live", () => {
    const live = [{
      id: "child",
      operationId: "spawn",
      threadId: "child",
      name: "explorer",
      task: "Inspect the renderer",
      status: "working" as const,
      createdAt: 3,
      updatedAt: 4,
    }];
    const current = conversation({ agentRuns: live });
    const runs = crewRunsForDisplay(current, agents);
    expect(runs[0]).toBe(live[0]);
    expect(runs.map((run) => [run.name, run.id.startsWith("queued:")])).toEqual([
      ["explorer", false],
      ["worker", true],
    ]);
    expect(crewRunStage(current, runs)).toBe("parallel");
  });

  it("shows the lead synthesis phase after specialists report back", () => {
    const finished = [{
      id: "child",
      operationId: "wait",
      threadId: "child",
      name: "explorer",
      task: "Inspect the renderer",
      status: "completed" as const,
      result: "Found the relevant component",
      createdAt: 3,
      updatedAt: 4,
    }];
    const current = conversation({ agentRuns: finished });
    expect(crewRunStage(current, finished)).toBe("synthesizing");
    expect(crewRunStage({ ...current, status: "idle" }, finished)).toBe("complete");
    expect(crewRunsForDisplay({ ...current, status: "idle" }, agents)).toBe(finished);
  });

  it("never leaves a blocked finished run visually live", () => {
    const unfinished = [{
      id: "child",
      operationId: "spawn",
      threadId: "child",
      name: "worker",
      task: "Return a final report",
      status: "working" as const,
      createdAt: 3,
      updatedAt: 4,
    }];
    expect(crewRunStage(conversation({ status: "idle", lastRunOutcome: "blocked", agentRuns: unfinished }), unfinished)).toBe("complete");
  });
});
