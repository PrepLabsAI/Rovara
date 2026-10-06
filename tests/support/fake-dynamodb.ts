// In-memory DynamoDB document client for broker tests. It evaluates the condition and update
// expressions the broker uses, and applies transactions all-or-nothing, as DynamoDB does.

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

export class FakeDynamoDb {
  readonly items = new Map<string, Item>();
  private readonly listeners = new Set<(change: { before?: Item; after?: Item }) => void>();
  /** Constructor names of every command sent, in order (spec 025 A3: no route scans). */
  private readonly sent: string[] = [];

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
    await Promise.resolve();
    const input = command.input;
    switch (command.constructor.name) {
      case "GetCommand": {
        const key = input.Key as { pk: string; sk: string };
        const item = this.get(key.pk, key.sk);
        return { Item: item === undefined ? undefined : structuredClone(item) };
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
      // An index with a sort key range, as the turn and workspace reads send it (spec 025 phase 25d):
      // `<attribute> = :v AND <sort> >= :a` or `<attribute> = :v AND <sort> BETWEEN :a AND :b`.
      const name = (token: string) => (token.startsWith("#") ? names[token]! : token);
      const ranged = INDEX_RANGE.exec(String(input.KeyConditionExpression));
      if (ranged) {
        const [partition, sort] = [name(ranged[1]!), name(ranged[3]!)];
        const low = values[ranged[5]!] as string;
        const high = ranged[6] === undefined ? undefined : values[ranged[6]] as string;
        const found = this.find((item) => item[partition] === values[ranged[2]!] && typeof item[sort] === "string"
          && compareKeys(item[sort], low) >= 0 && (high === undefined || compareKeys(item[sort], high) <= 0))
          // Items that share a sort value keep one order, by table key, so a page boundary between them skips nothing.
          .sort((left, right) => compareTuples(indexOrder(left, sort), indexOrder(right, sort)));
        if (input.ScanIndexForward === false) found.reverse();
        const start = input.ExclusiveStartKey as Record<string, unknown> | undefined;
        const after = start === undefined
          ? found
          : found.filter((item) => compareTuples(indexOrder(item, sort), indexOrder(start, sort)) * (input.ScanIndexForward === false ? -1 : 1) > 0);
        return after.map((item) => structuredClone(item));
      }
      // A secondary index keyed by one attribute: `<attribute> = :value`, sparse like DynamoDB's.
      const indexed = INDEX_EQUALS.exec(String(input.KeyConditionExpression));
      if (!indexed) throw new Error(`FakeDynamoDb does not support the index key condition ${String(input.KeyConditionExpression)}`);
      const attribute = indexed[1]!.startsWith("#") ? names[indexed[1]!]! : indexed[1]!;
      // The table's own (insertion) order, as before; ExclusiveStartKey resumes after that item in it.
      const found = this.find((item) => item[attribute] !== undefined && item[attribute] === values[indexed[2]!]);
      const start = input.ExclusiveStartKey as { pk?: unknown; sk?: unknown } | undefined;
      if (start === undefined) return found.map((item) => structuredClone(item));
      const position = found.findIndex((item) => item.pk === start.pk && item.sk === start.sk);
      if (position === -1) {
        throw Object.assign(new Error("FakeDynamoDb resumes a single-attribute index only after an item still in it"), { name: "ValidationException" });
      }
      return found.slice(position + 1).map((item) => structuredClone(item));
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
      return after.map((item) => structuredClone(item));
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
      return after.map((item) => structuredClone(item));
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
    return after.map((item) => structuredClone(item));
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
    for (const action of actions) {
      if (action.kind === "ConditionCheck") continue;
      const before = this.items.get(action.key);
      const next = action.apply(before);
      if (next === undefined) this.items.delete(action.key);
      else this.items.set(action.key, next);
      // Deleting an item that does not exist leaves no stream record, as in DynamoDB.
      if (before === undefined && next === undefined) continue;
      for (const listener of this.listeners) {
        listener({ ...(before === undefined ? {} : { before: structuredClone(before) }), ...(next === undefined ? {} : { after: structuredClone(next) }) });
      }
    }
  }
}

const INDEX_EQUALS = /^(#?[A-Za-z0-9_]+) = (:[A-Za-z0-9_]+)$/;
const INDEX_RANGE = /^(#?[A-Za-z0-9_]+) = (:[A-Za-z0-9_]+) AND (#?[A-Za-z0-9_]+) (>=|BETWEEN) (:[A-Za-z0-9_]+)(?: AND (:[A-Za-z0-9_]+))?$/;

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

function itemKey(pk: string, sk: string): string {
  return `${pk}\u0000${sk}`;
}

// DynamoDB orders string sort keys by code point, not by locale collation.
function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * DynamoDB reserved words that are also likely attribute names. Real DynamoDB refuses an expression
 * that uses one unaliased (ValidationException); spec 043's run result reached production that way
 * because this fake accepted `result = :result`. Not the whole list, which runs to hundreds of words.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "ACTION", "COMMENT", "CONNECTION", "COUNT", "DATA", "DATE", "HASH", "INDEX", "ITEM", "KEY", "KEYS", "LEVEL",
  "LIMIT", "MODE", "NAME", "OWNER", "PATH", "RESULT", "ROLE", "SESSION", "SIZE", "SOURCE", "STATE", "STATUS",
  "TABLE", "TIME", "TIMESTAMP", "TTL", "TYPE", "USER", "VALUE", "YEAR", "ZONE",
]);
const EXPRESSION_KEYWORDS: ReadonlySet<string> = new Set(["AND", "OR", "NOT", "SET", "ADD", "REMOVE", "DELETE", "IN", "BETWEEN"]);

/** Throws as DynamoDB does when an expression names a reserved word without an #alias. */
export function assertNoReservedWords(expression: string | undefined): void {
  if (expression === undefined) return;
  // A document-path separator does not make the following attribute name safe:
  // `workflow.state` still names the reserved DynamoDB word `state`.
  const words = expression.match(/(?<![#:\w])[A-Za-z_]\w*\b(?!\s*\()/g) ?? [];
  const reserved = words.find((word) => !EXPRESSION_KEYWORDS.has(word) && RESERVED_WORDS.has(word.toUpperCase()));
  if (reserved !== undefined) {
    throw Object.assign(new Error(`Invalid expression: Attribute name is a reserved keyword; reserved keyword: ${reserved}`), { name: "ValidationException" });
  }
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

const TOKEN = /\s*(attribute_not_exists|attribute_exists|attribute_type|if_not_exists|list_append|AND|OR|NOT|<>|<=|>=|[=<>(),.+-]|#[A-Za-z0-9_]+|:[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*)/y;

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

  path(): string {
    const token = this.next();
    const resolved = token.startsWith("#") ? this.names[token] ?? token : token;
    if (this.peek() !== ".") return resolved;
    this.next();
    return `${resolved}.${this.path()}`;
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
    return this.path().split(".").reduce<unknown>((value, segment) =>
      value && typeof value === "object" ? (value as Item)[segment] : undefined, item);
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
      const value = item?.[path];
      if (value instanceof Set) return value.has(operand);
      if (typeof value === "string") return typeof operand === "string" && value.includes(operand);
      if (Array.isArray(value)) return value.includes(operand);
      return false;
    }
    const left = this.operand(item ?? {});
    const comparator = this.next();
    const right = this.operand(item ?? {});
    switch (comparator) {
      case "=": return left === right;
      case "<>": return left !== right;
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
