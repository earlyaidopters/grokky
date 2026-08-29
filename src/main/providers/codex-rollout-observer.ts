import { homedir } from "node:os";
import { open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentDefinition, OrchestrationEvent } from "../../shared/contracts";

interface SpawnCall {
  agentType?: string;
  taskName?: string;
  message?: string;
}

interface DirectCall {
  target?: string;
  message?: string;
}

interface ObservedThread {
  threadId: string;
  name: string;
  task: string;
  operationId: string;
}

export interface CodexRolloutParseState {
  spawnCalls: Map<string, SpawnCall>;
  threadsByPath: Map<string, ObservedThread>;
  seenEventIds: Set<string>;
}

export function createCodexRolloutParseState(): CodexRolloutParseState {
  return {
    spawnCalls: new Map(),
    threadsByPath: new Map(),
    seenEventIds: new Set(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayTaskName(value: string | undefined): string {
  if (!value) return "Delegated specialist work";
  const words = value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  return words.map((word) => {
    if (/^readme$/i.test(word)) return "README";
    if (/^(?:api|ui|qa)$/i.test(word)) return word.toUpperCase();
    return word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
  }).join(" ");
}

function parseSpawnArguments(value: unknown): SpawnCall {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const rawMessage = typeof parsed.message === "string" ? parsed.message.trim() : "";
    const message = rawMessage && rawMessage !== "encrypted" && !/^gAAAAA/.test(rawMessage) ? rawMessage : undefined;
    return {
      ...(typeof parsed.agent_type === "string" ? { agentType: parsed.agent_type } : {}),
      ...(typeof parsed.task_name === "string" ? { taskName: parsed.task_name } : {}),
      ...(message ? { message } : {}),
    };
  } catch {
    return {};
  }
}

function parseDirectArguments(value: unknown): DirectCall {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const rawMessage = typeof parsed.message === "string" ? parsed.message : undefined;
    const message = rawMessage && !/^gAAAAA/.test(rawMessage) ? rawMessage : undefined;
    return {
      ...(typeof parsed.target === "string" ? { target: parsed.target } : {}),
      ...(message ? { message } : {}),
    };
  } catch {
    return {};
  }
}

function matchedAgent(agentType: string | undefined, agents: AgentDefinition[]): AgentDefinition | undefined {
  if (!agentType) return undefined;
  const normalized = agentType.toLowerCase();
  return agents.find((agent) => (
    agent.name.toLowerCase() === normalized
    || agent.id.split(":").at(-1)?.toLowerCase() === normalized
  ));
}

function readableMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((item): string[] => (
    isRecord(item) && item.type === "input_text" && typeof item.text === "string" ? [item.text] : []
  )).join("\n");
}

function finalAnswerPayload(text: string): string | undefined {
  if (!/^Message Type: FINAL_ANSWER\b/m.test(text)) return undefined;
  const match = text.match(/(?:^|\n)Payload:\n([\s\S]*)$/);
  const payload = match?.[1]?.trim();
  return payload || undefined;
}

export function orchestrationFromRolloutRecord(
  value: unknown,
  rootThreadId: string,
  agents: AgentDefinition[],
  state: CodexRolloutParseState,
): OrchestrationEvent[] {
  if (!isRecord(value) || !isRecord(value.payload)) return [];
  const payload = value.payload;

  if (value.type === "response_item" && payload.type === "function_call" && payload.name === "spawn_agent") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
    if (callId) state.spawnCalls.set(callId, parseSpawnArguments(payload.arguments));
    return [];
  }

  if (
    value.type === "response_item"
    && payload.type === "function_call"
    && typeof payload.name === "string"
    && /^(?:send_message|followup_task)$/.test(payload.name)
  ) {
    const operationId = typeof payload.call_id === "string" ? payload.call_id : typeof payload.id === "string" ? payload.id : undefined;
    const call = parseDirectArguments(payload.arguments);
    const thread = call.target ? state.threadsByPath.get(call.target) : undefined;
    if (!operationId || !thread || state.seenEventIds.has(`direct:${operationId}`)) return [];
    state.seenEventIds.add(`direct:${operationId}`);
    return [{
      operationId,
      tool: payload.name,
      senderThreadId: rootThreadId,
      senderName: "Grokky lead",
      receiverThreads: [{ threadId: thread.threadId, name: thread.name, status: "working" }],
      ...(call.message ? { prompt: call.message } : {}),
      status: "completed",
    }];
  }

  if (value.type === "event_msg" && payload.type === "item_completed" && isRecord(payload.item) && payload.item.type === "SubAgentActivity") {
    const item = payload.item;
    const operationId = typeof item.id === "string" ? item.id : undefined;
    const threadId = typeof item.agent_thread_id === "string" ? item.agent_thread_id : undefined;
    const agentPath = typeof item.agent_path === "string" ? item.agent_path : undefined;
    if (!operationId || !threadId || !agentPath || item.kind !== "started" || state.seenEventIds.has(`spawn:${operationId}`)) return [];
    const call = state.spawnCalls.get(operationId) || {};
    const agent = matchedAgent(call.agentType, agents);
    const name = agent?.name || call.agentType || agentPath.split("/").filter(Boolean).at(-1) || "Specialist";
    const task = call.message || (call.taskName ? displayTaskName(call.taskName) : agent?.description || "Delegated specialist work");
    state.threadsByPath.set(agentPath, { threadId, name, task, operationId });
    state.seenEventIds.add(`spawn:${operationId}`);
    return [{
      operationId,
      tool: "spawn_agent",
      senderThreadId: rootThreadId,
      senderName: "Grokky lead",
      receiverThreads: [{ threadId, name, status: "running" }],
      prompt: task,
      status: "running",
    }];
  }

  if (value.type === "response_item" && payload.type === "agent_message") {
    const messageId = typeof payload.id === "string" ? payload.id : undefined;
    const author = typeof payload.author === "string" ? payload.author : undefined;
    const thread = author ? state.threadsByPath.get(author) : undefined;
    const result = finalAnswerPayload(readableMessageText(payload.content));
    if (!messageId || !thread || !result || state.seenEventIds.has(`report:${messageId}`)) return [];
    state.seenEventIds.add(`report:${messageId}`);
    return [{
      operationId: messageId,
      tool: "wait",
      senderThreadId: rootThreadId,
      senderName: "Grokky lead",
      receiverThreads: [{ threadId: thread.threadId, name: thread.name, status: "completed", message: result }],
      status: "completed",
    }];
  }

  return [];
}

async function findRolloutPath(rootThreadId: string): Promise<string | undefined> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const sessionsDirectory = join(codexHome, "sessions");
  try {
    const entries = await readdir(sessionsDirectory, { recursive: true });
    const suffix = `-${rootThreadId}.jsonl`;
    const match = entries.find((entry) => basename(entry).endsWith(suffix));
    return match ? join(sessionsDirectory, match) : undefined;
  } catch {
    return undefined;
  }
}

export interface CodexRolloutObserver {
  stop(): Promise<void>;
}

export function startCodexRolloutObserver(options: {
  rootThreadId: string;
  agents: AgentDefinition[];
  startedAt: number;
  signal: AbortSignal;
  onEvent(event: OrchestrationEvent): void | Promise<void>;
}): CodexRolloutObserver {
  const state = createCodexRolloutParseState();
  let pathname: string | undefined;
  let offset = 0;
  let remainder = "";
  let stopped = false;
  let activePoll: Promise<void> | undefined;
  let eventQueue = Promise.resolve();

  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
      if (Number.isFinite(timestamp) && timestamp < options.startedAt - 5_000) return;
      for (const event of orchestrationFromRolloutRecord(record, options.rootThreadId, options.agents, state)) {
        eventQueue = eventQueue.then(() => options.onEvent(event));
      }
    } catch {
      // Partial JSONL is retained in remainder. Malformed complete lines are ignored.
    }
  };

  const poll = (): Promise<void> => {
    if (activePoll) return activePoll;
    activePoll = (async () => {
      try {
        pathname ||= await findRolloutPath(options.rootThreadId);
        if (!pathname) return;
        const handle = await open(pathname, "r");
        try {
          const info = await handle.stat();
          while (offset < info.size) {
            const length = Math.min(256 * 1024, info.size - offset);
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            if (!bytesRead) break;
            offset += bytesRead;
            const chunks = `${remainder}${buffer.subarray(0, bytesRead).toString("utf8")}`.split("\n");
            remainder = chunks.pop() || "";
            for (const line of chunks) processLine(line);
          }
        } finally {
          await handle.close();
        }
      } catch {
        // The rollout can be created or replaced between polls. Retry on the next interval.
      }
    })().finally(() => {
      activePoll = undefined;
    });
    return activePoll;
  };

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    clearInterval(timer);
    options.signal.removeEventListener("abort", abort);
    stopPromise = (async () => {
      await poll();
      await poll();
      if (remainder.trim()) {
        processLine(remainder);
        remainder = "";
      }
      await eventQueue;
    })();
    return stopPromise;
  };
  const timer = setInterval(() => void poll(), 300);
  const abort = () => { void stop(); };
  options.signal.addEventListener("abort", abort, { once: true });
  void poll();

  return { stop };
}
