import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { OpenRouter } from "@openrouter/sdk";
import type {
  ChatFunctionTool,
  ChatMessages,
  ChatResult,
  ChatToolMessage,
  ChatToolCall,
} from "@openrouter/sdk/models";
import type { ActivityItem, AgentDefinition, Conversation, UsageSummary } from "../../shared/contracts";
import type { ComputerToolName } from "../computer-access";
import { PRODUCT_WRITING_STYLE_RULE } from "../writing-style";
import type { OpenRouterRunContext } from "./types";

const OPENROUTER_WEB_RESEARCH_MODEL = "openai/gpt-5.2";

const readTools: ChatFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List readable files in the selected workspace. Secret files and dependency/build directories are excluded.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search readable workspace files for a literal text query.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read one UTF-8 text file using a path relative to the selected workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

const writeTools: ChatFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "create_file",
      description: "Create a new UTF-8 text file in the selected workspace. Refuses to overwrite an existing file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace one unique exact string in a UTF-8 workspace file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

const commandTool: ChatFunctionTool = {
  type: "function",
  function: {
    name: "run_command",
    description: "Run an allowlisted development command in the selected workspace. Network, deletion, shell composition, and system-control commands are blocked.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
};

const browserTool: ChatFunctionTool = {
  type: "function",
  function: {
    name: "browse_url",
    description: "Open one public http or https page on the selected computer and return its title, final URL, and readable text. Private network addresses are blocked.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
    strict: true,
  },
};

const screenTool: ChatFunctionTool = {
  type: "function",
  function: {
    name: "capture_screen",
    description: "Capture the current display on the selected computer. Requires Screen Recording permission and user approval unless it was granted for the session.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
};

const automationTools: ChatFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "open_application",
      description: "Open a named macOS application on the selected computer.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "click_screen",
      description: "Click an absolute screen coordinate on the selected computer. Use only after inspecting current visible state.",
      parameters: {
        type: "object",
        properties: { x: { type: "integer" }, y: { type: "integer" } },
        required: ["x", "y"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "Type text into the active application on the selected computer.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      strict: true,
    },
  },
];

function toolsFor(context: OpenRouterRunContext, conversation: Conversation, readOnly: boolean): ChatFunctionTool[] {
  if (!context.computerAccess.enabled) return [];
  const activeRemote = context.computerAccess.remoteDevices.find((device) => device.id === context.computerAccess.activeDeviceId && !device.revoked);
  const capabilities = new Set(activeRemote?.capabilities ?? ["files", "commands", "browser", "screen", "automation"]);
  return [
    ...(capabilities.has("files") && context.computerAccess.grants.files !== "blocked" ? readTools : []),
    ...(!readOnly && capabilities.has("files") && context.computerAccess.grants.files !== "blocked" && conversation.sandboxMode === "workspace-write" ? writeTools : []),
    ...(!readOnly && capabilities.has("commands") && context.computerAccess.grants.commands !== "blocked" && conversation.sandboxMode === "workspace-write" && conversation.allowCommands ? [commandTool] : []),
    ...(capabilities.has("browser") && context.computerAccess.grants.browser !== "blocked" ? [browserTool] : []),
    ...(capabilities.has("screen") && context.computerAccess.grants.screen !== "blocked" ? [screenTool] : []),
    ...(!readOnly && capabilities.has("automation") && context.computerAccess.grants.automation !== "blocked" ? automationTools : []),
  ];
}

function visibleContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
    return "";
  }).join("");
}

export async function openRouterToolContent(name: string, output: string): Promise<ChatToolMessage["content"]> {
  if (name !== "capture_screen") return output.slice(0, 40_000);
  const pathname = output.match(/^Captured the current display to (.+)$/)?.[1];
  if (!pathname) return output.slice(0, 40_000);
  try {
    const capture = await readFile(pathname);
    if (capture.length > 10_000_000) return `${output}\nThe capture exceeded the 10 MB model attachment limit.`;
    return [
      { type: "text", text: `${output}\nInspect the attached current-display image before choosing the next computer action.` },
      { type: "image_url", imageUrl: { url: `data:image/png;base64,${capture.toString("base64")}`, detail: "high" } },
    ];
  } catch (error) {
    return `${output}\nThe capture could not be attached to the model: ${error instanceof Error ? error.message : "unknown read error"}`;
  }
}

function usageFrom(result: ChatResult): UsageSummary | undefined {
  if (!result.usage) return undefined;
  return {
    inputTokens: result.usage.promptTokens,
    cachedInputTokens: result.usage.promptTokensDetails?.cachedTokens,
    outputTokens: result.usage.completionTokens,
    reasoningTokens: result.usage.completionTokensDetails?.reasoningTokens ?? undefined,
    costUsd: result.usage.cost ?? undefined,
  };
}

function addUsage(left: UsageSummary | undefined, right: UsageSummary | undefined): UsageSummary | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0),
  };
}

function activityForCall(call: ChatToolCall, status: ActivityItem["status"], detail?: string, prefix = ""): ActivityItem {
  return {
    id: `${prefix}${call.id}`,
    kind: call.function.name === "run_command" ? "command" : call.function.name.includes("file") ? "files" : "tool",
    label: call.function.name.replaceAll("_", " "),
    ...(detail ? { detail: detail.slice(-12_000) } : {}),
    status,
    createdAt: Date.now(),
  };
}

function baseSystem(conversation: Conversation, readOnly: boolean, webSearchEnabled: boolean): string[] {
  return [
    "You are Grokky, a careful local workspace agent.",
    `The selected workspace is ${conversation.workingDirectory}.`,
    "Use tools when repository evidence is needed. Never request, read, expose, or infer credentials or private keys.",
    "Only claim to have read, browsed, seen, clicked, typed, or opened something when the matching tool completed successfully.",
    readOnly || conversation.sandboxMode === "read-only" ? "This session is read-only." : "Workspace file edits are allowed.",
    !readOnly && conversation.allowCommands ? "A small development-command allowlist is enabled." : "Command execution is disabled.",
    webSearchEnabled
      ? "Live web search is enabled. Use it for current or online information and include links to the sources consulted."
      : "Live web search is disabled. Do not claim to browse or search the live web; explain that it can be enabled in Settings.",
    PRODUCT_WRITING_STYLE_RULE,
    "Finish with a concise, evidence-backed answer that states what changed and what remains.",
  ];
}

function needsWebResearch(prompt: string): boolean {
  return /\b(search|browse|look\s*up|web|internet|online|latest|current|today|news|recent|source|sources|url|website)\b/i.test(prompt);
}

interface WebSearchCitation {
  type: "url_citation";
  url_citation: {
    url: string;
    title?: string;
    content?: string;
  };
}

interface WebSearchChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      annotations?: WebSearchCitation[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    cost?: number;
    server_tool_use?: { web_search_requests?: number };
    server_tool_use_details?: { web_search_requests?: number };
  };
  error?: { message?: string };
}

function webSearchUsageFrom(result: WebSearchChatResponse): UsageSummary | undefined {
  if (!result.usage) return undefined;
  return {
    inputTokens: result.usage.prompt_tokens ?? 0,
    cachedInputTokens: result.usage.prompt_tokens_details?.cached_tokens,
    outputTokens: result.usage.completion_tokens ?? 0,
    reasoningTokens: result.usage.completion_tokens_details?.reasoning_tokens,
    costUsd: result.usage.cost,
  };
}

async function researchWeb(
  context: OpenRouterRunContext,
): Promise<{ text: string; usage?: UsageSummary }> {
  const activityId = `web-search:${randomUUID()}`;
  const running: ActivityItem = {
    id: activityId,
    kind: "tool",
    label: "Live web search",
    detail: "OpenRouter is researching the live web and collecting source URLs.",
    status: "running",
    createdAt: Date.now(),
  };
  await context.onEvent({ type: "activity", activity: running });

  try {
    let totalUsage: UsageSummary | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${context.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Grokky",
        },
        body: JSON.stringify({
          model: OPENROUTER_WEB_RESEARCH_MODEL,
          messages: [
            {
              role: "system",
              content: [
                "You are Grokky's web research step. You must use the provided live web search tool before answering. Prefer first-party sources and never invent URLs.",
                PRODUCT_WRITING_STYLE_RULE,
              ].join("\n"),
            },
            {
              role: "user",
              content: [
                "Use live web search to research this request.",
                "Return a concise research brief with markdown links to every source used.",
                "",
                context.prompt,
              ].join("\n"),
            },
          ],
          tools: [{
            type: "openrouter:web_search",
            parameters: {
              engine: "auto",
              max_results: 5,
              max_total_results: 10,
              max_uses: 3,
              search_context_size: "medium",
            },
          }],
          tool_choice: "required",
          reasoning: { effort: context.conversation.reasoning },
          max_tool_calls: 3,
          stream: false,
          session_id: context.conversation.id,
        }),
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]),
      });
      const result = await response.json() as WebSearchChatResponse;
      if (!response.ok || result.error) throw new Error(result.error?.message || `OpenRouter web search failed (${response.status})`);
      totalUsage = addUsage(totalUsage, webSearchUsageFrom(result));
      const message = result.choices?.[0]?.message;
      const citations = message?.annotations?.filter((annotation) => annotation.type === "url_citation") ?? [];
      const sources = [...new Set(citations.map((citation) => citation.url_citation.url).filter(Boolean))];
      const searchRequests = result.usage?.server_tool_use_details?.web_search_requests
        ?? result.usage?.server_tool_use?.web_search_requests
        ?? 0;
      const text = message?.content?.trim();
      if (process.env.GROKKY_DEBUG_EVENTS === "1") {
        console.log(JSON.stringify({
          attempt,
          status: response.status,
          searchRequests,
          sources,
          annotations: message?.annotations,
          usage: result.usage,
          content: text,
        }, null, 2));
      }
      if (!searchRequests || !sources.length || !text) continue;

      await context.onEvent({
        type: "activity",
        activity: {
          ...running,
          detail: [
            `${searchRequests} live ${searchRequests === 1 ? "search" : "searches"} completed${attempt > 1 ? ` on attempt ${attempt}` : ""}`,
            `Research model: ${OPENROUTER_WEB_RESEARCH_MODEL}`,
            ...sources.map((source) => `Source: ${source}`),
          ].join("\n").slice(-12_000),
          status: "completed",
        },
      });
      return { text, ...(totalUsage ? { usage: totalUsage } : {}) };
    }
    throw new Error("OpenRouter returned no auditable web search or source URLs after two attempts");
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenRouter web search failed";
    await context.onEvent({
      type: "activity",
      activity: { ...running, detail: message, status: "failed" },
    });
    throw error;
  }
}

interface LoopOptions {
  conversation: Conversation;
  prompt: string;
  model?: string;
  reasoning?: Conversation["reasoning"];
  systemExtra?: string[];
  history?: boolean;
  readOnly?: boolean;
  activityPrefix?: string;
  emitActivity?: boolean;
}

async function runLoop(
  context: OpenRouterRunContext,
  client: OpenRouter,
  options: LoopOptions,
): Promise<{ text: string; usage?: UsageSummary }> {
  const readOnly = options.readOnly === true;
  const tools = toolsFor(context, options.conversation, readOnly);
  const prior = options.history
    ? options.conversation.messages.slice(-41, -1).map((message) => ({ role: message.role, content: message.content }) as ChatMessages)
    : [];
  const messages: ChatMessages[] = [
    { role: "system", content: [...baseSystem(options.conversation, readOnly, context.settings.webSearchEnabled), ...(options.systemExtra ?? [])].join("\n") },
    ...prior,
    { role: "user", content: options.prompt },
  ];
  let totalUsage: UsageSummary | undefined;
  for (let step = 0; step < 8; step += 1) {
    if (context.signal.aborted) throw new Error("OpenRouter run cancelled");
    const response = await client.chat.send({
      chatRequest: {
        model: options.model || options.conversation.model,
        messages,
        tools,
        toolChoice: "auto",
        parallelToolCalls: false,
        reasoning: { effort: options.reasoning || options.conversation.reasoning },
        stream: false,
        sessionId: options.conversation.id,
      },
    }, {
      signal: context.signal,
      timeoutMs: 180_000,
      headers: { Authorization: `Bearer ${context.apiKey}` },
    });
    const result = response as ChatResult;
    totalUsage = addUsage(totalUsage, usageFrom(result));
    const choice = result.choices[0];
    if (!choice) throw new Error("OpenRouter returned no completion choice");
    const assistant = choice.message;
    const toolCalls = assistant.toolCalls ?? [];
    if (!toolCalls.length) {
      const text = visibleContent(assistant.content).trim();
      if (!text) throw new Error("OpenRouter returned an empty answer");
      return { text, ...(totalUsage ? { usage: totalUsage } : {}) };
    }
    messages.push({ role: "assistant", content: assistant.content ?? "", toolCalls });
    for (const call of toolCalls) {
      if (options.emitActivity !== false) {
        await context.onEvent({ type: "activity", activity: activityForCall(call, "running", undefined, options.activityPrefix) });
      }
      let toolOutput: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        toolOutput = await context.executeTool(call.function.name as ComputerToolName, args, { readOnly });
        if (options.emitActivity !== false) {
          await context.onEvent({ type: "activity", activity: activityForCall(call, "completed", toolOutput, options.activityPrefix) });
        }
      } catch (error) {
        toolOutput = `Tool error: ${error instanceof Error ? error.message : "Unknown tool failure"}`;
        if (options.emitActivity !== false) {
          await context.onEvent({ type: "activity", activity: activityForCall(call, "failed", toolOutput, options.activityPrefix) });
        }
      }
      messages.push({ role: "tool", toolCallId: call.id, content: await openRouterToolContent(call.function.name, toolOutput) });
    }
  }
  throw new Error("OpenRouter reached the eight-step tool limit without a final answer");
}

async function runCrewMember(
  context: OpenRouterRunContext,
  client: OpenRouter,
  agent: AgentDefinition,
  prompt: string,
): Promise<{ agent: AgentDefinition; text: string; usage?: UsageSummary }> {
  const threadId = `openrouter:${randomUUID()}`;
  const operationId = `spawn:${threadId}`;
  await context.onEvent({
    type: "orchestration",
    event: {
      operationId,
      tool: "spawn_agent",
      senderThreadId: context.conversation.id,
      receiverThreads: [{ threadId, name: agent.name, status: "running" }],
      prompt,
      status: "completed",
    },
  });
  try {
    const result = await runLoop(context, client, {
      conversation: { ...context.conversation, sandboxMode: "read-only", allowCommands: false },
      prompt,
      model: agent.model,
      reasoning: agent.reasoning,
      systemExtra: [
        `You are the ${agent.name} crew member.`,
        agent.description,
        agent.developerInstructions,
        "Work independently in read-only mode. Return findings and evidence to the lead agent. Do not attempt file changes.",
      ],
      readOnly: true,
      activityPrefix: `${threadId}:`,
    });
    await context.onEvent({
      type: "orchestration",
      event: {
        operationId: `wait:${threadId}`,
        tool: "wait",
        senderThreadId: context.conversation.id,
        receiverThreads: [{ threadId, name: agent.name, status: "completed", message: result.text }],
        status: "completed",
      },
    });
    return { agent, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Crew member failed";
    await context.onEvent({
      type: "orchestration",
      event: {
        operationId: `wait:${threadId}`,
        tool: "wait",
        senderThreadId: context.conversation.id,
        receiverThreads: [{ threadId, name: agent.name, status: "failed", message }],
        status: "failed",
      },
    });
    return { agent, text: `Crew member failed: ${message}` };
  }
}

export async function runOpenRouter(context: OpenRouterRunContext): Promise<void> {
  const client = new OpenRouter({
    apiKey: context.apiKey,
    appTitle: "Grokky",
    appCategories: "desktop-agent,local-agent",
    timeoutMs: 180_000,
  });
  const crew = context.settings.multiAgentEnabled
    ? context.agents.slice(0, context.settings.maxAgentThreads)
    : [];
  const webResearch = context.settings.webSearchEnabled && needsWebResearch(context.prompt)
    ? await researchWeb(context)
    : undefined;
  const prompt = webResearch
    ? [
        context.prompt,
        "",
        "Verified live web research follows. Use these findings and preserve the direct source URLs in the answer:",
        webResearch.text,
      ].join("\n")
    : context.prompt;
  const results = crew.length
    ? await Promise.all(crew.map((agent) => runCrewMember(context, client, agent, prompt)))
    : [];
  let totalUsage = addUsage(
    webResearch?.usage,
    results.reduce<UsageSummary | undefined>((usage, result) => addUsage(usage, result.usage), undefined),
  );
  const findings = results.length
    ? [
        "Read-only Grokky crew findings follow. Verify them, resolve disagreements, and own all final decisions and file changes.",
        ...results.map((result) => `\n[${result.agent.name}]\n${result.text}`),
      ].join("\n")
    : "";
  const final = await runLoop(context, client, {
    conversation: context.conversation,
    prompt: findings ? `${prompt}\n\n${findings}` : prompt,
    model: webResearch ? OPENROUTER_WEB_RESEARCH_MODEL : undefined,
    history: true,
    systemExtra: [
      ...(results.length ? ["You are the lead agent. Consolidate the crew's findings before acting or answering."] : []),
      ...(webResearch ? ["The Verified live web research block was produced by an auditable server-side search. Treat it as authoritative evidence, preserve its direct source links, and never contradict it using unverified memory."] : []),
    ],
  });
  totalUsage = addUsage(totalUsage, final.usage);
  await context.onEvent({ type: "final", text: final.text });
  if (totalUsage) await context.onEvent({ type: "usage", usage: totalUsage });
}
