import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserWindow } from "electron";
import type {
  AgentDefinition,
  AgentDraft,
  AgentIcon,
  AgentRunStatus,
  AppSettings,
  AppSnapshot,
  CapabilitiesSnapshot,
  ChatMessage,
  ComputerAccessLevel,
  ComputerApprovalDecision,
  ComputerApprovalRequest,
  ComputerCapabilityId,
  Conversation,
  ConversationPatch,
  MessagePriority,
  ProviderStatus,
  RunOutcome,
} from "../shared/contracts";
import { CODEX_MODELS, DEFAULT_OPENROUTER_MODEL, IPC } from "../shared/contracts";
import { requiresDevelopmentCommands, requiresProjectDirectory } from "../shared/run-preflight";
import { CapabilitiesService } from "./capabilities";
import { AgentService } from "./agents";
import { capabilityForTool, ComputerAccessService, newAuditId, targetForTool, type ComputerToolName } from "./computer-access";
import { providerStatuses, resolveOpenRouterCredential } from "./credentials";
import { runCodex } from "./providers/codex-provider";
import { runOpenRouter } from "./providers/openrouter-provider";
import type { ProviderEvent } from "./providers/types";
import { communicationsFromOrchestrationEvent, mergeCrewCommunications } from "./crew-communications";
import { noProjectDirectory, StateStore, type PersistentState } from "./state-store";

function id(): string {
  return randomUUID().replaceAll("-", "");
}

function titleFromMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 46 ? `${oneLine.slice(0, 45).trimEnd()}…` : oneLine;
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
  private readonly capabilities: CapabilitiesService;
  private readonly agents: AgentService;

  constructor(
    private readonly store: StateStore,
    private readonly homeDirectory: string,
    private readonly appVersion: string,
    private readonly computerAccess = new ComputerAccessService(),
  ) {
    this.capabilities = new CapabilitiesService(homeDirectory);
    this.agents = new AgentService(homeDirectory);
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
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
    this.publishSnapshot();
  }

  snapshot(): AppSnapshot {
    return structuredClone({
      conversations: [...this.state.conversations].sort((left, right) => right.updatedAt - left.updatedAt),
      ...(this.state.activeConversationId ? { activeConversationId: this.state.activeConversationId } : {}),
      settings: this.state.settings,
      providerStatuses: this.statuses,
      computerAccess: this.computerAccess.snapshot(this.state.computerAccess, this.activeWorkingDirectory(), this.pendingApprovals[0]),
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
      conversation.threadId = undefined;
      conversation.model = nextPatch.provider === "codex" ? CODEX_MODELS[0] : DEFAULT_OPENROUTER_MODEL;
    }
    if (
      (nextPatch.projectMode !== undefined && nextPatch.projectMode !== conversation.projectMode)
      || (nextPatch.workingDirectory !== undefined && resolve(nextPatch.workingDirectory) !== resolve(conversation.workingDirectory))
    ) {
      conversation.threadId = undefined;
    }
    Object.assign(conversation, nextPatch, { updatedAt: Date.now(), error: undefined });
    if (conversation.projectMode === "project") this.rememberProject(conversation.workingDirectory);
    await this.commit();
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.runs.get(conversationId)?.abort();
    this.runs.delete(conversationId);
    const index = this.state.conversations.findIndex((item) => item.id === conversationId);
    if (index < 0) throw new Error("Conversation not found");
    this.state.conversations.splice(index, 1);
    if (!this.state.conversations.length) this.createConversationInternal();
    if (this.state.activeConversationId === conversationId) this.state.activeConversationId = this.state.conversations[0]?.id;
    await this.commit();
  }

  async sendMessage(conversationId: string, text: string, priority: MessagePriority = "normal"): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    await requireDirectory(conversation.workingDirectory);
    if (conversation.projectMode === "none" && requiresProjectDirectory(text)) {
      throw new Error("Choose a project folder before Grokky starts this work. Use the project menu below the message box, then choose or create a folder.");
    }
    if (requiresDevelopmentCommands(text) && !conversation.allowCommands) {
      throw new Error("This request needs local development commands. Choose Full access below the message box before sending it.");
    }
    const providerStatus = this.statuses.find((status) => status.id === conversation.provider);
    if (!providerStatus?.ready) throw new Error(providerStatus?.detail || `${conversation.provider} is not configured`);

    if (conversation.status === "running") {
      if (conversation.queuedMessages.length >= 12) throw new Error("This chat already has 12 queued follow-ups");
      const queued = { id: id(), content: text, priority, createdAt: Date.now() };
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

    await this.beginRun(conversation, text);
  }

  private async beginRun(conversation: Conversation, text: string): Promise<void> {
    const conversationId = conversation.id;
    const now = Date.now();
    const message: ChatMessage = { id: id(), role: "user", content: text, createdAt: now, provider: conversation.provider };
    conversation.messages.push(message);
    if (conversation.messages.length === 1 && conversation.title === "New session") conversation.title = titleFromMessage(text);
    conversation.activities = [];
    conversation.agentRuns = [];
    conversation.crewCommunications = [];
    conversation.status = "running";
    conversation.lastRunOutcome = undefined;
    conversation.error = undefined;
    conversation.updatedAt = now;
    const controller = new AbortController();
    this.runs.set(conversationId, controller);
    await this.commit();
    void this.executeRun(conversationId, text, controller);
  }

  async cancelRun(conversationId: string): Promise<void> {
    const conversation = this.requireConversation(conversationId);
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
    conversation.updatedAt = Date.now();
    await this.commit();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    Object.assign(this.state.settings, patch);
    await this.refreshProviderStatuses(false);
    await this.commit();
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
    try {
      const detail = await this.computerAccess.test(this.state.computerAccess, capability, conversation);
      this.appendComputerAudit(conversation, capability, `test_${capability}`, target, "allowed", "completed", detail.slice(0, 2_000));
    } catch (error) {
      this.appendComputerAudit(conversation, capability, `test_${capability}`, target, "allowed", "failed", error instanceof Error ? error.message : "Capability test failed");
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
    await this.commit();
  }

  async revokeComputer(deviceId: string): Promise<void> {
    this.computerAccess.revoke(this.state.computerAccess, deviceId);
    await this.commit();
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
      const grants = this.sessionComputerGrants.get(approval.conversationId) ?? new Set<ComputerCapabilityId>();
      grants.add(approval.capability);
      this.sessionComputerGrants.set(approval.conversationId, grants);
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

  private async executeRun(conversationId: string, prompt: string, controller: AbortController): Promise<void> {
    const original = this.requireConversation(conversationId);
    const conversation = structuredClone(original);
    const settings = structuredClone(this.state.settings);
    const computerAccess = structuredClone(this.state.computerAccess);
    const onEvent = (event: ProviderEvent) => this.applyProviderEvent(conversationId, event);
    const executeTool = (name: ComputerToolName, args: Record<string, unknown>, options?: { readOnly?: boolean }) => this.executeComputerTool(conversationId, name, args, options);
    const effectivePrompt = conversation.instructions
      ? `Persistent session purpose:\n${conversation.instructions}\n\nCurrent request:\n${prompt}`
      : prompt;
    try {
      const agents = await this.agents.selected(conversation.selectedAgentIds, conversation.workingDirectory);
      this.runAgentIcons.set(conversationId, new Map(agents.flatMap((agent) => agent.icon ? [[agent.name.toLowerCase(), agent.icon] as const] : [])));
      if (conversation.provider === "codex") {
        await runCodex({ conversation, settings, agents, prompt: effectivePrompt, signal: controller.signal, computerAccess, executeTool, onEvent });
      } else {
        const credential = await resolveOpenRouterCredential(this.state.settings, this.homeDirectory);
        if (!credential) throw new Error("OpenRouter credential is unavailable");
        await runOpenRouter({ conversation, settings, agents, prompt: effectivePrompt, signal: controller.signal, computerAccess, executeTool, onEvent, apiKey: credential.apiKey });
      }
      const current = this.state.conversations.find((item) => item.id === conversationId);
      if (current && this.runs.get(conversationId) === controller) {
        current.status = "idle";
        current.lastRunOutcome = classifyRunOutcome(current, conversation.selectedAgentIds.length);
        current.error = undefined;
        current.updatedAt = Date.now();
        await this.commit();
      }
    } catch (error) {
      const current = this.state.conversations.find((item) => item.id === conversationId);
      const continuing = controller.signal.aborted && this.interruptingRuns.has(conversationId);
      if (current && this.runs.get(conversationId) === controller && !continuing) {
        current.status = "error";
        current.lastRunOutcome = controller.signal.aborted ? "stopped" : "failed";
        current.error = controller.signal.aborted ? "Run stopped" : error instanceof Error ? error.message : "Provider run failed";
        current.updatedAt = Date.now();
        await this.commit();
      }
    } finally {
      const ownsRun = this.runs.get(conversationId) === controller;
      if (ownsRun) this.runs.delete(conversationId);
      this.interruptingRuns.delete(conversationId);
      this.runAgentIcons.delete(conversationId);
      const current = this.state.conversations.find((item) => item.id === conversationId);
      if (ownsRun && current?.queuedMessages.length) {
        const next = current.queuedMessages.shift()!;
        await this.beginRun(current, next.content);
      }
    }
  }

  private async applyProviderEvent(conversationId: string, event: ProviderEvent): Promise<void> {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    if (event.type === "thread") conversation.threadId = event.threadId;
    if (event.type === "usage") conversation.usage = event.usage;
    if (event.type === "final") {
      conversation.messages.push({
        id: id(),
        role: "assistant",
        content: event.text,
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
    }
    conversation.updatedAt = Date.now();
    await this.commit();
  }

  private requireConversation(conversationId: string): Conversation {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error("Conversation not found");
    return conversation;
  }

  private async executeComputerTool(conversationId: string, name: ComputerToolName, args: Record<string, unknown>, options?: { readOnly?: boolean }): Promise<string> {
    const source = this.requireConversation(conversationId);
    const conversation = options?.readOnly ? { ...source, sandboxMode: "read-only" as const, allowCommands: false } : source;
    const capability = capabilityForTool(name);
    const target = targetForTool(name, args);
    const approvedTarget = await this.authorizeComputerTool(conversation, capability, name, target);
    try {
      const output = await this.computerAccess.execute({ state: this.state.computerAccess, conversation, name, args, approvedTarget });
      this.appendComputerAudit(conversation, capability, name, target, "allowed", "completed", output.slice(0, 2_000));
      await this.commit();
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Computer action failed";
      this.appendComputerAudit(conversation, capability, name, target, "allowed", "failed", message);
      await this.commit();
      throw error;
    }
  }

  private async authorizeComputerTool(conversation: Conversation, capability: ComputerCapabilityId, action: string, target: string): Promise<boolean> {
    const access = this.state.computerAccess;
    if (!access.enabled || access.grants[capability] === "blocked") {
      this.appendComputerAudit(conversation, capability, action, target, "denied", "failed", access.enabled ? "Capability is blocked" : "Computer access is disabled");
      await this.commit();
      throw new Error(access.enabled ? `${capability} access is blocked` : "Computer access is disabled");
    }
    if (access.grants[capability] === "allow") return false;
    if (this.sessionComputerGrants.get(conversation.id)?.has(capability)) return true;
    const device = this.computerAccess.snapshot(access, conversation.workingDirectory).devices.find((item) => item.id === access.activeDeviceId);
    const approval: ComputerApprovalRequest = {
      id: `approval-${id()}`,
      deviceId: access.activeDeviceId,
      deviceName: device?.name || "Computer",
      conversationId: conversation.id,
      capability,
      action: action.replaceAll("_", " "),
      target,
      createdAt: Date.now(),
    };
    this.pendingApprovals.push(approval);
    this.publishSnapshot();
    const decision = await new Promise<ComputerApprovalDecision>((resolve) => this.approvalResolvers.set(approval.id, resolve));
    if (decision === "deny") {
      this.appendComputerAudit(conversation, capability, action, target, "denied", "failed", "User denied the computer action");
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
    status: "completed" | "failed",
    detail?: string,
  ): void {
    this.state.computerAccess.auditLog.push({
      id: newAuditId(),
      deviceId: this.state.computerAccess.activeDeviceId,
      conversationId: conversation.id,
      provider: conversation.provider,
      capability,
      action,
      target,
      decision,
      status,
      ...(detail ? { detail } : {}),
      createdAt: Date.now(),
    });
    this.state.computerAccess.auditLog = this.state.computerAccess.auditLog.slice(-250);
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
