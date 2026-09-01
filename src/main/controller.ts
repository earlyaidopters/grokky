import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserWindow } from "electron";
import type {
  AgentDefinition,
  AgentComputerAction,
  AgentComputerEvidence,
  AgentComputerSession,
  AgentDraft,
  AgentIcon,
  AgentMeeting,
  AgentRunStatus,
  AppSettings,
  AppSnapshot,
  AttentionItem,
  ActivityItem,
  CapabilitiesSnapshot,
  ChatMessage,
  ComputerAccessLevel,
  ComputerAuditEntry,
  ComputerApprovalDecision,
  ComputerApprovalRequest,
  ComputerCapabilityId,
  ComputerDevice,
  Conversation,
  ConversationPatch,
  ImageAttachment,
  ImageInput,
  MessagePriority,
  ProviderStatus,
  RunOutcome,
  Routine,
  RoutineDraft,
  RoutineRun,
} from "../shared/contracts";
import { CODEX_MODELS, DEFAULT_OPENROUTER_MODEL, IPC } from "../shared/contracts";
import { requiresDevelopmentCommands, requiresInteractiveBrowser, requiresProjectDirectory } from "../shared/run-preflight";
import { CapabilitiesService } from "./capabilities";
import { AgentService } from "./agents";
import { assertPublicUrl, capabilityForTool, ComputerAccessService, domainAllowed, newAuditId, RemoteActionOutcomeUnknownError, targetForTool, type ComputerToolName } from "./computer-access";
import { browserOriginsForRequest } from "./codex-browser-permissions";
import type { AgentBrowserHost } from "./agent-computer";
import { unavailableAgentBrowserHost } from "./agent-computer";
import { providerStatuses, resolveOpenRouterCredential } from "./credentials";
import { runCodex } from "./providers/codex-provider";
import { runOpenRouter } from "./providers/openrouter-provider";
import type { AgentComputerIdentity, ProviderEvent, ProviderToolResult } from "./providers/types";
import { communicationsFromOrchestrationEvent, mergeCrewCommunications } from "./crew-communications";
import { finalizeAgentWorkflow, mergeAgentTasks, tasksFromOrchestrationEvent, updateMeetingFromOrchestration } from "./agent-workflow";
import { noProjectDirectory, StateStore, type PersistentState } from "./state-store";
import { ImageAttachmentStore } from "./image-attachments";
import { needsCrewMeeting } from "../shared/meeting-intent";
import { McpRuntime } from "./mcp-runtime";
import { extractGeneratedArtifacts } from "./generated-artifacts";
import { advancePastMissedOccurrences, isMissedRoutineWindow, MAX_ENABLED_ROUTINES, nextRoutineOccurrence, normalizeRoutineSchedule, ROUTINE_FAILURE_LIMIT } from "./routines";

interface RunOrigin {
  kind: "interactive" | "routine";
  unattended: boolean;
  routineId?: string;
  routineRunId?: string;
}

function id(): string {
  return randomUUID().replaceAll("-", "");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function argumentDigest(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

function titleFromMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 46 ? `${oneLine.slice(0, 45).trimEnd()}…` : oneLine;
}

function titleFromInput(text: string, attachments: ImageAttachment[]): string {
  if (text.trim()) return titleFromMessage(text);
  if (attachments.length === 1) return `Image: ${attachments[0]!.name}`;
  return `${attachments.length} images`;
}

async function requireDirectory(pathname: string): Promise<string> {
  const info = await stat(pathname);
  if (!info.isDirectory()) throw new Error("Working directory must be a folder");
  return pathname;
}

export function classifyRunOutcome(conversation: Conversation, selectedAgentCount: number): RunOutcome {
  const confirmedRuns = conversation.agentRuns.filter((run) => !/^(?:pending|queued|unconfirmed):/.test(run.id));
  if (selectedAgentCount > 0 && confirmedRuns.length < selectedAgentCount) return "blocked";
  if (confirmedRuns.some((run) => new Set(["failed", "stopped", "starting", "working", "waiting"]).has(run.status))) return "blocked";

  const productiveActivity = conversation.activities.some((activity) => (
    (activity.kind === "files" || activity.kind === "command") && activity.status === "completed"
  ));
  const lastUserIndex = conversation.messages.findLastIndex((message) => message.role === "user");
  const finalText = conversation.messages.slice(lastUserIndex + 1).find((message) => message.role === "assistant")?.content || "";
  if (!finalText.trim()) return "blocked";
  const blockingLanguage = /\b(?:no (?:files?|implementation|changes?) (?:were |was )?(?:made|changed)|could not|couldn't|cannot|can't|unable to|need(?:ed)? to proceed|requires? (?:a|the|your) (?:project|folder|permission)|not enabled|not available)\b/i;
  if (!productiveActivity && blockingLanguage.test(finalText)) return "blocked";
  return "delivered";
}

export function reconcileInterruptedConversation(
  conversation: Conversation,
  options: { aborted: boolean; continuing: boolean; error: unknown; now?: number },
): void {
  const now = options.now ?? Date.now();
  conversation.status = options.continuing ? "idle" : "error";
  conversation.lastRunOutcome = options.aborted ? "stopped" : "failed";
  conversation.agentRuns = conversation.agentRuns.map((run) => (
    new Set<AgentRunStatus>(["starting", "working", "waiting"]).has(run.status)
      ? { ...run, status: options.aborted ? "stopped" as const : "failed" as const, updatedAt: now }
      : run
  ));
  const workflow = finalizeAgentWorkflow(conversation.agentTasks ?? [], conversation.agentMeetings ?? [], conversation.agentRuns, now);
  conversation.agentTasks = workflow.tasks;
  conversation.agentMeetings = workflow.meetings;
  conversation.agentComputers = (conversation.agentComputers ?? []).map((computer) => (
    new Set<AgentComputerSession["status"]>(["provisioning", "ready", "working", "waiting"]).has(computer.status)
      ? { ...computer, status: options.aborted ? "stopped" as const : "failed" as const, currentAction: undefined, currentTarget: undefined, updatedAt: now }
      : computer
  ));
  conversation.error = options.continuing
    ? undefined
    : options.aborted
      ? "Run stopped"
      : options.error instanceof Error ? options.error.message : "Provider run failed";
  conversation.updatedAt = now;
}

export function agentComputerDeviceAssignments(
  devices: ComputerDevice[],
  activeDeviceId: string,
  spread: boolean,
  count: number,
): ComputerDevice[] {
  const active = devices.find((device) => device.id === activeDeviceId && device.status === "online") ?? devices.find((device) => device.status === "online");
  if (!active || count <= 0) return [];
  const pool = spread
    ? [active, ...devices.filter((device) => device.id !== active.id && device.status === "online")]
    : [active];
  return Array.from({ length: count }, (_, index) => pool[index % pool.length]!);
}

export class MainController {
  private state!: PersistentState;
  private statuses: ProviderStatus[] = [];
  private window: BrowserWindow | null = null;
  private readonly runs = new Map<string, AbortController>();
  private readonly interruptingRuns = new Set<string>();
  private readonly runAgentIcons = new Map<string, Map<string, AgentIcon>>();
  private readonly pendingApprovals: ComputerApprovalRequest[] = [];
  private readonly approvalResolvers = new Map<string, (decision: ComputerApprovalDecision) => void>();
  private readonly sessionComputerGrants = new Map<string, Set<ComputerCapabilityId>>();
  private readonly agentComputerLiveViews = new Map<string, string>();
  private computerHeartbeatTimer?: NodeJS.Timeout;
  private routineTimer?: NodeJS.Timeout;
  private schedulerLastHeartbeatAt = Date.now();
  private shutdownPromise?: Promise<void>;
  private readonly capabilities: CapabilitiesService;
  private readonly agents: AgentService;
  private readonly imageAttachments: ImageAttachmentStore;
  private readonly mcpRuntime: McpRuntime;

  constructor(
    private readonly store: StateStore,
    private readonly homeDirectory: string,
    private readonly appVersion: string,
    private readonly computerAccess = new ComputerAccessService(),
    private readonly agentBrowser: AgentBrowserHost = unavailableAgentBrowserHost(),
  ) {
    this.capabilities = new CapabilitiesService(homeDirectory);
    this.agents = new AgentService(homeDirectory);
    this.imageAttachments = new ImageAttachmentStore(join(homeDirectory, ".grokky", "attachments"));
    this.mcpRuntime = new McpRuntime(homeDirectory, appVersion);
  }

  async initialize(): Promise<void> {
    this.state = await this.store.load();
    await mkdir(noProjectDirectory(this.homeDirectory), { recursive: true });
    if (!this.state.settings.openRouterCredentialPath) {
      const credential = await resolveOpenRouterCredential(this.state.settings, this.homeDirectory);
      if (credential && credential.source !== "Process environment") {
        this.state.settings.openRouterCredentialPath = credential.source;
      }
    }
    if (!this.state.conversations.length) this.createConversationInternal();
    await this.refreshProviderStatuses(false);
    await this.store.save(this.state);
    void this.refreshComputerDevices();
    this.computerHeartbeatTimer = setInterval(() => void this.refreshComputerDevices(), 30_000);
    this.computerHeartbeatTimer.unref();
    this.routineTimer = setInterval(() => void this.tickRoutines(), 30_000);
    this.routineTimer.unref();
    void this.tickRoutines();
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
    this.publishSnapshot();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    if (this.computerHeartbeatTimer) clearInterval(this.computerHeartbeatTimer);
    this.computerHeartbeatTimer = undefined;
    if (this.routineTimer) clearInterval(this.routineTimer);
    this.routineTimer = undefined;
    for (const controller of this.runs.values()) controller.abort();
    for (const conversation of this.state.conversations) this.denyPendingApprovals(conversation.id);
    const seats = this.state.conversations.flatMap((conversation) => [
      ...(conversation.agentComputers ?? []),
      ...conversation.messages.flatMap((message) => message.crew?.agentComputers ?? []),
    ]);
    const uniqueSeats = [...new Map(seats.map((seat) => [seat.id, seat])).values()];
    await Promise.allSettled(uniqueSeats.map((seat) => this.disposeComputerSeat(seat)));
    this.agentBrowser.disposeAll();
    await this.mcpRuntime.close();
    this.agentComputerLiveViews.clear();
    this.window = null;
  }

  snapshot(): AppSnapshot {
    return structuredClone({
      conversations: [...this.state.conversations].sort((left, right) => right.updatedAt - left.updatedAt),
      ...(this.state.activeConversationId ? { activeConversationId: this.state.activeConversationId } : {}),
      settings: this.state.settings,
      providerStatuses: this.statuses,
      computerAccess: this.computerAccess.snapshot(this.state.computerAccess, this.activeWorkingDirectory(), this.pendingApprovals[0]),
      agentComputerLiveViews: Object.fromEntries(this.agentComputerLiveViews),
      routines: [...this.state.routines].sort((left, right) => left.nextRunAt - right.nextRunAt),
      routineRuns: [...this.state.routineRuns].sort((left, right) => right.createdAt - left.createdAt).slice(0, 100),
      attention: [...this.state.attention].sort((left, right) => right.createdAt - left.createdAt),
      scheduler: {
        active: Boolean(this.routineTimer),
        runsWhileAppOpen: true,
        lastHeartbeatAt: this.schedulerLastHeartbeatAt,
        ...((this.state.routines.filter((routine) => routine.enabled).sort((left, right) => left.nextRunAt - right.nextRunAt)[0]?.nextRunAt) ? {
          nextWakeAt: this.state.routines.filter((routine) => routine.enabled).sort((left, right) => left.nextRunAt - right.nextRunAt)[0]!.nextRunAt,
        } : {}),
      },
      appVersion: this.appVersion,
    });
  }

  async createConversation(): Promise<string> {
    const conversation = this.createConversationInternal();
    await this.commit();
    return conversation.id;
  }

  private createConversationInternal(): Conversation {
    const now = Date.now();
    const workingDirectory = this.state?.settings.defaultWorkingDirectory || noProjectDirectory(this.homeDirectory);
    const projectMode = resolve(workingDirectory) === resolve(noProjectDirectory(this.homeDirectory)) ? "none" : "project";
    const conversation: Conversation = {
      id: id(),
      title: "New session",
      instructions: "",
      provider: "codex",
      model: CODEX_MODELS[0],
      reasoning: "medium",
      sandboxMode: "workspace-write",
      allowCommands: false,
      projectMode,
      workingDirectory,
      messages: [],
      queuedMessages: [],
      activities: [],
      selectedAgentIds: [],
      agentRuns: [],
      crewCommunications: [],
      agentTasks: [],
      agentMeetings: [],
      agentComputers: [],
      status: "idle",
      unreadCount: 0,
      lastViewedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.state.conversations.unshift(conversation);
    this.state.activeConversationId = conversation.id;
    return conversation;
  }

  async setActiveConversation(conversationId: string): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    this.state.activeConversationId = conversationId;
    conversation.unreadCount = 0;
    conversation.lastViewedAt = Date.now();
    await this.commit();
  }

  async updateConversation(conversationId: string, patch: ConversationPatch): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    if (conversation.status === "running") throw new Error("Stop the current run before changing its configuration");
    const nextPatch = { ...patch };
    if (nextPatch.projectMode === "none") {
      nextPatch.workingDirectory = noProjectDirectory(this.homeDirectory);
      nextPatch.allowCommands = false;
    } else if (nextPatch.workingDirectory !== undefined) {
      nextPatch.workingDirectory = await requireDirectory(nextPatch.workingDirectory);
      nextPatch.projectMode = "project";
    }
    if (nextPatch.provider && nextPatch.provider !== conversation.provider) {
      this.switchConversationProvider(conversation, nextPatch.provider);
      if (nextPatch.provider === "openrouter") nextPatch.allowCommands = false;
    }
    const targetProvider = nextPatch.provider ?? conversation.provider;
    if (targetProvider === "openrouter" && nextPatch.allowCommands === true && !this.activeRemoteCommandDevice()) {
      throw new Error("Pair and select an online disposable sandbox before enabling OpenRouter commands");
    }
    if (
      (nextPatch.projectMode !== undefined && nextPatch.projectMode !== conversation.projectMode)
      || (nextPatch.workingDirectory !== undefined && resolve(nextPatch.workingDirectory) !== resolve(conversation.workingDirectory))
    ) {
      conversation.threadId = undefined;
      conversation.providerThreadIds = {};
    }
    Object.assign(conversation, nextPatch, { updatedAt: Date.now(), error: undefined });
    if (conversation.projectMode === "project") this.rememberProject(conversation.workingDirectory);
    await this.commit();
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.runs.get(conversationId)?.abort();
    this.denyPendingApprovals(conversationId);
    this.runs.delete(conversationId);
    const index = this.state.conversations.findIndex((item) => item.id === conversationId);
    if (index < 0) throw new Error("Conversation not found");
    const deletedConversation = this.state.conversations[index];
    const deletedComputers = [
      ...(deletedConversation?.agentComputers ?? []),
      ...(deletedConversation?.messages.flatMap((message) => message.crew?.agentComputers ?? []) ?? []),
    ];
    await Promise.allSettled(deletedComputers.map((computer) => this.disposeComputerSeat(computer)));
    for (const key of this.sessionComputerGrants.keys()) {
      if (key.startsWith(`${conversationId}:`)) this.sessionComputerGrants.delete(key);
    }
    this.state.conversations.splice(index, 1);
    const removedRoutineIds = new Set(this.state.routines.filter((routine) => routine.conversationId === conversationId).map((routine) => routine.id));
    this.state.routines = this.state.routines.filter((routine) => routine.conversationId !== conversationId);
    this.state.routineRuns = this.state.routineRuns.filter((run) => run.conversationId !== conversationId && !removedRoutineIds.has(run.routineId));
    this.state.attention = this.state.attention.filter((item) => item.conversationId !== conversationId && (!item.routineId || !removedRoutineIds.has(item.routineId)));
    if (!this.state.conversations.length) this.createConversationInternal();
    if (this.state.activeConversationId === conversationId) this.state.activeConversationId = this.state.conversations[0]?.id;
    await this.commit();
    try {
      await this.imageAttachments.removeConversation(conversationId);
    } catch {
      // The conversation is already deleted; stale attachment cleanup must not undo it.
    }
    await Promise.all(deletedComputers.flatMap((computer) => computer.evidence.map((evidence) => this.agentBrowser.removeEvidence(evidence.localPath))));
  }

  async sendMessage(conversationId: string, text: string, priority: MessagePriority = "normal", imageInputs: ImageInput[] = []): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    if (!text.trim() && !imageInputs.length) throw new Error("Message cannot be empty");
    await requireDirectory(conversation.workingDirectory);
    if (conversation.projectMode === "none" && requiresProjectDirectory(text)) {
      throw new Error("Choose a project folder before Grokky starts this work. Use the project menu below the message box, then choose or create a folder.");
    }
    if (conversation.provider === "codex" && requiresDevelopmentCommands(text) && !conversation.allowCommands) {
      throw new Error("This request needs local development commands. Choose Full access below the message box before sending it.");
    }
    const providerStatus = this.statuses.find((status) => status.id === conversation.provider);
    if (!providerStatus?.ready) throw new Error(providerStatus?.detail || `${conversation.provider} is not configured`);

    if (conversation.status === "running") {
      if (conversation.queuedMessages.length >= 12) throw new Error("This chat already has 12 queued follow-ups");
      const attachments = await this.imageAttachments.persist(conversationId, imageInputs);
      const queued = { id: id(), content: text, ...(attachments.length ? { attachments } : {}), priority, createdAt: Date.now() };
      if (priority === "priority") {
        conversation.queuedMessages.unshift(queued);
        this.interruptingRuns.add(conversationId);
        this.denyPendingApprovals(conversationId);
        this.runs.get(conversationId)?.abort();
      } else {
        conversation.queuedMessages.push(queued);
      }
      conversation.updatedAt = Date.now();
      await this.commit();
      return;
    }

    this.routeInteractiveBrowserRequest(conversation, text);

    const attachments = await this.imageAttachments.persist(conversationId, imageInputs);
    await this.beginRun(conversation, text, attachments);
  }

  private switchConversationProvider(conversation: Conversation, provider: Conversation["provider"]): void {
    if (provider === conversation.provider) return;
    conversation.providerThreadIds = {
      ...(conversation.providerThreadIds ?? {}),
      ...(conversation.threadId ? { [conversation.provider]: conversation.threadId } : {}),
    };
    conversation.threadId = conversation.providerThreadIds[provider];
    conversation.provider = provider;
    conversation.model = provider === "codex" ? CODEX_MODELS[0] : DEFAULT_OPENROUTER_MODEL;
  }

  private routeInteractiveBrowserRequest(conversation: Conversation, prompt: string): void {
    if (conversation.provider !== "codex" || !requiresInteractiveBrowser(prompt)) return;
    const remote = this.state.computerAccess.remoteDevices.find((device) => (
      !device.revoked
      && device.lastSeenAt > Date.now() - 90_000
      && device.capabilities.includes("browser")
      && device.capabilities.includes("automation")
    ));
    const openRouterReady = this.statuses.find((status) => status.id === "openrouter")?.ready === true;
    if (!remote || !openRouterReady) {
      throw new Error("Interactive browser control uses OpenRouter with the Grokky Cloud computer. Pair an online cloud sandbox and configure OpenRouter, then try again.");
    }
    this.switchConversationProvider(conversation, "openrouter");
    conversation.allowCommands = false;
    conversation.error = undefined;
    conversation.updatedAt = Date.now();
    this.state.computerAccess.activeDeviceId = remote.id;
  }

  private async beginRun(
    conversation: Conversation,
    text: string,
    attachments: ImageAttachment[] = [],
    origin: RunOrigin = { kind: "interactive", unattended: false },
  ): Promise<void> {
    const conversationId = conversation.id;
    const now = Date.now();
    this.archiveCurrentCrewTurn(conversation);
    const message: ChatMessage = {
      id: id(),
      role: "user",
      content: text,
      ...(attachments.length ? { attachments } : {}),
      ...(origin.routineId ? { routineId: origin.routineId } : {}),
      createdAt: now,
      provider: conversation.provider,
    };
    conversation.messages.push(message);
    if (conversation.messages.length === 1 && conversation.title === "New session") conversation.title = titleFromInput(text, attachments);
    conversation.activities = [];
    conversation.agentRuns = [];
    conversation.crewCommunications = [];
    conversation.agentTasks = [];
    conversation.agentMeetings = [];
    await Promise.allSettled((conversation.agentComputers ?? []).map((computer) => this.disposeComputerSeat(computer)));
    conversation.agentComputers = [];
    conversation.status = "running";
    conversation.lastRunOutcome = undefined;
    delete conversation.usage;
    conversation.error = undefined;
    conversation.updatedAt = now;
    const controller = new AbortController();
    this.runs.set(conversationId, controller);
    await this.commit();
    void this.executeRun(conversationId, text, attachments, controller, origin);
  }

  private archiveCurrentCrewTurn(conversation: Conversation): void {
    const userMessage = conversation.messages.findLast((message) => message.role === "user");
    if (!userMessage || userMessage.crew) return;
    const hasWorkflow = conversation.agentRuns.length > 0
      || conversation.crewCommunications.length > 0
      || (conversation.agentTasks?.length ?? 0) > 0
      || (conversation.agentMeetings?.length ?? 0) > 0
      || (conversation.agentComputers?.length ?? 0) > 0
      || conversation.activities.length > 0
      || Boolean(conversation.lastRunOutcome);
    if (!hasWorkflow) return;
    userMessage.crew = structuredClone({
      agentRuns: conversation.agentRuns,
      communications: conversation.crewCommunications,
      tasks: conversation.agentTasks ?? [],
      meetings: conversation.agentMeetings ?? [],
      agentComputers: conversation.agentComputers ?? [],
      activities: conversation.activities,
      ...(conversation.lastRunOutcome ? { lastRunOutcome: conversation.lastRunOutcome } : {}),
      ...(conversation.usage ? { usage: conversation.usage } : {}),
      updatedAt: conversation.updatedAt,
    });
  }

  async cancelRun(conversationId: string): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    const routineRunId = this.state.routineRuns.findLast((run) => run.conversationId === conversationId && run.status === "running")?.id;
    const queuedAttachments = conversation.queuedMessages.flatMap((message) => message.attachments ?? []);
    this.runs.get(conversationId)?.abort();
    this.runs.delete(conversationId);
    this.denyPendingApprovals(conversationId);
    conversation.status = "idle";
    conversation.lastRunOutcome = "stopped";
    conversation.error = "Run stopped";
    conversation.queuedMessages = [];
    conversation.agentRuns = conversation.agentRuns.map((run) => (
      new Set<AgentRunStatus>(["starting", "working", "waiting"]).has(run.status)
        ? { ...run, status: "stopped" as const, updatedAt: Date.now() }
        : run
    ));
    const workflow = finalizeAgentWorkflow(conversation.agentTasks ?? [], conversation.agentMeetings ?? [], conversation.agentRuns, Date.now());
    conversation.agentTasks = workflow.tasks;
    conversation.agentMeetings = workflow.meetings;
    conversation.agentComputers = (conversation.agentComputers ?? []).map((computer) => (
      new Set<AgentComputerSession["status"]>(["provisioning", "ready", "working", "waiting"]).has(computer.status)
        ? { ...computer, status: "stopped" as const, currentAction: undefined, currentTarget: undefined, updatedAt: Date.now() }
        : computer
    ));
    await Promise.allSettled(conversation.agentComputers.map((computer) => this.disposeComputerSeat(computer)));
    conversation.updatedAt = Date.now();
    await this.commit();
    if (routineRunId) await this.finishRoutineRun(routineRunId);
    await this.imageAttachments.remove(queuedAttachments);
  }

  async getImageAttachmentData(attachmentId: string): Promise<string> {
    const attachment = this.state.conversations
      .flatMap((conversation) => [
        ...conversation.messages.flatMap((message) => message.attachments ?? []),
        ...conversation.queuedMessages.flatMap((message) => message.attachments ?? []),
      ])
      .find((item) => item.id === attachmentId);
    if (!attachment) throw new Error("Image attachment not found");
    return this.imageAttachments.dataUrl(attachment);
  }

  async getAgentComputerEvidenceData(evidenceId: string): Promise<string> {
    const evidence = this.state.conversations
      .flatMap((conversation) => [
        ...(conversation.agentComputers ?? []),
        ...conversation.messages.flatMap((message) => message.crew?.agentComputers ?? []),
      ])
      .flatMap((computer) => computer.evidence)
      .find((item) => item.id === evidenceId);
    if (!evidence) throw new Error("Agent computer evidence not found");
    const data = await readFile(evidence.localPath);
    if (data.length > 15_000_000) throw new Error("Agent computer evidence is too large to preview");
    if (evidence.sha256 && createHash("sha256").update(data).digest("hex") !== evidence.sha256) {
      throw new Error("Agent computer evidence failed its integrity check");
    }
    return `data:${evidence.mimeType};base64,${data.toString("base64")}`;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    Object.assign(this.state.settings, patch);
    if (patch.multiAgentEnabled === false) {
      for (const conversation of this.state.conversations) conversation.selectedAgentIds = [];
    } else if (typeof patch.maxAgentThreads === "number") {
      for (const conversation of this.state.conversations) {
        conversation.selectedAgentIds = conversation.selectedAgentIds.slice(0, patch.maxAgentThreads);
      }
    }
    await this.refreshProviderStatuses(false);
    await this.commit();
  }

  async createRoutine(draft: RoutineDraft): Promise<void> {
    this.requireConversation(draft.conversationId);
    const schedule = normalizeRoutineSchedule(draft.schedule);
    if (draft.enabled && this.state.routines.filter((routine) => routine.enabled).length >= MAX_ENABLED_ROUTINES) {
      throw new Error(`Grokky supports up to ${MAX_ENABLED_ROUTINES} enabled routines`);
    }
    const now = Date.now();
    this.state.routines.push({
      id: `routine-${id()}`,
      conversationId: draft.conversationId,
      name: draft.name.trim().slice(0, 100),
      instruction: draft.instruction.trim().slice(0, 20_000),
      schedule,
      enabled: draft.enabled,
      nextRunAt: nextRoutineOccurrence(schedule, now),
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    });
    await this.commit();
  }

  async updateRoutine(routineId: string, patch: Partial<Omit<RoutineDraft, "conversationId">>): Promise<void> {
    const routine = this.requireRoutine(routineId);
    if (patch.enabled === true && !routine.enabled && this.state.routines.filter((candidate) => candidate.enabled).length >= MAX_ENABLED_ROUTINES) {
      throw new Error(`Grokky supports up to ${MAX_ENABLED_ROUTINES} enabled routines`);
    }
    if (patch.name !== undefined) routine.name = patch.name.trim().slice(0, 100);
    if (patch.instruction !== undefined) routine.instruction = patch.instruction.trim().slice(0, 20_000);
    if (patch.schedule !== undefined) {
      routine.schedule = normalizeRoutineSchedule(patch.schedule);
      routine.nextRunAt = nextRoutineOccurrence(routine.schedule, Date.now());
    }
    if (patch.enabled !== undefined) {
      routine.enabled = patch.enabled;
      if (patch.enabled) {
        routine.nextRunAt = nextRoutineOccurrence(routine.schedule, Date.now());
        routine.consecutiveFailures = 0;
      }
    }
    routine.updatedAt = Date.now();
    await this.commit();
  }

  async deleteRoutine(routineId: string): Promise<void> {
    const index = this.state.routines.findIndex((routine) => routine.id === routineId);
    if (index < 0) throw new Error("Routine not found");
    this.state.routines.splice(index, 1);
    this.state.routineRuns = this.state.routineRuns.filter((run) => run.routineId !== routineId);
    this.state.attention = this.state.attention.filter((item) => item.routineId !== routineId);
    await this.commit();
  }

  async runRoutine(routineId: string): Promise<void> {
    const routine = this.requireRoutine(routineId);
    await this.dispatchRoutine(routine, Date.now(), false, false);
  }

  async resolveAttention(attentionId: string): Promise<void> {
    const item = this.state.attention.find((candidate) => candidate.id === attentionId);
    if (!item) throw new Error("Attention item not found");
    item.status = "resolved";
    item.resolvedAt = Date.now();
    await this.commit();
  }

  private requireRoutine(routineId: string): Routine {
    const routine = this.state.routines.find((candidate) => candidate.id === routineId);
    if (!routine) throw new Error("Routine not found");
    return routine;
  }

  private appendAttention(item: Omit<AttentionItem, "id" | "status" | "createdAt">): AttentionItem {
    const existing = this.state.attention.find((candidate) => (
      candidate.status === "open"
      && candidate.kind === item.kind
      && candidate.title === item.title
      && candidate.conversationId === item.conversationId
      && candidate.routineId === item.routineId
    ));
    if (existing) {
      existing.detail = item.detail;
      existing.severity = item.severity;
      return existing;
    }
    const attention: AttentionItem = {
      id: `attention-${id()}`,
      ...item,
      status: "open",
      createdAt: Date.now(),
    };
    this.state.attention.push(attention);
    this.state.attention = this.state.attention.slice(-500);
    return attention;
  }

  private async tickRoutines(): Promise<void> {
    this.schedulerLastHeartbeatAt = Date.now();
    const now = this.schedulerLastHeartbeatAt;
    const due = this.state.routines.filter((routine) => routine.enabled && routine.nextRunAt <= now).sort((left, right) => left.nextRunAt - right.nextRunAt);
    for (const routine of due) {
      if (isMissedRoutineWindow(routine.nextRunAt, now)) {
        const skipped = this.newRoutineRun(routine, routine.nextRunAt, "skipped", "The scheduled window passed while Grokky was not available; missed occurrences are not replayed.");
        skipped.finishedAt = now;
        routine.nextRunAt = advancePastMissedOccurrences(routine, now);
        routine.updatedAt = now;
        continue;
      }
      await this.dispatchRoutine(routine, routine.nextRunAt, true, true);
    }
    if (due.length) await this.commit();
    else this.publishSnapshot();
  }

  private newRoutineRun(routine: Routine, scheduledFor: number, status: RoutineRun["status"], detail?: string): RoutineRun {
    const now = Date.now();
    const run: RoutineRun = {
      id: `routine-run-${id()}`,
      routineId: routine.id,
      conversationId: routine.conversationId,
      scheduledFor,
      status,
      ...(detail ? { detail } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.state.routineRuns.push(run);
    this.state.routineRuns = this.state.routineRuns.slice(-500);
    return run;
  }

  private async dispatchRoutine(routine: Routine, scheduledFor: number, unattended: boolean, advanceSchedule: boolean): Promise<void> {
    const conversation = this.requireConversation(routine.conversationId);
    if (advanceSchedule) {
      routine.nextRunAt = nextRoutineOccurrence(routine.schedule, scheduledFor);
      routine.updatedAt = Date.now();
    }
    if (conversation.status === "running") {
      const skipped = this.newRoutineRun(routine, scheduledFor, "skipped", "The target conversation was already running, so this occurrence was skipped instead of replayed later.");
      skipped.finishedAt = Date.now();
      await this.commit();
      return;
    }
    const providerStatus = this.statuses.find((status) => status.id === conversation.provider);
    if (!providerStatus?.ready) {
      const run = this.newRoutineRun(routine, scheduledFor, "failed", providerStatus?.detail || `${conversation.provider} is not configured`);
      run.finishedAt = Date.now();
      await this.recordRoutineFailure(routine, run);
      await this.commit();
      return;
    }
    const run = this.newRoutineRun(routine, scheduledFor, "running");
    run.startedAt = Date.now();
    run.updatedAt = run.startedAt;
    routine.lastRunAt = run.startedAt;
    await this.commit();
    try {
      await this.beginRun(conversation, routine.instruction, [], { kind: "routine", unattended, routineId: routine.id, routineRunId: run.id });
    } catch (error) {
      run.status = "failed";
      run.detail = error instanceof Error ? error.message : "Scheduled run failed to start";
      run.finishedAt = Date.now();
      run.updatedAt = run.finishedAt;
      await this.recordRoutineFailure(routine, run);
      await this.commit();
    }
  }

  private async recordRoutineFailure(routine: Routine, run: RoutineRun): Promise<void> {
    routine.consecutiveFailures += 1;
    routine.updatedAt = Date.now();
    this.appendAttention({
      kind: "routine",
      severity: "warning",
      title: `${routine.name} needs attention`,
      detail: run.detail || "The scheduled run did not complete.",
      conversationId: routine.conversationId,
      routineId: routine.id,
    });
    if (routine.consecutiveFailures >= ROUTINE_FAILURE_LIMIT) {
      routine.enabled = false;
      this.appendAttention({
        kind: "routine",
        severity: "critical",
        title: `${routine.name} was switched off`,
        detail: `Grokky disabled this routine after ${ROUTINE_FAILURE_LIMIT} consecutive unsuccessful runs. Review its permissions and instruction before enabling it again.`,
        conversationId: routine.conversationId,
        routineId: routine.id,
      });
    }
  }

  async setComputerAccessEnabled(enabled: boolean): Promise<void> {
    this.state.computerAccess.enabled = enabled;
    if (!enabled) {
      for (const conversation of this.state.conversations) this.denyPendingApprovals(conversation.id);
      this.sessionComputerGrants.clear();
    }
    await this.commit();
  }

  async setComputerCapability(capability: ComputerCapabilityId, level: ComputerAccessLevel): Promise<void> {
    this.computerAccess.setCapability(this.state.computerAccess, capability, level);
    if (level !== "allow") {
      for (const grants of this.sessionComputerGrants.values()) grants.delete(capability);
    }
    await this.commit();
  }

  async requestComputerPermission(capability: ComputerCapabilityId): Promise<void> {
    await this.computerAccess.requestPermission(capability);
    await this.commit();
  }

  async testComputerCapability(capability: ComputerCapabilityId): Promise<void> {
    const conversation = this.requireConversation(this.state.activeConversationId || this.state.conversations[0]!.id);
    const target = capability === "files" || capability === "commands" ? conversation.workingDirectory : "local capability check";
    const audit = this.appendComputerAudit(conversation, capability, `test_${capability}`, target, "allowed", "pending", "Capability test accepted; outcome pending");
    await this.commit();
    try {
      const detail = await this.computerAccess.test(this.state.computerAccess, capability, conversation);
      this.finishComputerAudit(audit.id, "completed", detail.slice(0, 2_000));
    } catch (error) {
      this.finishComputerAudit(audit.id, "failed", error instanceof Error ? error.message : "Capability test failed");
      await this.commit();
      throw error;
    }
    await this.commit();
  }

  async pairComputer(endpoint: string, code: string): Promise<void> {
    await this.computerAccess.pair(this.state.computerAccess, endpoint, code);
    await this.commit();
  }

  async selectComputer(deviceId: string): Promise<void> {
    this.computerAccess.select(this.state.computerAccess, deviceId);
    const active = this.state.conversations.find((conversation) => conversation.id === this.state.activeConversationId);
    if (active?.provider === "openrouter" && !this.activeRemoteCommandDevice()) active.allowCommands = false;
    await this.commit();
  }

  async revokeComputer(deviceId: string): Promise<void> {
    await this.computerAccess.revoke(this.state.computerAccess, deviceId);
    for (const conversation of this.state.conversations) {
      if (conversation.provider === "openrouter" && !this.activeRemoteCommandDevice()) conversation.allowCommands = false;
    }
    await this.commit();
  }

  private activeRemoteCommandDevice(): boolean {
    const device = this.state.computerAccess.remoteDevices.find((candidate) => (
      candidate.id === this.state.computerAccess.activeDeviceId
      && !candidate.revoked
      && candidate.lastSeenAt > Date.now() - 90_000
      && candidate.capabilities.includes("commands")
    ));
    return Boolean(device);
  }

  private async refreshComputerDevices(): Promise<void> {
    const refreshed = await this.computerAccess.heartbeat(this.state.computerAccess);
    if (refreshed) await this.store.save(this.state);
    this.publishSnapshot();
  }

  async updateComputerNetworkAllowlist(domains: string[]): Promise<void> {
    this.state.computerAccess.networkAllowlist = [...new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))].slice(0, 100);
    await this.commit();
  }

  async resolveComputerApproval(approvalId: string, decision: ComputerApprovalDecision): Promise<void> {
    const index = this.pendingApprovals.findIndex((approval) => approval.id === approvalId);
    if (index < 0) throw new Error("Computer approval is no longer pending");
    const approval = this.pendingApprovals[index]!;
    this.pendingApprovals.splice(index, 1);
    if (decision === "allow-session") {
      const grantKey = this.computerGrantKey(approval.conversationId, approval.agentComputerId, approval.deviceId);
      const grants = this.sessionComputerGrants.get(grantKey) ?? new Set<ComputerCapabilityId>();
      for (const [capability, level] of Object.entries(this.state.computerAccess.grants)) {
        if (level !== "blocked") grants.add(capability as ComputerCapabilityId);
      }
      this.sessionComputerGrants.set(grantKey, grants);
    }
    this.approvalResolvers.get(approvalId)?.(decision);
    this.approvalResolvers.delete(approvalId);
    this.publishSnapshot();
  }

  async refreshProviderStatuses(publish = true): Promise<void> {
    this.statuses = await providerStatuses(this.state.settings, this.homeDirectory);
    if (publish) await this.commit();
  }

  async getCapabilities(): Promise<CapabilitiesSnapshot> {
    return this.capabilities.snapshot(this.activeWorkingDirectory());
  }

  async setSkillEnabled(pathname: string, enabled: boolean): Promise<CapabilitiesSnapshot> {
    return this.capabilities.setSkillEnabled(pathname, enabled, this.activeWorkingDirectory());
  }

  async setMcpEnabled(id: string, enabled: boolean): Promise<CapabilitiesSnapshot> {
    return this.capabilities.setMcpEnabled(id, enabled, this.activeWorkingDirectory());
  }

  async setConnectorEnabled(id: string, enabled: boolean): Promise<CapabilitiesSnapshot> {
    return this.capabilities.setConnectorEnabled(id, enabled, this.activeWorkingDirectory());
  }

  async getAgents(): Promise<AgentDefinition[]> {
    return this.agents.list(this.activeWorkingDirectory());
  }

  async createAgent(draft: AgentDraft): Promise<AgentDefinition[]> {
    return this.agents.create(draft, this.activeWorkingDirectory());
  }

  async updateAgent(agentId: string, draft: AgentDraft): Promise<AgentDefinition[]> {
    return this.agents.update(agentId, draft, this.activeWorkingDirectory());
  }

  async deleteAgent(agentId: string): Promise<AgentDefinition[]> {
    const agents = await this.agents.delete(agentId, this.activeWorkingDirectory());
    const valid = new Set(agents.map((agent) => agent.id));
    for (const conversation of this.state.conversations) {
      conversation.selectedAgentIds = conversation.selectedAgentIds.filter((id) => valid.has(id));
    }
    await this.commit();
    return agents;
  }

  private async executeRun(conversationId: string, prompt: string, images: ImageAttachment[], controller: AbortController, origin: RunOrigin): Promise<void> {
    const original = this.requireConversation(conversationId);
    const existingComputerIds = new Set((original.agentComputers ?? []).map((computer) => computer.id));
    const runMessageId = original.messages.findLast((message) => message.role === "user")?.id;
    const runGrantScopes = new Set<string>(runMessageId ? [runMessageId] : []);
    const conversation = structuredClone(original);
    const settings = structuredClone(this.state.settings);
    const computerAccess = structuredClone(this.state.computerAccess);
    const ownsRun = () => this.runs.get(conversationId) === controller && !controller.signal.aborted;
    const onEvent = async (event: ProviderEvent) => {
      if (!ownsRun()) return;
      await this.applyProviderEvent(conversationId, event, controller);
    };
    const executeTool = async (name: ComputerToolName, args: Record<string, unknown>, options?: { readOnly?: boolean; agentComputer?: AgentComputerIdentity }) => {
      if (!ownsRun()) throw new Error("Run cancelled");
      const output = await this.executeComputerTool(conversationId, name, args, { ...options, signal: controller.signal, unattended: origin.unattended });
      if (!ownsRun()) throw new Error("Run cancelled");
      return output;
    };
    const executeExternalTool = async (name: string, args: Record<string, unknown>, options?: { readOnly?: boolean; agentComputer?: AgentComputerIdentity }) => {
      if (!ownsRun()) throw new Error("Run cancelled");
      const output = await this.executeExternalTool(conversationId, name, args, { ...options, signal: controller.signal, unattended: origin.unattended });
      if (!ownsRun()) throw new Error("Run cancelled");
      return output;
    };
    const readImageDataUrl = (attachment: ImageAttachment) => this.imageAttachments.dataUrl(attachment);
    const effectivePrompt = conversation.instructions
      ? `Persistent session purpose:\n${conversation.instructions}\n\nCurrent request:\n${prompt}`
      : prompt;
    try {
      const approvedBrowserOrigins = conversation.provider === "codex"
        ? await this.approveCodexBrowserOrigins(original, prompt, origin.unattended)
        : [];
      const selectedAgents = await this.agents.selected(conversation.selectedAgentIds, conversation.workingDirectory);
      const agents = settings.multiAgentEnabled ? selectedAgents.slice(0, settings.maxAgentThreads) : [];
      this.runAgentIcons.set(conversationId, new Map(agents.flatMap((agent) => agent.icon ? [[agent.name.toLowerCase(), agent.icon] as const] : [])));
      this.initializeAgentComputers(original, agents);
      for (const computer of original.agentComputers ?? []) {
        if (!existingComputerIds.has(computer.id)) runGrantScopes.add(computer.id);
      }
      conversation.agentComputers = structuredClone(original.agentComputers ?? []);
      await this.commit();
      const external = conversation.provider === "openrouter" && settings.openRouterExternalTools
        ? await this.mcpRuntime.listTools()
        : { tools: [], errors: [] };
      if (external.errors.length) {
        await onEvent({
          type: "activity",
          activity: {
            id: `external-tools-${id()}`,
            kind: "notice",
            label: "Some external tools were unavailable",
            detail: external.errors.join("\n").slice(0, 12_000),
            status: "failed",
            createdAt: Date.now(),
          },
        });
      }
      if (conversation.provider === "codex") {
        await runCodex({ conversation, settings, agents, prompt: effectivePrompt, images, readImageDataUrl, signal: controller.signal, computerAccess, approvedBrowserOrigins, executeTool, unattended: origin.unattended, onEvent });
      } else {
        const credential = await resolveOpenRouterCredential(this.state.settings, this.homeDirectory);
        if (!credential) throw new Error("OpenRouter credential is unavailable");
        await runOpenRouter({ conversation, settings, agents, prompt: effectivePrompt, images, readImageDataUrl, signal: controller.signal, computerAccess, approvedBrowserOrigins, executeTool, externalTools: external.tools, executeExternalTool, unattended: origin.unattended, onEvent, apiKey: credential.apiKey });
      }
      const current = this.state.conversations.find((item) => item.id === conversationId);
      if (current && this.runs.get(conversationId) === controller) {
        const now = Date.now();
        current.agentRuns = current.agentRuns.map((run) => (
          new Set<AgentRunStatus>(["starting", "working", "waiting"]).has(run.status)
            ? {
                ...run,
                status: "stopped" as const,
                result: run.result || "The lead turn ended before this specialist delivered a confirmed final report.",
                updatedAt: now,
              }
            : run
        ));
        current.crewCommunications = current.crewCommunications.map((entry) => {
          if (entry.status !== "running") return entry;
          const run = current.agentRuns.find((candidate) => candidate.threadId === entry.receiverThreadId);
          if (!run) return entry;
          return { ...entry, status: run.status === "completed" ? "completed" as const : "failed" as const };
        });
        const finalAnswer = [...current.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
        const workflow = finalizeAgentWorkflow(current.agentTasks ?? [], current.agentMeetings ?? [], current.agentRuns, now, finalAnswer);
        current.agentTasks = workflow.tasks;
        current.agentMeetings = workflow.meetings;
        current.status = "idle";
        const requiredAgentCount = conversation.provider === "codex" || needsCrewMeeting(prompt) ? agents.length : 0;
        current.lastRunOutcome = classifyRunOutcome(current, requiredAgentCount);
        current.agentComputers = (current.agentComputers ?? []).map((computer) => (
          !new Set<AgentComputerSession["status"]>(["provisioning", "ready", "working", "waiting"]).has(computer.status)
            ? computer
            : computer.role === "lead"
              ? { ...computer, status: "completed" as const, currentAction: undefined, currentTarget: undefined, updatedAt: now }
              : (() => {
                  const run = current.agentRuns.find((candidate) => candidate.threadId === computer.threadId || candidate.name.toLowerCase() === computer.agentName.toLowerCase());
                  const status: AgentComputerSession["status"] = run?.status === "completed"
                    ? "completed"
                    : run?.status === "failed"
                      ? "failed"
                      : "stopped";
                  return { ...computer, status, currentAction: undefined, currentTarget: undefined, updatedAt: now };
                })()
        ));
        current.error = undefined;
        current.updatedAt = now;
        await this.commit();
      }
    } catch (error) {
      const current = this.state.conversations.find((item) => item.id === conversationId);
      const continuing = controller.signal.aborted && this.interruptingRuns.has(conversationId);
      if (current && this.runs.get(conversationId) === controller) {
        reconcileInterruptedConversation(current, { aborted: controller.signal.aborted, continuing, error });
        await this.commit();
      }
    } finally {
      const ownsRun = this.runs.get(conversationId) === controller;
      if (ownsRun && origin.routineRunId) await this.finishRoutineRun(origin.routineRunId);
      if (ownsRun) this.runs.delete(conversationId);
      this.interruptingRuns.delete(conversationId);
      this.runAgentIcons.delete(conversationId);
      for (const key of this.sessionComputerGrants.keys()) {
        if ([...runGrantScopes].some((scope) => key.startsWith(`${conversationId}:${scope}:`))) {
          this.sessionComputerGrants.delete(key);
        }
      }
      const current = this.state.conversations.find((item) => item.id === conversationId);
      await Promise.allSettled((current?.agentComputers ?? []).map((computer) => this.disposeComputerSeat(computer)));
      if (ownsRun && current?.queuedMessages.length) {
        const next = current.queuedMessages.shift()!;
        await this.beginRun(current, next.content, next.attachments ?? []);
      }
    }
  }

  private async applyProviderEvent(conversationId: string, event: ProviderEvent, controller?: AbortController): Promise<void> {
    if (controller && (this.runs.get(conversationId) !== controller || controller.signal.aborted)) return;
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    if (event.type === "thread") {
      conversation.threadId = event.threadId;
      conversation.providerThreadIds = { ...(conversation.providerThreadIds ?? {}), [conversation.provider]: event.threadId };
      const lead = (conversation.agentComputers ?? []).findLast((computer) => computer.role === "lead");
      if (lead) {
        lead.threadId = event.threadId;
        lead.status = "ready";
        lead.currentAction = undefined;
        lead.currentTarget = undefined;
        lead.updatedAt = Date.now();
      }
    }
    if (event.type === "usage") conversation.usage = event.usage;
    if (event.type === "task") {
      conversation.agentTasks = mergeAgentTasks(conversation.agentTasks ?? [], [event.task]);
    }
    if (event.type === "meeting") {
      const meetings = conversation.agentMeetings ?? [];
      const index = meetings.findIndex((meeting) => meeting.id === event.meeting.id);
      conversation.agentMeetings = index >= 0
        ? meetings.map((meeting, meetingIndex) => meetingIndex === index ? { ...event.meeting, createdAt: meeting.createdAt } : meeting).slice(-20)
        : [...meetings, event.meeting].slice(-20);
    }
    if (event.type === "attention") {
      const activeRoutineId = this.state.routineRuns.findLast((run) => run.conversationId === conversationId && run.status === "running")?.routineId;
      this.appendAttention({
        kind: event.item.kind,
        severity: event.item.severity,
        title: event.item.title,
        detail: event.item.detail,
        conversationId: event.item.conversationId ?? conversationId,
        ...(event.item.routineId || activeRoutineId ? { routineId: event.item.routineId ?? activeRoutineId } : {}),
      });
    }
    if (event.type === "final") {
      const generated = this.state.settings.generatedArtifactsEnabled
        ? extractGeneratedArtifacts(event.text)
        : { text: event.text, artifacts: [] };
      conversation.messages.push({
        id: id(),
        role: "assistant",
        content: generated.text || (generated.artifacts.length ? "I created a structured result below." : "The provider completed without a visible answer."),
        ...(generated.artifacts.length ? { artifacts: generated.artifacts } : {}),
        createdAt: Date.now(),
        provider: conversation.provider,
      });
      if (this.state.activeConversationId !== conversationId) conversation.unreadCount = Math.min(99, conversation.unreadCount + 1);
    }
    if (event.type === "activity") {
      const index = conversation.activities.findIndex((item) => item.id === event.activity.id);
      if (index >= 0) conversation.activities[index] = { ...event.activity, createdAt: conversation.activities[index]!.createdAt };
      else conversation.activities.push(event.activity);
      conversation.activities = conversation.activities.slice(-80);
      this.applyActivityToAgentComputer(conversation, event.activity);
    }
    if (event.type === "orchestration") {
      const now = Date.now();
      const stateStatus = (value: string): AgentRunStatus => {
        if (/complete|done/i.test(value)) return "completed";
        if (/fail|error|not_found/i.test(value)) return "failed";
        if (/stop|shutdown|close|interrupt/i.test(value)) return "stopped";
        if (/wait/i.test(value)) return "waiting";
        if (/pending|init|start/i.test(value)) return "starting";
        return "working";
      };
      const iconFor = (name: string | undefined): AgentIcon | undefined => name ? this.runAgentIcons.get(conversationId)?.get(name.toLowerCase()) : undefined;
      if (event.event.tool === "spawn_agent" && event.event.status === "running" && !event.event.receiverThreads.length) {
        const pendingId = `pending:${event.event.operationId}`;
        if (!conversation.agentRuns.some((run) => run.id === pendingId)) {
          conversation.agentRuns.push({
            id: pendingId,
            operationId: event.event.operationId,
            threadId: pendingId,
            name: "Starting agent",
            task: event.event.prompt || "Preparing delegated work",
            status: "starting",
            createdAt: now,
            updatedAt: now,
          });
        }
      } else {
        if (event.event.tool === "spawn_agent" && event.event.receiverThreads.length) {
          conversation.agentRuns = conversation.agentRuns.filter((run) => run.id !== `pending:${event.event.operationId}`);
        }
        for (const thread of event.event.receiverThreads) {
          const icon = iconFor(thread.name);
          const index = conversation.agentRuns.findIndex((run) => run.threadId === thread.threadId);
          const status = event.event.tool === "wait" && event.event.status === "running" ? "waiting" : stateStatus(thread.status);
          if (index >= 0) {
            const previous = conversation.agentRuns[index]!;
            conversation.agentRuns[index] = {
              ...previous,
              status,
              ...(thread.name ? { name: thread.name } : {}),
              ...(icon ? { icon } : {}),
              ...(event.event.prompt && event.event.tool !== "wait" ? { task: event.event.prompt } : {}),
              ...(thread.message ? { result: thread.message } : {}),
              updatedAt: now,
            };
          } else {
            conversation.agentRuns.push({
              id: thread.threadId,
              operationId: event.event.operationId,
              threadId: thread.threadId,
              name: thread.name || `Crew member ${conversation.agentRuns.length + 1}`,
              ...(icon ? { icon } : {}),
              task: event.event.prompt || "Delegated task",
              status,
              ...(thread.message ? { result: thread.message } : {}),
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }
      conversation.agentRuns = conversation.agentRuns.slice(-40);
      conversation.crewCommunications = mergeCrewCommunications(
        conversation.crewCommunications,
        communicationsFromOrchestrationEvent(event.event, conversation.agentRuns, now),
      );
      if (event.event.tool === "wait") {
        const terminalByThread = new Map(event.event.receiverThreads.map((thread) => [thread.threadId, /complete|done/i.test(thread.status) ? "completed" as const : /fail|error|stop|interrupt/i.test(thread.status) ? "failed" as const : undefined]));
        conversation.crewCommunications = conversation.crewCommunications.map((entry) => {
          const status = terminalByThread.get(entry.receiverThreadId);
          return status && entry.kind === "assignment" ? { ...entry, status } : entry;
        });
      }
      conversation.agentTasks = mergeAgentTasks(
        conversation.agentTasks ?? [],
        tasksFromOrchestrationEvent(event.event, conversation.agentRuns, conversation.agentTasks ?? [], now),
      );
      const latestUser = conversation.messages.findLast((message) => message.role === "user");
      if (latestUser && needsCrewMeeting(latestUser.content)) {
        const meetingId = `meeting:${latestUser.id}`;
        const meetings = conversation.agentMeetings ?? [];
        const existing = meetings.find((meeting) => meeting.id === meetingId);
        const base: AgentMeeting = existing ?? {
          id: meetingId,
          title: "Crew review meeting",
          agenda: latestUser.content,
          participantThreadIds: conversation.agentRuns.filter((run) => !/^(?:pending|queued|unconfirmed):/.test(run.id)).map((run) => run.threadId),
          participantNames: conversation.agentRuns.filter((run) => !/^(?:pending|queued|unconfirmed):/.test(run.id)).map((run) => run.name),
          status: "live",
          contributions: [],
          decisions: [],
          actionItems: [],
          createdAt: now,
          updatedAt: now,
        };
        const updated = updateMeetingFromOrchestration(event.event, conversation.agentRuns, base, now);
        conversation.agentMeetings = existing
          ? meetings.map((meeting) => meeting.id === meetingId ? updated : meeting).slice(-20)
          : [...meetings, updated].slice(-20);
      }
      this.applyOrchestrationToAgentComputers(conversation, event.event.receiverThreads, event.event.prompt);
    }
    conversation.updatedAt = Date.now();
    await this.commit();
  }

  private initializeAgentComputers(conversation: Conversation, agents: AgentDefinition[]): void {
    const access = this.computerAccess.snapshot(this.state.computerAccess, conversation.workingDirectory);
    const localDevice = access.devices.find((item) => item.kind === "local");
    const device = conversation.provider === "codex"
      ? localDevice
      : access.devices.find((item) => item.id === access.activeDeviceId && item.status === "online") ?? localDevice;
    if (!device) return;
    const now = Date.now();
    const definitions: Array<{ agentId: string; agentName: string; role: AgentComputerSession["role"]; icon?: AgentIcon; task?: string }> = [
      { agentId: "grokky-lead", agentName: "Grokky lead", role: "lead", icon: "lime", task: "Coordinate the request and deliver the final result" },
      ...agents.map((agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        role: "specialist" as const,
        ...(agent.icon ? { icon: agent.icon } : {}),
        task: agent.description,
      })),
    ];
    const assignments = conversation.provider === "codex"
      ? Array.from({ length: definitions.length }, () => device)
      : agentComputerDeviceAssignments(access.devices, access.activeDeviceId, this.state.settings.spreadAgentComputers === true, definitions.length);
    const newComputers: AgentComputerSession[] = definitions.map((definition, index) => {
      const assignedDevice = assignments[index] ?? device;
      return ({
        id: `agent-computer-${id()}`,
        conversationId: conversation.id,
        agentId: definition.agentId,
        agentName: definition.agentName,
        role: definition.role,
        ...(definition.icon ? { icon: definition.icon } : {}),
        ...(definition.task ? { task: definition.task } : {}),
        status: definition.role === "lead" ? "working" : "provisioning",
        isolation: conversation.provider === "openrouter" && assignedDevice.kind === "local" && this.agentBrowser.available
          ? "isolated-browser"
          : conversation.provider === "openrouter" && assignedDevice.kind === "remote" && assignedDevice.capabilities.includes("browser")
            ? "cloud-browser"
            : "policy-session",
        deviceId: assignedDevice.id,
        deviceName: assignedDevice.name,
        workspaceRoot: assignedDevice.root,
        ...(definition.role === "lead" ? { currentAction: "Coordinating the run", currentTarget: definition.task } : {}),
        actions: [],
        evidence: [],
        createdAt: now,
        updatedAt: now,
      });
    });
    const combined = [...(conversation.agentComputers ?? []), ...newComputers];
    const dropped = combined.slice(0, Math.max(0, combined.length - 40));
    conversation.agentComputers = combined.slice(-40);
    const retainedEvidencePaths = new Set([
      ...(conversation.agentComputers ?? []).flatMap((computer) => computer.evidence.map((evidence) => evidence.localPath)),
      ...conversation.messages.flatMap((message) => (message.crew?.agentComputers ?? []).flatMap((computer) => computer.evidence.map((evidence) => evidence.localPath))),
    ]);
    for (const computer of dropped) {
      this.agentBrowser.disposeSession(computer.id);
      for (const evidence of computer.evidence) {
        if (!retainedEvidencePaths.has(evidence.localPath)) void this.agentBrowser.removeEvidence(evidence.localPath);
      }
    }
  }

  private applyActivityToAgentComputer(conversation: Conversation, activity: ActivityItem): void {
    const computers = conversation.agentComputers ?? [];
    const computer = computers.find((candidate) => candidate.threadId && activity.id.startsWith(`${candidate.threadId}:`))
      ?? computers.findLast((candidate) => candidate.role === "lead");
    if (!computer || computer.status === "completed" || computer.status === "stopped") return;
    computer.status = activity.status === "failed" ? "failed" : activity.status === "running" ? "working" : "ready";
    computer.currentAction = activity.status === "running" ? activity.label : undefined;
    computer.currentTarget = activity.status === "running" ? activity.detail?.slice(0, 500) : undefined;
    computer.updatedAt = Date.now();
  }

  private applyOrchestrationToAgentComputers(
    conversation: Conversation,
    threads: Array<{ threadId: string; name?: string; status: string; message?: string }>,
    prompt?: string,
  ): void {
    const now = Date.now();
    for (const thread of threads) {
      const computer = (conversation.agentComputers ?? []).findLast((candidate) => (
        candidate.threadId === thread.threadId
        || (thread.name && candidate.agentName.toLowerCase() === thread.name.toLowerCase())
      ));
      if (!computer) continue;
      computer.threadId = thread.threadId;
      if (prompt) computer.task = prompt;
      computer.status = /complete|done/i.test(thread.status)
        ? "completed"
        : /fail|error/i.test(thread.status)
          ? "failed"
          : /stop|interrupt/i.test(thread.status)
            ? "stopped"
            : /wait/i.test(thread.status)
              ? "waiting"
              : "working";
      computer.currentAction = computer.status === "working" ? "Working on assigned task" : undefined;
      computer.currentTarget = computer.status === "working" ? computer.task : undefined;
      computer.updatedAt = now;
    }
  }

  private requireConversation(conversationId: string): Conversation {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error("Conversation not found");
    return conversation;
  }

  private async executeComputerTool(
    conversationId: string,
    name: ComputerToolName,
    args: Record<string, unknown>,
    options?: { readOnly?: boolean; agentComputer?: AgentComputerIdentity; signal?: AbortSignal; unattended?: boolean },
  ): Promise<ProviderToolResult> {
    const signal = options?.signal;
    if (signal?.aborted) throw new Error("Run cancelled");
    const source = this.requireConversation(conversationId);
    const conversation = options?.readOnly ? { ...source, sandboxMode: "read-only" as const, allowCommands: false } : source;
    const capability = capabilityForTool(name);
    const target = targetForTool(name, args);
    if (name === "browse_url") await assertPublicUrl(new URL(String(args.url ?? "")));
    const computer = this.findAgentComputer(source, options?.agentComputer);
    const action = computer ? this.beginAgentComputerAction(computer, capability, name, target) : undefined;
    if (action) await this.commit();
    if (signal?.aborted) throw new Error("Run cancelled");
    let approvedTarget: boolean;
    try {
      approvedTarget = await this.authorizeComputerTool(conversation, capability, name, target, computer, options?.unattended);
    } catch (error) {
      const cancelled = signal?.aborted === true;
      const message = cancelled ? "Run cancelled before the action was authorized" : error instanceof Error ? error.message : "Computer action was denied";
      if (computer && action) this.finishAgentComputerAction(computer, action, cancelled ? "failed" : "denied", message);
      await this.commit();
      throw cancelled ? new Error("Run cancelled") : error;
    }
    if (signal?.aborted) {
      if (computer && action) this.finishAgentComputerAction(computer, action, "failed", "Run cancelled before the action started");
      await this.commit();
      throw new Error("Run cancelled");
    }
    const audit = this.appendComputerAudit(conversation, capability, name, target, "allowed", "pending", "Action authorized; outcome pending", computer, argumentDigest(args));
    await this.commit();
    try {
      let output: string;
      let attachmentPath: string | undefined;
      let browserObservation: ProviderToolResult["browserObservation"];
      let browserOutcome: ProviderToolResult["browserOutcome"];
      if (
        name === "browse_url"
        && computer
        && computer.deviceId === this.state.computerAccess.localDeviceId
        && this.agentBrowser.available
      ) {
        const result = await this.agentBrowser.browse({
          sessionId: computer.id,
          url: String(args.url ?? ""),
          networkAllowlist: this.state.computerAccess.networkAllowlist,
          approvedTarget,
          signal,
        });
        if (signal?.aborted) {
          await this.agentBrowser.removeEvidence(result.evidencePath);
          throw new Error("Run cancelled");
        }
        output = result.output;
        attachmentPath = result.evidencePath;
        computer.isolation = "isolated-browser";
        computer.currentUrl = result.currentUrl;
        computer.pageTitle = result.pageTitle;
        this.appendAgentComputerEvidence(computer, {
          kind: "browser",
          title: result.pageTitle,
          source: result.currentUrl,
          localPath: result.evidencePath,
          sha256: result.evidenceSha256,
        });
      } else {
        const execution = await this.computerAccess.execute({
          state: this.state.computerAccess,
          conversation,
          name,
          args,
          approvedTarget,
          ...(computer ? { deviceId: computer.deviceId } : {}),
          signal,
          auditContext: {
            actionId: audit.id,
            conversationId: conversation.id,
            ...(computer ? { agentComputerId: computer.id, agentName: computer.agentName } : {}),
            ...(audit.argumentDigest ? { argumentDigest: audit.argumentDigest } : {}),
          },
        });
        output = execution.output;
        browserObservation = execution.browserObservation;
        browserOutcome = execution.browserOutcome;
        if (signal?.aborted) throw new Error("Run cancelled");
        if (computer && execution.visualArtifact) {
          if (execution.visualArtifact.liveViewUrl) {
            this.agentComputerLiveViews.set(computer.id, execution.visualArtifact.liveViewUrl);
          }
          if (!this.agentBrowser.storeEvidence) throw new Error("Cloud browser evidence storage is unavailable in this runtime");
          const imageBytes = Buffer.from(execution.visualArtifact.dataBase64, "base64");
          const imported = await this.agentBrowser.storeEvidence(imageBytes, computer.id);
          if (imported.evidenceSha256 !== execution.visualArtifact.sha256) {
            await this.agentBrowser.removeEvidence(imported.evidencePath);
            throw new Error("Cloud browser frame integrity check failed");
          }
          computer.isolation = "cloud-browser";
          computer.currentUrl = execution.visualArtifact.currentUrl;
          computer.pageTitle = execution.visualArtifact.pageTitle;
          this.appendAgentComputerEvidence(computer, {
            kind: name === "capture_screen" ? "screen" : "browser",
            title: execution.visualArtifact.pageTitle || `${computer.agentName} cloud browser`,
            source: execution.visualArtifact.currentUrl,
            localPath: imported.evidencePath,
            sha256: imported.evidenceSha256,
          });
          attachmentPath = imported.evidencePath;
        } else if (computer && name === "capture_screen") {
          const pathname = output.match(/^Captured the current display to ([^\n]+)(?:\n|$)/)?.[1];
          if (pathname) {
            const imported = await this.agentBrowser.importEvidence(pathname, computer.id);
            this.appendAgentComputerEvidence(computer, {
              kind: "screen",
              title: `${computer.agentName} screen capture`,
              source: target,
              localPath: imported.evidencePath,
              sha256: imported.evidenceSha256,
            });
            attachmentPath = imported.evidencePath;
            output = output.replace(/^Captured the current display to [^\n]+/, "Captured the current display.");
          }
        }
      }
      const outcome = this.computerOutcomeSummary(name, output);
      if (computer && action) {
        this.finishAgentComputerAction(computer, action, "completed", browserOutcome?.changes.join("; ") || outcome);
        if (browserOutcome) action.effect = browserOutcome.effect;
        if (browserObservation) action.snapshotId = browserObservation.snapshotId;
      }
      this.finishComputerAudit(audit.id, "completed", outcome);
      await this.commit();
      return {
        output,
        ...(attachmentPath ? { attachmentPath, attachmentMimeType: "image/png" as const } : {}),
        ...(browserObservation ? { browserObservation } : {}),
        ...(browserOutcome ? { browserOutcome } : {}),
      };
    } catch (error) {
      const cancelled = signal?.aborted === true;
      const outcomeUnknown = cancelled || error instanceof RemoteActionOutcomeUnknownError;
      const message = cancelled
        ? "Run cancelled while the action was in flight; the final external outcome may be unknown"
        : error instanceof Error ? error.message : "Computer action failed";
      const outcomeStatus = outcomeUnknown ? "indeterminate" as const : "failed" as const;
      if (computer && action) this.finishAgentComputerAction(computer, action, outcomeStatus, message);
      this.finishComputerAudit(audit.id, outcomeStatus, message);
      await this.commit();
      throw cancelled ? new Error("Run cancelled") : error;
    }
  }

  private async executeExternalTool(
    conversationId: string,
    name: string,
    args: Record<string, unknown>,
    options?: { readOnly?: boolean; agentComputer?: AgentComputerIdentity; signal?: AbortSignal; unattended?: boolean },
  ): Promise<ProviderToolResult> {
    if (!this.state.settings.openRouterExternalTools) throw new Error("OpenRouter external tools are disabled");
    const definition = this.mcpRuntime.definition(name);
    if (!definition) throw new Error("External tool is not available");
    if (options?.readOnly && !definition.readOnly) throw new Error("Specialists may call only MCP tools explicitly marked read-only");
    const conversation = this.requireConversation(conversationId);
    const computer = options?.agentComputer
      ? (conversation.agentComputers ?? []).findLast((candidate) => candidate.agentId === options.agentComputer?.agentId || candidate.agentName.toLowerCase() === options.agentComputer?.agentName.toLowerCase())
      : undefined;
    const target = `${definition.serverId}/${definition.toolName}`.slice(0, 500);
    await this.authorizeComputerTool(conversation, "external", name, target, computer, options?.unattended);
    const audit = this.appendComputerAudit(conversation, "external", name, target, "allowed", "pending", "External tool authorized; outcome pending", computer, argumentDigest(args));
    await this.commit();
    try {
      const output = await this.mcpRuntime.callTool(name, args, options?.signal);
      this.finishComputerAudit(audit.id, "completed", `External tool completed; ${Buffer.byteLength(output, "utf8")} output bytes; SHA-256 ${createHash("sha256").update(output).digest("hex")}`);
      await this.commit();
      return { output };
    } catch (error) {
      const cancelled = options?.signal?.aborted === true;
      const detail = cancelled ? "Run cancelled while the external call was in flight; its final outcome may be unknown" : error instanceof Error ? error.message : "External tool failed";
      this.finishComputerAudit(audit.id, cancelled ? "indeterminate" : "failed", detail);
      this.appendAttention({
        kind: "computer",
        severity: cancelled ? "critical" : "warning",
        title: cancelled ? "External action outcome is unknown" : `${definition.serverId} tool failed`,
        detail,
        conversationId,
      });
      await this.commit();
      throw cancelled ? new Error("Run cancelled") : error;
    }
  }

  private async finishRoutineRun(routineRunId: string): Promise<void> {
    const run = this.state.routineRuns.find((candidate) => candidate.id === routineRunId);
    if (!run || run.status !== "running") return;
    const routine = this.state.routines.find((candidate) => candidate.id === run.routineId);
    const conversation = this.state.conversations.find((candidate) => candidate.id === run.conversationId);
    const outcome = conversation?.lastRunOutcome;
    run.status = outcome === "delivered" ? "completed" : outcome === "blocked" ? "blocked" : outcome === "stopped" ? "stopped" : "failed";
    run.detail = run.status === "completed"
      ? "Scheduled instruction delivered in the conversation."
      : conversation?.error || `Scheduled run ended ${run.status}.`;
    run.finishedAt = Date.now();
    run.updatedAt = run.finishedAt;
    if (routine) {
      routine.lastRunAt = run.finishedAt;
      if (run.status === "completed") {
        routine.consecutiveFailures = 0;
        for (const item of this.state.attention) {
          if (item.status === "open" && item.routineId === routine.id) {
            item.status = "resolved";
            item.resolvedAt = Date.now();
          }
        }
      } else if (run.status === "blocked" || run.status === "failed") {
        await this.recordRoutineFailure(routine, run);
      }
      routine.updatedAt = Date.now();
    }
    await this.commit();
  }

  private computerOutcomeSummary(name: ComputerToolName, output: string): string {
    const bytes = Buffer.byteLength(output, "utf8");
    const digest = createHash("sha256").update(output).digest("hex");
    const label = name === "capture_screen"
      ? "Captured the current display"
      : name === "browse_url"
        ? "Browser action completed"
        : name.includes("file")
          ? "Workspace file action completed"
          : "Computer action completed";
    return `${label}; ${bytes} output bytes; SHA-256 ${digest}`;
  }

  private async approveCodexBrowserOrigins(conversation: Conversation, prompt: string, unattended = false): Promise<string[]> {
    const access = this.state.computerAccess;
    if (access.activeDeviceId !== access.localDeviceId) return [];
    const origins = browserOriginsForRequest(prompt, conversation.messages);
    const approved: string[] = [];
    for (const origin of origins) {
      await this.authorizeComputerTool(conversation, "browser", "browse_url", origin, undefined, unattended);
      approved.push(origin);
      this.appendComputerAudit(conversation, "browser", "browse_url", origin, "allowed", "completed", "Approved for this Codex browser session");
    }
    if (approved.length) await this.commit();
    return approved;
  }

  private async authorizeComputerTool(
    conversation: Conversation,
    capability: ComputerCapabilityId,
    action: string,
    target: string,
    computer?: AgentComputerSession,
    unattended = false,
  ): Promise<boolean> {
    const access = this.state.computerAccess;
    if (!access.enabled || access.grants[capability] === "blocked") {
      this.appendComputerAudit(conversation, capability, action, target, "denied", "failed", access.enabled ? "Capability is blocked" : "Computer access is disabled", computer);
      await this.commit();
      throw new Error(access.enabled ? `${capability} access is blocked` : "Computer access is disabled");
    }
    if (capability === "browser") {
      try {
        if (domainAllowed(new URL(target).hostname, access.networkAllowlist)) return false;
      } catch {
        // Non-URL browser targets still follow the selected capability policy.
      }
    } else if (access.grants[capability] === "allow") {
      return false;
    }
    const deviceId = computer?.deviceId ?? access.activeDeviceId;
    const grantKey = this.computerGrantKey(conversation.id, computer?.id, deviceId);
    if (this.sessionComputerGrants.get(grantKey)?.has(capability)) return true;
    if (unattended) {
      this.appendComputerAudit(conversation, capability, action, target, "denied", "failed", "Unattended runs require Always allow; temporary approvals are never inherited", computer);
      await this.commit();
      throw new Error(`${capability} access needs approval; unattended routines can use only Always allow capabilities`);
    }
    const device = this.computerAccess.snapshot(access, conversation.workingDirectory).devices.find((item) => item.id === deviceId);
    const approval: ComputerApprovalRequest = {
      id: `approval-${id()}`,
      deviceId,
      deviceName: device?.name || "Computer",
      conversationId: conversation.id,
      ...(computer ? { agentComputerId: computer.id, agentId: computer.agentId, agentName: computer.agentName } : {}),
      capability,
      action: action.replaceAll("_", " "),
      target,
      createdAt: Date.now(),
    };
    this.pendingApprovals.push(approval);
    this.publishSnapshot();
    const decision = await new Promise<ComputerApprovalDecision>((resolve) => this.approvalResolvers.set(approval.id, resolve));
    if (decision === "deny") {
      this.appendComputerAudit(conversation, capability, action, target, "denied", "failed", "User denied the computer action", computer);
      await this.commit();
      throw new Error("Computer action was denied");
    }
    return true;
  }

  private appendComputerAudit(
    conversation: Conversation,
    capability: ComputerCapabilityId,
    action: string,
    target: string,
    decision: "allowed" | "denied",
    status: ComputerAuditEntry["status"],
    detail?: string,
    computer?: AgentComputerSession,
    argsDigest?: string,
  ): ComputerAuditEntry {
    const entry: ComputerAuditEntry = {
      id: newAuditId(),
      deviceId: computer?.deviceId ?? this.state.computerAccess.activeDeviceId,
      conversationId: conversation.id,
      provider: conversation.provider,
      ...(computer ? { agentComputerId: computer.id, agentName: computer.agentName } : {}),
      capability,
      action,
      target,
      ...(argsDigest ? { argumentDigest: argsDigest } : {}),
      decision,
      status,
      ...(detail ? { detail } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.state.computerAccess.auditLog.push(entry);
    this.state.computerAccess.auditLog = this.state.computerAccess.auditLog.slice(-250);
    return entry;
  }

  private finishComputerAudit(auditId: string, status: Exclude<ComputerAuditEntry["status"], "pending">, detail: string): void {
    const entry = this.state.computerAccess.auditLog.find((candidate) => candidate.id === auditId);
    if (!entry) return;
    entry.status = status;
    entry.detail = detail;
    entry.updatedAt = Date.now();
  }

  private computerGrantKey(conversationId: string, agentComputerId?: string, deviceId?: string): string {
    const conversation = this.state.conversations.find((candidate) => candidate.id === conversationId);
    const runScope = agentComputerId || conversation?.messages.findLast((message) => message.role === "user")?.id || "conversation";
    return `${conversationId}:${runScope}:${deviceId ?? this.state.computerAccess.activeDeviceId}`;
  }

  private findAgentComputer(conversation: Conversation, identity?: AgentComputerIdentity): AgentComputerSession | undefined {
    const computers = conversation.agentComputers ?? [];
    if (!identity) return computers.findLast((computer) => computer.role === "lead");
    return computers.findLast((computer) => computer.agentId === identity.agentId)
      ?? computers.findLast((computer) => identity.threadId && computer.threadId === identity.threadId)
      ?? computers.findLast((computer) => computer.agentName.toLowerCase() === identity.agentName.toLowerCase());
  }

  private beginAgentComputerAction(
    computer: AgentComputerSession,
    capability: ComputerCapabilityId,
    name: ComputerToolName,
    target: string,
  ): AgentComputerAction {
    const now = Date.now();
    const action: AgentComputerAction = {
      id: `agent-action-${id()}`,
      capability,
      action: name,
      target,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    computer.actions.push(action);
    computer.actions = computer.actions.slice(-40);
    computer.status = "working";
    computer.currentAction = name.replaceAll("_", " ");
    computer.currentTarget = target;
    computer.updatedAt = now;
    return action;
  }

  private finishAgentComputerAction(
    computer: AgentComputerSession,
    action: AgentComputerAction,
    status: AgentComputerAction["status"],
    detail: string,
  ): void {
    action.status = status;
    action.detail = detail.slice(0, 2_000);
    action.updatedAt = Date.now();
    computer.status = status === "completed" ? "ready" : "failed";
    computer.currentAction = undefined;
    computer.currentTarget = undefined;
    computer.updatedAt = action.updatedAt;
  }

  private appendAgentComputerEvidence(
    computer: AgentComputerSession,
    evidence: Omit<AgentComputerEvidence, "id" | "mimeType" | "createdAt">,
  ): void {
    computer.evidence.push({
      id: `agent-evidence-${id()}`,
      ...evidence,
      mimeType: "image/png",
      createdAt: Date.now(),
    });
    const dropped = computer.evidence.slice(0, Math.max(0, computer.evidence.length - 12));
    computer.evidence = computer.evidence.slice(-12);
    for (const item of dropped) void this.agentBrowser.removeEvidence(item.localPath);
  }

  private denyPendingApprovals(conversationId: string): void {
    for (const approval of [...this.pendingApprovals]) {
      if (approval.conversationId !== conversationId) continue;
      const index = this.pendingApprovals.findIndex((item) => item.id === approval.id);
      if (index >= 0) this.pendingApprovals.splice(index, 1);
      this.approvalResolvers.get(approval.id)?.("deny");
      this.approvalResolvers.delete(approval.id);
    }
  }

  private activeWorkingDirectory(): string {
    return this.state.conversations.find((item) => item.id === this.state.activeConversationId)?.workingDirectory
      || this.state.settings.defaultWorkingDirectory
      || this.homeDirectory;
  }

  private async disposeComputerSeat(computer: AgentComputerSession): Promise<void> {
    if (this.agentComputerLiveViews.delete(computer.id)) this.publishSnapshot();
    this.agentBrowser.disposeSession(computer.id);
    await this.computerAccess.disposeSeat(this.state.computerAccess, computer.deviceId, computer.conversationId, computer.id);
  }

  private rememberProject(pathname: string): void {
    const normalized = resolve(pathname);
    const recents = this.state.settings.recentWorkingDirectories.filter((item) => resolve(item) !== normalized);
    this.state.settings.recentWorkingDirectories = [pathname, ...recents].slice(0, 12);
    this.state.settings.defaultWorkingDirectory = pathname;
  }

  private async commit(): Promise<void> {
    await this.store.save(this.state);
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(IPC.snapshotChanged, this.snapshot());
  }
}
