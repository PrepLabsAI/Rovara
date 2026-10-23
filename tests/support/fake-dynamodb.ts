// In-memory DynamoDB document client for broker tests. It evaluates the condition and update
// expressions the broker uses, and applies transactions all-or-nothing, as DynamoDB does.

import { expect } from "vitest";
import { assertDynamoExpressionAttributes, assertNoReservedWords } from "./validating-document-client.js";

export { assertNoReservedWords };

type Item = Record<string, unknown>;
type Names = Record<string, string>;
type Values = Record<string, unknown>;

interface Command {
  constructor: { name: string };
  input: Record<string, unknown>;
}

interface WriteAction {
  kind: "Put" | "Update" | "Delete" | "ConditionCheck";
  key: string;
  apply: (current: Item | undefined) => Item | undefined;
  condition?: string | undefined;
  names?: Names | undefined;
  values?: Values | undefined;
}

/** DynamoDB's item size limit: 400 KB, where a KB is 1,024 bytes. */
export const DYNAMODB_ITEM_MAX_BYTES = 409_600;

interface InjectedFault {
  command?: string | undefined;
  match?: ((input: Record<string, unknown>) => boolean) | undefined;
  error: { name: string; message?: string | undefined; cancellationReasons?: Array<{ Code: string }> | undefined };
  remaining: number;
}

/**
 * How close to the real service a FakeDynamoDb is. Every realism is on by default; turning one off needs
 * `{ realism: { <name>: false } }` and a comment at the call site saying why.
 */
export interface FakeDynamoDbOptions {
  realism?: {
    /** Reads and stream images hand back a map's attributes in DynamoDB's own order, not the write order (default true). */
    mapOrder?: boolean;
    /** Refuse unused, undefined or missing ExpressionAttributeValues/Names, and empty maps, as DynamoDB does (default true). */
    validateExpressions?: boolean;
  };
  /**
   * "eventual": a GetCommand without `ConsistentRead: true` sees an item's previous version once after each write to it,
   * as an eventually consistent read may. Default "strong".
   */
  consistency?: "strong" | "eventual";
  /** Seeds the map order; two tables with different seeds order the same key set differently. Default: from the test's name. */
  seed?: number;
}

/** The map order seed outside a test: fixed, so a failure reproduces run to run. */
const DEFAULT_MAP_ORDER_SEED = 0x5eed;

/**
 * The map order seed for a table made in a test: a hash of the test's name, so different tests see different orders and
 * a failure reproduces when that test is run again.
 */
function testSeed(): number {
  let name: string | undefined;
  try {
    name = expect.getState().currentTestName;
  } catch {
    name = undefined;
  }
  return name === undefined ? DEFAULT_MAP_ORDER_SEED : keyRank(name, DEFAULT_MAP_ORDER_SEED);
}

let assumedDrivingTests = false;
/**
 * For a test file about something other than the driving-test gate (setup approval, dispatch, the budget): every route digest is read as having passed its driving test
 * (Task 4.10C), so those tests keep their own subject. A test of the gate itself must not call this. Module state, so it holds for the whole test file only.
 */
export function assumeDrivingTestsPassed(on = true): void { assumedDrivingTests = on; }

export class FakeDynamoDb {
  readonly items = new Map<string, Item>();
  /**
   * Reads (and, through `reorder`, stream images) hand back each map's attributes in an order of the table's own,
   * which depends only on the map's key set, as DynamoDB does (it does not keep a map's attribute order). On by default.
   */
  private readonly dynamoMapOrder: boolean;
  private readonly validateExpressions: boolean;
  private readonly eventual: boolean;
  private readonly seed: number;
  /** For eventual consistency: each written item's previous version (undefined: it did not exist), read once. */
  private readonly staleOnce = new Map<string, Item | undefined>();

  constructor(options: FakeDynamoDbOptions = {}) {
    this.dynamoMapOrder = options.realism?.mapOrder ?? true;
    this.validateExpressions = options.realism?.validateExpressions ?? true;
    this.eventual = options.consistency === "eventual";
    this.seed = options.seed ?? testSeed();
  }

  /** `value` with every map's attributes in this table's order (unchanged when map reordering is off). */
  reorder<T>(value: T): T {
    return this.dynamoMapOrder ? reorderMaps(value, this.seed) as T : value;
  }

  /** A read's copy of an item. */
  private readClone<T>(value: T): T {
    const read = this.reorder(structuredClone(value));
    const item = value as { pk?: unknown; sk?: unknown } | undefined;
    if (item !== null && typeof item === "object" && typeof item.pk === "string" && typeof item.sk === "string") {
      const kind = `${item.pk.split("#")[0]}#${item.sk.split("#")[0]}`;
      const counted = this.readOrders.get(kind) ?? { reads: 0, reordered: 0 };
      counted.reads += 1;
      if (JSON.stringify(read) !== JSON.stringify(value)) counted.reordered += 1;
      this.readOrders.set(kind, counted);
    }
    return read;
  }
  /**
   * Item reads by kind (`DEVTASK#META`: the pk's and sk's first segments): how many, and how many came back with some
   * map in an order other than the one it was written in.
   */
  readonly readOrders = new Map<string, { reads: number; reordered: number }>();
  private readonly listeners = new Set<(change: { before?: Item; after?: Item }) => void>();
  /** Every request the table refused as DynamoDB would (ValidationException), in order: a correct product causes none. */
  readonly refusals: Array<{ command: string; message: string }> = [];
  /** Constructor names of every command sent, in order (spec 025 A3: no route scans). */
  private readonly sent: string[] = [];

  private readonly faults: InjectedFault[] = [];

  /** Fails the next `times` (default 1) matching commands with the named AWS error, before they touch any item. */
  injectFault(fault: { command?: string; match?: (input: Record<string, unknown>) => boolean; error: { name: string; message?: string; cancellationReasons?: Array<{ Code: string }> }; times?: number }): void {
    this.faults.push({ command: fault.command, match: fault.match, error: fault.error, remaining: fault.times ?? 1 });
  }

  commandNames(): string[] {
    return [...this.sent];
  }

  /** Removes one item without a stream record, as seeding does. */
  delete(pk: string, sk: string): void {
    this.items.delete(itemKey(pk, sk));
  }

  /** Each committed write's item before and after, as a DynamoDB stream record carries them. `set` (seeding) is not reported. */
  onWrite(listener: (change: { before?: Item; after?: Item }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(pk: string, sk: string): Item | undefined {
    return this.items.get(itemKey(pk, sk));
  }

  set(item: Item): void {
    this.items.set(itemKey(item.pk as string, item.sk as string), item);
  }

  find(predicate: (item: Item) => boolean): Item[] {
    return [...this.items.values()].filter(predicate);
  }

  send = async (command: Command): Promise<unknown> => {
    this.sent.push(command.constructor.name);
    // DynamoDB checks a request's expression attributes before it does anything else, each transaction entry on its own.
    try {
      if (this.validateExpressions) {
        if (command.constructor.name === "TransactWriteCommand") {
          for (const entry of (command.input.TransactItems ?? []) as Array<Record<string, Record<string, unknown>>>) {
            assertDynamoExpressionAttributes(Object.values(entry)[0] ?? {});
          }
        } else {
          assertDynamoExpressionAttributes(command.input ?? {});
        }
      }
      return await this.execute(command);
    } catch (error) {
      if (error instanceof Error && error.name === "ValidationException" && (error as { injected?: boolean }).injected !== true) this.refusals.push({ command: command.constructor.name, message: error.message });
      throw error;
    }
  };

  private execute = async (command: Command): Promise<unknown> => {
    const fault = this.faults.find((candidate) => candidate.remaining > 0
      && (candidate.command === undefined || candidate.command === command.constructor.name)
      && (candidate.match === undefined || candidate.match(command.input)));
    if (fault !== undefined) {
      fault.remaining -= 1;
      throw Object.assign(new Error(fault.error.message ?? fault.error.name), { name: fault.error.name, $metadata: {}, injected: true, ...(fault.error.cancellationReasons === undefined ? {} : { CancellationReasons: fault.error.cancellationReasons }) });
    }
    await Promise.resolve();
    const input = command.input;
    switch (command.constructor.name) {
      case "GetCommand": {
        const key = input.Key as { pk: string; sk: string };
        const stored = itemKey(key.pk, key.sk);
        let item = this.get(key.pk, key.sk);
        if (this.eventual && input.ConsistentRead !== true && this.staleOnce.has(stored)) {
          item = this.staleOnce.get(stored);
          this.staleOnce.delete(stored);
        }
        if (item === undefined && assumedDrivingTests && key.pk === "E2E_MODEL_ROUTES" && key.sk.startsWith("E2E_MODEL_ROUTE_CANARY#")) {
          const [, routeId, definitionDigest] = key.sk.split("#");
          item = { ...key, entityType: "E2E_MODEL_ROUTE_CANARY", test: "driving/v1", routeId, definitionDigest, recordedAt: "2026-10-23T10:00:00.000Z" };
        }
        return { Item: item === undefined ? undefined : this.readClone(item) };
      }
      case "QueryCommand":
        return this.queryPage(input);
      case "PutCommand":
      case "UpdateCommand":
      case "DeleteCommand":
        this.commit([toAction(command.constructor.name.replace("Command", "") as WriteAction["kind"], input)], "ConditionalCheckFailedException");
        return {};
      case "TransactWriteCommand": {
        const entries = input.TransactItems as Array<Record<string, Record<string, unknown>>>;
        // DynamoDB refuses a transaction that names one item twice, before any condition is evaluated.
        const named = entries.map((entry) => {
          const action = Object.values(entry)[0] as Record<string, unknown>;
          const key = (action.Key ?? action.Item) as { pk?: unknown; sk?: unknown };
          return JSON.stringify([action.TableName, key.pk, key.sk]);
        });
        if (new Set(named).size !== named.length) {
          throw Object.assign(new Error("Transaction request cannot include multiple operations on one item"), { name: "ValidationException", $metadata: {} });
        }
        this.commit(entries.map((entry) => {
          const [kind, action] = Object.entries(entry)[0] as [WriteAction["kind"], Record<string, unknown>];
          return toAction(kind, action);
        }), "TransactionCanceledException");
        return {};
      }
      default:
        throw new Error(`FakeDynamoDb does not support ${command.constructor.name}`);
    }
  };

  /**
   * DynamoDB's order of work: the key condition, the start key, then `Limit` items evaluated, then
   * the filter. LastEvaluatedKey is handed out only when `Limit` stopped the read early, keyed by
   * the table's keys plus, for an index, the index's own key attributes.
   */
  private queryPage(input: Record<string, unknown>): { Items: Item[]; LastEvaluatedKey?: Record<string, unknown> } {
    const limit = input.Limit as number | undefined;
    const evaluated = this.query({ ...input, Limit: undefined });
    const page = limit === undefined ? evaluated : evaluated.slice(0, limit);
    const filter = input.FilterExpression as string | undefined;
    const names = (input.ExpressionAttributeNames ?? {}) as Names;
    const values = (input.ExpressionAttributeValues ?? {}) as Values;
    const items = filter === undefined ? page : page.filter((item) => evaluateCondition(filter, item, names, values));
    const last = page.at(-1);
    if (limit === undefined || evaluated.length <= limit || last === undefined) return { Items: items };
    const indexKeys = input.IndexName === undefined ? [] : this.indexAttributes(input);
    return { Items: items, LastEvaluatedKey: Object.fromEntries(["pk", "sk", ...indexKeys].map((name) => [name, last[name]])) };
  }

  /** The key attributes an index query names: the partition attribute, and the sort attribute of a range. */
  private indexAttributes(input: Record<string, unknown>): string[] {
    const names = (input.ExpressionAttributeNames ?? {}) as Names;
    const name = (token: string) => (token.startsWith("#") ? names[token]! : token);
    const ranged = INDEX_RANGE.exec(String(input.KeyConditionExpression));
    if (ranged) return [name(ranged[1]!), name(ranged[3]!)];
    const indexed = INDEX_EQUALS.exec(String(input.KeyConditionExpression));
    return indexed ? [name(indexed[1]!)] : [];
  }

  // Supports `pk = :pk AND begins_with(sk, :<name>)`, the key condition shape the broker uses (a
  // project's latest revision, credential records and a credential's cached tokens), and
  // `pk = :pk AND sk < :<name>`, the stuck-setup sweep's "older than" range (spec 025 C17).
  private query(input: Record<string, unknown>): Item[] {
    const values = input.ExpressionAttributeValues as Values;
    if (input.IndexName !== undefined) {
      const names = (input.ExpressionAttributeNames ?? {}) as Names;
      // An index with a sort key range, as the turn and workspace reads send it (spec 025 phase 25d), and the webhook
      // recovery sweep's due rows: `<attribute> = :v AND <sort> (>=|>|<=|<) :a` or `<attribute> = :v AND <sort> BETWEEN :a AND :b`.
      const name = (token: string) => (token.startsWith("#") ? names[token]! : token);
      const ranged = INDEX_RANGE.exec(String(input.KeyConditionExpression));
      if (ranged) {
        const [partition, sort] = [name(ranged[1]!), name(ranged[3]!)];
        const operator = ranged[4]!;
        const bound = values[ranged[5]!] as string;
        const high = ranged[6] === undefined ? undefined : values[ranged[6]] as string;
        const inRange = (value: string): boolean => {
          const order = compareKeys(value, bound);
          if (operator === "BETWEEN") return order >= 0 && compareKeys(value, high!) <= 0;
          return operator === ">=" ? order >= 0 : operator === ">" ? order > 0 : operator === "<=" ? order <= 0 : order < 0;
        };
        const found = this.find((item) => item[partition] === values[ranged[2]!] && typeof item[sort] === "string" && inRange(item[sort]))
          // Items that share a sort value keep one order, by table key, so a page boundary between them skips nothing.
          .sort((left, right) => compareTuples(indexOrder(left, sort), indexOrder(right, sort)));
        if (input.ScanIndexForward === false) found.reverse();
        const start = input.ExclusiveStartKey as Record<string, unknown> | undefined;
        const after = start === undefined
          ? found
          : found.filter((item) => compareTuples(indexOrder(item, sort), indexOrder(start, sort)) * (input.ScanIndexForward === false ? -1 : 1) > 0);
        return after.map((item) => this.readClone(item));
      }
      // A secondary index keyed by one attribute: `<attribute> = :value`, sparse like DynamoDB's.
      const indexed = INDEX_EQUALS.exec(String(input.KeyConditionExpression));
      if (!indexed) throw new Error(`FakeDynamoDb does not support the index key condition ${String(input.KeyConditionExpression)}`);
      const attribute = indexed[1]!.startsWith("#") ? names[indexed[1]!]! : indexed[1]!;
      // The table's own (insertion) order, as before; ExclusiveStartKey resumes after that item in it.
      const found = this.find((item) => item[attribute] !== undefined && item[attribute] === values[indexed[2]!]);
      const start = input.ExclusiveStartKey as { pk?: unknown; sk?: unknown } | undefined;
      if (start === undefined) return found.map((item) => this.readClone(item));
      const position = found.findIndex((item) => item.pk === start.pk && item.sk === start.sk);
      if (position === -1) {
        throw Object.assign(new Error("FakeDynamoDb resumes a single-attribute index only after an item still in it"), { name: "ValidationException" });
      }
      return found.slice(position + 1).map((item) => this.readClone(item));
    }
    // A sort key range, as the operation events page reads it: `pk = :pk AND sk BETWEEN :a AND :b`.
    const range = /^pk = :pk AND sk BETWEEN (:[a-zA-Z]+) AND (:[a-zA-Z]+)$/.exec(String(input.KeyConditionExpression));
    if (range) {
      const low = values[range[1]!] as string;
      const high = values[range[2]!] as string;
      const inRange = this.find((item) => item.pk === values[":pk"] && compareKeys(item.sk as string, low) >= 0 && compareKeys(item.sk as string, high) <= 0)
        .sort((left, right) => compareKeys(left.sk as string, right.sk as string));
      if (input.ScanIndexForward === false) inRange.reverse();
      // ExclusiveStartKey resumes after that key in the query's direction, as in the begins_with branch.
      const start = input.ExclusiveStartKey as { sk?: unknown } | undefined;
      const after = start === undefined
        ? inRange
        : inRange.filter((item) => compareKeys(item.sk as string, String(start.sk)) * (input.ScanIndexForward === false ? -1 : 1) > 0);
      return after.map((item) => this.readClone(item));
    }
    // The stuck-setup sweep's "older than" range (spec 025 C17).
    const before = /^pk = :pk AND sk < (:[a-zA-Z]+)$/.exec(String(input.KeyConditionExpression));
    if (before) {
      const bound = values[before[1]!] as string;
      const found = this.find((item) => item.pk === values[":pk"] && compareKeys(item.sk as string, bound) < 0)
        .sort((left, right) => compareKeys(left.sk as string, right.sk as string));
      // ExclusiveStartKey resumes after that key (this range is read oldest first only).
      const start = input.ExclusiveStartKey as { sk?: unknown } | undefined;
      const after = start === undefined ? found : found.filter((item) => compareKeys(item.sk as string, String(start.sk)) > 0);
      return after.map((item) => this.readClone(item));
    }
    // A whole partition, as the workflow dispatch sweep reads it (sort key order).
    if (String(input.KeyConditionExpression) === "pk = :pk") {
      const whole = this.find((item) => item.pk === values[":pk"]).sort((left, right) => compareKeys(left.sk as string, right.sk as string));
      if (input.ScanIndexForward === false) whole.reverse();
      const start = input.ExclusiveStartKey as { sk?: unknown } | undefined;
      const after = start === undefined
        ? whole
        : whole.filter((item) => compareKeys(item.sk as string, String(start.sk)) * (input.ScanIndexForward === false ? -1 : 1) > 0);
      return after.map((item) => this.readClone(item));
    }
    const match = /^pk = :pk AND begins_with\(sk, (:[a-zA-Z]+)\)$/.exec(String(input.KeyConditionExpression));
    if (!match) throw new Error(`FakeDynamoDb does not support the key condition ${String(input.KeyConditionExpression)}`);
    const prefix = values[match[1]!] as string;
    const items = this.find((item) => item.pk === values[":pk"] && (item.sk as string).startsWith(prefix))
      .sort((left, right) => compareKeys(left.sk as string, right.sk as string));
    if (input.ScanIndexForward === false) items.reverse();
    // ExclusiveStartKey resumes after that key in the query's direction. DynamoDB refuses a start
    // key from another partition, without a sort key, or outside the key condition's range, and so
    // does this fake. (queryPage hands out LastEvaluatedKey when Limit stops the read early.)
    const start = input.ExclusiveStartKey as { pk?: unknown; sk?: unknown } | undefined;
    if (start !== undefined && (start.pk !== values[":pk"] || typeof start.sk !== "string" || !start.sk.startsWith(prefix))) {
      throw Object.assign(new Error("The provided starting key is invalid"), { name: "ValidationException" });
    }
    const after = start === undefined
      ? items
      : items.filter((item) => compareKeys(item.sk as string, String(start.sk)) * (input.ScanIndexForward === false ? -1 : 1) > 0);
    return after.map((item) => this.readClone(item));
  }

  private commit(actions: WriteAction[], errorName: string): void {
    // Evaluate every action's condition against the current (pre-write) snapshot before applying
    // anything, as DynamoDB does for a transaction: it is the full set of pass/fail results, not
    // just the first failure, that a real TransactWriteItems reports back.
    const passed = actions.map((action) =>
      action.condition === undefined || evaluateCondition(action.condition, this.items.get(action.key), action.names ?? {}, action.values ?? {}));
    const failedIndex = passed.findIndex((ok) => !ok);
    if (failedIndex !== -1) {
      const error = new Error(`condition failed: ${actions[failedIndex]!.condition}`) as Error & { CancellationReasons?: Array<{ Code: string }> };
      error.name = errorName;
      if (errorName === "TransactionCanceledException") {
        // One entry per TransactItem, in order, "None" for items whose own condition held -- the
        // shape real DynamoDB always reports on a cancelled TransactWriteItems.
        error.CancellationReasons = passed.map((ok) => ({ Code: ok ? "None" : "ConditionalCheckFailed" }));
      }
      throw error;
    }
    // Compute every result first so one oversize item refuses the whole transaction (`apply` is pure).
    const nexts = actions.map((action) => action.kind === "ConditionCheck" ? undefined : action.apply(this.items.get(action.key)));
    if (nexts.some((next) => next !== undefined && Buffer.byteLength(JSON.stringify(next), "utf8") > DYNAMODB_ITEM_MAX_BYTES)) {
      throw Object.assign(new Error("Item size has exceeded the maximum allowed size"), { name: "ValidationException" });
    }
    for (const [index, action] of actions.entries()) {
      if (action.kind === "ConditionCheck") continue;
      const before = this.items.get(action.key);
      const next = nexts[index];
      if (next === undefined) this.items.delete(action.key);
      else this.items.set(action.key, next);
      if (this.eventual) this.staleOnce.set(action.key, before);
      // Deleting an item that does not exist leaves no stream record, as in DynamoDB.
      if (before === undefined && next === undefined) continue;
      for (const listener of this.listeners) {
        listener({ ...(before === undefined ? {} : { before: structuredClone(before) }), ...(next === undefined ? {} : { after: structuredClone(next) }) });
      }
    }
  }
}

const INDEX_EQUALS = /^(#?[A-Za-z0-9_]+) = (:[A-Za-z0-9_]+)$/;
const INDEX_RANGE = /^(#?[A-Za-z0-9_]+) = (:[A-Za-z0-9_]+) AND (#?[A-Za-z0-9_]+) (>=|<=|>|<|BETWEEN) (:[A-Za-z0-9_]+)(?: AND (:[A-Za-z0-9_]+))?$/;

/** An index item's position: its sort value, then its table keys. */
function indexOrder(item: Record<string, unknown>, sort: string): string[] {
  return [String(item[sort]), String(item.pk), String(item.sk)];
}

function compareTuples(left: string[], right: string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const order = compareKeys(left[index]!, right[index]!);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * DynamoDB does not keep the order of a map's attributes (an item's top level, or a map inside it): it hands them back
 * in its own order. Here that order is by a hash of each attribute name and `seed`, so it depends only on the key set
 * (stable across round trips, whatever order the map was written in), and code that compares what it read with what it
 * built by their JSON text, rather than by their content, fails in a test as it does live.
 */
export function reorderMaps(value: unknown, seed: number = DEFAULT_MAP_ORDER_SEED): unknown {
  if (Array.isArray(value)) return value.map((entry) => reorderMaps(entry, seed));
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const given = Object.keys(value);
  const ordered = Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [key, reorderMaps(entry, seed), keyRank(key, seed)] as const)
    .sort((left, right) => left[2] - right[2] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([key, entry]) => [key, entry] as const);
  // A map that the key set's order would hand back exactly as written (a two-key map, half the time) is handed back
  // rotated by one, so a read never shows a map of two or more attributes in the order it was written.
  if (ordered.length > 1 && ordered.every(([key], index) => key === given[index])) ordered.push(ordered.shift()!);
  return Object.fromEntries(ordered);
}

/** FNV-1a over the seed and the attribute name. */
function keyRank(key: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (const char of `${key}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function itemKey(pk: string, sk: string): string {
  return `${pk}\u0000${sk}`;
}

// DynamoDB orders string sort keys by code point, not by locale collation.
function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function toAction(kind: WriteAction["kind"], input: Record<string, unknown>): WriteAction {
  const names = input.ExpressionAttributeNames as Names | undefined;
  const values = input.ExpressionAttributeValues as Values | undefined;
  const condition = input.ConditionExpression as string | undefined;
  assertNoReservedWords(condition);
  assertNoReservedWords(input.UpdateExpression as string | undefined);
  if (kind === "Put") {
    const item = structuredClone(input.Item as Item);
    return { kind, key: itemKey(item.pk as string, item.sk as string), apply: () => item, condition, names, values };
  }
  const key = input.Key as { pk: string; sk: string };
  if (kind === "Delete" || kind === "ConditionCheck") {
    return { kind, key: itemKey(key.pk, key.sk), apply: () => undefined, condition, names, values };
  }
  const expression = input.UpdateExpression as string;
  return {
    kind,
    key: itemKey(key.pk, key.sk),
    apply: (current) => applyUpdate({ ...(structuredClone(current) ?? {}), pk: key.pk, sk: key.sk }, expression, names ?? {}, values ?? {}),
    condition,
    names,
    values,
  };
}

const TOKEN = /\s*(attribute_not_exists|attribute_exists|attribute_type|if_not_exists|list_append|size|AND|OR|NOT|<>|<=|>=|[=<>(),.+\-[\]]|#[A-Za-z0-9_]+|:[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*|[0-9]+)/y;

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expression.length) {
    if (/^\s*$/.test(expression.slice(TOKEN.lastIndex))) break;
    const match = TOKEN.exec(expression);
    if (!match?.[1]) throw new Error(`cannot tokenize expression: ${expression}`);
    tokens.push(match[1]);
  }
  return tokens;
}

function plainMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Set || ArrayBuffer.isView(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** DynamoDB map equality ignores key order; list equality preserves position and nested value type. */
function dynamoEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => dynamoEqual(value, right[index]));
  }
  if (!plainMap(left) || !plainMap(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && dynamoEqual(left[key], right[key]));
}

class Parser {
  private position = 0;
  constructor(private readonly tokens: string[], private readonly names: Names, private readonly values: Values) {}

  peek(): string | undefined {
    return this.tokens[this.position];
  }

  next(): string {
    const token = this.tokens[this.position++];
    if (token === undefined) throw new Error("unexpected end of expression");
    return token;
  }

  expect(token: string): void {
    const actual = this.next();
    if (actual !== token) throw new Error(`expected ${token} but found ${actual}`);
  }

  done(): boolean {
    return this.position >= this.tokens.length;
  }

  private pathValue(item: Item | undefined, path: string): unknown {
    const segments: Array<string | number> = [];
    const matcher = /(?:^|\.)([^.[\]]+)|\[([0-9]+)\]/gu;
    for (const match of path.matchAll(matcher)) segments.push(match[1] ?? Number(match[2]));
    return segments.reduce<unknown>((value, segment) => {
      if (typeof segment === "number") return Array.isArray(value) ? value[segment] : undefined;
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Item)[segment] : undefined;
    }, item);
  }

  path(): string {
    const token = this.next();
    const resolved = token.startsWith("#") ? this.names[token] ?? token : token;
    let path = resolved;
    while (true) {
      if (this.peek() === ".") {
        this.next();
        const segment = this.next();
        path += `.${segment.startsWith("#") ? this.names[segment] ?? segment : segment}`;
      } else if (this.peek() === "[") {
        this.next();
        const index = this.next();
        if (!/^[0-9]+$/u.test(index)) throw new Error("list index must be a non-negative integer");
        this.expect("]");
        path += `[${index}]`;
      } else {
        return path;
      }
    }
  }

  operand(item: Item): unknown {
    const token = this.peek();
    if (token?.startsWith(":")) {
      this.next();
      return this.values[token];
    }
    if (token === "if_not_exists") {
      this.next();
      this.expect("(");
      const path = this.path();
      this.expect(",");
      const fallback = this.operand(item);
      this.expect(")");
      return item[path] ?? fallback;
    }
    if (token === "list_append") {
      this.next();
      this.expect("(");
      const first = this.operand(item) as unknown[];
      this.expect(",");
      const second = this.operand(item) as unknown[];
      this.expect(")");
      return [...first, ...second];
    }
    return this.pathValue(item, this.path());
  }

  valueExpression(item: Item): unknown {
    const left = this.operand(item);
    const operator = this.peek();
    if (operator === "+" || operator === "-") {
      this.next();
      const right = this.operand(item) as number;
      return operator === "+" ? (left as number) + right : (left as number) - right;
    }
    return left;
  }

  condition(item: Item | undefined): boolean {
    let result = this.conjunction(item);
    while (this.peek() === "OR") {
      this.next();
      const right = this.conjunction(item);
      result = result || right;
    }
    return result;
  }

  private conjunction(item: Item | undefined): boolean {
    let result = this.factor(item);
    while (this.peek() === "AND") {
      this.next();
      const right = this.factor(item);
      result = result && right;
    }
    return result;
  }

  private factor(item: Item | undefined): boolean {
    const token = this.peek();
    if (token === "NOT") {
      this.next();
      return !this.factor(item);
    }
    if (token === "(") {
      this.next();
      const result = this.condition(item);
      this.expect(")");
      return result;
    }
    if (token === "attribute_type") {
      this.next();
      this.expect("(");
      const path = this.path();
      this.expect(",");
      const type = this.operand(item ?? {});
      this.expect(")");
      return dynamoType(item?.[path]) === type;
    }
    if (token === "attribute_not_exists" || token === "attribute_exists") {
      this.next();
      this.expect("(");
      const path = this.path();
      this.expect(")");
      const exists = item?.[path] !== undefined;
      return token === "attribute_exists" ? exists : !exists;
    }
    if (token === "contains") {
      this.next();
      this.expect("(");
      const path = this.path();
      this.expect(",");
      const operand = this.operand(item ?? {});
      this.expect(")");
      const value = this.pathValue(item, path);
      if (value instanceof Set) return value.has(operand);
      if (typeof value === "string") return typeof operand === "string" && value.includes(operand);
      if (Array.isArray(value)) return value.some((entry) => dynamoEqual(entry, operand));
      return false;
    }
    if (token === "size") {
      this.next();
      this.expect("(");
      const path = this.path();
      this.expect(")");
      const value = this.pathValue(item, path);
      const length = typeof value === "string" ? Buffer.byteLength(value, "utf8")
        : Array.isArray(value) ? value.length : value instanceof Set ? value.size
          : plainMap(value) ? Object.keys(value).length : undefined;
      const comparator = this.next();
      const right = this.operand(item ?? {}) as number;
      switch (comparator) {
        case "=": return length === right;
        case "<>": return length !== right;
        case "<": return length !== undefined && length < right;
        case "<=": return length !== undefined && length <= right;
        case ">": return length !== undefined && length > right;
        case ">=": return length !== undefined && length >= right;
        default: throw new Error(`unsupported size comparator ${comparator}`);
      }
    }
    const left = this.operand(item ?? {});
    const comparator = this.next();
    const right = this.operand(item ?? {});
    switch (comparator) {
      case "=": return dynamoEqual(left, right);
      case "<>": return !dynamoEqual(left, right);
      case "<": return (left as number) < (right as number);
      case "<=": return (left as number) <= (right as number);
      case ">": return (left as number) > (right as number);
      case ">=": return (left as number) >= (right as number);
      default: throw new Error(`unsupported comparator ${comparator}`);
    }
  }
}

function evaluateCondition(expression: string, item: Item | undefined, names: Names, values: Values): boolean {
  const parser = new Parser(tokenize(expression), names, values);
  const result = parser.condition(item);
  if (!parser.done()) throw new Error(`unparsed condition tokens in: ${expression}`);
  return result;
}

function applyUpdate(item: Item, expression: string, names: Names, values: Values): Item {
  const clauses = expression.split(/\b(SET|ADD|REMOVE|DELETE)\b/).map((part) => part.trim()).filter(Boolean);
  for (let index = 0; index < clauses.length; index += 2) {
    const keyword = clauses[index];
    for (const action of splitTopLevel(clauses[index + 1] ?? "")) {
      const parser = new Parser(tokenize(action), names, values);
      const path = parser.path();
      if (keyword === "SET") {
        parser.expect("=");
        item[path] = parser.valueExpression(item);
      } else if (keyword === "ADD") {
        const value = parser.operand(item);
        const current = item[path];
        if (value instanceof Set) item[path] = new Set([...((current as Set<unknown> | undefined) ?? []), ...value]);
        else item[path] = ((current as number | undefined) ?? 0) + (value as number);
      } else if (keyword === "REMOVE") {
        delete item[path];
      } else if (keyword === "DELETE") {
        // Removes values from a set; DynamoDB drops a set attribute that becomes empty.
        const value = parser.operand(item) as Set<unknown>;
        const remaining = new Set([...((item[path] as Set<unknown> | undefined) ?? [])].filter((entry) => !value.has(entry)));
        if (remaining.size === 0) delete item[path];
        else item[path] = remaining;
      } else {
        throw new Error(`unsupported update keyword ${keyword}`);
      }
    }
  }
  return item;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function dynamoType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "NULL";
  if (typeof value === "string") return "S";
  if (typeof value === "number") return "N";
  if (typeof value === "boolean") return "BOOL";
  if (value instanceof Set) return "SS";
  return Array.isArray(value) ? "L" : "M";
}
