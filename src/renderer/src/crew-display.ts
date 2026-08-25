import type { AgentDefinition, AgentRun, Conversation } from "../../shared/contracts";

const activeStatuses = new Set<AgentRun["status"]>(["starting", "working", "waiting"]);

export function crewRunsForDisplay(conversation: Conversation, agents: AgentDefinition[]): AgentRun[] {
  if (conversation.agentRuns.length) return conversation.agentRuns;
  if (conversation.status !== "running" || !conversation.selectedAgentIds.length) return [];

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return conversation.selectedAgentIds.map((agentId) => {
    const agent = byId.get(agentId);
    return {
      id: `queued:${agentId}`,
      operationId: `queued:${agentId}`,
      threadId: `queued:${agentId}`,
      name: agent?.name || agentId.split(":").at(-1) || "crew member",
      task: agent?.description || "Waiting for a delegated task",
      status: "starting" as const,
      ...(agent?.icon ? { icon: agent.icon } : {}),
      createdAt: conversation.updatedAt,
      updatedAt: conversation.updatedAt,
    };
  });
}

export function crewRunStage(conversation: Conversation, runs: AgentRun[]): "starting" | "parallel" | "synthesizing" | "complete" {
  if (conversation.status === "running" && !conversation.agentRuns.length) return "starting";
  if (runs.some((run) => activeStatuses.has(run.status))) return "parallel";
  if (conversation.status === "running" && runs.length) return "synthesizing";
  return "complete";
}
