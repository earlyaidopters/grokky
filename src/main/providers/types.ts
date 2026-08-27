import type { ActivityItem, AgentDefinition, AppSettings, Conversation, ImageAttachment, OrchestrationEvent, UsageSummary } from "../../shared/contracts";
import type { ComputerToolName } from "../computer-access";
import type { PersistedComputerAccess } from "../state-store";

export type ProviderEvent =
  | { type: "thread"; threadId: string }
  | { type: "activity"; activity: ActivityItem }
  | { type: "orchestration"; event: OrchestrationEvent }
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
  executeTool(name: ComputerToolName, args: Record<string, unknown>, options?: { readOnly?: boolean }): Promise<string>;
  onEvent(event: ProviderEvent): void | Promise<void>;
}

export interface OpenRouterRunContext extends ProviderRunContext {
  apiKey: string;
}
