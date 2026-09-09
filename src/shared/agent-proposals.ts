import type { AgentDefinition, AgentDraft, AgentProposal } from "./contracts";
import { validateAgentDraft } from "./validation";
import { hasPositiveIntent } from "./run-preflight";

export function requestsAgentProposal(prompt: string): boolean {
  return hasPositiveIntent(prompt, /\b(?:suggest|recommend|propose|design|create)\b[^.!?\n]{0,65}\b(?:agent|specialist|role)\b/i)
    && !/\b(?:agent app|agent application|agent framework|agent sdk|source code for)\b/i.test(prompt);
}

export function validatedProposalDraft(value: unknown): AgentDraft {
  const draft = validateAgentDraft(value);
  const name = draft.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name)) throw new Error("Use a role name of 2–64 letters, numbers, hyphens or underscores, starting with a letter.");
  if (!draft.description.trim() || !draft.developerInstructions.trim()) throw new Error("Add a description and instructions for this role.");
  // A reviewed definition cannot request an unrestricted runtime.
  if (draft.sandboxMode && !["read-only", "workspace-write"].includes(draft.sandboxMode)) throw new Error("Choose read-only or workspace access.");
  return { ...draft, name, description: draft.description.trim(), developerInstructions: draft.developerInstructions.trim() };
}

export function proposalFromRequest(prompt: string, catalog: AgentDefinition[], id: string): AgentProposal {
  const terms = new Set(prompt.toLowerCase().match(/[a-z][a-z_-]{3,}/g) ?? []);
  const ranked = catalog.map((agent) => ({ agent, score: (terms.has(agent.name.toLowerCase()) ? 10 : 0)
    + [...new Set(agent.description.toLowerCase().match(/[a-z][a-z_-]{3,}/g) ?? [])].filter((word) => terms.has(word)).length }))
    .filter(({ agent, score }) => agent.name !== "default" && score >= 2).sort((a, b) => b.score - a.score);
  const matched = !/\b(?:new|custom|missing)\b/i.test(prompt) ? ranked[0]?.agent : undefined;
  const explicitName = prompt.match(/\b(?:called|named)\s+["“']?([a-z][a-z0-9_ -]{1,48})["”']?(?:[.,\n]|$)/i)?.[1];
  const specialty = prompt.match(/\b(?:new |custom )?([a-z][a-z -]{1,32})\s+(?:specialist|agent)\b/i)?.[1]?.replace(/^(?:please |can you |i want |a |an |create |suggest |recommend |propose |design )+/gi, "");
  const name = (explicitName || specialty || "task_specialist").trim().replace(/[^a-z0-9_-]+/gi, "_").toLowerCase().slice(0, 64);
  const draft: AgentDraft = matched ? { ...matched, scope: "personal" } : {
    name: name.length >= 2 ? name : "task_specialist", scope: "personal", icon: "cyan", sandboxMode: "read-only",
    description: prompt.trim().slice(0, 800),
    developerInstructions: `Specialist brief supplied by the user:\n${prompt.trim().slice(0, 6000)}\n\nWork only on the assigned part of the next request. Stay within the conversation's permissions. Report concrete findings, uncertainty, and a concise result to the lead. Do not save new agent definitions or claim tools that are not available.`,
  };
  return { id, draft: validatedProposalDraft(draft), status: "proposed", ...(matched ? { matchedAgentId: matched.id } : {}) };
}

export function normalizeAgentProposal(value: unknown): AgentProposal | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as AgentProposal;
  if (typeof item.id !== "string" || !/^[a-zA-Z0-9:_-]{3,100}$/.test(item.id) || !["proposed", "used", "saved", "dismissed"].includes(item.status)) return;
  try { return { id: item.id, draft: validatedProposalDraft(item.draft), status: item.status,
    ...(typeof item.matchedAgentId === "string" ? { matchedAgentId: item.matchedAgentId.slice(0, 100) } : {}) }; } catch { return; }
}
