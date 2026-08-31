import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  AgentComputerAction,
  AgentComputerEvidence,
  AgentComputerSession,
  AgentMeeting,
  AgentRun,
  AgentTask,
  AppSettings,
  ChatMessage,
  ComputerAccessLevel,
  ComputerAuditEntry,
  ComputerCapabilityId,
  Conversation,
  CrewCommunication,
  CrewTurnSnapshot,
  ImageAttachment,
  ImageMimeType,
  RunOutcome,
  UsageSummary,
} from "../shared/contracts";
import { MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES } from "../shared/contracts";

export interface PersistedRemoteDevice {
  id: string;
  name: string;
  platform: string;
  endpoint: string;
  root: string;
  encryptedToken: string;
  capabilities: ComputerCapabilityId[];
  lastSeenAt: number;
  revoked: boolean;
  tokenEpoch?: number;
  protocolVersion?: number;
  browserTools?: string[];
}

export interface PersistedComputerAccess {
  enabled: boolean;
  localDeviceId: string;
  activeDeviceId: string;
  grants: Record<ComputerCapabilityId, ComputerAccessLevel>;
  networkAllowlist: string[];
  remoteDevices: PersistedRemoteDevice[];
  auditLog: ComputerAuditEntry[];
}

export interface PersistentState {
  version: 2;
  conversations: Conversation[];
  activeConversationId?: string;
  settings: AppSettings;
  computerAccess: PersistedComputerAccess;
}

export function noProjectDirectory(homeDirectory: string): string {
  return join(homeDirectory, ".grokky", "no-project");
}

export function defaultComputerAccess(): PersistedComputerAccess {
  const localDeviceId = `local-${randomUUID().replaceAll("-", "")}`;
  return {
    enabled: true,
    localDeviceId,
    activeDeviceId: localDeviceId,
    grants: {
      files: "allow",
      commands: "ask",
      browser: "ask",
      screen: "ask",
      automation: "ask",
    },
    networkAllowlist: [],
    remoteDevices: [],
    auditLog: [],
  };
}

export function defaultPersistentState(homeDirectory: string): PersistentState {
  const scratchDirectory = noProjectDirectory(homeDirectory);
  return {
    version: 2,
    conversations: [],
    settings: {
      defaultWorkingDirectory: scratchDirectory,
      recentWorkingDirectories: [],
      openRouterCredentialPath: "",
      theme: "system",
      accentPalette: "lime",
      multiAgentEnabled: true,
      maxAgentThreads: 4,
      defaultSubagentModel: "",
      defaultSubagentReasoning: "",
      interruptAgentMessage: true,
      spreadAgentComputers: false,
      connectorsEnabled: true,
      webSearchEnabled: true,
    },
    computerAccess: defaultComputerAccess(),
  };
}

const capabilityIds = new Set<ComputerCapabilityId>(["files", "commands", "browser", "screen", "automation"]);
const accessLevels = new Set<ComputerAccessLevel>(["blocked", "ask", "allow"]);
const imageMimeTypes = new Set<ImageMimeType>(["image/png", "image/jpeg", "image/webp"]);

function normalizeUsage(value: unknown): UsageSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<UsageSummary>;
  if (!Number.isFinite(item.inputTokens) || !Number.isFinite(item.outputTokens)) return undefined;
  const token = (entry: number) => Math.max(0, Math.min(1_000_000_000_000, Math.floor(entry)));
  const optionalToken = (entry: unknown) => typeof entry === "number" && Number.isFinite(entry) ? token(entry) : undefined;
  const costUsd = typeof item.costUsd === "number" && Number.isFinite(item.costUsd)
    ? Math.max(0, Math.min(1_000_000_000, item.costUsd))
    : undefined;
  return {
    inputTokens: token(item.inputTokens!),
    outputTokens: token(item.outputTokens!),
    ...(optionalToken(item.cachedInputTokens) !== undefined ? { cachedInputTokens: optionalToken(item.cachedInputTokens) } : {}),
    ...(optionalToken(item.reasoningTokens) !== undefined ? { reasoningTokens: optionalToken(item.reasoningTokens) } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function normalizeImageAttachment(value: unknown): ImageAttachment | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ImageAttachment>;
  if (
    typeof item.id !== "string"
    || !/^[a-zA-Z0-9_-]{8,100}$/.test(item.id)
    || typeof item.name !== "string"
    || !item.name.trim()
    || !imageMimeTypes.has(item.mimeType as ImageMimeType)
    || typeof item.size !== "number"
    || item.size <= 0
    || item.size > MAX_IMAGE_BYTES
    || typeof item.localPath !== "string"
    || item.localPath.length > 4_000
  ) return null;
  return {
    id: item.id,
    name: item.name.trim().slice(0, 180),
    mimeType: item.mimeType as ImageMimeType,
    size: item.size,
    localPath: item.localPath,
  };
}

function normalizeMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ChatMessage>;
  const attachments = Array.isArray(item.attachments)
    ? item.attachments.map(normalizeImageAttachment).filter((attachment): attachment is ImageAttachment => Boolean(attachment)).slice(0, MAX_IMAGE_ATTACHMENTS)
    : [];
  if (
    typeof item.id !== "string"
    || (item.role !== "user" && item.role !== "assistant")
    || typeof item.content !== "string"
    || (!item.content.trim() && attachments.length === 0)
  ) return null;
  return {
    id: item.id,
    role: item.role,
    content: item.content.slice(0, 200_000),
    ...(attachments.length ? { attachments } : {}),
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
    provider: item.provider === "openrouter" ? "openrouter" : "codex",
    ...(normalizeCrewTurnSnapshot(item.crew) ? { crew: normalizeCrewTurnSnapshot(item.crew) } : {}),
  };
}

function normalizeActivity(value: unknown): import("../shared/contracts").ActivityItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<import("../shared/contracts").ActivityItem>;
  const kinds = new Set(["reasoning", "command", "files", "tool", "plan", "notice", "agent"]);
  const statuses = new Set(["running", "completed", "failed"]);
  if (typeof item.id !== "string" || typeof item.label !== "string" || !kinds.has(item.kind ?? "") || !statuses.has(item.status ?? "")) return null;
  return {
    id: item.id,
    kind: item.kind!,
    label: item.label.slice(0, 500),
    ...(typeof item.detail === "string" ? { detail: item.detail.slice(0, 40_000) } : {}),
    status: item.status!,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
  };
}

function normalizeComputerAccess(value: unknown): PersistedComputerAccess {
  const fallback = defaultComputerAccess();
  if (!value || typeof value !== "object") return fallback;
  const input = value as Partial<PersistedComputerAccess>;
  const localDeviceId = typeof input.localDeviceId === "string" && /^local-[a-zA-Z0-9_-]{12,100}$/.test(input.localDeviceId)
    ? input.localDeviceId
    : fallback.localDeviceId;
  const grants = { ...fallback.grants };
  if (input.grants && typeof input.grants === "object") {
    for (const capability of capabilityIds) {
      const level = input.grants[capability];
      if (accessLevels.has(level)) grants[capability] = level;
    }
  }
  const remoteDevices = Array.isArray(input.remoteDevices)
    ? input.remoteDevices.flatMap((item): PersistedRemoteDevice[] => {
        if (!item || typeof item !== "object") return [];
        const device = item as Partial<PersistedRemoteDevice>;
        if (
          typeof device.id !== "string"
          || typeof device.name !== "string"
          || typeof device.platform !== "string"
          || typeof device.endpoint !== "string"
          || typeof device.root !== "string"
          || typeof device.encryptedToken !== "string"
        ) return [];
        return [{
          id: device.id,
          name: device.name.slice(0, 120),
          platform: device.platform.slice(0, 80),
          endpoint: device.endpoint,
          root: device.root,
          encryptedToken: device.encryptedToken,
          capabilities: Array.isArray(device.capabilities)
            ? device.capabilities.filter((capability): capability is ComputerCapabilityId => capabilityIds.has(capability as ComputerCapabilityId))
            : ["files"],
          lastSeenAt: typeof device.lastSeenAt === "number" ? device.lastSeenAt : 0,
          revoked: device.revoked === true,
          ...(Number.isSafeInteger(device.tokenEpoch) && (device.tokenEpoch ?? 0) >= 1 ? { tokenEpoch: device.tokenEpoch } : {}),
          ...(Number.isSafeInteger(device.protocolVersion) && (device.protocolVersion ?? 0) >= 1 ? { protocolVersion: device.protocolVersion } : {}),
          ...(Array.isArray(device.browserTools)
            ? { browserTools: device.browserTools.filter((tool): tool is string => typeof tool === "string" && /^[a-z_]{3,40}$/.test(tool)).slice(0, 32) }
            : {}),
        }];
      }).slice(0, 24)
    : [];
  const validDeviceIds = new Set([localDeviceId, ...remoteDevices.filter((device) => !device.revoked).map((device) => device.id)]);
  const activeDeviceId = typeof input.activeDeviceId === "string" && validDeviceIds.has(input.activeDeviceId)
    ? input.activeDeviceId
    : localDeviceId;
  const auditLog = Array.isArray(input.auditLog)
    ? input.auditLog.flatMap((value): ComputerAuditEntry[] => {
        if (!value || typeof value !== "object") return [];
        const entry = value as Partial<ComputerAuditEntry>;
        if (typeof entry.id !== "string" || !capabilityIds.has(entry.capability as ComputerCapabilityId)) return [];
        const createdAt = typeof entry.createdAt === "number" ? entry.createdAt : Date.now();
        const interrupted = entry.status === "pending";
        return [{
          id: entry.id,
          deviceId: typeof entry.deviceId === "string" ? entry.deviceId : localDeviceId,
          ...(typeof entry.conversationId === "string" ? { conversationId: entry.conversationId } : {}),
          ...(entry.provider === "codex" || entry.provider === "openrouter" ? { provider: entry.provider } : {}),
          ...(typeof entry.agentComputerId === "string" ? { agentComputerId: entry.agentComputerId } : {}),
          ...(typeof entry.agentName === "string" ? { agentName: entry.agentName.slice(0, 120) } : {}),
          capability: entry.capability as ComputerCapabilityId,
          action: typeof entry.action === "string" ? entry.action.slice(0, 120) : "unknown_action",
          target: typeof entry.target === "string" ? entry.target.slice(0, 500) : "unknown target",
          ...(typeof entry.argumentDigest === "string" && /^[a-f0-9]{64}$/i.test(entry.argumentDigest) ? { argumentDigest: entry.argumentDigest.toLowerCase() } : {}),
          decision: entry.decision === "denied" ? "denied" : "allowed",
          status: interrupted ? "indeterminate" : entry.status === "completed" ? "completed" : entry.status === "indeterminate" ? "indeterminate" : "failed",
          ...(interrupted
            ? { detail: "Grokky restarted while this action was in flight; the final external outcome is unknown." }
            : typeof entry.detail === "string" ? { detail: entry.detail.slice(0, 2_000) } : {}),
          createdAt,
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : createdAt,
        }];
      }).slice(-250)
    : [];
  return {
    enabled: input.enabled !== false,
    localDeviceId,
    activeDeviceId,
    grants,
    networkAllowlist: Array.isArray(input.networkAllowlist)
      ? input.networkAllowlist.filter((domain): domain is string => typeof domain === "string").map((domain) => domain.trim().toLowerCase()).filter(Boolean).slice(0, 100)
      : [],
    remoteDevices,
    auditLog,
  };
}

function normalizeAgentRun(value: unknown): AgentRun | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AgentRun>;
  if (typeof item.id !== "string" || typeof item.threadId !== "string" || typeof item.task !== "string") return null;
  const now = Date.now();
  const allowed = new Set<AgentRun["status"]>(["starting", "working", "waiting", "completed", "failed", "stopped"]);
  const storedStatus = allowed.has(item.status as AgentRun["status"]) ? item.status as AgentRun["status"] : "stopped";
  return {
    id: item.id,
    operationId: typeof item.operationId === "string" ? item.operationId : item.id,
    threadId: item.threadId,
    name: typeof item.name === "string" ? item.name : "Crew member",
    task: item.task,
    status: new Set<AgentRun["status"]>(["starting", "working", "waiting"]).has(storedStatus) ? "stopped" : storedStatus,
    ...(typeof item.result === "string" ? { result: item.result } : {}),
    createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now,
  };
}

function normalizeAgentComputerAction(value: unknown): AgentComputerAction | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AgentComputerAction>;
  const statuses = new Set<AgentComputerAction["status"]>(["running", "completed", "failed", "denied", "indeterminate"]);
  if (
    typeof item.id !== "string"
    || !capabilityIds.has(item.capability as ComputerCapabilityId)
    || typeof item.action !== "string"
    || typeof item.target !== "string"
    || !statuses.has(item.status as AgentComputerAction["status"])
  ) return null;
  const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.now();
  return {
    id: item.id,
    capability: item.capability as ComputerCapabilityId,
    action: item.action.slice(0, 120),
    target: item.target.slice(0, 500),
    status: item.status === "running" ? "indeterminate" : item.status as AgentComputerAction["status"],
    ...(item.status === "running"
      ? { detail: "Grokky restarted while this action was in flight; the final external outcome is unknown." }
      : typeof item.detail === "string" ? { detail: item.detail.slice(0, 2_000) } : {}),
    ...(typeof item.effect === "string" && new Set(["changed", "no_effect", "already_satisfied", "navigated", "opened_dialog", "opened_popup", "stale_reference", "blocked", "uncertain"]).has(item.effect)
      ? { effect: item.effect as AgentComputerAction["effect"] }
      : {}),
    ...(typeof item.snapshotId === "string" && /^page-[a-f0-9]{16}$/.test(item.snapshotId) ? { snapshotId: item.snapshotId } : {}),
    createdAt,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : createdAt,
  };
}

function normalizeAgentComputerEvidence(value: unknown): AgentComputerEvidence | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AgentComputerEvidence>;
  if (
    typeof item.id !== "string"
    || (item.kind !== "browser" && item.kind !== "screen")
    || typeof item.title !== "string"
    || typeof item.source !== "string"
    || typeof item.localPath !== "string"
  ) return null;
  return {
    id: item.id,
    kind: item.kind,
    title: item.title.slice(0, 240),
    source: item.source.slice(0, 1_000),
    mimeType: "image/png",
    localPath: item.localPath.slice(0, 4_000),
    ...(typeof item.sha256 === "string" && /^[a-f0-9]{64}$/i.test(item.sha256) ? { sha256: item.sha256.toLowerCase() } : {}),
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
  };
}

function normalizeAgentComputer(value: unknown): AgentComputerSession | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AgentComputerSession>;
  if (
    typeof item.id !== "string"
    || typeof item.conversationId !== "string"
    || typeof item.agentId !== "string"
    || typeof item.agentName !== "string"
    || typeof item.deviceId !== "string"
    || typeof item.deviceName !== "string"
    || typeof item.workspaceRoot !== "string"
  ) return null;
  const now = Date.now();
  const statuses = new Set<AgentComputerSession["status"]>(["provisioning", "ready", "working", "waiting", "completed", "failed", "stopped"]);
  const storedStatus = statuses.has(item.status as AgentComputerSession["status"])
    ? item.status as AgentComputerSession["status"]
    : "stopped";
  const normalizedStatus = new Set<AgentComputerSession["status"]>(["provisioning", "ready", "working", "waiting"]).has(storedStatus)
    ? "stopped" as const
    : storedStatus;
  return {
    id: item.id,
    conversationId: item.conversationId,
    agentId: item.agentId,
    agentName: item.agentName.slice(0, 120),
    role: item.role === "specialist" ? "specialist" : "lead",
    ...(item.icon ? { icon: item.icon } : {}),
    ...(typeof item.threadId === "string" ? { threadId: item.threadId } : {}),
    ...(typeof item.task === "string" ? { task: item.task.slice(0, 12_000) } : {}),
    status: normalizedStatus,
    isolation: item.isolation === "isolated-browser" || item.isolation === "cloud-browser" ? item.isolation : "policy-session",
    deviceId: item.deviceId,
    deviceName: item.deviceName.slice(0, 120),
    workspaceRoot: item.workspaceRoot.slice(0, 4_000),
    ...(normalizedStatus === "working" && typeof item.currentAction === "string" ? { currentAction: item.currentAction.slice(0, 120) } : {}),
    ...(normalizedStatus === "working" && typeof item.currentTarget === "string" ? { currentTarget: item.currentTarget.slice(0, 500) } : {}),
    ...(typeof item.currentUrl === "string" ? { currentUrl: item.currentUrl.slice(0, 1_000) } : {}),
    ...(typeof item.pageTitle === "string" ? { pageTitle: item.pageTitle.slice(0, 240) } : {}),
    actions: Array.isArray(item.actions)
      ? item.actions.map(normalizeAgentComputerAction).filter((action): action is AgentComputerAction => Boolean(action)).slice(-40)
      : [],
    evidence: Array.isArray(item.evidence)
      ? item.evidence.map(normalizeAgentComputerEvidence).filter((evidence): evidence is AgentComputerEvidence => Boolean(evidence)).slice(-12)
      : [],
    createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now,
  };
}

function normalizeQueuedMessage(value: unknown): Conversation["queuedMessages"][number] | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Conversation["queuedMessages"][number]>;
  const attachments = Array.isArray(item.attachments)
    ? item.attachments.map(normalizeImageAttachment).filter((attachment): attachment is ImageAttachment => Boolean(attachment)).slice(0, MAX_IMAGE_ATTACHMENTS)
    : [];
  if (typeof item.id !== "string" || typeof item.content !== "string" || (!item.content.trim() && attachments.length === 0)) return null;
  return {
    id: item.id,
    content: item.content.slice(0, 200_000),
    ...(attachments.length ? { attachments } : {}),
    priority: item.priority === "priority" ? "priority" : "normal",
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
  };
}

function normalizeCrewCommunication(value: unknown): CrewCommunication | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<CrewCommunication>;
  const kinds = new Set<CrewCommunication["kind"]>(["assignment", "message", "report", "status"]);
  const statuses = new Set<CrewCommunication["status"]>(["running", "completed", "failed"]);
  if (
    typeof item.id !== "string"
    || typeof item.operationId !== "string"
    || typeof item.tool !== "string"
    || !kinds.has(item.kind as CrewCommunication["kind"])
    || typeof item.senderThreadId !== "string"
    || typeof item.senderName !== "string"
    || typeof item.receiverThreadId !== "string"
    || typeof item.receiverName !== "string"
    || !statuses.has(item.status as CrewCommunication["status"])
  ) return null;
  return {
    id: item.id,
    operationId: item.operationId,
    tool: item.tool,
    kind: item.kind as CrewCommunication["kind"],
    senderThreadId: item.senderThreadId,
    senderName: item.senderName.slice(0, 120),
    receiverThreadId: item.receiverThreadId,
    receiverName: item.receiverName.slice(0, 120),
    ...(typeof item.content === "string" ? { content: item.content.slice(0, 12_000) } : {}),
    status: item.status as CrewCommunication["status"],
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
  };
}

function normalizeAgentTask(value: unknown): AgentTask | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AgentTask>;
  const statuses = new Set<AgentTask["status"]>(["assigned", "working", "waiting", "completed", "blocked", "failed", "stopped"]);
  if (
    typeof item.id !== "string"
    || typeof item.operationId !== "string"
    || typeof item.fromThreadId !== "string"
    || typeof item.fromName !== "string"
    || typeof item.toThreadId !== "string"
    || typeof item.toName !== "string"
    || typeof item.title !== "string"
    || typeof item.instructions !== "string"
    || !statuses.has(item.status as AgentTask["status"])
  ) return null;
  const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.now();
  const status = new Set<AgentTask["status"]>(["assigned", "working", "waiting"]).has(item.status as AgentTask["status"])
    ? "stopped" as const
    : item.status as AgentTask["status"];
  return {
    id: item.id,
    operationId: item.operationId,
    fromThreadId: item.fromThreadId,
    fromName: item.fromName.slice(0, 120),
    toThreadId: item.toThreadId,
    toName: item.toName.slice(0, 120),
    title: item.title.slice(0, 240),
    instructions: item.instructions.slice(0, 12_000),
    acceptanceCriteria: Array.isArray(item.acceptanceCriteria)
      ? item.acceptanceCriteria.filter((criterion): criterion is string => typeof criterion === "string").map((criterion) => criterion.slice(0, 1_000)).slice(0, 12)
      : [],
    status,
    ...(typeof item.result === "string" ? { result: item.result.slice(0, 12_000) } : {}),
    createdAt,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : createdAt,
  };
}

function normalizeAgentMeeting(value: unknown): AgentMeeting | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AgentMeeting>;
  const statuses = new Set<AgentMeeting["status"]>(["live", "completed", "incomplete"]);
  if (
    typeof item.id !== "string"
    || typeof item.title !== "string"
    || typeof item.agenda !== "string"
    || !statuses.has(item.status as AgentMeeting["status"])
  ) return null;
  const normalizedMeetingStatus: AgentMeeting["status"] = item.status === "live"
    ? "incomplete"
    : item.status as AgentMeeting["status"];
  const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.now();
  const contributions = Array.isArray(item.contributions)
    ? item.contributions.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const contribution = value as AgentMeeting["contributions"][number];
        if (
          typeof contribution.id !== "string"
          || typeof contribution.speakerThreadId !== "string"
          || typeof contribution.speakerName !== "string"
          || !new Set(["opening", "challenge", "response", "decision", "action"]).has(contribution.kind)
          || typeof contribution.content !== "string"
        ) return [];
        return [{
          id: contribution.id,
          speakerThreadId: contribution.speakerThreadId,
          speakerName: contribution.speakerName.slice(0, 120),
          kind: contribution.kind,
          content: contribution.content.slice(0, 12_000),
          createdAt: typeof contribution.createdAt === "number" ? contribution.createdAt : createdAt,
        }];
      }).slice(-40)
    : [];
  return {
    id: item.id,
    title: item.title.slice(0, 240),
    agenda: item.agenda.slice(0, 12_000),
    participantThreadIds: Array.isArray(item.participantThreadIds)
      ? item.participantThreadIds.filter((threadId): threadId is string => typeof threadId === "string").slice(0, 16)
      : [],
    participantNames: Array.isArray(item.participantNames)
      ? item.participantNames.filter((name): name is string => typeof name === "string").map((name) => name.slice(0, 120)).slice(0, 16)
      : [],
    status: normalizedMeetingStatus,
    contributions,
    decisions: Array.isArray(item.decisions)
      ? item.decisions.filter((decision): decision is string => typeof decision === "string").map((decision) => decision.slice(0, 2_000)).slice(0, 12)
      : [],
    actionItems: Array.isArray(item.actionItems)
      ? item.actionItems.filter((action): action is string => typeof action === "string").map((action) => action.slice(0, 2_000)).slice(0, 12)
      : [],
    createdAt,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : createdAt,
  };
}

function normalizeCrewTurnSnapshot(value: unknown): CrewTurnSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<CrewTurnSnapshot>;
  const runOutcomes = new Set<RunOutcome>(["delivered", "blocked", "failed", "stopped"]);
  return {
    agentRuns: Array.isArray(item.agentRuns) ? item.agentRuns.map(normalizeAgentRun).filter((entry): entry is AgentRun => Boolean(entry)).slice(-40) : [],
    communications: Array.isArray(item.communications) ? item.communications.map(normalizeCrewCommunication).filter((entry): entry is CrewCommunication => Boolean(entry)).slice(-80) : [],
    tasks: Array.isArray(item.tasks) ? item.tasks.map(normalizeAgentTask).filter((entry): entry is AgentTask => Boolean(entry)).slice(-80) : [],
    meetings: Array.isArray(item.meetings) ? item.meetings.map(normalizeAgentMeeting).filter((entry): entry is AgentMeeting => Boolean(entry)).slice(-20) : [],
    agentComputers: Array.isArray(item.agentComputers) ? item.agentComputers.map(normalizeAgentComputer).filter((entry): entry is AgentComputerSession => Boolean(entry)).slice(-24) : [],
    activities: Array.isArray(item.activities) ? item.activities.map(normalizeActivity).filter((entry): entry is NonNullable<ReturnType<typeof normalizeActivity>> => Boolean(entry)).slice(-80) : [],
    ...(runOutcomes.has(item.lastRunOutcome as RunOutcome) ? { lastRunOutcome: item.lastRunOutcome as RunOutcome } : {}),
    ...(normalizeUsage(item.usage) ? { usage: normalizeUsage(item.usage) } : {}),
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
  };
}

function isBenignSkillsNotice(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as { detail?: unknown };
  return typeof item.detail === "string" && item.detail.startsWith("Skill descriptions were shortened to fit the skills context budget.");
}

function normalizeConversation(value: unknown, homeDirectory: string): Conversation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Conversation>;
  if (typeof item.id !== "string" || typeof item.title !== "string") return null;
  const now = Date.now();
  const scratchDirectory = noProjectDirectory(homeDirectory);
  const storedDirectory = typeof item.workingDirectory === "string" && item.workingDirectory
    ? item.workingDirectory
    : scratchDirectory;
  const inferredProjectMode = resolve(storedDirectory) === resolve(homeDirectory)
    || resolve(storedDirectory) === resolve(scratchDirectory)
    ? "none"
    : "project";
  const projectMode = item.projectMode === "project" || item.projectMode === "none"
    ? item.projectMode
    : inferredProjectMode;
  const runOutcomes = new Set<NonNullable<Conversation["lastRunOutcome"]>>(["delivered", "blocked", "failed", "stopped"]);
  return {
    id: item.id,
    title: item.title,
    instructions: typeof item.instructions === "string" ? item.instructions.slice(0, 4_000).trim() : "",
    provider: item.provider === "openrouter" ? "openrouter" : "codex",
    model: typeof item.model === "string" ? item.model : "gpt-5.6-sol",
    reasoning: ["low", "medium", "high", "xhigh"].includes(item.reasoning ?? "") ? item.reasoning! : "medium",
    sandboxMode: item.sandboxMode === "read-only" ? "read-only" : "workspace-write",
    allowCommands: item.allowCommands === true,
    projectMode,
    workingDirectory: projectMode === "project" ? storedDirectory : scratchDirectory,
    ...(typeof item.threadId === "string" ? { threadId: item.threadId } : {}),
    ...(item.providerThreadIds && typeof item.providerThreadIds === "object"
      ? { providerThreadIds: {
          ...(typeof item.providerThreadIds.codex === "string" ? { codex: item.providerThreadIds.codex } : {}),
          ...(typeof item.providerThreadIds.openrouter === "string" ? { openrouter: item.providerThreadIds.openrouter } : {}),
        } }
      : {}),
    messages: Array.isArray(item.messages)
      ? item.messages.map(normalizeMessage).filter((message): message is ChatMessage => Boolean(message))
      : [],
    queuedMessages: Array.isArray(item.queuedMessages)
      ? item.queuedMessages.map(normalizeQueuedMessage).filter((message): message is Conversation["queuedMessages"][number] => Boolean(message)).slice(0, 12)
      : [],
    activities: Array.isArray(item.activities) ? item.activities.filter((activity) => !isBenignSkillsNotice(activity)).map(normalizeActivity).filter((activity): activity is NonNullable<ReturnType<typeof normalizeActivity>> => Boolean(activity)).slice(-80) : [],
    selectedAgentIds: Array.isArray(item.selectedAgentIds)
      ? item.selectedAgentIds.filter((agentId): agentId is string => typeof agentId === "string").slice(0, 8)
      : [],
    agentRuns: Array.isArray(item.agentRuns)
      ? item.agentRuns.map(normalizeAgentRun).filter((run): run is AgentRun => Boolean(run)).slice(-40)
      : [],
    crewCommunications: Array.isArray(item.crewCommunications)
      ? item.crewCommunications.map(normalizeCrewCommunication).filter((entry): entry is CrewCommunication => Boolean(entry)).slice(-80)
      : [],
    agentTasks: Array.isArray(item.agentTasks)
      ? item.agentTasks.map(normalizeAgentTask).filter((task): task is AgentTask => Boolean(task)).slice(-80)
      : [],
    agentMeetings: Array.isArray(item.agentMeetings)
      ? item.agentMeetings.map(normalizeAgentMeeting).filter((meeting): meeting is AgentMeeting => Boolean(meeting)).slice(-20)
      : [],
    agentComputers: Array.isArray(item.agentComputers)
      ? item.agentComputers.map(normalizeAgentComputer).filter((computer): computer is AgentComputerSession => Boolean(computer)).slice(-40)
      : [],
    ...(normalizeUsage(item.usage) ? { usage: normalizeUsage(item.usage) } : {}),
    status: "idle",
    ...(runOutcomes.has(item.lastRunOutcome as NonNullable<Conversation["lastRunOutcome"]>) ? { lastRunOutcome: item.lastRunOutcome } : {}),
    ...(typeof item.error === "string" ? { error: item.error } : {}),
    unreadCount: typeof item.unreadCount === "number" ? Math.max(0, Math.min(99, Math.floor(item.unreadCount))) : 0,
    lastViewedAt: typeof item.lastViewedAt === "number" ? item.lastViewedAt : now,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now,
  };
}

export class StateStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly pathname: string,
    private readonly homeDirectory: string,
  ) {}

  async load(): Promise<PersistentState> {
    const fallback = defaultPersistentState(this.homeDirectory);
    try {
      const parsed = JSON.parse(await readFile(this.pathname, "utf8")) as Partial<PersistentState>;
      const conversations = Array.isArray(parsed.conversations)
        ? parsed.conversations.map((item) => normalizeConversation(item, this.homeDirectory)).filter((item): item is Conversation => Boolean(item))
        : [];
      const settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : fallback.settings;
      const scratchDirectory = noProjectDirectory(this.homeDirectory);
      const storedDefaultDirectory = typeof settings.defaultWorkingDirectory === "string"
        ? settings.defaultWorkingDirectory
        : fallback.settings.defaultWorkingDirectory;
      const defaultWorkingDirectory = resolve(storedDefaultDirectory) === resolve(this.homeDirectory)
        ? scratchDirectory
        : storedDefaultDirectory;
      const storedRecentDirectories = Array.isArray(settings.recentWorkingDirectories)
        ? settings.recentWorkingDirectories.filter((pathname): pathname is string => (
            typeof pathname === "string"
            && pathname.length > 0
            && resolve(pathname) !== resolve(this.homeDirectory)
            && resolve(pathname) !== resolve(scratchDirectory)
          ))
        : [];
      const conversationDirectories = conversations.flatMap((conversation) => conversation.projectMode === "project" ? [conversation.workingDirectory] : []);
      const recentWorkingDirectories = [...new Set([...storedRecentDirectories, ...conversationDirectories])].slice(0, 12);
      const activeConversationId = conversations.some((item) => item.id === parsed.activeConversationId)
        ? parsed.activeConversationId
        : conversations[0]?.id;
      return {
        version: 2,
        conversations,
        ...(activeConversationId ? { activeConversationId } : {}),
        settings: {
          defaultWorkingDirectory,
          recentWorkingDirectories,
          openRouterCredentialPath: typeof settings.openRouterCredentialPath === "string"
            ? settings.openRouterCredentialPath
            : "",
          theme: ["system", "light", "dark"].includes(settings.theme) ? settings.theme : "system",
          accentPalette: typeof settings.accentPalette === "string"
            && ["lime", "electric-blue", "ultraviolet", "solar-amber", "ice"].includes(settings.accentPalette)
            ? settings.accentPalette as AppSettings["accentPalette"]
            : "lime",
          multiAgentEnabled: typeof settings.multiAgentEnabled === "boolean" ? settings.multiAgentEnabled : true,
          maxAgentThreads: typeof settings.maxAgentThreads === "number"
            ? Math.max(1, Math.min(8, Math.round(settings.maxAgentThreads)))
            : 4,
          defaultSubagentModel: typeof settings.defaultSubagentModel === "string" ? settings.defaultSubagentModel : "",
          defaultSubagentReasoning: typeof settings.defaultSubagentReasoning === "string"
            && ["", "low", "medium", "high", "xhigh"].includes(settings.defaultSubagentReasoning)
            ? settings.defaultSubagentReasoning as AppSettings["defaultSubagentReasoning"]
            : "",
          interruptAgentMessage: typeof settings.interruptAgentMessage === "boolean" ? settings.interruptAgentMessage : true,
          spreadAgentComputers: typeof settings.spreadAgentComputers === "boolean" ? settings.spreadAgentComputers : false,
          connectorsEnabled: typeof settings.connectorsEnabled === "boolean" ? settings.connectorsEnabled : true,
          webSearchEnabled: typeof settings.webSearchEnabled === "boolean" ? settings.webSearchEnabled : true,
        },
        computerAccess: normalizeComputerAccess(parsed.computerAccess),
      };
    } catch {
      return fallback;
    }
  }

  save(state: PersistentState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const temporaryPath = `${this.pathname}.next`;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.pathname), { recursive: true });
      await writeFile(temporaryPath, payload, { mode: 0o600 });
      await rename(temporaryPath, this.pathname);
    });
    return this.writeQueue;
  }
}
