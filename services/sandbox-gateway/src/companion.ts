import { DurableObject } from "cloudflare:workers";
import { parsePhoneCommand, type PhoneCommand, type PhoneSnapshot } from "../../../src/shared/phone";
import { sha256Hex, secureEqual } from "./protocol";

interface RoomState {
  deviceId: string; inviteHash: string; inviteExpires: number; phoneHash?: string;
  expiresAt: number; confirmed: boolean; revoked: boolean;
}

/** Control metadata is durable. Frames and human input are ephemeral and never logged. */
export class GrokkyCompanion extends DurableObject<Env> {
  private latest?: PhoneSnapshot;
  private heartbeat = 0;
  private pending?: PhoneCommand;
  private deliveredAt = 0;
  private receipts = new Map<string, { ok: boolean; detail: string }>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    });
  }
  private state(): RoomState {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM room WHERE id=1").toArray()[0];
    if (!row) throw new Error("Phone session unavailable");
    const state = JSON.parse(row.value) as RoomState;
    if (state.revoked || state.expiresAt <= Date.now()) throw new Error("Phone session expired; pair again from Grokky");
    return state;
  }
  private save(state: RoomState): void { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO room VALUES (1, ?)", JSON.stringify(state)); }
  async initialize(deviceId: string, inviteHash: string): Promise<number> {
    if (this.ctx.storage.sql.exec("SELECT id FROM room").toArray().length) throw new Error("Session already initialized");
    const expiresAt = Date.now() + 30 * 60_000;
    this.save({ deviceId, inviteHash, inviteExpires: Date.now() + 120_000, expiresAt, confirmed: false, revoked: false });
    await this.ctx.storage.setAlarm(expiresAt);
    return expiresAt;
  }
  async alarm(): Promise<void> { this.latest = undefined; this.pending = undefined; this.receipts.clear(); await this.ctx.storage.deleteAll(); }
  async claim(invite: string): Promise<{ token: string; expiresAt: number }> {
    const digest = await sha256Hex(invite);
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const phoneHash = await sha256Hex(token);
    const state = this.state();
    if (state.phoneHash || state.inviteExpires <= Date.now() || !await secureEqual(digest, state.inviteHash)) throw new Error("Pairing link expired or already used");
    if (this.state().phoneHash) throw new Error("Pairing link already used");
    state.phoneHash = phoneHash; state.inviteHash = ""; this.save(state);
    return { token, expiresAt: state.expiresAt };
  }
  private async phone(token: string): Promise<RoomState> {
    const hash = await sha256Hex(token);
    const state = this.state();
    if (!state.phoneHash || !await secureEqual(hash, state.phoneHash)) throw new Error("Phone authorization failed");
    return this.state();
  }
  async desktop(deviceId: string, body: { snapshot?: PhoneSnapshot; confirm?: boolean; revoke?: boolean; ack?: { id: string; ok: boolean; detail: string } }): Promise<unknown> {
    const state = this.state();
    if (state.deviceId !== deviceId) throw new Error("Desktop authorization failed");
    if (body.revoke) { state.revoked = true; this.save(state); this.pending = undefined; this.latest = undefined; return { ok: true }; }
    if (body.confirm && state.phoneHash) { state.confirmed = true; this.save(state); }
    if (body.snapshot) {
      // Only the authenticated desktop creates these snapshots; never expose raw desktop state.
      this.latest = { ...body.snapshot, frame: body.snapshot.frame ?? this.latest?.frame, confirmed: state.confirmed, expiresAt: state.expiresAt };
    }
    this.heartbeat = Date.now();
    if (body.ack && this.pending?.id === body.ack.id) {
      this.receipts.set(body.ack.id, { ok: body.ack.ok, detail: body.ack.detail.slice(0, 300) });
      this.ctx.storage.sql.exec("UPDATE commands SET status='finished' WHERE id=?", body.ack.id);
      this.pending = undefined;
      if (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
    }
    if (this.pending && Date.now() - this.deliveredAt > 60_000) {
      this.receipts.set(this.pending.id, { ok: false, detail: "Command outcome is unknown. Refresh the browser before another action." });
      this.pending = undefined;
    }
    return { claimed: Boolean(state.phoneHash), confirmed: state.confirmed, command: this.pending, needsFrame: !this.latest?.frame };
  }
  async poll(token: string, receiptId?: string, frameId?: string): Promise<unknown> {
    const state = await this.phone(token);
    const online = this.heartbeat > Date.now() - 15_000;
    const snapshot = this.latest && { ...this.latest, ...(frameId === this.latest.frame?.id ? { frame: undefined } : {}) };
    return { online, confirmed: state.confirmed, snapshot: state.confirmed && online ? snapshot : undefined, receipt: receiptId ? this.receipts.get(receiptId) : undefined };
  }
  async command(token: string, raw: unknown): Promise<unknown> {
    const state = await this.phone(token);
    if (!state.confirmed || this.heartbeat <= Date.now() - 15_000 || !this.latest) throw new Error("Desktop is offline or pairing is not confirmed");
    const command = parsePhoneCommand(raw);
    const prior = this.ctx.storage.sql.exec<{ status: string }>("SELECT status FROM commands WHERE id=?", command.id).toArray()[0];
    if (prior) return { accepted: true, duplicate: true, receipt: this.receipts.get(command.id) ?? { ok: false, detail: "Command was already received; it will not be replayed." } };
    if (this.pending) throw new Error("Wait for the current action to finish");
    if (command.epoch !== this.latest.epoch) throw new Error("Browser control changed; refresh your phone");
    if (["tap", "type", "key", "scroll", "refresh", "resume"].includes(command.kind) && this.latest.owner !== "human") throw new Error("Take control before sending browser input");
    if (command.frameId && command.frameId !== this.latest.frame?.id) throw new Error("Browser changed; refresh before interacting");
    this.ctx.storage.sql.exec("INSERT INTO commands VALUES (?, 'accepted')", command.id);
    this.pending = command; this.deliveredAt = Date.now();
    return { accepted: true };
  }
}
