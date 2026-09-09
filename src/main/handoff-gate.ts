import type { PhoneOwner } from "../shared/phone";

/** One writer per run. Pausing blocks new actions before waiting for current actions. */
export class HandoffGate {
  owner: PhoneOwner = "agent";
  epoch = 0;
  note = "";
  private active = 0;
  private changed = new Set<() => void>();

  private wake(): void { for (const wake of this.changed) wake(); this.changed.clear(); }
  private wait(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { this.changed.delete(done); signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => { this.changed.delete(done); reject(new Error("Run cancelled")); };
      if (signal?.aborted) return abort();
      this.changed.add(done); signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async checkpoint(signal?: AbortSignal): Promise<{ epoch: number; note: string }> {
    while (this.owner === "pausing" || this.owner === "human") await this.wait(signal);
    if (this.owner === "stopped" || signal?.aborted) throw new Error("Run cancelled");
    return { epoch: this.epoch, note: this.note };
  }
  async agentAction<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // Never wait and then execute a pre-handoff action against the human's changed page.
    if (this.owner !== "agent" || signal?.aborted) throw new Error("Browser control changed; re-inspect before choosing another action");
    this.active += 1;
    try { return await action(); } finally { this.active -= 1; this.wake(); }
  }
  async takeover(): Promise<void> {
    if (this.owner !== "agent") throw new Error("Control is already paused or stopped");
    this.owner = "pausing"; this.epoch += 1; this.wake();
    while (this.active) await this.wait();
    if (this.owner !== "pausing") throw new Error("Handoff was cancelled");
    this.owner = "human"; this.wake();
  }
  async humanAction<T>(action: () => Promise<T>): Promise<T> {
    if (this.owner !== "human") throw new Error("Human control is no longer active");
    this.active += 1;
    try { return await action(); } finally { this.active -= 1; this.wake(); }
  }
  async resume(note: string): Promise<void> {
    if (this.owner !== "human") throw new Error("The phone does not own this browser");
    this.owner = "pausing"; this.epoch += 1;
    while (this.active) await this.wait();
    if (this.owner !== "pausing") throw new Error("Handoff was cancelled");
    this.note = note; this.owner = "agent"; this.epoch += 1; this.wake();
  }
  stop(): void { this.owner = "stopped"; this.epoch += 1; this.wake(); }
}
