import { AwsError, AwsJsonClient, AwsNotSentError, AwsUnknownError, throttled, type AwsCallOptions, type CredentialSource, type WireTransport } from "./aws.js";
import { record } from "./model-gateway-token.js";

/** DynamoDB's wire format (AttributeValue) and the few calls the gateway makes. Plain values: string, safe integer, boolean, Uint8Array, arrays, objects. */
export type Plain = string | number | boolean | null | Uint8Array | Plain[] | { [key: string]: Plain };
export type Item = Record<string, Plain>;
type Wire = Record<string, unknown>;

export function marshal(value: Plain): Wire {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "boolean") return { BOOL: value };
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw new Error("unsupported number"); return { N: String(value) }; }
  if (value instanceof Uint8Array) return { B: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return { L: value.map(marshal) };
  return { M: marshalItem(value) };
}
export function marshalItem(item: Readonly<Record<string, Plain>>): Record<string, Wire> {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, marshal(value)]));
}
export function unmarshal(value: unknown): Plain {
  const v = record(value); if (v === undefined) throw new Error("unreadable item");
  const [type, inner] = Object.entries(v)[0] ?? [];
  if (Object.keys(v).length !== 1) throw new Error("unreadable item");
  switch (type) {
    case "S": if (typeof inner === "string") return inner; break;
    case "N": { const n = typeof inner === "string" && /^-?\d{1,16}$/u.test(inner) ? Number(inner) : NaN; if (Number.isSafeInteger(n)) return n; break; }
    case "BOOL": if (typeof inner === "boolean") return inner; break;
    case "NULL": return null;
    case "B": if (typeof inner === "string") return new Uint8Array(Buffer.from(inner, "base64")); break;
    case "L": if (Array.isArray(inner)) return inner.map(unmarshal); break;
    case "M": { const m = record(inner); if (m !== undefined) return unmarshalItem(m); break; }
    default: break;
  }
  throw new Error("unreadable item");
}
export function unmarshalItem(value: unknown): Item {
  const v = record(value); if (v === undefined) throw new Error("unreadable item");
  return Object.fromEntries(Object.entries(v).map(([key, inner]) => [key, unmarshal(inner)]));
}

/** Builds one expression's attribute names and values, so none is unused (DynamoDB refuses unused ones). */
export class Expr {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, Plain> = {};
  #n = 0; #v = 0;
  name(attribute: string): string {
    const existing = Object.entries(this.names).find(([, value]) => value === attribute)?.[0];
    if (existing !== undefined) return existing;
    const key = `#n${String(this.#n++)}`; this.names[key] = attribute; return key;
  }
  value(value: Plain): string { const key = `:v${String(this.#v++)}`; this.values[key] = value; return key; }
  /** The ExpressionAttributeNames/Values members, omitted when empty. */
  wire(): { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, Wire> } {
    return { ...(Object.keys(this.names).length === 0 ? {} : { ExpressionAttributeNames: { ...this.names } }), ...(Object.keys(this.values).length === 0 ? {} : { ExpressionAttributeValues: marshalItem(this.values) }) };
  }
}

export interface Key { pk: string; sk: string }
export interface TransactPut { kind: "Put"; table: string; item: Item; condition?: (e: Expr) => string }
export interface TransactUpdate { kind: "Update"; table: string; key: Key; update: (e: Expr) => string; condition?: (e: Expr) => string }
/** Writes nothing: fences the transaction on another item (DynamoDB ConditionCheck; IAM dynamodb:ConditionCheckItem). */
export interface TransactCheck { kind: "Check"; table: string; key: Key; condition: (e: Expr) => string }
export type TransactAction = TransactPut | TransactUpdate | TransactCheck;

/** Why a transaction did not apply. "condition": item i's condition failed (reasons by index); "retry": a conflict or throttle. */
export class TransactionRefused extends Error {
  constructor(readonly reasons: readonly string[]) { super("transaction refused"); this.name = "TransactionRefused"; }
  conditionFailed(index: number): boolean { return this.reasons[index] === "ConditionalCheckFailed"; }
}

export interface DynamoOptions { region: string; credentials: CredentialSource; transport?: WireTransport; endpoint?: string; now?: () => number }

/** DynamoDB calls with consistent reads by default, bounded reads retried twice on throttling, writes never retried here. */
export class Dynamo {
  readonly #client: AwsJsonClient;
  constructor(options: DynamoOptions) {
    this.#client = new AwsJsonClient({ region: options.region, service: "dynamodb", targetPrefix: "DynamoDB_20120810", contentType: "application/x-amz-json-1.0", credentials: options.credentials, ...(options.transport === undefined ? {} : { transport: options.transport }), ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }), ...(options.now === undefined ? {} : { now: options.now }) });
  }
  async #read(operation: string, input: unknown, options: AwsCallOptions): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.#client.call(operation, input, options); }
      catch (error) {
        const retry = attempt < 2 && !options.signal?.aborted && (throttled(error) || error instanceof AwsUnknownError);
        if (!retry) throw error;
      }
    }
  }
  async get(table: string, key: Key, options: AwsCallOptions & { consistent?: boolean } = {}): Promise<Item | undefined> {
    const answer = await this.#read("GetItem", { TableName: table, Key: marshalItem({ ...key }), ConsistentRead: options.consistent ?? true }, options);
    return answer.Item === undefined ? undefined : unmarshalItem(answer.Item);
  }
  async query(table: string, input: { index?: string; key: (e: Expr) => string; limit: number; consistent?: boolean; descending?: boolean }, options: AwsCallOptions = {}): Promise<Item[]> {
    const e = new Expr(); const condition = input.key(e);
    const answer = await this.#read("Query", { TableName: table, ...(input.index === undefined ? {} : { IndexName: input.index }), KeyConditionExpression: condition, ...e.wire(), Limit: input.limit, ScanIndexForward: input.descending !== true, ...(input.index === undefined ? { ConsistentRead: input.consistent ?? true } : {}) }, options);
    if (!Array.isArray(answer.Items)) throw new AwsUnknownError();
    return answer.Items.map(unmarshalItem);
  }
  /** One conditional put. Returns false when its condition failed; throws on anything else. */
  async put(table: string, item: Item, condition?: (e: Expr) => string, options: AwsCallOptions = {}): Promise<boolean> {
    const e = new Expr(); const expression = condition?.(e);
    try { await this.#client.call("PutItem", { TableName: table, Item: marshalItem(item), ...(expression === undefined ? {} : { ConditionExpression: expression }), ...e.wire() }, options); return true; }
    catch (error) { if (error instanceof AwsError && error.code === "ConditionalCheckFailedException") return false; throw error; }
  }
  async update(table: string, key: Key, update: (e: Expr) => string, condition?: (e: Expr) => string, options: AwsCallOptions = {}): Promise<boolean> {
    const e = new Expr(); const expression = update(e); const guard = condition?.(e);
    try { await this.#client.call("UpdateItem", { TableName: table, Key: marshalItem({ ...key }), UpdateExpression: expression, ...(guard === undefined ? {} : { ConditionExpression: guard }), ...e.wire() }, options); return true; }
    catch (error) { if (error instanceof AwsError && error.code === "ConditionalCheckFailedException") return false; throw error; }
  }
  /** Markers table only (the role allows DeleteItem nowhere else). */
  async delete(table: string, key: Key, condition: (e: Expr) => string, options: AwsCallOptions = {}): Promise<boolean> {
    const e = new Expr(); const guard = condition(e);
    try { await this.#client.call("DeleteItem", { TableName: table, Key: marshalItem({ ...key }), ConditionExpression: guard, ...e.wire() }, options); return true; }
    catch (error) { if (error instanceof AwsError && error.code === "ConditionalCheckFailedException") return false; throw error; }
  }
  /**
   * All or nothing. `token` makes a retry of the same request idempotent for ten minutes (DynamoDB ClientRequestToken): an
   * unknown outcome is retried once with the same token, so a write that did apply is not applied twice.
   * Throws TransactionRefused (nothing applied), AwsUnknownError (still unknown) or AwsNotSentError.
   */
  async transact(actions: readonly TransactAction[], token: string, options: AwsCallOptions = {}): Promise<void> {
    if (actions.length === 0 || actions.length > 100 || !/^[A-Za-z0-9-]{1,36}$/u.test(token)) throw new AwsNotSentError();
    const items = actions.map((action) => {
      const e = new Expr();
      if (action.kind === "Put") {
        const condition = action.condition?.(e);
        return { Put: { TableName: action.table, Item: marshalItem(action.item), ...(condition === undefined ? {} : { ConditionExpression: condition }), ...e.wire() } };
      }
      if (action.kind === "Check") {
        const condition = action.condition(e);
        return { ConditionCheck: { TableName: action.table, Key: marshalItem({ ...action.key }), ConditionExpression: condition, ...e.wire() } };
      }
      const update = action.update(e); const condition = action.condition?.(e);
      return { Update: { TableName: action.table, Key: marshalItem({ ...action.key }), UpdateExpression: update, ...(condition === undefined ? {} : { ConditionExpression: condition }), ...e.wire() } };
    });
    const input = { TransactItems: items, ClientRequestToken: token };
    for (let attempt = 0; ; attempt++) {
      try { await this.#client.call("TransactWriteItems", input, options); return; }
      catch (error) {
        if (error instanceof AwsError) {
          if (error.code === "TransactionCanceledException") throw new TransactionRefused(error.reasons);
          // The same token's first request is still running: its outcome is not known yet.
          if (error.code === "TransactionInProgressException") throw new AwsUnknownError();
          // After an unknown first attempt, a refusal of the retry does not say the first one did not apply.
          if (attempt > 0) throw new AwsUnknownError();
          // Any other answered error (throttle, validation, token mismatch) applied nothing.
          throw new TransactionRefused([]);
        }
        if (error instanceof AwsUnknownError && attempt === 0 && !options.signal?.aborted) continue;
        throw error;
      }
    }
  }
}
