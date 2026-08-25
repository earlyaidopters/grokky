import { describe, expect, it } from "vitest";
import type { AgentDefinition, Conversation } from "../src/shared/contracts";
import { crewRunsForDisplay, crewRunStage } from "../src/renderer/src/crew-display";

const agents: AgentDefinition[] = [
  { id: "builtin:explorer", name: "explorer", description: "Trace the code path", developerInstructions: "Read only", scope: "built-in", builtIn: true, icon: "cyan" },
  { id: "builtin:worker", name: "worker", description: "Implement the change", developerInstructions: "Make the fix", scope: "built-in", builtIn: true, icon: "coral" },
];

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation",
    title: "Crew test",
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    sandboxMode: "workspace-write",
    allowCommands: false,
    workingDirectory: "/tmp",
    messages: [],
    activities: [],
    selectedAgentIds: agents.map((agent) => agent.id),
    agentRuns: [],
    status: "running",
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
    expect(crewRunStage(conversation(), runs)).toBe("starting");
  });

  it("uses live provider runs once orchestration events arrive", () => {
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
    expect(crewRunsForDisplay(current, agents)).toBe(live);
    expect(crewRunStage(current, live)).toBe("parallel");
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
  });
});
