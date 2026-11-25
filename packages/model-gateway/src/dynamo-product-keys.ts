// The DynamoDB adapter behind ProductKeyStore's table port (product-keys.ts ProductKeyTable): one table, all-or-nothing
// transactions with condition checks, key-row reads that answer only the AWSCURRENT stage, and expiry by DynamoDB TTL.
//
//   pk  CO#[iss,cid]                      the store's own company prefix (the IAM LeadingKeys rule: CO# keys only)
//   sk  doc#<owner> | key#<owner>#<source>#<version> | req#<owner>#<request> | audit#<owner>#<revision> |
//       eval#<owner> (eval approval and budget, eval-approvals.ts)
//   v   the row's version (1 on create, +1 per write): the store's revision and every version condition
//   f_<field>  one top-level attribute per field of the store's item, so a merge is a plain top-level SET
//   expiresAt  epoch seconds (the table's TTL attribute): a key row's purgeAfter or a receipt's expiresAt; absent = kept
//
// Nothing here deletes a row: removal and rotation only re-stage a key row and set its purge time; DynamoDB's TTL purges it.
import { randomUUID } from "node:crypto";
import { AwsError } from "./aws.js";
import { GATEWAY_COMPANY_KEY_PREFIX } from "./deploy.js";
import { TransactionRefused, type Dynamo, type Expr, type Item, type Key, type Plain, type TransactAction } from "./dynamo.js";
import { record, whole } from "./model-gateway-token.js";
import { CURRENT_STAGE, isKeyRow, type ProductKeyTable, type StoredRow, type TableWrite } from "./product-keys.js";

/** The table's TTL attribute (infra/lib/model-gateway.ts sets it; the contract test pins the two). */
export const PRODUCT_KEYS_TTL_ATTRIBUTE = "expiresAt";
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const PREFIX = "f_";

/** Splits a store key `CO#[iss,cid]#rest` into the table key. Anything else is refused (never guessed). */
export function productKeyTableKey(key: string): Key {
  if (typeof key !== "string" || !key.startsWith(`${GATEWAY_COMPANY_KEY_PREFIX}[`) || key.length > 2048) throw new Error("invalid product key row");
  // The first `]#` after which the JSON parses as [iss, cid] (an issuer may itself hold `]#`).
  for (let at = key.indexOf("]#"); at >= 0; at = key.indexOf("]#", at + 1)) {
    let parsed: unknown;
    try { parsed = JSON.parse(key.slice(GATEWAY_COMPANY_KEY_PREFIX.length, at + 1)); } catch { continue; }
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === "string") && JSON.stringify(parsed) === key.slice(GATEWAY_COMPANY_KEY_PREFIX.length, at + 1)) {
      const sk = key.slice(at + 2);
      if (sk.length === 0) break;
      return { pk: key.slice(0, at + 1), sk };
    }
  }
  throw new Error("invalid product key row");
}

function fields(item: Readonly<Record<string, unknown>>): Array<[string, Plain]> {
  return Object.entries(item).map(([name, value]) => {
    if (!FIELD.test(name) || value === undefined) throw new Error("invalid product key row");
    return [name, value as Plain];
  });
}
/** The TTL a row carries: a key row's purgeAfter or a receipt's expiresAt, in epoch seconds. */
function expiryOf(item: Readonly<Record<string, unknown>>): number | null | undefined {
  const value = item.purgeAfter !== undefined ? item.purgeAfter : item.expiresAt;
  if (value === undefined) return undefined;
  if (value === null) return null;
  return whole(value) ? value : undefined;
}

export class DynamoProductKeyTable implements ProductKeyTable {
  constructor(private readonly db: Dynamo, private readonly table: string) {}

  async get(key: string, read?: { stage: typeof CURRENT_STAGE }): Promise<StoredRow | undefined> {
    const keyRow = isKeyRow(key);
    // F1-d L3: a sealed-key row is read only naming the current stage; any other read of one is refused before DynamoDB.
    if (keyRow && read?.stage !== CURRENT_STAGE) throw new Error("AccessDenied: a key read must name the AWSCURRENT stage");
    const stored = await this.db.get(this.table, productKeyTableKey(key), { consistent: true });
    if (stored === undefined) return undefined;
    if (!whole(stored.v) || stored.v < 1) throw new Error("unreadable product key row");
    const item: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(stored)) if (name.startsWith(PREFIX)) item[name.slice(PREFIX.length)] = value;
    // A key row at any other stage (AWSPREVIOUS, scheduled_deletion) is not there for a reader.
    if (keyRow && item.stage !== CURRENT_STAGE) return undefined;
    return { version: stored.v, item };
  }

  async transact(writes: readonly TableWrite[]): Promise<boolean> {
    if (writes.length === 0 || writes.length > 100) throw new Error("invalid product key transaction");
    if (new Set(writes.map((w) => w.key)).size !== writes.length) return false;
    const actions = writes.map((write) => this.#action(write));
    try { await this.db.transact(actions, randomUUID()); return true; }
    catch (error) {
      // A condition failed (or a conflict): nothing applied, the store answers stale.
      if (error instanceof TransactionRefused && error.reasons.some((reason) => reason === "ConditionalCheckFailed" || reason === "TransactionConflict")) return false;
      if (error instanceof AwsError && error.code === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  #action(write: TableWrite): TransactAction {
    const key = productKeyTableKey(write.key);
    if ("check" in write) {
      const version = write.check.version;
      if (!whole(version)) throw new Error("invalid product key transaction");
      return { kind: "Check", table: this.table, key, condition: (e) => version === 0 ? `attribute_not_exists(${e.name("pk")})` : `${e.name("v")} = ${e.value(version)}` };
    }
    if ("put" in write) {
      const c = write.condition;
      if (record(c) === undefined || "exists" in c) throw new Error("invalid product key transaction");
      const next = "absent" in c ? 1 : c.version + 1;
      if (!whole(next) || next < 1) throw new Error("invalid product key transaction");
      const expiry = expiryOf(write.put);
      const item: Item = { ...key, v: next, ...Object.fromEntries(fields(write.put).map(([name, value]) => [`${PREFIX}${name}`, value])), ...(typeof expiry === "number" ? { [PRODUCT_KEYS_TTL_ATTRIBUTE]: expiry } : {}) };
      const condition = (e: Expr) => ("absent" in c || c.version === 0) ? `attribute_not_exists(${e.name("pk")})` : `${e.name("v")} = ${e.value(c.version)}`;
      return { kind: "Put", table: this.table, item, condition };
    }
    // A merge: top-level SETs of the named fields on an existing row, its version +1; the TTL follows purgeAfter.
    const merged = fields(write.merge);
    if (merged.length === 0) throw new Error("invalid product key transaction");
    const expiry = expiryOf(write.merge);
    return {
      kind: "Update", table: this.table, key,
      update: (e) => {
        const sets = [...merged.map(([name, value]) => `${e.name(`${PREFIX}${name}`)} = ${e.value(value)}`), `${e.name("v")} = ${e.name("v")} + ${e.value(1)}`];
        if (typeof expiry === "number") sets.push(`${e.name(PRODUCT_KEYS_TTL_ATTRIBUTE)} = ${e.value(expiry)}`);
        return `SET ${sets.join(", ")}${expiry === null ? ` REMOVE ${e.name(PRODUCT_KEYS_TTL_ATTRIBUTE)}` : ""}`;
      },
      condition: (e) => `attribute_exists(${e.name("pk")})`,
    };
  }
}
