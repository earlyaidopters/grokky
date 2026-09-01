import type { ActivityItem, AgentDefinition, AgentMeeting, AgentTask, AppSettings, AttentionItem, Conversation, ImageAttachment, OrchestrationEvent, UsageSummary } from "../../shared/contracts";
import type { BrowserActionOutcome, BrowserObservation, ComputerToolName } from "../computer-access";
import type { PersistedComputerAccess } from "../state-store";
import type { ExternalToolDefinition } from "../mcp-runtime";

export interface AgentComputerIdentity {
  agentId: string;
  agentName: string;
  threadId?: string;
}

export interface ProviderToolResult {
  output: string;
  attachmentPath?: string;
  attachmentMimeType?: "image/png";
  browserObservation?: BrowserObservation;
  browserOutcome?: BrowserActionOutcome;
}

export type ProviderEvent =
  | { type: "thread"; threadId: string }
  | { type: "activity"; activity: ActivityItem }
  | { type: "orchestration"; event: OrchestrationEvent }
  | { type: "task"; task: AgentTask }
  | { type: "meeting"; meeting: AgentMeeting }
  | { type: "attention"; item: AttentionItem }
  | { type: "final"; text: string }
  | { type: "usage"; usage: UsageSummary };

export interface ProviderRunContext {
  conversation: Conversation;
  settings: AppSettings;
  agents: AgentDefinition[];
  prompt: string;
  images: ImageAttachment[];
  readImageDataUrl(attachment: ImageAttachment): Promise<string>;
  signal: AbortSignal;
  computerAccess: PersistedComputerAccess;
  approvedBrowserOrigins: string[];
  executeTool(name: ComputerToolName, args: Record<string, unknown>, options?: { readOnly?: boolean; agentComputer?: AgentComputerIdentity }): Promise<ProviderToolResult>;
  externalTools?: ExternalToolDefinition[];
  executeExternalTool?(name: string, args: Record<string, unknown>, options?: { readOnly?: boolean; agentComputer?: AgentComputerIdentity }): Promise<ProviderToolResult>;
  unattended?: boolean;
  onEvent(event: ProviderEvent): void | Promise<void>;
}

export interface OpenRouterRunContext extends ProviderRunContext {
  apiKey: string;
}
