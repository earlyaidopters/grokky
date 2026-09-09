import { useEffect, useId, useRef, useState } from "react";
import QRCode from "qrcode";
import type { PhoneDesktopStatus, PhonePairingReadiness } from "../../shared/phone";

export function PhoneControl({ conversationId, computerId, readiness, status, build }: { conversationId: string; computerId: string; readiness?: PhonePairingReadiness; status?: PhoneDesktopStatus; build?: string }) {
  const readinessId = useId();
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pending = useRef(false);
  const session = status?.conversationId === conversationId && status.computerId === computerId ? status : undefined;
  useEffect(() => {
    let cancelled = false; setQr("");
    if (session?.inviteUrl) void QRCode.toDataURL(session.inviteUrl, { width: 216, margin: 2 }).then((url) => { if (!cancelled) setQr(url); }).catch(() => { if (!cancelled) setError("Could not display the pairing code. You can still copy the pairing link."); });
    return () => { cancelled = true; };
  }, [session?.inviteUrl]);
  useEffect(() => { if (!expanded || !session) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [expanded, session?.expiresAt]);
  useEffect(() => { setError(""); setFeedback(""); }, [conversationId, computerId, readiness?.ready, readiness?.reason, status?.computerId]);
  const act = async (label: string, action: () => Promise<void>, success = "") => {
    if (pending.current) return;
    pending.current = true; setBusy(label); setError(""); setFeedback("");
    try { await action(); setFeedback(success); }
    catch (e) { const message = e instanceof Error ? e.message : "Phone control failed. Try again."; setError(message); }
    finally { pending.current = false; setBusy(""); }
  };
  const seconds = Math.max(0, Math.ceil(((session?.expiresAt ?? now) - now) / 1000));
  return <section className="phone-control" aria-busy={Boolean(busy)}>
    <button className="phone-control-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{session?.confirmed ? "Phone connected" : "Control from your phone"}<span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
    {expanded && <div className="phone-control-content">
      {!session && <>
        <p>Watch, approve an action, or take over this cloud browser from your phone.</p>
        <p id={readinessId} role="status">{status
          ? "Another browser session is paired. Disconnect that phone session before pairing this task."
          : readiness?.ready ? "This task is ready to pair. Scan the code while Grokky is working."
          : readiness?.reason || "This is an earlier browser session. Open Watch for a running cloud task to pair your phone."}</p>
        <button type="button" aria-describedby={readinessId} disabled={Boolean(busy) || Boolean(status) || !readiness?.ready} onClick={() => void act("Preparing pairing…", () => window.grokky.startPhone(conversationId, computerId))}>Pair phone</button>
      </>}
      {session?.inviteUrl && <><p>Scan within two minutes, then confirm this phone here.</p>{qr ? <img src={qr} width="216" height="216" alt="Private phone pairing QR code" /> : <div className="phone-qr-loading" role="status">Preparing pairing code…</div>}<button type="button" disabled={Boolean(busy)} onClick={() => void act("Copying link…", () => navigator.clipboard.writeText(session.inviteUrl!), "Pairing link copied")}>Copy pairing link</button></>}
      {session?.claimed && !session.confirmed && <><p>A phone opened your link. Confirm only if that was you.</p><button className="primary" type="button" disabled={Boolean(busy)} onClick={() => void act("Confirming phone…", () => window.grokky.confirmPhone())}>Confirm my phone</button></>}
      {session?.confirmed && <p>{session.owner === "human" ? "Your phone has control. Grokky is paused." : session.owner === "pausing" ? "Waiting for the current action to finish." : "Phone connected. Grokky has control."}</p>}
      {session?.owner === "human" && <button className="primary" type="button" disabled={Boolean(busy)} onClick={() => void act("Returning control…", () => window.grokky.resumePhone())}>Return control to Grokky</button>}
      {(error || session?.error) && <p className="inline-error" role="alert">{error || session?.error}</p>}
      {(busy || feedback) && <p className="phone-feedback" role="status">{busy || feedback}</p>}
      {session && <><small>{seconds ? `Session expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Session expired. Disconnect and pair again."}</small><button type="button" disabled={Boolean(busy)} onClick={() => void act("Disconnecting…", () => window.grokky.disconnectPhone(), "Phone disconnected")}>{session.owner === "human" || session.owner === "pausing" ? "Disconnect and stop task" : "Disconnect phone"}</button></>}
      <small>Keep Grokky open and your computer awake.</small><details className="phone-build"><summary>Connection details</summary><small>Build {build}</small></details>
    </div>}
  </section>;
}
