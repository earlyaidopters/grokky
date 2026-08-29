import { Sandbox } from "@cloudflare/sandbox";

export interface StoredActionResult {
  output: string;
  argumentDigest: string;
}

export type ActionClaim =
  | { kind: "accepted"; receiptId: string }
  | { kind: "in-flight"; receiptId: string }
  | { kind: "replay"; receiptId: string; result: StoredActionResult };

export class GrokkySandbox extends Sandbox<Env> {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS action_receipts (
          action_id TEXT PRIMARY KEY,
          argument_digest TEXT NOT NULL,
          receipt_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('accepted', 'completed')),
          output TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER
        );
      `);
    });
  }

  async claimAction(actionId: string, argumentDigest: string, now: number): Promise<ActionClaim> {
    const prior = this.ctx.storage.sql.exec<{
      argument_digest: string;
      receipt_id: string;
      status: string;
      output: string | null;
    }>("SELECT argument_digest, receipt_id, status, output FROM action_receipts WHERE action_id = ?", actionId).toArray()[0];
    if (prior) {
      if (prior.argument_digest !== argumentDigest) throw new Error("Action ID was already claimed for different arguments");
      if (prior.status === "completed" && prior.output !== null) {
        return { kind: "replay", receiptId: prior.receipt_id, result: { output: prior.output, argumentDigest } };
      }
      return { kind: "in-flight", receiptId: prior.receipt_id };
    }
    const receiptId = `runner-${crypto.randomUUID().replaceAll("-", "")}`;
    this.ctx.storage.sql.exec(
      "INSERT INTO action_receipts (action_id, argument_digest, receipt_id, status, created_at) VALUES (?, ?, ?, 'accepted', ?)",
      actionId,
      argumentDigest,
      receiptId,
      now,
    );
    this.ctx.storage.sql.exec("DELETE FROM action_receipts WHERE created_at < ?", now - 24 * 60 * 60_000);
    return { kind: "accepted", receiptId };
  }

  async completeAction(actionId: string, argumentDigest: string, output: string, now: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE action_receipts SET status = 'completed', output = ?, completed_at = ? WHERE action_id = ? AND argument_digest = ? AND status = 'accepted'",
      output,
      now,
      actionId,
      argumentDigest,
    );
  }
}
