import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentRun,
  AppSettings,
  ComputerAccessLevel,
  ComputerAuditEntry,
  ComputerCapabilityId,
  Conversation,
} from "../shared/contracts";

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
  return {
    version: 2,
    conversations: [],
    settings: {
      defaultWorkingDirectory: homeDirectory,
      openRouterCredentialPath: "",
      theme: "system",
      accentPalette: "lime",
      multiAgentEnabled: true,
      maxAgentThreads: 4,
      defaultSubagentModel: "",
      defaultSubagentReasoning: "",
      interruptAgentMessage: true,
      connectorsEnabled: true,
      webSearchEnabled: true,
    },
    computerAccess: defaultComputerAccess(),
  };
}

const capabilityIds = new Set<ComputerCapabilityId>(["files", "commands", "browser", "screen", "automation"]);
const accessLevels = new Set<ComputerAccessLevel>(["blocked", "ask", "allow"]);

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
        }];
      }).slice(0, 24)
    : [];
  const validDeviceIds = new Set([localDeviceId, ...remoteDevices.filter((device) => !device.revoked).map((device) => device.id)]);
  const activeDeviceId = typeof input.activeDeviceId === "string" && validDeviceIds.has(input.activeDeviceId)
    ? input.activeDeviceId
    : localDeviceId;
  const auditLog = Array.isArray(input.auditLog)
    ? input.auditLog.filter((entry): entry is ComputerAuditEntry => Boolean(
        entry
        && typeof entry === "object"
        && typeof (entry as ComputerAuditEntry).id === "string"
        && capabilityIds.has((entry as ComputerAuditEntry).capability),
      )).slice(-250)
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

function isBenignSkillsNotice(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as { detail?: unknown };
  return typeof item.detail === "string" && item.detail.startsWith("Skill descriptions were shortened to fit the skills context budget.");
}

function normalizeConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Conversation>;
  if (typeof item.id !== "string" || typeof item.title !== "string") return null;
  const now = Date.now();
  return {
    id: item.id,
    title: item.title,
    provider: item.provider === "openrouter" ? "openrouter" : "codex",
    model: typeof item.model === "string" ? item.model : "gpt-5.6-sol",
    reasoning: ["low", "medium", "high", "xhigh"].includes(item.reasoning ?? "") ? item.reasoning! : "medium",
    sandboxMode: item.sandboxMode === "read-only" ? "read-only" : "workspace-write",
    allowCommands: item.allowCommands === true,
    workingDirectory: typeof item.workingDirectory === "string" ? item.workingDirectory : "",
    ...(typeof item.threadId === "string" ? { threadId: item.threadId } : {}),
    messages: Array.isArray(item.messages) ? item.messages : [],
    activities: Array.isArray(item.activities) ? item.activities.filter((activity) => !isBenignSkillsNotice(activity)).slice(-80) : [],
    selectedAgentIds: Array.isArray(item.selectedAgentIds)
      ? item.selectedAgentIds.filter((agentId): agentId is string => typeof agentId === "string").slice(0, 8)
      : [],
    agentRuns: Array.isArray(item.agentRuns)
      ? item.agentRuns.map(normalizeAgentRun).filter((run): run is AgentRun => Boolean(run)).slice(-40)
      : [],
    ...(item.usage ? { usage: item.usage } : {}),
    status: "idle",
    ...(typeof item.error === "string" ? { error: item.error } : {}),
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
        ? parsed.conversations.map(normalizeConversation).filter((item): item is Conversation => Boolean(item))
        : [];
      const settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : fallback.settings;
      const activeConversationId = conversations.some((item) => item.id === parsed.activeConversationId)
        ? parsed.activeConversationId
        : conversations[0]?.id;
      return {
        version: 2,
        conversations,
        ...(activeConversationId ? { activeConversationId } : {}),
        settings: {
          defaultWorkingDirectory: typeof settings.defaultWorkingDirectory === "string"
            ? settings.defaultWorkingDirectory
            : fallback.settings.defaultWorkingDirectory,
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
