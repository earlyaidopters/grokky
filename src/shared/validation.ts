import type {
  AccentPalette,
  AgentDraft,
  AppSettings,
  ComputerAccessLevel,
  ComputerApprovalDecision,
  ComputerCapabilityId,
  ConversationPatch,
  ProviderId,
  ProjectMode,
  ReasoningEffort,
  SandboxMode,
} from "./contracts";

const providers = new Set<ProviderId>(["codex", "openrouter"]);
const reasoning = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);
const sandboxModes = new Set<SandboxMode>(["read-only", "workspace-write"]);
const projectModes = new Set<ProjectMode>(["project", "none"]);
const themes = new Set<AppSettings["theme"]>(["system", "light", "dark"]);
const accentPalettes = new Set<AccentPalette>(["lime", "electric-blue", "ultraviolet", "solar-amber", "ice"]);
const computerCapabilities = new Set<ComputerCapabilityId>(["files", "commands", "browser", "screen", "automation"]);
const computerLevels = new Set<ComputerAccessLevel>(["blocked", "ask", "allow"]);
const computerDecisions = new Set<ComputerApprovalDecision>(["deny", "allow-once", "allow-session"]);

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
  if (typeof value !== "string" || !/^\d{6}$/.test(value.trim())) throw new Error("Invalid pairing code");
  return value.trim();
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
