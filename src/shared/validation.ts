import type {
  AccentPalette,
  AgentDraft,
  AppSettings,
  ComputerAccessLevel,
  ComputerApprovalDecision,
  ComputerCapabilityId,
  ConversationPatch,
  ImageInput,
  ImageMimeType,
  MessagePriority,
  ProviderId,
  ProjectMode,
  ReasoningEffort,
  RoutineDraft,
  RoutineSchedule,
  SandboxMode,
} from "./contracts";
import { MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES } from "./contracts";

const providers = new Set<ProviderId>(["codex", "openrouter"]);
const reasoning = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);
const sandboxModes = new Set<SandboxMode>(["read-only", "workspace-write"]);
const projectModes = new Set<ProjectMode>(["project", "none"]);
const themes = new Set<AppSettings["theme"]>(["system", "light", "dark"]);
const accentPalettes = new Set<AccentPalette>(["lime", "electric-blue", "ultraviolet", "solar-amber", "ice"]);
const computerCapabilities = new Set<ComputerCapabilityId>(["files", "commands", "browser", "screen", "automation", "external"]);
const computerLevels = new Set<ComputerAccessLevel>(["blocked", "ask", "allow"]);
const computerDecisions = new Set<ComputerApprovalDecision>(["deny", "allow-once", "allow-session"]);
const messagePriorities = new Set<MessagePriority>(["normal", "priority"]);
const imageMimeTypes = new Set<ImageMimeType>(["image/png", "image/jpeg", "image/webp"]);

export function requireId(value: unknown, label = "ID"): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function requireMessage(value: unknown): string {
  if (typeof value !== "string") throw new Error("Message must be text");
  const result = value.trim();
  if (!result) throw new Error("Message cannot be empty");
  if (result.length > 200_000) throw new Error("Message is too large");
  return result;
}

export function requireMessageOrImages(value: unknown, imageCount: number): string {
  if (typeof value !== "string") throw new Error("Message must be text");
  const result = value.trim();
  if (!result && imageCount === 0) throw new Error("Message cannot be empty");
  if (result.length > 200_000) throw new Error("Message is too long");
  return result;
}

export function requireImageInputs(value: unknown): ImageInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGE_ATTACHMENTS) throw new Error(`Attach up to ${MAX_IMAGE_ATTACHMENTS} images`);
  let totalBytes = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Image ${index + 1} is invalid`);
    const input = item as Partial<ImageInput>;
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 180) throw new Error(`Image ${index + 1} has an invalid name`);
    if (!imageMimeTypes.has(input.mimeType as ImageMimeType)) throw new Error(`Image ${input.name} must be PNG, JPEG, or WebP`);
    const rawData: unknown = (item as Record<string, unknown>).data;
    const data = rawData instanceof Uint8Array
      ? rawData
      : rawData instanceof ArrayBuffer
        ? new Uint8Array(rawData)
        : null;
    if (!data || data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) throw new Error(`Image ${input.name} must be smaller than ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB`);
    totalBytes += data.byteLength;
    if (totalBytes > MAX_IMAGE_TOTAL_BYTES) throw new Error("Attached images are too large in total");
    return { name: input.name.trim(), mimeType: input.mimeType as ImageMimeType, data };
  });
}

export function requireMessagePriority(value: unknown): MessagePriority {
  if (value === undefined) return "normal";
  if (!messagePriorities.has(value as MessagePriority)) throw new Error("Invalid message priority");
  return value as MessagePriority;
}

export function requireComputerCapability(value: unknown): ComputerCapabilityId {
  if (!computerCapabilities.has(value as ComputerCapabilityId)) throw new Error("Invalid computer capability");
  return value as ComputerCapabilityId;
}

export function requireComputerAccessLevel(value: unknown): ComputerAccessLevel {
  if (!computerLevels.has(value as ComputerAccessLevel)) throw new Error("Invalid computer access level");
  return value as ComputerAccessLevel;
}

export function requireComputerApprovalDecision(value: unknown): ComputerApprovalDecision {
  if (!computerDecisions.has(value as ComputerApprovalDecision)) throw new Error("Invalid computer approval decision");
  return value as ComputerApprovalDecision;
}

export function requireRunnerEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000) throw new Error("Invalid runner endpoint");
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Runner endpoint must use http or https");
  return value.trim();
}

export function requirePairingCode(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid pairing code or enrollment key");
  const secret = value.trim();
  if (!/^\d{6}$/.test(secret) && !/^gsk_[a-zA-Z0-9_-]{32,180}$/.test(secret)) throw new Error("Invalid pairing code or enrollment key");
  return secret;
}

export function requireNetworkAllowlist(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid network allowlist");
  return value.map((entry) => {
    if (typeof entry !== "string" || !/^(?:https?:\/\/)?(?:\*\.)?[a-zA-Z0-9.-]{1,253}$/.test(entry.trim())) throw new Error("Invalid network domain");
    return entry.trim().toLowerCase();
  });
}

export function validateConversationPatch(value: unknown): ConversationPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid conversation update");
  const input = value as Record<string, unknown>;
  const patch: ConversationPatch = {};
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 80) throw new Error("Invalid session name");
    patch.title = input.title.trim();
  }
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== "string" || input.instructions.length > 4_000) throw new Error("Invalid session purpose");
    patch.instructions = input.instructions.trim();
  }
  if (input.provider !== undefined) {
    if (!providers.has(input.provider as ProviderId)) throw new Error("Unsupported provider");
    patch.provider = input.provider as ProviderId;
  }
  if (input.model !== undefined) {
    if (typeof input.model !== "string" || !/^[a-zA-Z0-9_~./:-]{2,160}$/.test(input.model)) throw new Error("Invalid model");
    patch.model = input.model;
  }
  if (input.reasoning !== undefined) {
    if (!reasoning.has(input.reasoning as ReasoningEffort)) throw new Error("Invalid reasoning effort");
    patch.reasoning = input.reasoning as ReasoningEffort;
  }
  if (input.sandboxMode !== undefined) {
    if (!sandboxModes.has(input.sandboxMode as SandboxMode)) throw new Error("Invalid workspace permission");
    patch.sandboxMode = input.sandboxMode as SandboxMode;
  }
  if (input.allowCommands !== undefined) {
    if (typeof input.allowCommands !== "boolean") throw new Error("Invalid command permission");
    patch.allowCommands = input.allowCommands;
  }
  if (input.projectMode !== undefined) {
    if (!projectModes.has(input.projectMode as ProjectMode)) throw new Error("Invalid project mode");
    patch.projectMode = input.projectMode as ProjectMode;
  }
  if (input.workingDirectory !== undefined) {
    if (typeof input.workingDirectory !== "string" || input.workingDirectory.length > 2_000) throw new Error("Invalid working directory");
    patch.workingDirectory = input.workingDirectory;
  }
  if (input.selectedAgentIds !== undefined) {
    if (!Array.isArray(input.selectedAgentIds) || input.selectedAgentIds.length > 8 || input.selectedAgentIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9:_-]{3,100}$/.test(id))) {
      throw new Error("Invalid crew selection");
    }
    patch.selectedAgentIds = [...new Set(input.selectedAgentIds as string[])];
  }
  return patch;
}

export function validateSettingsPatch(value: unknown): Partial<AppSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings update");
  const input = value as Record<string, unknown>;
  const patch: Partial<AppSettings> = {};
  if (input.defaultWorkingDirectory !== undefined) {
    if (typeof input.defaultWorkingDirectory !== "string" || input.defaultWorkingDirectory.length > 2_000) throw new Error("Invalid default directory");
    patch.defaultWorkingDirectory = input.defaultWorkingDirectory;
  }
  if (input.recentWorkingDirectories !== undefined) {
    if (!Array.isArray(input.recentWorkingDirectories) || input.recentWorkingDirectories.length > 12 || input.recentWorkingDirectories.some((pathname) => typeof pathname !== "string" || pathname.length > 2_000)) {
      throw new Error("Invalid recent project directories");
    }
    patch.recentWorkingDirectories = [...new Set(input.recentWorkingDirectories as string[])];
  }
  if (input.openRouterExternalTools !== undefined) {
    if (typeof input.openRouterExternalTools !== "boolean") throw new Error("Invalid OpenRouter external-tools setting");
    patch.openRouterExternalTools = input.openRouterExternalTools;
  }
  if (input.generatedArtifactsEnabled !== undefined) {
    if (typeof input.generatedArtifactsEnabled !== "boolean") throw new Error("Invalid generated-artifacts setting");
    patch.generatedArtifactsEnabled = input.generatedArtifactsEnabled;
  }
  if (input.onboardingComplete !== undefined) {
    if (typeof input.onboardingComplete !== "boolean") throw new Error("Invalid onboarding setting");
    patch.onboardingComplete = input.onboardingComplete;
  }
  if (input.openRouterCredentialPath !== undefined) {
    if (typeof input.openRouterCredentialPath !== "string" || input.openRouterCredentialPath.length > 2_000) throw new Error("Invalid credential path");
    patch.openRouterCredentialPath = input.openRouterCredentialPath;
  }
  if (input.theme !== undefined) {
    if (!themes.has(input.theme as AppSettings["theme"])) throw new Error("Invalid theme");
    patch.theme = input.theme as AppSettings["theme"];
  }
  if (input.accentPalette !== undefined) {
    if (!accentPalettes.has(input.accentPalette as AccentPalette)) throw new Error("Invalid signal colour");
    patch.accentPalette = input.accentPalette as AccentPalette;
  }
  if (input.multiAgentEnabled !== undefined) {
    if (typeof input.multiAgentEnabled !== "boolean") throw new Error("Invalid multi-agent setting");
    patch.multiAgentEnabled = input.multiAgentEnabled;
  }
  if (input.maxAgentThreads !== undefined) {
    if (typeof input.maxAgentThreads !== "number" || !Number.isInteger(input.maxAgentThreads) || input.maxAgentThreads < 1 || input.maxAgentThreads > 8) {
      throw new Error("Agent thread limit must be between 1 and 8");
    }
    patch.maxAgentThreads = input.maxAgentThreads;
  }
  if (input.defaultSubagentModel !== undefined) {
    if (typeof input.defaultSubagentModel !== "string" || (input.defaultSubagentModel && !/^[a-zA-Z0-9_~./:-]{2,160}$/.test(input.defaultSubagentModel))) {
      throw new Error("Invalid default subagent model");
    }
    patch.defaultSubagentModel = input.defaultSubagentModel;
  }
  if (input.defaultSubagentReasoning !== undefined) {
    if (input.defaultSubagentReasoning !== "" && !reasoning.has(input.defaultSubagentReasoning as ReasoningEffort)) throw new Error("Invalid default subagent reasoning");
    patch.defaultSubagentReasoning = input.defaultSubagentReasoning as AppSettings["defaultSubagentReasoning"];
  }
  if (input.interruptAgentMessage !== undefined) {
    if (typeof input.interruptAgentMessage !== "boolean") throw new Error("Invalid agent interruption setting");
    patch.interruptAgentMessage = input.interruptAgentMessage;
  }
  if (input.spreadAgentComputers !== undefined) {
    if (typeof input.spreadAgentComputers !== "boolean") throw new Error("Invalid agent computer distribution setting");
    patch.spreadAgentComputers = input.spreadAgentComputers;
  }
  if (input.connectorsEnabled !== undefined) {
    if (typeof input.connectorsEnabled !== "boolean") throw new Error("Invalid connector setting");
    patch.connectorsEnabled = input.connectorsEnabled;
  }
  if (input.webSearchEnabled !== undefined) {
    if (typeof input.webSearchEnabled !== "boolean") throw new Error("Invalid web search setting");
    patch.webSearchEnabled = input.webSearchEnabled;
  }
  return patch;
}

function validateRoutineSchedule(value: unknown): RoutineSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid routine schedule");
  const input = value as Record<string, unknown>;
  if (input.kind === "interval") {
    if (!Number.isSafeInteger(input.minutes) || Number(input.minutes) < 15 || Number(input.minutes) > 43_200) {
      throw new Error("Routine intervals must be between 15 minutes and 30 days");
    }
    return { kind: "interval", minutes: Number(input.minutes) };
  }
  if (input.kind === "daily") {
    if (typeof input.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error("Routine time must use HH:MM");
    if (!Array.isArray(input.weekdays) || input.weekdays.length < 1 || input.weekdays.length > 7 || input.weekdays.some((day) => !Number.isSafeInteger(day) || Number(day) < 0 || Number(day) > 6)) {
      throw new Error("Choose valid routine weekdays");
    }
    return { kind: "daily", time: input.time, weekdays: [...new Set(input.weekdays as number[])].sort((left, right) => left - right) };
  }
  throw new Error("Unsupported routine schedule");
}

export function validateRoutineDraft(value: unknown): RoutineDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid routine");
  const input = value as Record<string, unknown>;
  return {
    conversationId: requireId(input.conversationId, "conversation ID"),
    name: requireBoundedRoutineText(input.name, "Routine name", 100),
    instruction: requireBoundedRoutineText(input.instruction, "Routine instruction", 20_000),
    schedule: validateRoutineSchedule(input.schedule),
    enabled: input.enabled !== false,
  };
}

export function validateRoutinePatch(value: unknown): Partial<Omit<RoutineDraft, "conversationId">> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid routine update");
  const input = value as Record<string, unknown>;
  const patch: Partial<Omit<RoutineDraft, "conversationId">> = {};
  if (input.name !== undefined) patch.name = requireBoundedRoutineText(input.name, "Routine name", 100);
  if (input.instruction !== undefined) patch.instruction = requireBoundedRoutineText(input.instruction, "Routine instruction", 20_000);
  if (input.schedule !== undefined) patch.schedule = validateRoutineSchedule(input.schedule);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new Error("Invalid routine enabled state");
    patch.enabled = input.enabled;
  }
  return patch;
}

function requireBoundedRoutineText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(`${label} is invalid`);
  return value.trim();
}

export function validateAgentDraft(value: unknown): AgentDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent definition");
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || input.name.length > 120) throw new Error("Invalid agent name");
  if (typeof input.description !== "string" || input.description.length > 800) throw new Error("Invalid agent description");
  if (typeof input.developerInstructions !== "string" || input.developerInstructions.length > 30_000) throw new Error("Invalid agent instructions");
  if (input.scope !== "personal" && input.scope !== "project") throw new Error("Invalid agent scope");
  if (input.model !== undefined && (typeof input.model !== "string" || (input.model && !/^[a-zA-Z0-9_~./:-]{2,160}$/.test(input.model)))) throw new Error("Invalid agent model");
  if (input.reasoning !== undefined && !reasoning.has(input.reasoning as ReasoningEffort)) throw new Error("Invalid agent reasoning");
  if (input.sandboxMode !== undefined && !sandboxModes.has(input.sandboxMode as SandboxMode)) throw new Error("Invalid agent permission");
  const agentIcons = new Set(["lime", "cyan", "coral", "violet", "amber", "mint"]);
  if (input.icon !== undefined && !agentIcons.has(input.icon as string)) throw new Error("Invalid agent icon");
  return {
    name: input.name,
    description: input.description,
    developerInstructions: input.developerInstructions,
    scope: input.scope,
    ...(input.icon ? { icon: input.icon as AgentDraft["icon"] } : {}),
    ...(input.model ? { model: input.model as string } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning as ReasoningEffort } : {}),
    ...(input.sandboxMode ? { sandboxMode: input.sandboxMode as SandboxMode } : {}),
  };
}
