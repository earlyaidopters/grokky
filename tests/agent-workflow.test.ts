import { describe, expect, test } from "vitest";
import { finalizeAgentWorkflow, meetingOutcomesFromFinal, mergeAgentTasks, tasksFromOrchestrationEvent, updateMeetingFromOrchestration } from "../src/main/agent-workflow";
import type { AgentMeeting, AgentRun, AgentTask, OrchestrationEvent } from "../src/shared/contracts";

const runs: AgentRun[] = [
  { id: "explorer", operationId: "spawn-1", threadId: "thread-explorer", name: "explorer", task: "Inspect package.json", status: "working", createdAt: 1, updatedAt: 1 },
  { id: "worker", operationId: "spawn-2", threadId: "thread-worker", name: "worker", task: "Run the selected command", status: "working", createdAt: 1, updatedAt: 1 },
];

function event(patch: Partial<OrchestrationEvent> = {}): OrchestrationEvent {
  return {
    operationId: "spawn-1",
    tool: "spawn_agent",
    senderThreadId: "lead",
    senderName: "Grokky lead",
    receiverThreads: [{ threadId: "thread-explorer", name: "explorer", status: "running" }],
    prompt: "Inspect package.json and report one exact test command with evidence.",
    status: "completed",
    ...patch,
  };
}

describe("typed agent workflow", () => {
  test("turns a real spawn and report into one task lifecycle", () => {
    const assigned = tasksFromOrchestrationEvent(event(), runs, [], 10);
    expect(assigned).toEqual([expect.objectContaining({ toName: "explorer", status: "working", title: "Inspect package.json and report one exact test command with evidence." })]);

    const current = mergeAgentTasks([], assigned);
    const completed = tasksFromOrchestrationEvent(event({
      operationId: "report-1",
      tool: "wait",
      receiverThreads: [{ threadId: "thread-explorer", name: "explorer", status: "completed", message: "Use npm test." }],
    }), runs, current, 20);
    expect(mergeAgentTasks(current, completed)).toEqual([expect.objectContaining({ status: "completed", result: "Use npm test.", createdAt: 10, updatedAt: 20 })]);
  });

  test("records observed meeting contributions and refuses false consensus", () => {
    const meeting: AgentMeeting = {
      id: "meeting-1",
      title: "Review",
      agenda: "Challenge the evidence",
      participantThreadIds: runs.map((run) => run.threadId),
      participantNames: runs.map((run) => run.name),
      status: "live",
      contributions: [],
      decisions: [],
      actionItems: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const challenged = updateMeetingFromOrchestration(event({
      operationId: "followup-1",
      tool: "followup_task",
      receiverThreads: [{ threadId: "thread-worker", name: "worker", status: "working" }],
      prompt: "Challenge the command provenance before agreeing.",
    }), runs, meeting, 20);
    expect(challenged.contributions).toEqual([expect.objectContaining({ speakerName: "Grokky lead", kind: "opening", content: "Challenge the command provenance before agreeing." })]);

    const finalized = finalizeAgentWorkflow([], [challenged], [
      { ...runs[0]!, status: "completed" },
      { ...runs[1]!, status: "stopped" },
    ], 30);
    expect(finalized.meetings[0]).toMatchObject({ status: "incomplete", decisions: [], actionItems: [] });
  });

  test("stops unfinished tasks when the lead turn ends", () => {
    const tasks = tasksFromOrchestrationEvent(event(), runs, [], 10);
    const finalized = finalizeAgentWorkflow(tasks, [], [{ ...runs[0]!, status: "stopped" }, runs[1]!], 40);
    expect(finalized.tasks[0]).toMatchObject({ status: "stopped", result: "The run ended before this task produced a confirmed report." });
  });

  test("does not complete a later task from an earlier completed run on the same thread", () => {
    const reviewTask: AgentTask = {
      id: "task:meeting-1:thread-explorer",
      operationId: "meeting-1",
      fromThreadId: "lead",
      fromName: "Grokky lead",
      toThreadId: "thread-explorer",
      toName: "explorer",
      title: "Challenge the crew evidence",
      instructions: "Review the other specialist report and return a challenge.",
      acceptanceCriteria: ["Return one challenge"],
      status: "working",
      createdAt: 20,
      updatedAt: 20,
    };
    const completedRun = { ...runs[0]!, status: "completed" as const, result: "Initial specialist report" };

    const finalized = finalizeAgentWorkflow([reviewTask], [], [completedRun], 40);

    expect(finalized.tasks[0]).toMatchObject({
      status: "stopped",
      result: "The run ended before this task produced a confirmed report.",
    });

    const matchingAssignment = { ...reviewTask, id: "task:spawn-1:thread-explorer", operationId: "spawn-1" };
    const completed = finalizeAgentWorkflow([matchingAssignment], [], [completedRun], 41);
    expect(completed.tasks[0]).toMatchObject({ status: "completed", result: "Initial specialist report" });
  });

  test("requires every meeting response to follow the latest opening or challenge", () => {
    const meeting: AgentMeeting = {
      id: "meeting-1",
      title: "Review",
      agenda: "Challenge the evidence",
      participantThreadIds: runs.map((run) => run.threadId),
      participantNames: runs.map((run) => run.name),
      status: "live",
      contributions: [
        { id: "response-1", speakerThreadId: "thread-explorer", speakerName: "explorer", kind: "response", content: "Initial report", createdAt: 10 },
        { id: "response-2", speakerThreadId: "thread-worker", speakerName: "worker", kind: "response", content: "Initial report", createdAt: 11 },
        { id: "challenge", speakerThreadId: "lead", speakerName: "Grokky lead", kind: "challenge", content: "Challenge the provenance.", createdAt: 20 },
        { id: "late-response-1", speakerThreadId: "thread-explorer", speakerName: "explorer", kind: "response", content: "Verified provenance", createdAt: 21 },
      ],
      decisions: [],
      actionItems: [],
      createdAt: 1,
      updatedAt: 21,
    };
    const completedRuns = runs.map((run) => ({ ...run, status: "completed" as const }));

    const incomplete = finalizeAgentWorkflow([], [meeting], completedRuns, 30, "**Decision:**\nShip it.");
    expect(incomplete.meetings[0]).toMatchObject({ status: "incomplete", decisions: [] });

    const completedMeeting = {
      ...meeting,
      contributions: [
        ...meeting.contributions,
        { id: "late-response-2", speakerThreadId: "thread-worker", speakerName: "worker", kind: "response" as const, content: "Provenance accepted", createdAt: 22 },
      ],
    };
    const completed = finalizeAgentWorkflow([], [completedMeeting], completedRuns, 31, "**Decision:**\nShip it.");
    expect(completed.meetings[0]).toMatchObject({ status: "completed", decisions: ["Ship it."] });
  });

  test("folds lead follow-ups into the existing assignment instead of creating task spam", () => {
    const assigned = tasksFromOrchestrationEvent(event(), runs, [], 10);
    const followup = tasksFromOrchestrationEvent(event({
      operationId: "followup-1",
      tool: "followup_task",
      receiverThreads: [{ threadId: "thread-explorer", name: "explorer", status: "working" }],
      prompt: undefined,
    }), runs, assigned, 20);
    const merged = mergeAgentTasks(assigned, followup);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: assigned[0]!.id, title: assigned[0]!.title, status: "working", updatedAt: 20 });
  });

  test("folds repeated encrypted meeting follow-ups and extracts only explicit outcomes", () => {
    const meeting: AgentMeeting = {
      id: "meeting-1", title: "Review", agenda: "Agree wording",
      participantThreadIds: runs.map((run) => run.threadId), participantNames: runs.map((run) => run.name),
      status: "live", contributions: [], decisions: [], actionItems: [], createdAt: 1, updatedAt: 1,
    };
    const encryptedFollowup = event({
      operationId: "followup-1", tool: "followup_task", prompt: undefined,
      receiverThreads: [{ threadId: "thread-worker", name: "worker", status: "working" }],
    });
    const once = updateMeetingFromOrchestration(encryptedFollowup, runs, meeting, 20);
    const twice = updateMeetingFromOrchestration({ ...encryptedFollowup, operationId: "followup-2" }, runs, once, 21);
    expect(twice.contributions).toHaveLength(1);

    const explorerResponse = updateMeetingFromOrchestration(event({
      operationId: "wait-explorer", tool: "wait", prompt: undefined,
      receiverThreads: [{ threadId: "thread-explorer", name: "explorer", status: "completed", message: "I verified the wording against the source." }],
    }), runs, twice, 22);
    const withResponses = updateMeetingFromOrchestration(event({
      operationId: "wait-worker", tool: "wait", prompt: undefined,
      receiverThreads: [{ threadId: "thread-worker", name: "worker", status: "completed", message: "I accept the verified wording and will ship it." }],
    }), runs, explorerResponse, 23);

    const answer = "**Agreed precise wording:**\n\n> Grokky is a fast local cockpit.\n\n**Next action:**\n\n- Ship the verified wording.";
    expect(meetingOutcomesFromFinal(answer)).toEqual({
      decisions: ["Grokky is a fast local cockpit."],
      actionItems: ["Ship the verified wording."],
    });
    const finalized = finalizeAgentWorkflow([], [withResponses], runs.map((run) => ({ ...run, status: "completed" })), 30, answer);
    expect(finalized.meetings[0]).toMatchObject({ status: "completed", decisions: ["Grokky is a fast local cockpit."], actionItems: ["Ship the verified wording."] });
  });

  test("extracts each explicit Markdown list item as a separate meeting outcome", () => {
    const answer = [
      "## Decisions",
      "",
      "- Ship the verified patch.",
      "",
      "- Keep the feature behind a flag.",
      "",
      "## Action items",
      "",
      "1. Run the focused test suite.",
      "2. Publish the release notes.",
    ].join("\n");

    expect(meetingOutcomesFromFinal(answer)).toEqual({
      decisions: ["Ship the verified patch.", "Keep the feature behind a flag."],
      actionItems: ["Run the focused test suite.", "Publish the release notes."],
    });
  });
});
