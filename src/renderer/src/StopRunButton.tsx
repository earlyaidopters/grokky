import { useRef, useState } from "react";
import { Stop } from "@phosphor-icons/react";

export function StopRunButton({ conversationId, className = "", label = "Stop" }: { conversationId: string; className?: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const stop = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await window.grokky.cancelRun(conversationId); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not stop this run. Try again."); }
    finally { pending.current = false; setBusy(false); }
  };
  return <><button className={className} type="button" disabled={busy} aria-busy={busy} onClick={() => void stop()}><Stop size={12} weight="fill" />{busy ? "Stopping…" : label}</button>{error && <span role="alert" className="inline-error">{error}</span>}</>;
}
