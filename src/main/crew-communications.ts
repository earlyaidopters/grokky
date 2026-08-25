import type { AgentRun, CrewCommunication, OrchestrationEvent } from "../shared/contracts";

const directMessageTools = /send|message|followup|input|steer/i;
const statusTools = /interrupt|close|stop|shutdown|resume/i;

function runName(threadId: string, runs: AgentRun[]): string | undefined {
  return runs.find((run) => run.threadId === threadId)?.name;
}

function senderName(event: OrchestrationEvent, runs: AgentRun[]): string {
  return event.senderName || runName(event.senderThreadId, runs) || "Grokky lead";
}

function receiverName(threadId: string, explicitName: string | undefined, runs: AgentRun[]): string {
  return explicitName || runName(threadId, runs) || "Specialist";
}

function communication(
  event: OrchestrationEvent,
  values: Omit<CrewCommunication, "operationId" | "tool" | "status" | "createdAt">,
  now: number,
): CrewCommunication {
  return {
    ...values,
    operationId: event.operationId,
    tool: event.tool,
    status: event.status,
    createdAt: now,
  };
}

export function communicationsFromOrchestrationEvent(
  event: OrchestrationEvent,
  runs: AgentRun[],
  now = Date.now(),
): CrewCommunication[] {
  const leadName = senderName(event, runs);

  if (event.tool === "wait") {
    return event.receiverThreads.flatMap((thread) => {
      if (!thread.message) return [];
      const specialistName = receiverName(thread.threadId, thread.name, runs);
      return [communication(event, {
        id: `report:${event.operationId}:${thread.threadId}`,
        kind: "report",
        senderThreadId: thread.threadId,
        senderName: specialistName,
        receiverThreadId: event.senderThreadId,
        receiverName: leadName,
        content: thread.message,
      }, now)];
    });
  }

  if (event.tool === "spawn_agent") {
    return event.receiverThreads.map((thread) => communication(event, {
      id: `assignment:${event.operationId}:${thread.threadId}`,
      kind: "assignment",
      senderThreadId: event.senderThreadId,
      senderName: leadName,
      receiverThreadId: thread.threadId,
      receiverName: receiverName(thread.threadId, thread.name, runs),
      ...(event.prompt ? { content: event.prompt } : {}),
    }, now));
  }

  if (directMessageTools.test(event.tool) || event.prompt) {
    return event.receiverThreads.map((thread) => communication(event, {
      id: `message:${event.operationId}:${thread.threadId}`,
      kind: "message",
      senderThreadId: event.senderThreadId,
      senderName: leadName,
      receiverThreadId: thread.threadId,
      receiverName: receiverName(thread.threadId, thread.name, runs),
      ...(event.prompt ? { content: event.prompt } : {}),
    }, now));
  }

  if (statusTools.test(event.tool)) {
    return event.receiverThreads.map((thread) => communication(event, {
      id: `status:${event.operationId}:${thread.threadId}`,
      kind: "status",
      senderThreadId: event.senderThreadId,
      senderName: leadName,
      receiverThreadId: thread.threadId,
      receiverName: receiverName(thread.threadId, thread.name, runs),
    }, now));
  }

  return [];
}

export function mergeCrewCommunications(
  current: CrewCommunication[],
  incoming: CrewCommunication[],
): CrewCommunication[] {
  const merged = [...current];
  for (const next of incoming) {
    const index = merged.findIndex((item) => item.id === next.id);
    if (index >= 0) merged[index] = { ...next, createdAt: merged[index]!.createdAt };
    else merged.push(next);
  }
  return merged.slice(-80);
}
