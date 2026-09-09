import { useRef, useState } from "react";
import { CheckCircle, UserPlus, X } from "@phosphor-icons/react";
import type { AgentDefinition, AgentProposal, ProviderId } from "../../shared/contracts";

export function AgentProposalCard({ proposal, conversationId, provider, onAgentsChange }: {
  proposal: AgentProposal; conversationId: string; provider: ProviderId; onAgentsChange(agents: AgentDefinition[]): void;
}) {
  const [draft, setDraft] = useState(proposal.draft);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const resolve = async (action: "use" | "save" | "dismiss") => {
    if (pending.current) return;
    pending.current = true; setBusy(action); setError("");
    try { onAgentsChange(await window.grokky.resolveAgentProposal(conversationId, proposal.id, action, action === "dismiss" ? proposal.draft : draft)); }
    catch (e) { setError(e instanceof Error ? e.message : "The role could not be updated. Your edits are still here."); }
    finally { pending.current = false; setBusy(""); }
  };
  if (proposal.status === "dismissed") return <div className="agent-proposal resolved"><span>Role proposal dismissed</span></div>;
  return <section className="agent-proposal" aria-label={`Role proposal: ${proposal.draft.name}`}>
    <header><UserPlus size={19} /><div><small>{proposal.matchedAgentId ? "From your agent library" : "Role brief from your request"}</small><h3>{draft.name.replaceAll("_", " ")}</h3></div></header>
    {proposal.status !== "proposed" ? <p role="status"><CheckCircle size={16} />{proposal.status === "used" ? "Selected for the next turn only. Send its task when you’re ready." : "Saved to your agent library. Select it in the crew picker when needed."}</p> : <>
      {editing ? <div className="proposal-fields">
        <label>Name<input value={draft.name} maxLength={64} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>Description<textarea rows={2} value={draft.description} maxLength={800} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
        <label>Instructions<textarea rows={6} value={draft.developerInstructions} maxLength={30000} onChange={(e) => setDraft({ ...draft, developerInstructions: e.target.value })} /></label>
        <label>Save location<select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as "personal" | "project" })}><option value="personal">Personal agent library</option><option value="project">This project</option></select></label>
      </div> : <><p>{draft.description}</p><details><summary>Role instructions</summary><p className="proposal-instructions">{draft.developerInstructions}</p></details></>}
      <div className="proposal-boundary"><strong>{provider === "codex" ? "Codex native specialist" : "OpenRouter read-only specialist"}</strong><span>{draft.sandboxMode === "workspace-write" && provider === "codex" ? "Workspace writes remain limited by this conversation’s access." : "Read-only by default. This role does not grant new permissions."} Model: {draft.model || "session agent defaults"}.</span></div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={Boolean(busy)} onClick={() => setEditing(!editing)}>{editing ? "Review role" : "Edit role"}</button><span />
        <button type="button" disabled={Boolean(busy)} onClick={() => void resolve("dismiss")} aria-label="Dismiss role proposal"><X size={15} /></button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void resolve("save")}>{busy === "save" ? "Saving…" : "Save for reuse"}</button>
        <button className="primary" type="button" disabled={Boolean(busy)} onClick={() => void resolve("use")}>{busy === "use" ? "Selecting…" : "Use once"}</button></footer>
    </>}
  </section>;
}
