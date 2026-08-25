import { Codex } from "@openai/codex-sdk";
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ActivityItem, AgentDefinition, OrchestrationEvent } from "../../shared/contracts";
import { PRODUCT_WRITING_STYLE_RULE } from "../writing-style";
import type { ProviderRunContext } from "./types";

function packagedCodexPath(): string | undefined {
  if (!process.resourcesPath || process.platform !== "darwin") return undefined;
  const packageArch = process.arch === "arm64" ? "arm64" : "x64";
  const vendorArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const candidate = join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@openai",
    `codex-darwin-${packageArch}`,
    "vendor",
    `${vendorArch}-apple-darwin`,
    "bin",
    "codex",
  );
  return existsSync(candidate) ? candidate : undefined;
}

function activityFromItem(item: ThreadItem, fallbackStatus: ActivityItem["status"]): ActivityItem | null {
  const createdAt = Date.now();
  switch (item.type) {
    case "reasoning":
      return { id: item.id, kind: "reasoning", label: "Reasoning", detail: item.text, status: fallbackStatus, createdAt };
    case "command_execution":
      return {
        id: item.id,
        kind: "command",
        label: item.command.split("\n")[0]?.slice(0, 160) || "Command",
        detail: item.aggregated_output?.slice(-12_000),
        status: item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "running",
        createdAt,
      };
    case "file_change":
      return {
        id: item.id,
        kind: "files",
        label: `${item.status === "completed" ? "Updated" : "Updating"} ${item.changes.length} file${item.changes.length === 1 ? "" : "s"}`,
        detail: item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n"),
        status: item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "running",
        createdAt,
      };
    case "mcp_tool_call":
      return {
        id: item.id,
        kind: "tool",
        label: `${item.server}.${item.tool}`,
        detail: item.error?.message,
        status: item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "running",
        createdAt,
      };
    case "todo_list":
      return {
        id: item.id,
        kind: "plan",
        label: "Plan updated",
        detail: item.items.map((todo) => `${todo.completed ? "✓" : "○"} ${todo.text}`).join("\n"),
        status: fallbackStatus,
        createdAt,
      };
    case "web_search":
      return { id: item.id, kind: "tool", label: "Web search", detail: item.query, status: fallbackStatus, createdAt };
    case "error": {
      const isContextBudgetNotice = item.message.startsWith("Skill descriptions were shortened to fit the skills context budget.");
      if (isContextBudgetNotice) return null;
      if (item.message.startsWith("This session was recorded with model")) {
        return { id: item.id, kind: "notice", label: "Model changed for this session", detail: item.message, status: "completed", createdAt };
      }
      return { id: item.id, kind: "notice", label: "Codex reported an error", detail: item.message, status: "failed", createdAt };
    }
    case "agent_message":
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function orchestrationFromThreadEvent(event: unknown, agents: AgentDefinition[] = []): OrchestrationEvent | null {
  if (!isRecord(event) || !isRecord(event.item) || event.item.type !== "collab_tool_call") return null;
  const item = event.item;
  if (typeof item.id !== "string" || typeof item.tool !== "string" || typeof item.sender_thread_id !== "string") return null;
  const receiverIds = Array.isArray(item.receiver_thread_ids)
    ? item.receiver_thread_ids.filter((value): value is string => typeof value === "string")
    : [];
  const agentStates = isRecord(item.agents_states) ? item.agents_states : {};
  const prompt = typeof item.prompt === "string" ? item.prompt : "";
  const receiverThreads = receiverIds.map((threadId, index) => {
    const state = isRecord(agentStates[threadId]) ? agentStates[threadId] : {};
    const namedAgent = agents.find((agent) => new RegExp(`\\b${agent.name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i").test(prompt));
    const indexAgent = receiverIds.length === agents.length ? agents[index] : undefined;
    return {
      threadId,
      ...((namedAgent?.name || indexAgent?.name) ? { name: namedAgent?.name || indexAgent?.name } : {}),
      status: typeof state.status === "string" ? state.status : item.status === "in_progress" ? "running" : "unknown",
      ...(typeof state.message === "string" ? { message: state.message } : {}),
    };
  });
  const eventStatus: OrchestrationEvent["status"] = item.status === "failed"
    ? "failed"
    : item.status === "completed" || event.type === "item.completed"
      ? "completed"
      : "running";
  return {
    operationId: item.id,
    tool: item.tool,
    senderThreadId: item.sender_thread_id,
    receiverThreads,
    ...(prompt ? { prompt } : {}),
    status: eventStatus,
  };
}

function crewPrompt(prompt: string, agents: AgentDefinition[], webSearchEnabled: boolean, commandsAllowed: boolean): string {
  const webRule = webSearchEnabled
    ? "Live web search is enabled. When the user asks for current or online information, actually use the web search tool and cite the sources you consulted."
    : "Live web search is disabled for this Grokky session. Do not claim that you can browse or search the live web; explain that it can be enabled in Settings.";
  const computerRule = commandsAllowed
    ? "The user has enabled local development commands for this session. Stay within the selected workspace and the SDK sandbox."
    : "Local command execution is not enabled for this session. Do not use shell or command-execution tools; use read and file-edit tools within the selected workspace only.";
  if (!agents.length) return `${webRule}\n${computerRule}\n${PRODUCT_WRITING_STYLE_RULE}\n\nUser request:\n${prompt}`;
  const roster = agents.map((agent) => `- agent_type=${agent.name}: ${agent.description}`).join("\n");
  return [
    webRule,
    computerRule,
    PRODUCT_WRITING_STYLE_RULE,
    "",
    "A Grokky crew is explicitly selected for this request. You must use the collaboration tools, not simulate or merely describe delegation.",
    roster,
    "Before doing the specialist work yourself, call spawn_agent exactly once for every selected agent_type above. Give each a bounded task. Spawn all roles before waiting so independent work runs in parallel. Then call wait for every child thread and consolidate their actual results into one answer.",
    "Never claim an agent was assigned unless spawn_agent succeeded. If a role cannot be spawned, state that failure clearly in the final answer.",
    "Keep the main thread focused on coordination and final decisions. Parallel agents must avoid editing the same files at the same time.",
    "",
    "User request:",
    prompt,
  ].join("\n");
}

interface CodexEventState {
  pendingAgentMessage?: { id: string; text: string };
  agentNameByThread: Map<string, string>;
  unusedAgentNames: string[];
}

async function handleEvent(event: ThreadEvent, context: ProviderRunContext, state: CodexEventState): Promise<void> {
  const orchestration = orchestrationFromThreadEvent(event, context.agents);
  if (orchestration) {
    for (const thread of orchestration.receiverThreads) {
      const known = state.agentNameByThread.get(thread.threadId);
      if (thread.name) {
        state.agentNameByThread.set(thread.threadId, thread.name);
        const index = state.unusedAgentNames.indexOf(thread.name);
        if (index >= 0) state.unusedAgentNames.splice(index, 1);
      } else if (known) {
        thread.name = known;
      } else if (orchestration.tool === "spawn_agent") {
        const next = state.unusedAgentNames.shift();
        if (next) {
          thread.name = next;
          state.agentNameByThread.set(thread.threadId, next);
        }
      }
    }
    await context.onEvent({ type: "orchestration", event: orchestration });
    return;
  }
  if (event.type === "thread.started") {
    await context.onEvent({ type: "thread", threadId: event.thread_id });
    return;
  }
  if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
    if (event.item.type === "agent_message" && event.type === "item.completed") {
      const text = event.item.text.trim();
      if (!text) return;
      if (state.pendingAgentMessage) {
        await context.onEvent({
          type: "activity",
          activity: {
            id: `coordinator:${state.pendingAgentMessage.id}`,
            kind: "notice",
            label: "Coordinator update",
            detail: state.pendingAgentMessage.text,
            status: "completed",
            createdAt: Date.now(),
          },
        });
      }
      state.pendingAgentMessage = { id: event.item.id, text };
      return;
    }
    const activity = activityFromItem(event.item, event.type === "item.completed" ? "completed" : "running");
    if (activity) await context.onEvent({ type: "activity", activity });
    return;
  }
  if (event.type === "turn.completed") {
    if (state.pendingAgentMessage) {
      await context.onEvent({ type: "final", text: state.pendingAgentMessage.text });
      state.pendingAgentMessage = undefined;
    }
    await context.onEvent({
      type: "usage",
      usage: {
        inputTokens: event.usage.input_tokens,
        cachedInputTokens: event.usage.cached_input_tokens,
        outputTokens: event.usage.output_tokens,
        reasoningTokens: event.usage.reasoning_output_tokens,
      },
    });
    return;
  }
  if (event.type === "turn.failed") throw new Error(event.error.message);
  if (event.type === "error") throw new Error(event.message);
}

export async function runCodex(context: ProviderRunContext): Promise<void> {
  const { conversation, settings } = context;
  const localComputerSelected = context.computerAccess.activeDeviceId === context.computerAccess.localDeviceId;
  const nativeBrowserEnabled = context.computerAccess.enabled
    && localComputerSelected
    && context.computerAccess.grants.browser === "allow";
  const nativeComputerEnabled = context.computerAccess.enabled
    && localComputerSelected
    && context.computerAccess.grants.screen === "allow"
    && context.computerAccess.grants.automation === "allow";
  const commandsAllowed = context.computerAccess.enabled
    && localComputerSelected
    && context.computerAccess.grants.commands === "allow"
    && conversation.allowCommands;
  const codexPathOverride = packagedCodexPath();
  const codex = new Codex({
    ...(codexPathOverride ? { codexPathOverride } : {}),
    config: {
      features: {
        apps: settings.connectorsEnabled,
        browser_use: nativeBrowserEnabled,
        computer_use: nativeComputerEnabled,
        image_generation: false,
        multi_agent: settings.multiAgentEnabled,
        plugins: settings.connectorsEnabled,
        skill_search: true,
        workspace_dependencies: true,
      },
      agents: {
        enabled: settings.multiAgentEnabled,
        max_concurrent_threads_per_session: settings.maxAgentThreads,
        ...(settings.defaultSubagentModel ? { default_subagent_model: settings.defaultSubagentModel } : {}),
        ...(settings.defaultSubagentReasoning ? { default_subagent_reasoning_effort: settings.defaultSubagentReasoning } : {}),
        interrupt_message: settings.interruptAgentMessage,
      },
    },
  });
  const options = {
    workingDirectory: conversation.workingDirectory,
    model: conversation.model,
    modelReasoningEffort: conversation.reasoning,
    sandboxMode: conversation.sandboxMode,
    networkAccessEnabled: settings.connectorsEnabled || nativeBrowserEnabled,
    webSearchMode: settings.webSearchEnabled ? "live" as const : "disabled" as const,
    approvalPolicy: "never" as const,
    skipGitRepoCheck: true,
  };
  const thread = conversation.threadId
    ? codex.resumeThread(conversation.threadId, options)
    : codex.startThread(options);
  const { events } = await thread.runStreamed(crewPrompt(context.prompt, context.agents, settings.webSearchEnabled, commandsAllowed), { signal: context.signal });
  const eventState: CodexEventState = {
    agentNameByThread: new Map(),
    unusedAgentNames: context.agents.map((agent) => agent.name),
  };
  for await (const event of events) await handleEvent(event, context, eventState);
}
