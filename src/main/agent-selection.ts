import type { AgentDefinition, AppSettings, Conversation } from "../shared/contracts";
import { hasPositiveIntent, requestsAgentDelegation } from "../shared/run-preflight";

/** Explicit picks win. OpenRouter can discover a bounded roster for a natural-language delegation request. */
export function agentsForRun(catalog: AgentDefinition[], conversation: Conversation, settings: AppSettings, prompt: string): AgentDefinition[] {
  if (!settings.multiAgentEnabled) return [];
  const limit = Math.max(1, Math.min(8, settings.maxAgentThreads));
  if (conversation.selectedAgentIds.length) {
    return catalog.filter((agent) => conversation.selectedAgentIds.includes(agent.id)).slice(0, limit);
  }
  // Codex selects its native roles itself; the rollout observer records the actual agents.
  const namedRequest = catalog.some((agent) => {
    const name = agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return hasPositiveIntent(prompt, new RegExp(`\\b(?:ask|have|use|assign|delegate to)\\s+(?:the\\s+)?${name}\\b`, "i"));
  });
  if (conversation.provider === "codex" || (!requestsAgentDelegation(prompt) && !namedRequest)) return [];
  const words = new Set(prompt.toLowerCase().match(/[a-z][a-z_-]{3,}/g) ?? []);
  return catalog.filter((agent) => agent.name !== "default")
    .map((agent, index) => ({ agent, index, score:
      (words.has(agent.name.toLowerCase()) ? 1000 : 0)
      + (agent.description.toLowerCase().match(/[a-z][a-z_-]{3,}/g) ?? []).filter((word) => words.has(word)).length,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map(({ agent }) => agent);
}
