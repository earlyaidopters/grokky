import { temporaryCodexRoles } from "./codex-role-config";
import { Codex } from "@openai/codex-sdk";
import type { Input, ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ActivityItem, AgentDefinition, OrchestrationEvent } from "../../shared/contracts";
import { commandActivityLabel } from "../../shared/activity-labels";
import { PRODUCT_WRITING_STYLE_RULE } from "../writing-style";
import { GENERATED_ARTIFACT_INSTRUCTIONS } from "../generated-artifacts";
import { allowBrowserOriginsForThread } from "../codex-browser-permissions";
import { startCodexRolloutObserver, type CodexRolloutObserver } from "./codex-rollout-observer";
import type { ProviderRunContext } from "./types";

const codexEnvironmentKeys = [
  "HOME",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
] as const;

/** Keep provider and runner credentials out of the native Codex child process. */
export function codexChildEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of codexEnvironmentKeys) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  return environment;
}

export function packagedCodexCandidate(resourcesPath: string, platform: NodeJS.Platform, arch: string): string | undefined {
  const packageArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (!packageArch) return undefined;
  const vendorArch = packageArch === "arm64" ? "aarch64" : "x86_64";
  const platformPackage = platform === "darwin"
    ? `codex-darwin-${packageArch}`
    : platform === "win32"
      ? `codex-win32-${packageArch}`
      : undefined;
  const vendorPlatform = platform === "darwin"
    ? `${vendorArch}-apple-darwin`
    : platform === "win32"
      ? `${vendorArch}-pc-windows-msvc`
      : undefined;
  if (!platformPackage || !vendorPlatform) return undefined;
  return join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@openai",
    platformPackage,
    "vendor",
    vendorPlatform,
    "bin",
    platform === "win32" ? "codex.exe" : "codex",
  );
}

function packagedCodexPath(): string | undefined {
  if (!process.resourcesPath) return undefined;
  const candidate = packagedCodexCandidate(process.resourcesPath, process.platform, process.arch);
  if (!candidate) return undefined;
  return existsSync(candidate) ? candidate : undefined;
}

function commandActivityDetail(command: string, output: string | undefined): string {
  return [`Command\n${command}`, ...(output ? [`Output\n${output.slice(-12_000)}`] : [])].join("\n\n");
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
        label: commandActivityLabel(item.command),
        detail: commandActivityDetail(item.command, item.aggregated_output),
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
  const receiverAgents = Array.isArray(item.receiver_agents)
    ? item.receiver_agents.filter(isRecord)
    : [];
  const agentStates = isRecord(item.agents_states) ? item.agents_states : {};
  const prompt = typeof item.prompt === "string" ? item.prompt : "";
  const receiverThreads = receiverIds.map((threadId, index) => {
    const rawState = agentStates[threadId];
    const state = isRecord(rawState) ? rawState : {};
    const receiverAgent = receiverAgents.find((candidate) => candidate.thread_id === threadId);
    const runtimeRole = typeof receiverAgent?.agent_role === "string" ? receiverAgent.agent_role : undefined;
    const namedAgent = agents.find((agent) => new RegExp(`\\b${agent.name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i").test(prompt));
    const indexAgent = receiverIds.length === agents.length ? agents[index] : undefined;
    const matchedRole = runtimeRole
      ? agents.find((agent) => agent.name.toLowerCase() === runtimeRole.toLowerCase())?.name || runtimeRole
      : undefined;
    const keyedState = Object.entries(state).find(([key]) => /pending|init|start|running|working|wait|complete|done|fail|error|stop|interrupt/i.test(key));
    const status = typeof rawState === "string"
      ? rawState
      : typeof state.status === "string"
        ? state.status
        : keyedState?.[0] || (item.status === "in_progress" ? "running" : "unknown");
    const message = typeof state.message === "string"
      ? state.message
      : typeof keyedState?.[1] === "string" && /complete|done|fail|error/i.test(keyedState[0])
        ? keyedState[1]
        : undefined;
    return {
      threadId,
      ...((matchedRole || namedAgent?.name || indexAgent?.name) ? { name: matchedRole || namedAgent?.name || indexAgent?.name } : {}),
      status,
      ...(message ? { message } : {}),
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

export type CodexCrewMode = "parallel" | "staged";

export function codexComputerPluginOverrides(browserEnabled: boolean, computerEnabled: boolean): string[] {
  return [
    `plugins."browser@openai-bundled".enabled=${browserEnabled}`,
    `plugins."chrome@openai-bundled".enabled=${browserEnabled}`,
    `plugins."computer-use@openai-bundled".enabled=${computerEnabled}`,
  ];
}

const implementationRequest = /\b(?:build|create|implement|fix|edit|change|update|refactor|debug|redesign|launch|start|run|ship|develop|code|write)\b/i;

export function codexCrewMode(prompt: string, agents: AgentDefinition[]): CodexCrewMode {
  const roleNames = agents.map((agent) => `${agent.id} ${agent.name}`.toLowerCase());
  const hasWorker = roleNames.some((name) => /\b(?:worker|implementer|builder|developer|engineer)\b/.test(name));
  const hasTester = roleNames.some((name) => /\b(?:tester|test|qa|reviewer|verifier)\b/.test(name));
  return hasWorker && hasTester && implementationRequest.test(prompt) ? "staged" : "parallel";
}

export function crewPrompt(prompt: string, agents: AgentDefinition[], webSearchEnabled: boolean, commandsAllowed: boolean, generatedArtifactsEnabled = false): string {
  const webRule = webSearchEnabled
    ? "Live web search is enabled. When the user asks for current or online information, actually use the web search tool and cite the sources you consulted."
    : "Live web search is disabled for this Grokky session. Do not claim that you can browse or search the live web; explain that it can be enabled in Settings.";
  const computerRule = commandsAllowed
    ? "The user has enabled local development commands for this session. Stay within the selected workspace and the SDK sandbox."
    : "Local development commands are not enabled for this session. You may use shell commands only for read-only inspection inside the selected workspace, such as pwd, ls, rg, sed, cat, file, and git status, diff, or log. Do not install packages, run package scripts, builds, tests, servers, or mutate files through the shell. File edits are allowed only when the SDK workspace sandbox permits them.";
  const workspaceGroundingRule = "Ground claims about this project in files from the selected local workspace. Prefer local read-only inspection over the web, cite the local path or line evidence when practical, and never substitute a public repository or similarly named product for a local file. If the requested local source cannot be inspected within the user's constraints, report that blocker instead of filling the gap with web evidence or inference.";
  const artifactRule = generatedArtifactsEnabled ? GENERATED_ARTIFACT_INSTRUCTIONS : "";
  if (!agents.length) return `${webRule}\n${computerRule}\n${workspaceGroundingRule}\n${PRODUCT_WRITING_STYLE_RULE}\n${artifactRule}\n\nUser request:\n${prompt}`;
  const roster = agents.map((agent) => `- agent_type=${agent.name}: ${agent.description}`).join("\n");
  const mode = codexCrewMode(prompt, agents);
  const orchestrationRule = mode === "staged"
    ? [
        "Execution mode: staged implementation pipeline. The selected roles have dependencies, so do not spawn every role at once.",
        "Start the single implementation worker immediately. You may concurrently spawn non-testing discovery roles only for bounded read-only work that does not block the worker. The worker is the sole owner of file changes.",
        "The worker assignment must require an IMPLEMENTATION_READY message to the lead immediately after all intended files are written and stable, before extended verification. The worker then performs only fast syntax, build, and reference checks; it must leave exhaustive browser, interaction, and accessibility QA to the testing role.",
        "Do not spawn tester, QA, reviewer, or verifier roles until the worker sends IMPLEMENTATION_READY. Spawn the tester immediately on that handoff while the worker finishes its short smoke checks; do not wait for the worker's final report first.",
        "If discovery reports while the worker is active, send only relevant findings to that existing worker with send_message. Do not restart the worker.",
        "The tester assignment must be a bounded pass over the user's acceptance criteria. Try any unavailable browser or system capability at most once, then fall back immediately to source, syntax, build, and file-reference checks instead of retrying the environment.",
        "Wait for both the worker and tester reports, resolve any real failure, then produce the final response.",
      ].join("\n")
    : [
        "Execution mode: parallel independent crew.",
        "Call spawn_agent exactly once for every selected agent_type above before waiting. Give each a distinct bounded task and spawn all roles before the first wait.",
      ].join("\n");
  return [
    webRule,
    computerRule,
    workspaceGroundingRule,
    PRODUCT_WRITING_STYLE_RULE,
    artifactRule,
    "",
    "A Grokky crew is explicitly selected for this request. You must use the collaboration tools, not simulate or merely describe delegation.",
    roster,
    orchestrationRule,
    "Use fork_turns=none for specialist spawns and put the necessary user outcome, workspace, ownership, constraints, and acceptance checks directly in each assignment. Do not copy the entire conversation into every child.",
    "Treat specialist final reports as workflow events. Prefer one event-driven wait of at least 120 seconds over repeated short waits or list_agents polling. Continue useful coordination while children work, but do not duplicate their file inspection, skill reading, implementation, or tests on the lead thread.",
    "A send_message or followup_task contribution is an interim handoff, not a final specialist report. Every selected specialist must still reach a terminal final report before you answer the user.",
    "When the user requests a meeting, moderate at least one explicit challenge-and-response round with followup_task, wait for every participant's response, record the decision and next action, and then wait again until every participant has returned a final report. Do not describe that meeting as complete while any participant is still working or waiting.",
    "Never claim an agent was assigned unless spawn_agent succeeded. If a role cannot be spawned, state that failure clearly in the final answer.",
    "Never declare the crew delivered until required stages have reported and you are ready to return the final answer. Do not stop an active child merely because another child finished.",
    "User request:",
    prompt,
  ].join("\n");
}

interface CodexEventState {
  pendingAgentMessage?: { id: string; text: string };
  rootThreadId?: string;
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
    orchestration.senderName = state.agentNameByThread.get(orchestration.senderThreadId)
      || (orchestration.senderThreadId === state.rootThreadId ? "Grokky lead" : undefined);
    await context.onEvent({ type: "orchestration", event: orchestration });
    return;
  }
  if (event.type === "thread.started") {
    state.rootThreadId = event.thread_id;
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
  const roles = await temporaryCodexRoles(context.agents);
  try { await runCodexRegistered(context, roles.overrides); }
  finally { await roles.dispose(); }
}

async function runCodexRegistered(context: ProviderRunContext, roleOverrides: string[]): Promise<void> {
  const { conversation, settings } = context;
  const localComputerSelected = context.computerAccess.activeDeviceId === context.computerAccess.localDeviceId;
  const nativeBrowserEnabled = context.computerAccess.enabled
    && localComputerSelected
    && context.approvedBrowserOrigins.length > 0;
  const nativeComputerEnabled = context.computerAccess.enabled
    && localComputerSelected
    && context.computerAccess.grants.screen === "allow"
    && context.computerAccess.grants.automation === "allow";
  const commandsAllowed = conversation.allowCommands;
  const codexPathOverride = packagedCodexPath();
  const codex = new Codex({
    ...(codexPathOverride ? { codexPathOverride } : {}),
    env: codexChildEnvironment(),
    configOverrides: [...codexComputerPluginOverrides(nativeBrowserEnabled, nativeComputerEnabled), ...roleOverrides],
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
  if (conversation.threadId && context.approvedBrowserOrigins.length) {
    await allowBrowserOriginsForThread(conversation.threadId, context.approvedBrowserOrigins);
  }
  const prompt = crewPrompt(context.prompt, context.agents, settings.webSearchEnabled, commandsAllowed, settings.generatedArtifactsEnabled);
  const input: Input = context.images.length
    ? [
        { type: "text", text: prompt },
        ...context.images.map((image) => ({ type: "local_image" as const, path: image.localPath })),
      ]
    : prompt;
  const { events } = await thread.runStreamed(input, { signal: context.signal });
  const eventState: CodexEventState = {
    agentNameByThread: new Map(),
    unusedAgentNames: context.agents.map((agent) => agent.name),
  };
  let rolloutObserver: CodexRolloutObserver | undefined;
  const startedAt = Date.now();
  try {
    for await (const event of events) {
      if (event.type === "thread.started" && context.approvedBrowserOrigins.length) {
        await allowBrowserOriginsForThread(event.thread_id, context.approvedBrowserOrigins);
      }
      if (event.type === "thread.started" && context.settings.multiAgentEnabled && !rolloutObserver) {
        rolloutObserver = startCodexRolloutObserver({
          rootThreadId: event.thread_id,
          agents: context.agents,
          startedAt,
          signal: context.signal,
          onEvent: (orchestration) => context.onEvent({ type: "orchestration", event: orchestration }),
        });
      }
      await handleEvent(event, context, eventState);
    }
  } finally {
    await rolloutObserver?.stop();
  }
}
