// DEC 165 on the product route, shared by every gateway task: once a product call settles above its hold, every later product
// call of that task is refused ("budget exceeded by one call"). One item per blocked task in the PRODUCT meter's markers table
// (CO#[iss,cid] / PRODUCT_OVERRUN#<tid>), expiring with the task token's life (a task's product calls cannot outlive its token).
import type { Dynamo } from "./dynamo.js";
import { companyPartition } from "./dynamo-meter.js";
import { COMPANY, TASK, TASK_TOKEN_SECONDS } from "./model-gateway-token.js";
import type { ProductOverrunTasks } from "./product-route.js";

export class DynamoProductOverrunTasks implements ProductOverrunTasks {
  constructor(private readonly db: Dynamo, private readonly table: string, private readonly now: () => number = Date.now) {}
  #key(iss: string, cid: string, tid: string): { pk: string; sk: string } {
    if (typeof cid !== "string" || !COMPANY.test(cid) || typeof tid !== "string" || !TASK.test(tid)) throw new Error("invalid task");
    return { pk: companyPartition(iss, cid), sk: `PRODUCT_OVERRUN#${tid}` };
  }
  /** A failed read throws: the route answers 503 and sends nothing. */
  async isBlocked(iss: string, cid: string, tid: string): Promise<boolean> {
    const item = await this.db.get(this.table, this.#key(iss, cid, tid), { consistent: true });
    return item !== undefined;
  }
  async block(iss: string, cid: string, tid: string): Promise<void> {
    // Twice the token's life: TTL deletion is lazy and a refusal must outlast every call the token could still make.
    const expiresAt = Math.floor(this.now() / 1000) + 2 * TASK_TOKEN_SECONDS;
    await this.db.put(this.table, { ...this.#key(iss, cid, tid), blockedAt: this.now(), expiresAt });
  }
}
