// Convergence lane A1: the DocumentStore port on one DynamoDB table.
//
// Key layout (no data moves): the table's partition key is the text attribute `pk` and its sort key the text attribute `sk`, and a
// document's attributes are the item's top-level attributes, in the form the hosted broker's document client writes them (see
// attribute-values.ts). A port key { pk, sk } is therefore the item key { pk: {S}, sk: {S} } unchanged; the company scope lives in the
// key text (`ORG#<company>#...`, decision 45.6), never in a prefix or a table of the adapter's own. A secondary index of the port is a
// global secondary index of the table with the same name and key attributes, projecting every attribute (state-table.ts lists the
// table's). The adapter adds no attribute of its own to a stored item.
//
// Rules held here, beyond the translation (the conformance suite pins each):
//  - Every request is checked against the port's rules first (document-semantics.ts), so a bad request never reaches DynamoDB.
//  - Single reads and table queries are strongly consistent; index queries are not (DynamoDB cannot do that).
//  - A failed condition is an answer; a lost transaction race is retried a bounded number of times and then thrown as `conflict`.
//  - A page is cut at `limit` before the filter, as DynamoDB does; the cursor is DynamoDB's last evaluated key, wrapped.
import { randomUUID } from "node:crypto";
import {
  BatchGetItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type BatchGetItemCommandOutput,
  type CancellationReason,
  type DeleteItemCommandOutput,
  type GetItemCommandOutput,
  type PutItemCommandOutput,
  type QueryCommandOutput,
  type TransactWriteItem,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import {
  DOCUMENT_STORE_LIMITS,
  DocumentStoreError,
  assertDistinctKeys,
  assertValidDocument,
  assertValidIndexAttributes,
  assertValidKey,
  assertValidOps,
  assertValidTransaction,
  type Condition,
  type DeleteRequest,
  type DocumentChangeFeed,
  type DocumentKey,
  type DocumentStore,
  type IndexDefinition,
  type IndexQueryRequest,
  type PutRequest,
  type QueryPage,
  type QueryRequest,
  type StoredDocument,
  type TransactItem,
  type TransactResult,
  type UpdateOp,
  type UpdateRequest,
  type WriteResult,
} from "@agentx/contracts";
import { UnrepresentableValueError, assertCloudReadableNumbers, assertWellFormedText, fromWireItem, hasLoneSurrogate, toWireItem, type WireItem } from "./attribute-values.js";
import { ExpressionBuilder } from "./expressions.js";

/** The commands this adapter sends. */
export type DynamoDbCommand = GetItemCommand | BatchGetItemCommand | PutItemCommand | UpdateItemCommand | DeleteItemCommand | QueryCommand | TransactWriteItemsCommand;

/** What the adapter needs of a client: a `DynamoDBClient` fits, and so does a test double. */
export interface DynamoDbSender {
  send(command: DynamoDbCommand): Promise<unknown>;
}

export interface DynamoDocumentStoreOptions {
  client: DynamoDbSender;
  tableName: string;
  /** The table's global secondary indexes the port may query. Each must exist on the table with these names and attributes. */
  indexes?: readonly IndexDefinition[];
  /** The table's time-to-live attribute, if it has one. */
  ttlAttribute?: string;
  /** The change feed of the table's stream, when this process is a stream reader (change-feed.ts). */
  changes?: DocumentChangeFeed;
  /** Attempts of a transaction (and of a single write) that loses a race with another transaction. Default 4. */
  conflictAttempts?: number;
  /** Rounds of `getMany` to fetch keys DynamoDB left unprocessed. Default 8. */
  unprocessedAttempts?: number;
  /** Waits between retries; the first wait is about this long and each doubles, with jitter. Default 25 ms. */
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Refuse to write a number whose size is past 2^53 - 1 (`invalid_request`), because the hosted broker's document client cannot read
   * one back as a number. Default true. The port's own range is wider (to 9.99e125); false allows it, for a table only this store reads.
   * An `add` that carries a stored number past the line is not caught here (the store does not read before it writes).
   */
  cloudReadableNumbers?: boolean;
  /**
   * Told about a stored item the port cannot represent (a set or bytes, decision 60), which a query page or a `getMany` then leaves out.
   * Default: one JSON line on standard error naming the key. A `get` of such an item throws `UnrepresentableValueError` instead.
   */
  onUnreadable?: (key: DocumentKey, error: UnrepresentableValueError) => void;
}

const invalid = (message: string): DocumentStoreError => new DocumentStoreError("invalid_request", message);

/** Error names of DynamoDB (and of the SDK around it) and what they mean for the port. */
const THROTTLED = new Set(["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded", "LimitExceededException"]);
const CONFLICT = new Set(["TransactionConflictException", "TransactionInProgressException"]);

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "";
}

/** A DynamoDB fault as the port's error. Never carries the request (it can hold document text). */
export function portError(error: unknown, operation: string): DocumentStoreError {
  if (error instanceof DocumentStoreError) return error;
  const name = errorName(error);
  if (name === "ValidationException") return invalid(`DynamoDB refused the ${operation}: ${(error as Error).message.slice(0, 300)}`);
  if (THROTTLED.has(name)) return new DocumentStoreError("throttled", `DynamoDB asked to slow down (${name}) on ${operation}`);
  if (CONFLICT.has(name)) return new DocumentStoreError("conflict", `the ${operation} lost a race with a transaction (${name})`);
  return new DocumentStoreError("unavailable", `the ${operation} failed: ${name === "" ? "unknown error" : name}`);
}

const keyOf = (key: DocumentKey): WireItem => ({ pk: { S: key.pk }, sk: { S: key.sk } });

function assertKeyText(key: DocumentKey): void {
  assertValidKey(key);
  if (hasLoneSurrogate(key.pk) || hasLoneSurrogate(key.sk)) throw invalid("a key holds an unpaired surrogate, which DynamoDB cannot store");
}

function assertDocument(document: StoredDocument, indexes: readonly IndexDefinition[], cloudNumbers: boolean): void {
  assertValidDocument(document);
  if (cloudNumbers) assertCloudReadableNumbers(document, "the document");
  assertKeyText(document);
  assertWellFormedText(document, "the document");
  assertValidIndexAttributes(indexes, document);
}

function assertOps(ops: readonly UpdateOp[], indexes: readonly IndexDefinition[], cloudNumbers: boolean): void {
  assertValidOps(ops);
  for (const op of ops) {
    if (cloudNumbers && (op.op === "set" || op.op === "setIfAbsent")) assertCloudReadableNumbers(op.value, "the new value");
    if (cloudNumbers && op.op === "add") assertCloudReadableNumbers(op.amount, "the amount");
    if (op.op === "set" || op.op === "setIfAbsent") assertWellFormedText(op.value, "the new value");
    for (const part of op.path) if (hasLoneSurrogate(part)) throw invalid("a path holds an unpaired surrogate");
    // A top-level index attribute must keep its type; DynamoDB refuses the write too, and checking here names the attribute. (`setIfAbsent`
    // is left to DynamoDB: on an item that already holds the attribute it changes nothing, so it is not wrong in itself.)
    if (op.path.length !== 1) continue;
    const attribute = op.path[0];
    for (const index of indexes) {
      const sortType = index.sortType ?? "string";
      if (op.op === "set") assertValidIndexAttributes([index], { pk: "p", sk: "s", [attribute]: op.value });
      if (op.op === "add" && (attribute === index.partitionAttribute || (attribute === index.sortAttribute && sortType === "string"))) {
        throw invalid(`${attribute} is an index key of text, so a number cannot be added to it`);
      }
    }
  }
}

function assertConditionText(condition: Condition | undefined): void {
  if (condition === undefined) return;
  switch (condition.op) {
    case "and": case "or": condition.conditions.forEach(assertConditionText); return;
    case "not": assertConditionText(condition.condition); return;
    case "eq": assertWellFormedText(condition.value, "a condition value"); break;
    case "beginsWith": assertWellFormedText(condition.prefix, "a condition prefix"); break;
    case "lt": case "lte": case "gt": case "gte": assertWellFormedText(condition.value, "a condition value"); break;
    default: break;
  }
  if (condition.path.length === 0 || condition.path.some((part) => typeof part !== "string" || part === "")) throw invalid("an attribute path has one or more non-empty parts");
}

function assertLimit(limit: number | undefined): number {
  if (limit === undefined) return DOCUMENT_STORE_LIMITS.maxPageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > DOCUMENT_STORE_LIMITS.maxPageSize) throw invalid(`limit is a whole number from 1 to ${DOCUMENT_STORE_LIMITS.maxPageSize}`);
  return limit;
}

// ---- Cursors ----
// A cursor is DynamoDB's LastEvaluatedKey with the partition it belongs to, as base64url JSON. The partition is checked on use, so a
// cursor of one partition cannot be replayed against another.

interface CursorBody { p: string; k: WireItem }

function encodeCursor(partition: string, key: WireItem | undefined): string | undefined {
  if (key === undefined || Object.keys(key).length === 0) return undefined;
  return Buffer.from(JSON.stringify({ p: partition, k: key } satisfies CursorBody), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, partition: string, attributes: readonly string[]): WireItem {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid("the cursor is not one this store gave out");
  }
  if (typeof body !== "object" || body === null || (body as CursorBody).p !== partition) throw invalid("the cursor belongs to another request");
  const key = (body as CursorBody).k;
  if (typeof key !== "object" || key === null || Array.isArray(key)) throw invalid("the cursor is not one this store gave out");
  for (const attribute of attributes) {
    const value = key[attribute];
    if (typeof value !== "object" || value === null || (typeof value.S !== "string" && typeof value.N !== "string")) throw invalid("the cursor is not one this store gave out");
  }
  for (const [name, value] of Object.entries(key)) {
    if (!attributes.includes(name) || Object.keys(value).length !== 1) throw invalid("the cursor is not one this store gave out");
  }
  return key;
}

export class DynamoDocumentStore implements DocumentStore {
  readonly indexes: readonly IndexDefinition[];
  readonly ttlAttribute?: string;
  readonly changes?: DocumentChangeFeed;
  readonly #client: DynamoDbSender;
  readonly #table: string;
  readonly #conflictAttempts: number;
  readonly #unprocessedAttempts: number;
  readonly #retryBaseMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #cloudNumbers: boolean;
  readonly #onUnreadable: (key: DocumentKey, error: UnrepresentableValueError) => void;

  constructor(options: DynamoDocumentStoreOptions) {
    if (typeof options.tableName !== "string" || options.tableName === "") throw invalid("tableName is the DynamoDB table's name");
    const names = new Set<string>();
    for (const index of options.indexes ?? []) {
      if (names.has(index.name)) throw invalid(`two indexes are named ${index.name}`);
      names.add(index.name);
      if (index.partitionAttribute === "pk" || index.partitionAttribute === "sk") throw invalid("an index partition attribute is not a table key attribute");
    }
    this.indexes = Object.freeze([...(options.indexes ?? [])]);
    if (options.ttlAttribute !== undefined) this.ttlAttribute = options.ttlAttribute;
    if (options.changes !== undefined) this.changes = options.changes;
    this.#client = options.client;
    this.#table = options.tableName;
    this.#conflictAttempts = Math.max(1, options.conflictAttempts ?? 4);
    this.#unprocessedAttempts = Math.max(1, options.unprocessedAttempts ?? 8);
    this.#retryBaseMs = Math.max(0, options.retryBaseMs ?? 25);
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#cloudNumbers = options.cloudReadableNumbers ?? true;
    this.#onUnreadable = options.onUnreadable ?? ((key, error) => console.error(JSON.stringify({ component: "dynamodb-document-store", event: "unreadable_item", pk: key.pk, sk: key.sk, found: error.found })));
  }

  async get(key: DocumentKey): Promise<StoredDocument | undefined> {
    assertKeyText(key);
    const output = await this.#send<GetItemCommandOutput>(new GetItemCommand({ TableName: this.#table, Key: keyOf(key), ConsistentRead: true }), "get");
    return output.Item === undefined ? undefined : fromWireItem(output.Item);
  }

  async getMany(keys: readonly DocumentKey[]): Promise<(StoredDocument | undefined)[]> {
    assertDistinctKeys(keys);
    if (keys.length > DOCUMENT_STORE_LIMITS.maxGetMany) throw invalid(`a getMany reads at most ${DOCUMENT_STORE_LIMITS.maxGetMany} keys`);
    for (const key of keys) assertKeyText(key);
    if (keys.length === 0) return [];
    const found = new Map<string, StoredDocument>();
    let pending: WireItem[] = keys.map(keyOf);
    for (let round = 0; pending.length > 0; round += 1) {
      if (round >= this.#unprocessedAttempts) throw new DocumentStoreError("throttled", "DynamoDB kept keys of a getMany unprocessed");
      if (round > 0) await this.#backoff(round);
      const output = await this.#send<BatchGetItemCommandOutput>(new BatchGetItemCommand({ RequestItems: { [this.#table]: { Keys: pending, ConsistentRead: true } } }), "getMany");
      for (const item of output.Responses?.[this.#table] ?? []) {
        const document = this.#readable(item);
        if (document !== undefined) found.set(`${document.pk}\u0000${document.sk}`, document);
      }
      pending = output.UnprocessedKeys?.[this.#table]?.Keys ?? [];
    }
    return keys.map((key) => found.get(`${key.pk}\u0000${key.sk}`));
  }

  async put(request: PutRequest): Promise<WriteResult> {
    assertDocument(request.item, this.indexes, this.#cloudNumbers);
    assertConditionText(request.condition);
    const builder = new ExpressionBuilder();
    const condition = request.condition === undefined ? undefined : builder.condition(request.condition);
    const command = new PutItemCommand({
      TableName: this.#table,
      Item: toWireItem(request.item),
      ...(condition === undefined ? {} : { ConditionExpression: condition }),
      ...builder.placeholders(),
      ReturnValues: request.return === "old" ? "ALL_OLD" : "NONE",
    });
    const output = await this.#conditional<PutItemCommandOutput>(command, "put");
    if (output === undefined) return { applied: false, reason: "condition_failed" };
    return request.return === "old" && output.Attributes !== undefined ? { applied: true, item: fromWireItem(output.Attributes) } : { applied: true };
  }

  async update(request: UpdateRequest): Promise<WriteResult> {
    assertKeyText(request.key);
    assertOps(request.ops, this.indexes, this.#cloudNumbers);
    assertConditionText(request.condition);
    const builder = new ExpressionBuilder();
    const update = builder.update(request.ops);
    const condition = request.condition === undefined ? undefined : builder.condition(request.condition);
    const command = new UpdateItemCommand({
      TableName: this.#table,
      Key: keyOf(request.key),
      UpdateExpression: update,
      ...(condition === undefined ? {} : { ConditionExpression: condition }),
      ...builder.placeholders(),
      ReturnValues: request.return === "new" ? "ALL_NEW" : request.return === "old" ? "ALL_OLD" : "NONE",
    });
    const output = await this.#conditional<UpdateItemCommandOutput>(command, "update");
    if (output === undefined) return { applied: false, reason: "condition_failed" };
    return request.return !== undefined && output.Attributes !== undefined ? { applied: true, item: fromWireItem(output.Attributes) } : { applied: true };
  }

  async delete(request: DeleteRequest): Promise<WriteResult> {
    assertKeyText(request.key);
    assertConditionText(request.condition);
    const builder = new ExpressionBuilder();
    const condition = request.condition === undefined ? undefined : builder.condition(request.condition);
    const command = new DeleteItemCommand({
      TableName: this.#table,
      Key: keyOf(request.key),
      ...(condition === undefined ? {} : { ConditionExpression: condition }),
      ...builder.placeholders(),
      ReturnValues: request.return === "old" ? "ALL_OLD" : "NONE",
    });
    const output = await this.#conditional<DeleteItemCommandOutput>(command, "delete");
    if (output === undefined) return { applied: false, reason: "condition_failed" };
    return request.return === "old" && output.Attributes !== undefined ? { applied: true, item: fromWireItem(output.Attributes) } : { applied: true };
  }

  async query(request: QueryRequest): Promise<QueryPage> {
    assertKeyText({ pk: request.pk, sk: "-" });
    const limit = assertLimit(request.limit);
    assertConditionText(request.filter);
    if (request.sk !== undefined) {
      for (const text of request.sk.op === "beginsWith" ? [request.sk.prefix] : request.sk.op === "between" ? [request.sk.low, request.sk.high] : [request.sk.value]) {
        if (typeof text !== "string") throw invalid("a sort key bound is text");
        if (hasLoneSurrogate(text)) throw invalid("a sort key bound holds an unpaired surrogate");
      }
      // DynamoDB refuses a BETWEEN whose low end is above its high end; the port's answer is simply nothing.
      if (request.sk.op === "between" && Buffer.compare(Buffer.from(request.sk.low, "utf8"), Buffer.from(request.sk.high, "utf8")) > 0) return { items: [] };
    }
    const builder = new ExpressionBuilder();
    const keyCondition = builder.tableKey(request.pk, request.sk);
    const filter = request.filter === undefined ? undefined : builder.condition(request.filter);
    const output = await this.#send<QueryOutputShape>(new QueryCommand({
      TableName: this.#table,
      KeyConditionExpression: keyCondition,
      ...(filter === undefined ? {} : { FilterExpression: filter }),
      ...builder.placeholders(),
      ConsistentRead: true,
      ScanIndexForward: request.descending !== true,
      Limit: limit,
      ...(request.cursor === undefined ? {} : { ExclusiveStartKey: decodeCursor(request.cursor, `table:${request.pk}`, ["pk", "sk"]) }),
    }), "query");
    return this.#page(output, `table:${request.pk}`);
  }

  async queryIndex(request: IndexQueryRequest): Promise<QueryPage> {
    const index = this.indexes.find((each) => each.name === request.index);
    if (index === undefined) throw invalid(`this store keeps no index named ${String(request.index).slice(0, 80)}`);
    if (request.sort !== undefined && index.sortAttribute === undefined) throw invalid(`the index ${index.name} has no sort attribute`);
    if (typeof request.partition !== "string" || request.partition === "") throw invalid("an index partition is non-empty text");
    if (hasLoneSurrogate(request.partition)) throw invalid("an index partition holds an unpaired surrogate");
    const limit = assertLimit(request.limit);
    assertConditionText(request.filter);
    const sortType = index.sortType ?? "string";
    if (request.sort !== undefined) {
      const bounds = request.sort.op === "between" ? [request.sort.low, request.sort.high] : [request.sort.value];
      // A bound of the other type matches nothing (the port's rule); DynamoDB would refuse it as a type mismatch.
      if (bounds.some((bound) => (sortType === "number" ? typeof bound !== "number" : typeof bound !== "string"))) return { items: [] };
      for (const bound of bounds) if (typeof bound === "string" && hasLoneSurrogate(bound)) throw invalid("a sort bound holds an unpaired surrogate");
      if (request.sort.op === "between") {
        const { low, high } = request.sort;
        const above = typeof low === "number" ? low > (high as number) : Buffer.compare(Buffer.from(low, "utf8"), Buffer.from(high as string, "utf8")) > 0;
        if (above) return { items: [] };
      }
    }
    const builder = new ExpressionBuilder();
    const keyCondition = builder.indexKey(index.partitionAttribute, request.partition, index.sortAttribute, request.sort);
    const filter = request.filter === undefined ? undefined : builder.condition(request.filter);
    const cursorAttributes = ["pk", "sk", index.partitionAttribute, ...(index.sortAttribute === undefined ? [] : [index.sortAttribute])];
    const scope = `index:${index.name}:${request.partition}`;
    const output = await this.#send<QueryOutputShape>(new QueryCommand({
      TableName: this.#table,
      IndexName: index.name,
      KeyConditionExpression: keyCondition,
      ...(filter === undefined ? {} : { FilterExpression: filter }),
      ...builder.placeholders(),
      ScanIndexForward: request.descending !== true,
      Limit: limit,
      ...(request.cursor === undefined ? {} : { ExclusiveStartKey: decodeCursor(request.cursor, scope, [...new Set(cursorAttributes)]) }),
    }), "queryIndex");
    return this.#page(output, scope);
  }

  async transact(items: readonly TransactItem[]): Promise<TransactResult> {
    assertValidTransaction(items);
    const steps: TransactWriteItem[] = items.map((item) => {
      const builder = new ExpressionBuilder();
      switch (item.kind) {
        case "put": {
          assertDocument(item.item, this.indexes, this.#cloudNumbers);
          assertConditionText(item.condition);
          const condition = item.condition === undefined ? undefined : builder.condition(item.condition);
          return { Put: { TableName: this.#table, Item: toWireItem(item.item), ...(condition === undefined ? {} : { ConditionExpression: condition }), ...builder.placeholders() } };
        }
        case "update": {
          assertKeyText(item.key);
          assertOps(item.ops, this.indexes, this.#cloudNumbers);
          assertConditionText(item.condition);
          const update = builder.update(item.ops);
          const condition = item.condition === undefined ? undefined : builder.condition(item.condition);
          return { Update: { TableName: this.#table, Key: keyOf(item.key), UpdateExpression: update, ...(condition === undefined ? {} : { ConditionExpression: condition }), ...builder.placeholders() } };
        }
        case "delete": {
          assertKeyText(item.key);
          assertConditionText(item.condition);
          const condition = item.condition === undefined ? undefined : builder.condition(item.condition);
          return { Delete: { TableName: this.#table, Key: keyOf(item.key), ...(condition === undefined ? {} : { ConditionExpression: condition }), ...builder.placeholders() } };
        }
        case "check": {
          assertKeyText(item.key);
          assertConditionText(item.condition);
          return { ConditionCheck: { TableName: this.#table, Key: keyOf(item.key), ConditionExpression: builder.condition(item.condition), ...builder.placeholders() } };
        }
      }
    });
    for (let attempt = 1; ; attempt += 1) {
      try {
        // A token per attempt: the SDK's own retries of this attempt are idempotent, and a new attempt is a new request.
        await this.#client.send(new TransactWriteItemsCommand({ TransactItems: steps, ClientRequestToken: randomUUID() }));
        return { applied: true };
      } catch (error) {
        if (errorName(error) !== "TransactionCanceledException") {
          const mapped = portError(error, "transaction");
          if (mapped.code === "conflict" && attempt < this.#conflictAttempts) {
            await this.#backoff(attempt);
            continue;
          }
          throw mapped;
        }
        const reasons: readonly CancellationReason[] = (error as { CancellationReasons?: CancellationReason[] }).CancellationReasons ?? [];
        const failed = reasons.flatMap((reason, index) => (reason.Code === "ConditionalCheckFailed" ? [index] : []));
        if (failed.length > 0) return { applied: false, reason: "condition_failed", failed };
        const codes = new Set(reasons.map((reason) => reason.Code ?? "None"));
        if (codes.has("ValidationError")) throw invalid(`DynamoDB refused a step of the transaction: ${reasons.find((reason) => reason.Code === "ValidationError")?.Message?.slice(0, 300) ?? "validation error"}`);
        const lostRace = codes.has("TransactionConflict");
        const throttled = codes.has("ThrottlingError") || codes.has("ProvisionedThroughputExceeded") || codes.has("RequestLimitExceeded");
        if ((lostRace || throttled) && attempt < this.#conflictAttempts) {
          await this.#backoff(attempt);
          continue;
        }
        if (lostRace) throw new DocumentStoreError("conflict", `the transaction lost a race with another writer ${attempt} times`);
        if (throttled) throw new DocumentStoreError("throttled", "DynamoDB asked to slow down on the transaction");
        throw new DocumentStoreError("unavailable", `DynamoDB cancelled the transaction (${[...codes].filter((code) => code !== "None").join(", ") || "no reason given"})`);
      }
    }
  }

  // ---- helpers ----

  #page(output: QueryOutputShape, scope: string): QueryPage {
    const items = (output.Items ?? []).flatMap((item) => { const document = this.#readable(item); return document === undefined ? [] : [document]; });
    const cursor = encodeCursor(scope, output.LastEvaluatedKey);
    return cursor === undefined ? { items } : { items, cursor };
  }

  /** The item as a document, or undefined (reported) when it holds what the port cannot represent. */
  #readable(item: WireItem): StoredDocument | undefined {
    try {
      return fromWireItem(item);
    } catch (error) {
      if (!(error instanceof UnrepresentableValueError) || item.pk?.S === undefined || item.sk?.S === undefined) throw error;
      try {
        this.#onUnreadable({ pk: item.pk.S, sk: item.sk.S }, error);
      } catch {
        // A failing report does not fail the read.
      }
      return undefined;
    }
  }

  async #send<T>(command: DynamoDbCommand, operation: string): Promise<T> {
    try {
      return (await this.#client.send(command)) as T;
    } catch (error) {
      throw portError(error, operation);
    }
  }

  /** A single conditional write: its output, or undefined when the condition failed. A write blocked by a running transaction is retried. */
  async #conditional<T>(command: DynamoDbCommand, operation: string): Promise<T | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return (await this.#client.send(command)) as T;
      } catch (error) {
        if (errorName(error) === "ConditionalCheckFailedException") return undefined;
        const mapped = portError(error, operation);
        if (mapped.code === "conflict" && attempt < this.#conflictAttempts) {
          await this.#backoff(attempt);
          continue;
        }
        throw mapped;
      }
    }
  }

  async #backoff(attempt: number): Promise<void> {
    const ceiling = this.#retryBaseMs * 2 ** Math.min(attempt - 1, 6);
    await this.#sleep(ceiling / 2 + Math.random() * (ceiling / 2));
  }
}

type QueryOutputShape = Pick<QueryCommandOutput, "Items" | "LastEvaluatedKey">;
