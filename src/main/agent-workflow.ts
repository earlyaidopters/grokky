import type {
  AgentMeeting,
  AgentMeetingContribution,
  AgentRun,
  AgentTask,
  AgentTaskStatus,
  OrchestrationEvent,
} from "../shared/contracts";

const directMessageTools = /send|message|followup|input|steer/i;
const activeRunStatuses = new Set<AgentRun["status"]>(["starting", "working", "waiting"]);
const activeTaskStatuses = new Set<AgentTaskStatus>(["assigned", "working", "waiting"]);

function confirmedRuns(runs: AgentRun[]): AgentRun[] {
  return runs.filter((run) => !/^(?:pending|queued|unconfirmed):/.test(run.id));
}

function compactTitle(value: string, fallback: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (!oneLine) return fallback;
  return oneLine.length > 76 ? `${oneLine.slice(0, 75).trimEnd()}…` : oneLine;
}

function taskStatus(value: string, eventStatus: OrchestrationEvent["status"]): AgentTaskStatus {
  if (/complete|done/i.test(value)) return "completed";
  if (/fail|error|not_found/i.test(value)) return "failed";
  if (/stop|shutdown|close|interrupt/i.test(value)) return "stopped";
  if (/wait/i.test(value)) return "waiting";
  if (/pending|init|start/i.test(value)) return "assigned";
  if (eventStatus === "failed") return "failed";
  return "working";
}

function runName(threadId: string, runs: AgentRun[], fallback = "Specialist"): string {
  return runs.find((run) => run.threadId === threadId)?.name || fallback;
}

function criteriaFrom(instructions: string): string[] {
  return instructions
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•\d.)\s]+/, ""))
    .filter((line) => /(?:verify|confirm|must|accept|return|report|evidence|test)/i.test(line))
    .slice(0, 6);
}

function cleanOutcome(value: string): string {
  return value
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function outcomesFromBlock(lines: string[]): string[] {
  const firstContent = lines.findIndex((line) => line.trim());
  if (firstContent < 0) return [];
  const first = lines[firstContent]!;
  const listItem = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;

  if (listItem.test(first)) {
    const outcomes: string[] = [];
    let current: string[] = [];
    const flush = () => {
      const outcome = cleanOutcome(current.join(" "));
      if (outcome && !outcomes.includes(outcome)) outcomes.push(outcome);
      current = [];
    };
    for (const line of lines.slice(firstContent)) {
      const match = line.match(listItem);
      if (match) {
        flush();
        current.push(match[1]!);
      } else if (line.trim() && current.length) {
        current.push(line.trim());
      }
    }
    flush();
    return outcomes;
  }

  const block: string[] = [];
  for (const line of lines.slice(firstContent)) {
    if (!line.trim() && block.length) break;
    if (line.trim()) block.push(line);
  }
  const outcome = cleanOutcome(block.join(" "));
  return outcome ? [outcome] : [];
}

export function meetingOutcomesFromFinal(content: string): { decisions: string[]; actionItems: string[] } {
  const lines = content.split("\n");
  const decisions: string[] = [];
  const actionItems: string[] = [];
  const labelFor = (line: string): "decision" | "action" | undefined => {
    const label = line.trim().replace(/^#{1,6}\s*/, "").replace(/^\*\*|\*\*:?$/g, "").replace(/:$/, "").trim().toLowerCase();
    if (/^(?:agreed (?:precise )?wording|decision|decisions|consensus|agreement)$/.test(label)) return "decision";
    if (/^(?:agreed )?(?:next actions?|action items?)$/.test(label)) return "action";
    return undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const kind = labelFor(lines[index]!);
    if (!kind) continue;
    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!;
      if (labelFor(line) || /^\s*#{1,6}\s+/.test(line) || (/^\s*\*\*[^*]+\*\*\s*:?[\s]*$/.test(line) && block.length)) break;
      block.push(line);
      index = cursor;
    }
    const target = kind === "decision" ? decisions : actionItems;
    for (const outcome of outcomesFromBlock(block)) {
      if (!target.includes(outcome)) target.push(outcome);
    }
  }

  return { decisions: decisions.slice(0, 6), actionItems: actionItems.slice(0, 6) };
}

export function mergeAgentTasks(current: AgentTask[], incoming: AgentTask[]): AgentTask[] {
  const merged = [...current];
  for (const next of incoming) {
    const index = merged.findIndex((task) => task.id === next.id);
    if (index >= 0) merged[index] = { ...next, createdAt: merged[index]!.createdAt };
    else merged.push(next);
  }
  return merged.slice(-80);
}

export function tasksFromOrchestrationEvent(
  event: OrchestrationEvent,
  runs: AgentRun[],
  current: AgentTask[],
  now = Date.now(),
): AgentTask[] {
  const fromName = event.senderName || runName(event.senderThreadId, runs, "Grokky lead");

  if (event.tool === "wait") {
    return event.receiverThreads.flatMap((thread) => {
      const existing = [...current].reverse().find((task) => task.toThreadId === thread.threadId && activeTaskStatuses.has(task.status));
      if (!existing) return [];
      const status = taskStatus(thread.status, event.status);
      return [{
        ...existing,
        status,
        ...(thread.message ? { result: thread.message } : {}),
        updatedAt: now,
      }];
    });
  }

  if (event.tool !== "spawn_agent" && !directMessageTools.test(event.tool) && !event.prompt) return [];

  return event.receiverThreads.map((thread) => {
    const toName = thread.name || runName(thread.threadId, runs);
    const activeAssignment = event.tool !== "spawn_agent"
      ? [...current].reverse().find((task) => task.toThreadId === thread.threadId && task.fromThreadId === event.senderThreadId && activeTaskStatuses.has(task.status))
      : undefined;
    if (activeAssignment) {
      return {
        ...activeAssignment,
        ...(event.prompt?.trim() ? {
          instructions: event.prompt.trim(),
          acceptanceCriteria: criteriaFrom(event.prompt.trim()),
        } : {}),
        status: taskStatus(thread.status, event.status),
        updatedAt: now,
      };
    }
    const instructions = event.prompt?.trim()
      || (event.tool === "spawn_agent" ? `Complete the assigned ${toName} work and report evidence.` : "Provide the requested follow-up contribution.");
    const existing = event.tool === "spawn_agent"
      ? current.find((task) => task.id === `task:${event.operationId}:${thread.threadId}`)
      : undefined;
    const id = existing?.id || `${event.tool === "spawn_agent" ? "task" : "handoff"}:${event.operationId}:${thread.threadId}`;
    return {
      id,
      operationId: event.operationId,
      fromThreadId: event.senderThreadId,
      fromName,
      toThreadId: thread.threadId,
      toName,
      title: compactTitle(instructions, `${event.tool === "spawn_agent" ? "Assignment" : "Handoff"} for ${toName}`),
      instructions,
      acceptanceCriteria: criteriaFrom(instructions),
      status: taskStatus(thread.status, event.status),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  });
}

function meetingContribution(
  event: OrchestrationEvent,
  threadId: string,
  speakerName: string,
  content: string,
  kind: AgentMeetingContribution["kind"],
  now: number,
): AgentMeetingContribution {
  return {
    id: `meeting-turn:${event.operationId}:${threadId}:${kind}`,
    speakerThreadId: threadId,
    speakerName,
    kind,
    content,
    createdAt: now,
  };
}

export function updateMeetingFromOrchestration(
  event: OrchestrationEvent,
  runs: AgentRun[],
  meeting: AgentMeeting,
  now = Date.now(),
): AgentMeeting {
  const contributions = [...meeting.contributions];
  const append = (contribution: AgentMeetingContribution) => {
    const index = contributions.findIndex((item) => item.id === contribution.id);
    if (index >= 0) contributions[index] = contribution;
    else contributions.push(contribution);
  };

  if (event.tool === "wait") {
    for (const thread of event.receiverThreads) {
      if (!thread.message) continue;
      append(meetingContribution(event, thread.threadId, thread.name || runName(thread.threadId, runs), thread.message, "response", now));
    }
  } else if (directMessageTools.test(event.tool) && event.receiverThreads.length) {
    const speakerName = event.senderName || runName(event.senderThreadId, runs, "Grokky lead");
    const receiverNames = event.receiverThreads.map((thread) => thread.name || runName(thread.threadId, runs)).join(", ");
    const contribution = meetingContribution(
      event,
      event.senderThreadId,
      speakerName,
      event.prompt?.trim() || `${speakerName} requested a follow-up contribution from ${receiverNames}.`,
      meeting.contributions.length ? "challenge" : "opening",
      now,
    );
    if (!event.prompt?.trim()) {
      const receivers = event.receiverThreads.map((thread) => thread.threadId).sort().join(",");
      contribution.id = `meeting-turn:followup:${event.senderThreadId}:${receivers}`;
    }
    append(contribution);
  }

  const participantThreads = new Set(meeting.participantThreadIds);
  const participantNames = new Set(meeting.participantNames);
  for (const run of confirmedRuns(runs)) {
    participantThreads.add(run.threadId);
    participantNames.add(run.name);
  }
  return {
    ...meeting,
    participantThreadIds: [...participantThreads],
    participantNames: [...participantNames],
    contributions: contributions.slice(-40),
    updatedAt: now,
  };
}

export function finalizeAgentWorkflow(
  tasks: AgentTask[],
  meetings: AgentMeeting[],
  runs: AgentRun[],
  now = Date.now(),
  finalAnswer = "",
): { tasks: AgentTask[]; meetings: AgentMeeting[] } {
  const runByThread = new Map(runs.map((run) => [run.threadId, run]));
  const finalizedTasks = tasks.map((task) => {
    if (!new Set<AgentTaskStatus>(["assigned", "working", "waiting"]).has(task.status)) return task;
    const run = runByThread.get(task.toThreadId);
    const belongsToRun = run?.operationId === task.operationId;
    if (belongsToRun && run.status === "completed") return { ...task, status: "completed" as const, ...(run.result ? { result: run.result } : {}), updatedAt: now };
    if (belongsToRun && run.status === "failed") return { ...task, status: "failed" as const, ...(run.result ? { result: run.result } : {}), updatedAt: now };
    return { ...task, status: "stopped" as const, result: task.result || "The run ended before this task produced a confirmed report.", updatedAt: now };
  });
  const finalizedMeetings = meetings.map((meeting) => {
    if (meeting.status !== "live") return meeting;
    const participantRuns = meeting.participantThreadIds.map((threadId) => runByThread.get(threadId)).filter(Boolean) as AgentRun[];
    const reviewStartIndex = meeting.contributions.findLastIndex((contribution) => contribution.kind === "opening" || contribution.kind === "challenge");
    const responseThreads = new Set(meeting.contributions
      .slice(reviewStartIndex + 1)
      .filter((contribution) => contribution.kind === "response")
      .map((contribution) => contribution.speakerThreadId));
    const complete = participantRuns.length > 0
      && participantRuns.length === meeting.participantThreadIds.length
      && participantRuns.every((run) => run.status === "completed")
      && reviewStartIndex >= 0
      && meeting.participantThreadIds.every((threadId) => responseThreads.has(threadId));
    const outcomes = complete ? meetingOutcomesFromFinal(finalAnswer) : { decisions: [], actionItems: [] };
    return {
      ...meeting,
      status: complete ? "completed" as const : "incomplete" as const,
      decisions: [...new Set([...meeting.decisions, ...outcomes.decisions])],
      actionItems: [...new Set([...meeting.actionItems, ...outcomes.actionItems])],
      updatedAt: now,
    };
  });
  return { tasks: finalizedTasks, meetings: finalizedMeetings };
}

export function hasActiveAgentRuns(runs: AgentRun[]): boolean {
  return runs.some((run) => activeRunStatuses.has(run.status));
}
