import { Schema } from "effect";
import { RunControlOutcome } from "../../../../packages/protocol/src/runs.js";
import type { MachineContext } from "../context.js";
import type { RunReceiptRow } from "../db.js";
import { CloudError } from "../errors.js";

export class Receipts {
  constructor(
    private readonly c: MachineContext,
    private readonly bindingId: string,
    private readonly key: string,
    private readonly requestHash: string,
  ) {}

  async lookup() {
    const receipt = await this.c.env.DB.prepare(
      "SELECT * FROM runCommandReceipts WHERE machineId = ? AND key = ?",
    )
      .bind(this.c.machine.id, this.key)
      .first<RunReceiptRow>();
    if (
      receipt &&
      (receipt.bindingId !== this.bindingId || receipt.requestHash !== this.requestHash)
    )
      throw new CloudError("idempotency_conflict", 409);
    return receipt;
  }

  outcome(receipt: RunReceiptRow) {
    return receipt.outcomeJson === null
      ? undefined
      : Schema.decodeUnknownSync(RunControlOutcome)(JSON.parse(receipt.outcomeJson));
  }

  async claim() {
    const now = Date.now();
    const result = await this.c.env.DB.prepare(`INSERT INTO runCommandReceipts
      (machineId, key, bindingId, requestHash, state, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'submitted', ?, ?) ON CONFLICT (machineId, key) DO NOTHING`)
      .bind(this.c.machine.id, this.key, this.bindingId, this.requestHash, now, now)
      .run();
    const receipt = await this.lookup();
    if (!receipt) throw new Error("Run command receipt persistence failed.");
    return { fresh: result.meta.changes === 1, receipt };
  }

  async finish(outcome: RunControlOutcome) {
    const result = await this.c.env.DB.prepare(`UPDATE runCommandReceipts
      SET state = ?, outcomeJson = ?, updatedAt = ?
      WHERE machineId = ? AND key = ? AND bindingId = ? AND requestHash = ? AND state = 'submitted'`)
      .bind(
        outcome.state,
        JSON.stringify(outcome),
        Date.now(),
        this.c.machine.id,
        this.key,
        this.bindingId,
        this.requestHash,
      )
      .run();
    if (!result.meta.changes) throw new Error("Run command receipt completion failed.");
  }
}
