import type { AgentDefinition, AgentRun, Conversation, CrewCommunication } from "../../shared/contracts";

const activeStatuses = new Set<AgentRun["status"]>(["starting", "working", "waiting"]);

export function crewRunsForDisplay(conversation: Conversation, agents: AgentDefinition[]): AgentRun[] {
  if (conversation.status !== "running" || !conversation.selectedAgentIds.length) return conversation.agentRuns;

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const confirmed = conversation.agentRuns;
  const representedNames = new Set(confirmed.map((run) => run.name.trim().toLowerCase()));
  const waiting = conversation.selectedAgentIds.flatMap((agentId): AgentRun[] => {
    const agent = byId.get(agentId);
    const name = agent?.name || agentId.split(":").at(-1) || "crew member";
    if (representedNames.has(name.trim().toLowerCase())) return [];
    const prefix = confirmed.length ? "queued" : "unconfirmed";
    return [{
      id: `${prefix}:${agentId}`,
      operationId: `${prefix}:${agentId}`,
      threadId: `${prefix}:${agentId}`,
      name: agent?.name || agentId.split(":").at(-1) || "crew member",
      task: agent?.description || "Waiting for a delegated task",
      status: "starting" as const,
      ...(agent?.icon ? { icon: agent.icon } : {}),
      createdAt: conversation.updatedAt,
      updatedAt: conversation.updatedAt,
    }];
  });
  return [...confirmed, ...waiting];
}

export function crewRunStage(conversation: Conversation, runs: AgentRun[]): "starting" | "parallel" | "synthesizing" | "complete" {
  if (conversation.status !== "running") return "complete";
  if (conversation.status === "running" && !conversation.agentRuns.length) return "starting";
  if (runs.some((run) => activeStatuses.has(run.status))) return "parallel";
  if (conversation.status === "running" && runs.length) return "synthesizing";
  return "complete";
}

export interface CrewCommunicationGroup {
  senderThreadId: string;
  senderName: string;
  entries: CrewCommunication[];
}

export function groupCrewCommunications(communications: CrewCommunication[]): CrewCommunicationGroup[] {
  const ordered = [...communications].sort((left, right) => left.createdAt - right.createdAt);
  return ordered.reduce<CrewCommunicationGroup[]>((groups, entry) => {
    const latest = groups.at(-1);
    if (latest?.senderThreadId === entry.senderThreadId) {
      latest.entries.push(entry);
      return groups;
    }
    groups.push({ senderThreadId: entry.senderThreadId, senderName: entry.senderName, entries: [entry] });
    return groups;
  }, []);
}
