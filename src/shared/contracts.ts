export type ProviderId = "codex" | "openrouter";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type SandboxMode = "read-only" | "workspace-write";
export type RunStatus = "idle" | "running" | "error";
export type RunOutcome = "delivered" | "blocked" | "failed" | "stopped";
export type ProjectMode = "project" | "none";
export type AgentScope = "built-in" | "personal" | "project";
export type AgentRunStatus = "starting" | "working" | "waiting" | "completed" | "failed" | "stopped";
export type AgentIcon = "lime" | "cyan" | "coral" | "violet" | "amber" | "mint";
export type AccentPalette = "lime" | "electric-blue" | "ultraviolet" | "solar-amber" | "ice";
export type ComputerCapabilityId = "files" | "commands" | "browser" | "screen" | "automation";
export type ComputerAccessLevel = "blocked" | "ask" | "allow";
export type ComputerPermissionStatus = "granted" | "denied" | "not-determined" | "not-required" | "unavailable";
export type ComputerDeviceStatus = "online" | "offline" | "revoked";
export type ComputerApprovalDecision = "deny" | "allow-once" | "allow-session";
export type MessagePriority = "normal" | "priority";

export interface UsageSummary {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  provider: ProviderId;
}

export interface QueuedMessage {
  id: string;
  content: string;
  priority: MessagePriority;
  createdAt: number;
}

export interface ActivityItem {
  id: string;
  kind: "reasoning" | "command" | "files" | "tool" | "plan" | "notice" | "agent";
  label: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  developerInstructions: string;
  scope: AgentScope;
  builtIn: boolean;
  icon?: AgentIcon;
  model?: string;
  reasoning?: ReasoningEffort;
  sandboxMode?: SandboxMode;
  path?: string;
}

export interface AgentDraft {
  name: string;
  description: string;
  developerInstructions: string;
  scope: Exclude<AgentScope, "built-in">;
  icon?: AgentIcon;
  model?: string;
  reasoning?: ReasoningEffort;
  sandboxMode?: SandboxMode;
}

export interface AgentRun {
  id: string;
  operationId: string;
  threadId: string;
  name: string;
  task: string;
  status: AgentRunStatus;
  icon?: AgentIcon;
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestrationThreadState {
  threadId: string;
  name?: string;
  status: string;
  message?: string;
}

export interface OrchestrationEvent {
  operationId: string;
  tool: string;
  senderThreadId: string;
  senderName?: string;
  receiverThreads: OrchestrationThreadState[];
  prompt?: string;
  status: "running" | "completed" | "failed";
}

export type CrewCommunicationKind = "assignment" | "message" | "report" | "status";

export interface CrewCommunication {
  id: string;
  operationId: string;
  tool: string;
  kind: CrewCommunicationKind;
  senderThreadId: string;
  senderName: string;
  receiverThreadId: string;
  receiverName: string;
  content?: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  instructions: string;
  provider: ProviderId;
  model: string;
  reasoning: ReasoningEffort;
  sandboxMode: SandboxMode;
  allowCommands: boolean;
  projectMode: ProjectMode;
  workingDirectory: string;
  threadId?: string;
  messages: ChatMessage[];
  queuedMessages: QueuedMessage[];
  activities: ActivityItem[];
  selectedAgentIds: string[];
  agentRuns: AgentRun[];
  crewCommunications: CrewCommunication[];
  usage?: UsageSummary;
  status: RunStatus;
  lastRunOutcome?: RunOutcome;
  error?: string;
  unreadCount: number;
  lastViewedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  defaultWorkingDirectory: string;
  recentWorkingDirectories: string[];
  openRouterCredentialPath: string;
  theme: "system" | "light" | "dark";
  accentPalette?: AccentPalette;
  multiAgentEnabled: boolean;
  maxAgentThreads: number;
  defaultSubagentModel: string;
  defaultSubagentReasoning: ReasoningEffort | "";
  interruptAgentMessage: boolean;
  connectorsEnabled: boolean;
  webSearchEnabled: boolean;
}

export interface ComputerCapability {
  id: ComputerCapabilityId;
  label: string;
  description: string;
  level: ComputerAccessLevel;
  permission: ComputerPermissionStatus;
  available: boolean;
}

export interface ComputerDevice {
  id: string;
  name: string;
  platform: string;
  kind: "local" | "remote";
  status: ComputerDeviceStatus;
  root: string;
  endpoint?: string;
  capabilities: ComputerCapabilityId[];
  lastSeenAt: number;
}

export interface ComputerAuditEntry {
  id: string;
  deviceId: string;
  conversationId?: string;
  provider?: ProviderId;
  capability: ComputerCapabilityId;
  action: string;
  target: string;
  decision: "allowed" | "denied";
  status: "completed" | "failed";
  detail?: string;
  createdAt: number;
}

export interface ComputerApprovalRequest {
  id: string;
  deviceId: string;
  deviceName: string;
  conversationId: string;
  capability: ComputerCapabilityId;
  action: string;
  target: string;
  createdAt: number;
}

export interface ComputerAccessSnapshot {
  enabled: boolean;
  activeDeviceId: string;
  devices: ComputerDevice[];
  capabilities: ComputerCapability[];
  networkAllowlist: string[];
  auditLog: ComputerAuditEntry[];
  pendingApproval?: ComputerApprovalRequest;
}

export interface SkillCapability {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: "project" | "personal" | "plugin" | "system";
  enabled: boolean;
}

export interface McpCapability {
  id: string;
  name: string;
  transport: "local" | "remote" | "configured";
  enabled: boolean;
}

export interface ConnectorCapability {
  id: string;
  name: string;
  enabled: boolean;
}

export interface CapabilitiesSnapshot {
  skills: SkillCapability[];
  mcpServers: McpCapability[];
  connectors: ConnectorCapability[];
  configPath: string;
}

export interface ProviderStatus {
  id: ProviderId;
  ready: boolean;
  label: string;
  source: string;
  detail: string;
}

export interface AppSnapshot {
  conversations: Conversation[];
  activeConversationId?: string;
  settings: AppSettings;
  providerStatuses: ProviderStatus[];
  computerAccess: ComputerAccessSnapshot;
  appVersion: string;
}

export interface ConversationPatch {
  title?: string;
  instructions?: string;
  provider?: ProviderId;
  model?: string;
  reasoning?: ReasoningEffort;
  sandboxMode?: SandboxMode;
  allowCommands?: boolean;
  projectMode?: ProjectMode;
  workingDirectory?: string;
  selectedAgentIds?: string[];
}

export interface GrokkyApi {
  getSnapshot(): Promise<AppSnapshot>;
  createConversation(): Promise<string>;
  setActiveConversation(conversationId: string): Promise<void>;
  updateConversation(conversationId: string, patch: ConversationPatch): Promise<void>;
  deleteConversation(conversationId: string): Promise<void>;
  sendMessage(conversationId: string, text: string, priority?: MessagePriority): Promise<void>;
  cancelRun(conversationId: string): Promise<void>;
  chooseWorkingDirectory(conversationId: string): Promise<string | null>;
  chooseOpenRouterCredential(): Promise<string | null>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  refreshProviderStatuses(): Promise<void>;
  getCapabilities(): Promise<CapabilitiesSnapshot>;
  setSkillEnabled(path: string, enabled: boolean): Promise<CapabilitiesSnapshot>;
  setMcpEnabled(id: string, enabled: boolean): Promise<CapabilitiesSnapshot>;
  setConnectorEnabled(id: string, enabled: boolean): Promise<CapabilitiesSnapshot>;
  getAgents(): Promise<AgentDefinition[]>;
  createAgent(draft: AgentDraft): Promise<AgentDefinition[]>;
  updateAgent(id: string, draft: AgentDraft): Promise<AgentDefinition[]>;
  deleteAgent(id: string): Promise<AgentDefinition[]>;
  setComputerAccessEnabled(enabled: boolean): Promise<void>;
  setComputerCapability(id: ComputerCapabilityId, level: ComputerAccessLevel): Promise<void>;
  requestComputerPermission(id: ComputerCapabilityId): Promise<void>;
  testComputerCapability(id: ComputerCapabilityId): Promise<void>;
  pairComputer(endpoint: string, code: string): Promise<void>;
  selectComputer(deviceId: string): Promise<void>;
  revokeComputer(deviceId: string): Promise<void>;
  updateComputerNetworkAllowlist(domains: string[]): Promise<void>;
  resolveComputerApproval(id: string, decision: ComputerApprovalDecision): Promise<void>;
  openExternal(url: string): Promise<void>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): void;
}

export const IPC = {
  snapshotGet: "grokky:snapshot:get",
  snapshotChanged: "grokky:snapshot:changed",
  conversationCreate: "grokky:conversation:create",
  conversationActivate: "grokky:conversation:activate",
  conversationUpdate: "grokky:conversation:update",
  conversationDelete: "grokky:conversation:delete",
  messageSend: "grokky:message:send",
  runCancel: "grokky:run:cancel",
  directoryChoose: "grokky:directory:choose",
  credentialChoose: "grokky:credential:choose",
  settingsUpdate: "grokky:settings:update",
  providersRefresh: "grokky:providers:refresh",
  capabilitiesGet: "grokky:capabilities:get",
  skillToggle: "grokky:capabilities:skill-toggle",
  mcpToggle: "grokky:capabilities:mcp-toggle",
  connectorToggle: "grokky:capabilities:connector-toggle",
  agentsGet: "grokky:agents:get",
  agentCreate: "grokky:agents:create",
  agentUpdate: "grokky:agents:update",
  agentDelete: "grokky:agents:delete",
  computerEnabled: "grokky:computer:enabled",
  computerCapability: "grokky:computer:capability",
  computerPermission: "grokky:computer:permission",
  computerTest: "grokky:computer:test",
  computerPair: "grokky:computer:pair",
  computerSelect: "grokky:computer:select",
  computerRevoke: "grokky:computer:revoke",
  computerNetworkAllowlist: "grokky:computer:network-allowlist",
  computerApprovalResolve: "grokky:computer:approval-resolve",
  externalOpen: "grokky:external:open",
} as const;

export const CODEX_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;

export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.2";
