import type { PhoneDesktopStatus } from "./phone";
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
export type ComputerCapabilityId = "files" | "commands" | "browser" | "screen" | "automation" | "external";
export type ComputerAccessLevel = "blocked" | "ask" | "allow";
export type ComputerPermissionStatus = "granted" | "denied" | "not-determined" | "not-required" | "unavailable";
export type ComputerDeviceStatus = "online" | "offline" | "revoked";
export type ComputerApprovalDecision = "deny" | "allow-once" | "allow-session";
export type AgentComputerStatus = "provisioning" | "ready" | "working" | "waiting" | "completed" | "blocked" | "failed" | "stopped";
export type AgentComputerIsolation = "isolated-browser" | "cloud-browser" | "policy-session";
export type AgentTaskStatus = "assigned" | "working" | "waiting" | "completed" | "blocked" | "failed" | "stopped";
export type AgentMeetingStatus = "live" | "completed" | "incomplete";
export type AgentMeetingContributionKind = "opening" | "challenge" | "response" | "decision" | "action";
export type MessagePriority = "normal" | "priority";
export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";
export type RoutineRunStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "skipped" | "stopped";
export type AttentionKind = "approval" | "routine" | "handoff" | "provider" | "computer" | "meeting";
export type ArtifactKind = "table" | "metrics" | "checklist" | "timeline";

export const MAX_IMAGE_ATTACHMENTS = 6;
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = MAX_IMAGE_BYTES * 3;

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
  attachments?: ImageAttachment[];
  createdAt: number;
  provider: ProviderId;
  crew?: CrewTurnSnapshot;
  artifacts?: GeneratedArtifact[];
  routineId?: string;
  agentProposal?: AgentProposal;
}

export interface GeneratedArtifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  description?: string;
  columns?: string[];
  rows?: Array<Array<string | number>>;
  items?: Array<{ label: string; value?: string | number; detail?: string; status?: "pending" | "active" | "complete" | "blocked" }>;
  createdAt: number;
}

export type RoutineSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string; weekdays: number[] };

export interface Routine {
  id: string;
  conversationId: string;
  name: string;
  instruction: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number;
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  conversationId: string;
  scheduledFor: number;
  status: RoutineRunStatus;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineDraft {
  conversationId: string;
  name: string;
  instruction: string;
  schedule: RoutineSchedule;
  enabled: boolean;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  conversationId?: string;
  routineId?: string;
  status: "open" | "resolved";
  createdAt: number;
  resolvedAt?: number;
}

export interface SchedulerStatus {
  active: boolean;
  runsWhileAppOpen: true;
  lastHeartbeatAt: number;
  nextWakeAt?: number;
}

export interface CrewTurnSnapshot {
  agentRuns: AgentRun[];
  communications: CrewCommunication[];
  tasks: AgentTask[];
  meetings: AgentMeeting[];
  agentComputers: AgentComputerSession[];
  activities: ActivityItem[];
  lastRunOutcome?: RunOutcome;
  usage?: UsageSummary;
  updatedAt: number;
}

export interface ImageInput {
  name: string;
  mimeType: ImageMimeType;
  data: Uint8Array;
}

export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: ImageMimeType;
  size: number;
  localPath: string;
}

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: ImageAttachment[];
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

export interface AgentComputerAction {
  id: string;
  capability: ComputerCapabilityId;
  action: string;
  target: string;
  status: "running" | "completed" | "failed" | "denied" | "indeterminate";
  detail?: string;
  effect?: "changed" | "no_effect" | "already_satisfied" | "navigated" | "opened_dialog" | "opened_popup" | "stale_reference" | "blocked" | "uncertain";
  snapshotId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentComputerEvidence {
  id: string;
  kind: "browser" | "screen";
  title: string;
  source: string;
  mimeType: "image/png";
  localPath: string;
  sha256?: string;
  createdAt: number;
}

export interface AgentComputerSession {
  id: string;
  conversationId: string;
  agentId: string;
  agentName: string;
  role: "lead" | "specialist";
  icon?: AgentIcon;
  threadId?: string;
  task?: string;
  status: AgentComputerStatus;
  isolation: AgentComputerIsolation;
  deviceId: string;
  deviceName: string;
  workspaceRoot: string;
  currentAction?: string;
  currentTarget?: string;
  currentUrl?: string;
  pageTitle?: string;
  actions: AgentComputerAction[];
  evidence: AgentComputerEvidence[];
  createdAt: number;
  updatedAt: number;
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

export interface AgentProposal {
  id: string;
  draft: AgentDraft;
  status: "proposed" | "used" | "saved" | "dismissed";
  matchedAgentId?: string;
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

export interface AgentTask {
  id: string;
  operationId: string;
  fromThreadId: string;
  fromName: string;
  toThreadId: string;
  toName: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  status: AgentTaskStatus;
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMeetingContribution {
  id: string;
  speakerThreadId: string;
  speakerName: string;
  kind: AgentMeetingContributionKind;
  content: string;
  createdAt: number;
}

export interface AgentMeeting {
  id: string;
  title: string;
  agenda: string;
  participantThreadIds: string[];
  participantNames: string[];
  status: AgentMeetingStatus;
  contributions: AgentMeetingContribution[];
  decisions: string[];
  actionItems: string[];
  createdAt: number;
  updatedAt: number;
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
  providerThreadIds?: Partial<Record<ProviderId, string>>;
  messages: ChatMessage[];
  queuedMessages: QueuedMessage[];
  activities: ActivityItem[];
  pendingAgent?: AgentDefinition;
  selectedAgentIds: string[];
  agentRuns: AgentRun[];
  crewCommunications: CrewCommunication[];
  agentTasks?: AgentTask[];
  agentMeetings?: AgentMeeting[];
  agentComputers?: AgentComputerSession[];
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
  spreadAgentComputers?: boolean;
  connectorsEnabled: boolean;
  webSearchEnabled: boolean;
  openRouterExternalTools?: boolean;
  generatedArtifactsEnabled?: boolean;
  onboardingComplete?: boolean;
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
  protocolVersion?: number;
  browserTools?: string[];
  lastSeenAt: number;
}

export interface ComputerAuditEntry {
  id: string;
  deviceId: string;
  conversationId?: string;
  provider?: ProviderId;
  agentComputerId?: string;
  agentName?: string;
  capability: ComputerCapabilityId;
  action: string;
  target: string;
  argumentDigest?: string;
  decision: "allowed" | "denied";
  status: "pending" | "completed" | "failed" | "indeterminate";
  detail?: string;
  createdAt: number;
  updatedAt?: number;
}

export interface ComputerApprovalRequest {
  id: string;
  deviceId: string;
  deviceName: string;
  conversationId: string;
  agentComputerId?: string;
  agentId?: string;
  agentName?: string;
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
  buildIdentity?: string;
  phone?: PhoneDesktopStatus;
  conversations: Conversation[];
  activeConversationId?: string;
  settings: AppSettings;
  providerStatuses: ProviderStatus[];
  computerAccess: ComputerAccessSnapshot;
  /** Ephemeral signed streams for active cloud-browser seats; never persisted. */
  agentComputerLiveViews: Record<string, string>;
  routines: Routine[];
  routineRuns: RoutineRun[];
  attention: AttentionItem[];
  scheduler: SchedulerStatus;
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
  startPhone(conversationId: string): Promise<void>;
  confirmPhone(): Promise<void>;
  disconnectPhone(): Promise<void>;
  resumePhone(): Promise<void>;
  getSnapshot(): Promise<AppSnapshot>;
  createConversation(): Promise<string>;
  setActiveConversation(conversationId: string): Promise<void>;
  updateConversation(conversationId: string, patch: ConversationPatch): Promise<void>;
  deleteConversation(conversationId: string): Promise<void>;
  sendMessage(conversationId: string, text: string, priority?: MessagePriority, images?: ImageInput[]): Promise<void>;
  getImageAttachmentData(attachmentId: string): Promise<string>;
  getAgentComputerEvidenceData(evidenceId: string): Promise<string>;
  cancelRun(conversationId: string): Promise<void>;
  chooseWorkingDirectory(conversationId: string): Promise<string | null>;
  chooseOpenRouterCredential(): Promise<string | null>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  refreshProviderStatuses(): Promise<void>;
  getCapabilities(): Promise<CapabilitiesSnapshot>;
  setSkillEnabled(path: string, enabled: boolean): Promise<CapabilitiesSnapshot>;
  setMcpEnabled(id: string, enabled: boolean): Promise<CapabilitiesSnapshot>;
  setConnectorEnabled(id: string, enabled: boolean): Promise<CapabilitiesSnapshot>;
  createRoutine(draft: RoutineDraft): Promise<void>;
  updateRoutine(id: string, patch: Partial<Omit<RoutineDraft, "conversationId">>): Promise<void>;
  deleteRoutine(id: string): Promise<void>;
  runRoutine(id: string): Promise<void>;
  resolveAttention(id: string): Promise<void>;
  resolveAgentProposal(conversationId: string, proposalId: string, action: "use" | "save" | "dismiss", draft: AgentDraft): Promise<AgentDefinition[]>;
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
  phoneStart: "grokky:phone:start",
  phoneConfirm: "grokky:phone:confirm",
  phoneDisconnect: "grokky:phone:disconnect",
  phoneResume: "grokky:phone:resume",
  snapshotGet: "grokky:snapshot:get",
  snapshotChanged: "grokky:snapshot:changed",
  conversationCreate: "grokky:conversation:create",
  conversationActivate: "grokky:conversation:activate",
  conversationUpdate: "grokky:conversation:update",
  conversationDelete: "grokky:conversation:delete",
  messageSend: "grokky:message:send",
  imageAttachmentData: "grokky:image-attachment:data",
  agentComputerEvidenceData: "grokky:agent-computer:evidence-data",
  runCancel: "grokky:run:cancel",
  directoryChoose: "grokky:directory:choose",
  credentialChoose: "grokky:credential:choose",
  settingsUpdate: "grokky:settings:update",
  providersRefresh: "grokky:providers:refresh",
  capabilitiesGet: "grokky:capabilities:get",
  skillToggle: "grokky:capabilities:skill-toggle",
  mcpToggle: "grokky:capabilities:mcp-toggle",
  connectorToggle: "grokky:capabilities:connector-toggle",
  routineCreate: "grokky:routines:create",
  routineUpdate: "grokky:routines:update",
  routineDelete: "grokky:routines:delete",
  routineRun: "grokky:routines:run",
  attentionResolve: "grokky:attention:resolve",
  agentProposalResolve: "grokky:agent-proposal:resolve",
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
