import type { PhoneCommand, PhoneDesktopStatus, PhoneSnapshot } from "../shared/phone";

interface Exchange {
  claimed: boolean; confirmed: boolean; command?: PhoneCommand; needsFrame?: boolean;
}
export class PhoneBridge {
  status: PhoneDesktopStatus;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private executing = false;
  private closed = false;
  private seen = new Set<string>();
  private ack?: { id: string; ok: boolean; detail: string };
  private lastFrame?: string;
  private lastHumanRefresh = Date.now();
  private confirmRequested = false;
  constructor(
    readonly roomId: string,
    status: PhoneDesktopStatus,
    private readonly request: <T>(path: string, body: Record<string, unknown>) => Promise<T>,
    private readonly snapshot: () => PhoneSnapshot,
    private readonly execute: (command: PhoneCommand) => Promise<void>,
    private readonly changed: () => void,
    private readonly expired: () => Promise<void>,
  ) { this.status = status; }
  start(): void { this.timer = setInterval(() => void this.tick(), 1_500); this.timer.unref(); void this.tick(); }
  confirm(): void { this.confirmRequested = true; void this.tick(); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; if (this.timer) clearInterval(this.timer);
    await this.request(`/companion/desktop/${this.roomId}`, { revoke: true }).catch(() => undefined);
  }
  private async tick(): Promise<void> {
    if (this.closed || this.polling) return;
    if (Date.now() >= this.status.expiresAt) { await this.close(); await this.expired(); return; }
    this.polling = true;
    try {
      const snapshot = this.snapshot();
      this.status.owner = snapshot.owner;
      const frame = snapshot.frame;
      if (frame?.id === this.lastFrame) delete snapshot.frame;
      const ack = this.ack;
      const response = await this.request<Exchange>(`/companion/desktop/${this.roomId}`, { snapshot, confirm: this.confirmRequested, ...(ack ? { ack } : {}) });
      if (this.closed) return;
      this.lastFrame = response.needsFrame ? undefined : frame?.id;
      if (ack === this.ack) this.ack = undefined;
      this.status.claimed = response.claimed; this.status.confirmed = response.confirmed;
      if (response.claimed) delete this.status.inviteUrl;
      if (response.confirmed) this.confirmRequested = false;
      delete this.status.error;
      // Keep the retained tab alive and refresh delayed page changes during human control.
      // This frame stays in the companion channel, outside the model transcript.
      const command = response.command ?? (snapshot.owner === "human" && Date.now() - this.lastHumanRefresh > 60_000
        ? { id: `refresh-${crypto.randomUUID()}`, epoch: snapshot.epoch, kind: "refresh" as const } : undefined);
      if (command && !this.executing && !this.seen.has(command.id)) {
        this.seen.add(command.id); this.executing = true; this.lastHumanRefresh = Date.now();
        void this.execute(command).then(
          () => { this.ack = { id: command.id, ok: true, detail: "Done" }; },
          (error) => { this.ack = { id: command.id, ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : "Phone action failed" }; },
        ).finally(() => { this.executing = false; this.changed(); });
      }
    } catch {
      this.status.error = "Phone relay is unavailable. Human control stays paused until you reconnect or stop.";
    } finally { this.polling = false; this.changed(); }
  }
}
