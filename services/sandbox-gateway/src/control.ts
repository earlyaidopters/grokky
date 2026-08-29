import { DurableObject } from "cloudflare:workers";

export class GrokkyControl extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          epoch INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS enrollments (
          secret_digest TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          used_at INTEGER NOT NULL
        );
      `);
    });
  }

  async enroll(secretDigest: string, now: number): Promise<{ ok: true; deviceId: string; epoch: number } | { ok: false }> {
    const prior = this.ctx.storage.sql.exec<{ device_id: string }>(
      "SELECT device_id FROM enrollments WHERE secret_digest = ?",
      secretDigest,
    ).toArray()[0];
    if (prior) return { ok: false };
    const random = crypto.randomUUID().replaceAll("-", "");
    const deviceId = `sandbox-${random}`;
    this.ctx.storage.sql.exec("INSERT INTO devices (device_id, epoch, created_at) VALUES (?, 1, ?)", deviceId, now);
    this.ctx.storage.sql.exec("INSERT INTO enrollments (secret_digest, device_id, used_at) VALUES (?, ?, ?)", secretDigest, deviceId, now);
    return { ok: true, deviceId, epoch: 1 };
  }

  async currentEpoch(deviceId: string): Promise<number | null> {
    const row = this.ctx.storage.sql.exec<{ epoch: number; revoked_at: number | null }>(
      "SELECT epoch, revoked_at FROM devices WHERE device_id = ?",
      deviceId,
    ).toArray()[0];
    return row && row.revoked_at === null ? row.epoch : null;
  }

  async initDevice(deviceId: string, now: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO devices (device_id, epoch, created_at) VALUES (?, 1, ?)",
      deviceId,
      now,
    );
  }

  async revoke(deviceId: string, expectedEpoch: number, now: number): Promise<number | null> {
    const row = this.ctx.storage.sql.exec<{ epoch: number; revoked_at: number | null }>(
      "SELECT epoch, revoked_at FROM devices WHERE device_id = ?",
      deviceId,
    ).toArray()[0];
    if (!row || row.revoked_at !== null || row.epoch !== expectedEpoch) return null;
    const nextEpoch = row.epoch + 1;
    this.ctx.storage.sql.exec("UPDATE devices SET epoch = ?, revoked_at = ? WHERE device_id = ?", nextEpoch, now, deviceId);
    return nextEpoch;
  }
}
