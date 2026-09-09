import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { PhoneDesktopStatus } from "../../shared/phone";

export function PhoneControl({ conversationId, status, build, onError }: { conversationId: string; status?: PhoneDesktopStatus; build?: string; onError(message: string): void }) {
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const session = status?.conversationId === conversationId ? status : undefined;
  useEffect(() => {
    let cancelled = false; setQr("");
    if (session?.inviteUrl) void QRCode.toDataURL(session.inviteUrl, { width: 216, margin: 2 }).then((url) => { if (!cancelled) setQr(url); }).catch(() => onError("Could not display the pairing code"));
    return () => { cancelled = true; };
  }, [session?.inviteUrl]);
  const act = async (action: () => Promise<void>) => { setBusy(true); try { await action(); } catch (e) { onError(e instanceof Error ? e.message : "Phone control failed"); } finally { setBusy(false); } };
  return <section className="phone-control">
    <button className="phone-control-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{session?.confirmed ? "Phone connected" : "Control from your phone"}<span>{expanded ? "−" : "+"}</span></button>
    {expanded && <div className="phone-control-content">
      {!session && <><p>Watch, approve an action, or take over this cloud browser from your phone.</p><button type="button" disabled={busy || Boolean(status)} onClick={() => void act(() => window.grokky.startPhone(conversationId))}>Pair phone</button></>}
      {session?.inviteUrl && <><p>Scan this code within two minutes. Then confirm your phone here.</p>{qr && <img src={qr} width="216" height="216" alt="Private phone pairing QR code" />}<button type="button" onClick={() => void act(() => navigator.clipboard.writeText(session.inviteUrl!))}>Copy pairing link</button></>}
      {session?.claimed && !session.confirmed && <><p>A phone opened your link. Confirm only if that was you.</p><button type="button" disabled={busy} onClick={() => void act(() => window.grokky.confirmPhone())}>Confirm my phone</button></>}
      {session?.confirmed && <p>{session.owner === "human" ? "Your phone has control. Grokky is paused." : session.owner === "pausing" ? "Waiting for the current action to finish." : "Phone connected. Grokky has control."}</p>}
      {session?.owner === "human" && <button type="button" disabled={busy} onClick={() => void act(() => window.grokky.resumePhone())}>Return control to Grokky</button>}
      {session?.error && <p role="status">{session.error}</p>}
      {session && <button type="button" disabled={busy} onClick={() => void act(() => window.grokky.disconnectPhone())}>{session.owner === "human" || session.owner === "pausing" ? "Disconnect and stop task" : "Disconnect phone"}</button>}
      <small>Keep your Mac awake. Pairing lasts 30 minutes.<br />Build {build}</small>
    </div>}
  </section>;
}
