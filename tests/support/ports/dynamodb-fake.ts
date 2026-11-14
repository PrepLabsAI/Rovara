// Convergence lane A1: an in-memory DynamoDB table that speaks the wire protocol of the commands the DynamoDB document store sends.
//
// It is a test double of DynamoDB, not of the port: it takes the SDK's command objects with real expression strings and attribute values,
// parses the expressions, and answers as DynamoDB does, so the conformance suite checks the adapter's translation rather than a shortcut.
// What it models (each rule as DynamoDB documents it):
//  - Condition, update and key-condition expressions with `#name` / `:value` placeholders; a placeholder a request defines and does not
//    use, or uses and does not define, and an empty placeholder map, are a ValidationException.
//  - Comparisons: `=` on any type (maps without order, lists in order), `<` and friends only between two numbers or two strings (UTF-8
//    byte order), anything with a missing path false; `begins_with`, `attribute_exists`, `attribute_not_exists`, `size`, `IN`, `BETWEEN`.
//  - Updates read the old item for every action; overlapping paths, a key attribute, a path through a missing parent, and `+`/`-` on a
//    non-number are ValidationExceptions; `if_not_exists`.
//  - Item limits: 400 KB by DynamoDB's own size rules, 32 levels, number range and 38 digits, non-empty text keys, index key types.
//  - Conditional writes (ConditionalCheckFailedException), ReturnValues, transactions of at most 100 distinct items and 4 MB that apply
//    all or nothing (TransactionCanceledException with a reason per item), BatchGetItem (at most 100 distinct keys).
//  - Query: Limit counts items read before the filter, a page also ends at 1 MB, ExclusiveStartKey is a position (the item may be gone),
//    strongly consistent reads refused on an index, a missing index refused.
//  - The stream: a NEW_AND_OLD_IMAGES record per item that changed (none for a write that changed nothing or failed), sequence numbers as
//    growing decimal text, and time-to-live removals marked with the service principal.
// Faults can be injected per operation (throttling, transaction conflicts, unprocessed keys) for the adapter's retry tests.
import {
  BatchGetItemCommand,
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBServiceException,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type CancellationReason,
} from "@aws-sdk/client-dynamodb";
import type { IndexDefinition } from "@agentx/contracts";
import type { DynamoDbCommand, DynamoDbSender, DynamoStreamRecord } from "../../../packages/aws-adapters/src/index.js";

type AV = AttributeValue;
type Item = Record<string, AV>;

/** DynamoDB's ValidationException (the SDK has no class for it: it is a service exception known by its name). */
const validation = (message: string): DynamoDBServiceException => new DynamoDBServiceException({ name: "ValidationException", $fault: "client", $metadata: {}, message });

/** Thrown inside the evaluation of one item; a transaction turns it into a reason, a single write into a ValidationException. */
class ItemError extends Error {}

// ---- Values ----

const utf8 = (text: string): Buffer => Buffer.from(text, "utf8");
const typeOf = (value: AV): string => Object.keys(value).find((key) => (value as unknown as Record<string, unknown>)[key] !== undefined) ?? "?";

function numberIsValid(text: string): boolean {
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return false;
  const value = Number(text);
  if (!Number.isFinite(value)) return false;
  const mantissa = text.replace(/^-/, "").replace(/[eE].*$/, "").replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  if (mantissa.length > 38) return false;
  return value === 0 || (Math.abs(value) >= 1e-130 && Math.abs(value) < 1e126);
}

function assertValue(value: AV, depth: number): void {
  const type = typeOf(value);
  if (Object.values(value).filter((entry) => entry !== undefined).length !== 1) throw validation("Supplied AttributeValue has more than one datatypes set");
  if (depth > 32) throw validation("Nesting Levels have exceeded supported limits");
  if (type === "N" && !numberIsValid(value.N!)) throw validation("Number overflow or invalid number");
  if (type === "S" && /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value.S!)) throw validation("Invalid UTF-8 in a string");
  if (type === "L") value.L!.forEach((entry) => assertValue(entry, depth + 1));
  if (type === "M") Object.values(value.M!).forEach((entry) => assertValue(entry, depth + 1));
}

function avEqual(a: AV, b: AV): boolean {
  const type = typeOf(a);
  if (type !== typeOf(b)) return false;
  switch (type) {
    case "S": return a.S === b.S;
    case "N": return Number(a.N) === Number(b.N);
    case "BOOL": return a.BOOL === b.BOOL;
    case "NULL": return true;
    case "L": return a.L!.length === b.L!.length && a.L!.every((entry, index) => avEqual(entry, b.L![index]!));
    case "M": {
      const left = Object.keys(a.M!);
      return left.length === Object.keys(b.M!).length && left.every((key) => b.M![key] !== undefined && avEqual(a.M![key]!, b.M![key]));
    }
    default: return JSON.stringify(a) === JSON.stringify(b);
  }
}

function itemEqual(a: Item, b: Item): boolean {
  return avEqual({ M: a }, { M: b });
}

/** -1, 0, 1, or undefined when the two do not compare (different types, or a type with no order). */
function avCompare(a: AV | undefined, b: AV | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  const type = typeOf(a);
  if (type !== typeOf(b)) return undefined;
  if (type === "N") { const x = Number(a.N); const y = Number(b.N); return x === y ? 0 : x < y ? -1 : 1; }
  if (type === "S") return Math.sign(Buffer.compare(utf8(a.S!), utf8(b.S!)));
  return undefined;
}

/** DynamoDB's item size rules: names plus values; a number is about half its digits plus one; a list or map 3 bytes plus 1 per element. */
function valueSize(value: AV): number {
  switch (typeOf(value)) {
    case "S": return utf8(value.S!).length;
    case "N": { const digits = value.N!.replace(/^-/, "").replace(/[eE].*$/, "").replace(".", "").replace(/^0+/, "") || "0"; return Math.ceil(digits.length / 2) + 1; }
    case "BOOL": case "NULL": return 1;
    case "L": return 3 + value.L!.reduce((sum, entry) => sum + 1 + valueSize(entry), 0);
    case "M": return 3 + Object.entries(value.M!).reduce((sum, [name, entry]) => sum + 1 + utf8(name).length + valueSize(entry), 0);
    default: return JSON.stringify(value).length;
  }
}
export function itemSize(item: Item): number {
  return Object.entries(item).reduce((sum, [name, entry]) => sum + utf8(name).length + valueSize(entry), 0);
}

// ---- Expressions ----

type Token = { t: "name" | "value" | "ident" | "num" | "punct"; v: string };
type PathPart = string | number;
type Operand =
  | { k: "path"; path: PathPart[] }
  | { k: "value"; value: AV }
  | { k: "size"; path: PathPart[] }
  | { k: "ifNotExists"; path: PathPart[]; fallback: Operand }
  | { k: "listAppend"; a: Operand; b: Operand }
  | { k: "arith"; op: "+" | "-"; a: Operand; b: Operand };
type Cond =
  | { k: "and" | "or"; a: Cond; b: Cond }
  | { k: "not"; c: Cond }
  | { k: "cmp"; op: string; a: Operand; b: Operand }
  | { k: "between"; a: Operand; lo: Operand; hi: Operand }
  | { k: "in"; a: Operand; list: Operand[] }
  | { k: "fn"; name: string; args: Operand[] };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const space = /^\s+/.exec(rest);
    if (space) { index += space[0].length; continue; }
    const match = /^#[A-Za-z0-9_]+/.exec(rest) ?? /^:[A-Za-z0-9_]+/.exec(rest) ?? /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest) ?? /^\d+/.exec(rest) ?? /^(<>|<=|>=|[()=<>,.[\]+-])/.exec(rest);
    if (match === null) throw validation(`Invalid expression: unexpected character at ${index}`);
    const v = match[0];
    tokens.push({ t: v.startsWith("#") ? "name" : v.startsWith(":") ? "value" : /^\d/.test(v) ? "num" : /^[A-Za-z_]/.test(v) ? "ident" : "punct", v });
    index += v.length;
  }
  return tokens;
}

const KEYWORDS = new Set(["AND", "OR", "NOT", "BETWEEN", "IN", "SET", "REMOVE", "ADD", "DELETE"]);

class Parser {
  #at = 0;
  constructor(private readonly tokens: Token[], private readonly scope: Placeholders) {}
  get done(): boolean { return this.#at >= this.tokens.length; }
  peek(): Token | undefined { return this.tokens[this.#at]; }
  isWord(word: string): boolean { const token = this.peek(); return token?.t === "ident" && token.v.toUpperCase() === word; }
  isPunct(punct: string): boolean { const token = this.peek(); return token?.t === "punct" && token.v === punct; }
  next(): Token { const token = this.tokens[this.#at]; if (token === undefined) throw validation("Invalid expression: unexpected end"); this.#at += 1; return token; }
  expectPunct(punct: string): void { if (!this.isPunct(punct)) throw validation(`Invalid expression: expected ${punct}`); this.#at += 1; }
  expectWord(word: string): void { if (!this.isWord(word)) throw validation(`Invalid expression: expected ${word}`); this.#at += 1; }

  path(): PathPart[] {
    const parts: PathPart[] = [this.element()];
    for (;;) {
      if (this.isPunct(".")) { this.#at += 1; parts.push(this.element()); continue; }
      if (this.isPunct("[")) { this.#at += 1; const token = this.next(); if (token.t !== "num") throw validation("Invalid list index"); parts.push(Number(token.v)); this.expectPunct("]"); continue; }
      return parts;
    }
  }
  element(): string {
    const token = this.next();
    if (token.t === "name") return this.scope.name(token.v);
    if (token.t === "ident" && !KEYWORDS.has(token.v.toUpperCase())) return token.v;
    throw validation("Invalid expression: expected an attribute name");
  }

  operand(): Operand {
    const token = this.peek();
    if (token?.t === "value") { this.#at += 1; return { k: "value", value: this.scope.value(token.v) }; }
    if (token?.t === "ident" && token.v === "size" && this.tokens[this.#at + 1]?.v === "(") { this.#at += 2; const path = this.path(); this.expectPunct(")"); return { k: "size", path }; }
    return { k: "path", path: this.path() };
  }

  updateOperand(): Operand {
    const token = this.peek();
    if (token?.t === "ident" && token.v === "if_not_exists" && this.tokens[this.#at + 1]?.v === "(") {
      this.#at += 2; const path = this.path(); this.expectPunct(","); const fallback = this.updateOperand(); this.expectPunct(")");
      return { k: "ifNotExists", path, fallback };
    }
    if (token?.t === "ident" && token.v === "list_append" && this.tokens[this.#at + 1]?.v === "(") {
      this.#at += 2; const a = this.updateOperand(); this.expectPunct(","); const b = this.updateOperand(); this.expectPunct(")");
      return { k: "listAppend", a, b };
    }
    if (token?.t === "value") { this.#at += 1; return { k: "value", value: this.scope.value(token.v) }; }
    return { k: "path", path: this.path() };
  }

  setValue(): Operand {
    const a = this.updateOperand();
    if (this.isPunct("+") || this.isPunct("-")) { const op = this.next().v as "+" | "-"; return { k: "arith", op, a, b: this.updateOperand() }; }
    return a;
  }

  condition(): Cond {
    let left = this.conjunction();
    while (this.isWord("OR")) { this.#at += 1; left = { k: "or", a: left, b: this.conjunction() }; }
    return left;
  }
  conjunction(): Cond {
    let left = this.negation();
    while (this.isWord("AND")) { this.#at += 1; left = { k: "and", a: left, b: this.negation() }; }
    return left;
  }
  negation(): Cond {
    if (this.isWord("NOT")) { this.#at += 1; return { k: "not", c: this.negation() }; }
    return this.atom();
  }
  atom(): Cond {
    if (this.isPunct("(")) { this.#at += 1; const inner = this.condition(); this.expectPunct(")"); return inner; }
    const token = this.peek();
    if (token?.t === "ident" && ["attribute_exists", "attribute_not_exists", "begins_with", "contains", "attribute_type"].includes(token.v) && this.tokens[this.#at + 1]?.v === "(") {
      this.#at += 2;
      const args: Operand[] = [this.operand()];
      while (this.isPunct(",")) { this.#at += 1; args.push(this.operand()); }
      this.expectPunct(")");
      return { k: "fn", name: token.v, args };
    }
    const a = this.operand();
    if (this.isWord("BETWEEN")) { this.#at += 1; const lo = this.operand(); this.expectWord("AND"); return { k: "between", a, lo, hi: this.operand() }; }
    if (this.isWord("IN")) {
      this.#at += 1; this.expectPunct("(");
      const list = [this.operand()];
      while (this.isPunct(",")) { this.#at += 1; list.push(this.operand()); }
      this.expectPunct(")");
      return { k: "in", a, list };
    }
    const op = this.next();
    if (op.t !== "punct" || !["=", "<>", "<", "<=", ">", ">="].includes(op.v)) throw validation("Invalid expression: expected a comparator");
    return { k: "cmp", op: op.v, a, b: this.operand() };
  }
}

class Placeholders {
  readonly usedNames = new Set<string>();
  readonly usedValues = new Set<string>();
  constructor(private readonly names: Record<string, string> | undefined, private readonly values: Item | undefined) {
    if (names !== undefined && Object.keys(names).length === 0) throw validation("ExpressionAttributeNames must not be empty");
    if (values !== undefined && Object.keys(values).length === 0) throw validation("ExpressionAttributeValues must not be empty");
    for (const value of Object.values(values ?? {})) assertValue(value, 0);
  }
  name(placeholder: string): string {
    const found = this.names?.[placeholder];
    if (found === undefined) throw validation(`An expression attribute name used in the document path is not defined; attribute name: ${placeholder}`);
    this.usedNames.add(placeholder);
    return found;
  }
  value(placeholder: string): AV {
    const found = this.values?.[placeholder];
    if (found === undefined) throw validation(`An expression attribute value used in expression is not defined; attribute value: ${placeholder}`);
    this.usedValues.add(placeholder);
    return found;
  }
  assertAllUsed(): void {
    const unusedNames = Object.keys(this.names ?? {}).filter((name) => !this.usedNames.has(name));
    if (unusedNames.length > 0) throw validation(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${unusedNames.join(", ")}}`);
    const unusedValues = Object.keys(this.values ?? {}).filter((name) => !this.usedValues.has(name));
    if (unusedValues.length > 0) throw validation(`Value provided in ExpressionAttributeValues unused in expressions: keys: {${unusedValues.join(", ")}}`);
  }
}

function parseCondition(text: string, scope: Placeholders): Cond {
  const parser = new Parser(tokenize(text), scope);
  const condition = parser.condition();
  if (!parser.done) throw validation("Invalid ConditionExpression: unexpected trailing tokens");
  return condition;
}

interface UpdatePlan { sets: { path: PathPart[]; value: Operand }[]; removes: PathPart[][]; adds: { path: PathPart[]; value: Operand }[] }

function parseUpdate(text: string, scope: Placeholders): UpdatePlan {
  const parser = new Parser(tokenize(text), scope);
  const plan: UpdatePlan = { sets: [], removes: [], adds: [] };
  const seen = new Set<string>();
  while (!parser.done) {
    const word = parser.next();
    const clause = word.t === "ident" ? word.v.toUpperCase() : "";
    if (!["SET", "REMOVE", "ADD"].includes(clause)) throw validation("Invalid UpdateExpression: expected SET, REMOVE or ADD");
    if (seen.has(clause)) throw validation(`Invalid UpdateExpression: The "${clause}" section can only be used once in an update expression`);
    seen.add(clause);
    for (;;) {
      if (clause === "SET") { const path = parser.path(); parser.expectPunct("="); plan.sets.push({ path, value: parser.setValue() }); }
      else if (clause === "REMOVE") plan.removes.push(parser.path());
      else { const path = parser.path(); plan.adds.push({ path, value: parser.updateOperand() }); }
      if (!parser.isPunct(",")) break;
      parser.next();
    }
  }
  if (plan.sets.length + plan.removes.length + plan.adds.length === 0) throw validation("Invalid UpdateExpression: empty");
  return plan;
}

function getPath(item: Item | undefined, path: PathPart[]): AV | undefined {
  if (item === undefined) return undefined;
  let current: AV | undefined = { M: item };
  for (const part of path) {
    if (current === undefined) return undefined;
    if (typeof part === "number") current = current.L?.[part];
    else current = current.M?.[part];
  }
  return current;
}

function evalOperand(item: Item | undefined, operand: Operand): AV | undefined {
  switch (operand.k) {
    case "value": return operand.value;
    case "path": return getPath(item, operand.path);
    case "size": {
      const found = getPath(item, operand.path);
      if (found === undefined) return undefined;
      const type = typeOf(found);
      const size = type === "S" ? utf8(found.S!).length : type === "L" ? found.L!.length : type === "M" ? Object.keys(found.M!).length : undefined;
      return size === undefined ? undefined : { N: String(size) };
    }
    default: throw validation("Invalid ConditionExpression: an update function in a condition");
  }
}

function evalCondition(item: Item | undefined, condition: Cond): boolean {
  switch (condition.k) {
    case "and": return evalCondition(item, condition.a) && evalCondition(item, condition.b);
    case "or": return evalCondition(item, condition.a) || evalCondition(item, condition.b);
    case "not": return !evalCondition(item, condition.c);
    case "cmp": {
      const a = evalOperand(item, condition.a);
      const b = evalOperand(item, condition.b);
      if (a === undefined || b === undefined) return false;
      if (condition.op === "=") return avEqual(a, b);
      if (condition.op === "<>") return !avEqual(a, b);
      const order = avCompare(a, b);
      if (order === undefined) return false;
      return condition.op === "<" ? order < 0 : condition.op === "<=" ? order <= 0 : condition.op === ">" ? order > 0 : order >= 0;
    }
    case "between": {
      const a = evalOperand(item, condition.a);
      const low = avCompare(a, evalOperand(item, condition.lo));
      const high = avCompare(a, evalOperand(item, condition.hi));
      return low !== undefined && high !== undefined && low >= 0 && high <= 0;
    }
    case "in": {
      const a = evalOperand(item, condition.a);
      return a !== undefined && condition.list.some((entry) => { const b = evalOperand(item, entry); return b !== undefined && avEqual(a, b); });
    }
    case "fn": {
      const [first, second] = condition.args;
      if (first?.k !== "path" && condition.name.startsWith("attribute_")) throw validation(`Invalid ConditionExpression: ${condition.name} takes a path`);
      switch (condition.name) {
        case "attribute_exists": return evalOperand(item, first!) !== undefined;
        case "attribute_not_exists": return evalOperand(item, first!) === undefined;
        case "begins_with": {
          const a = evalOperand(item, first!);
          const b = second === undefined ? undefined : evalOperand(item, second);
          return a?.S !== undefined && b?.S !== undefined && a.S.startsWith(b.S);
        }
        case "contains": {
          const a = evalOperand(item, first!);
          const b = second === undefined ? undefined : evalOperand(item, second);
          if (a === undefined || b === undefined) return false;
          if (a.S !== undefined && b.S !== undefined) return a.S.includes(b.S);
          if (a.SS !== undefined && b.S !== undefined) return a.SS.includes(b.S);
          if (a.L !== undefined) return a.L.some((entry) => avEqual(entry, b));
          return false;
        }
        default: throw validation(`Unsupported function ${condition.name}`);
      }
    }
  }
}

const pathKey = (path: PathPart[]): string => JSON.stringify(path);
function overlaps(a: PathPart[], b: PathPart[]): boolean {
  const shared = Math.min(a.length, b.length);
  return a.slice(0, shared).every((part, index) => part === b[index]);
}

function addNumbers(a: AV, b: AV, op: "+" | "-"): AV {
  if (a.N === undefined || b.N === undefined) throw new ItemError("An operand in the update expression has an incorrect data type");
  const result = op === "+" ? Number(a.N) + Number(b.N) : Number(a.N) - Number(b.N);
  return { N: String(result) };
}

function evalUpdateOperand(old: Item | undefined, operand: Operand): AV {
  switch (operand.k) {
    case "value": return operand.value;
    case "path": {
      const found = getPath(old, operand.path);
      if (found === undefined) throw new ItemError("The provided expression refers to an attribute that does not exist in the item");
      return found;
    }
    case "ifNotExists": return getPath(old, operand.path) ?? evalUpdateOperand(old, operand.fallback);
    case "listAppend": {
      const a = evalUpdateOperand(old, operand.a);
      const b = evalUpdateOperand(old, operand.b);
      if (a.L === undefined || b.L === undefined) throw new ItemError("An operand in the update expression has an incorrect data type");
      return { L: [...a.L, ...b.L] };
    }
    case "arith": return addNumbers(evalUpdateOperand(old, operand.a), evalUpdateOperand(old, operand.b), operand.op);
    default: throw validation("Invalid UpdateExpression operand");
  }
}

/** The static checks of an update: no overlapping paths, no key attribute. */
function checkUpdatePlan(plan: UpdatePlan): void {
  const targets = [...plan.sets.map((entry) => entry.path), ...plan.removes, ...plan.adds.map((entry) => entry.path)];
  for (const [index, path] of targets.entries()) {
    if (path.length === 1 && (path[0] === "pk" || path[0] === "sk")) throw validation(`Cannot update attribute ${String(path[0])}. This attribute is part of the key`);
    for (const earlier of targets.slice(0, index)) {
      if (overlaps(earlier, path)) throw validation(`Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [${pathKey(earlier)}], path two: [${pathKey(path)}]`);
    }
  }
}

function applyUpdate(old: Item | undefined, key: Item, plan: UpdatePlan): Item {
  // Every right-hand side reads the old item.
  const sets = plan.sets.map((entry) => ({ path: entry.path, value: evalUpdateOperand(old, entry.value) }));
  const adds = plan.adds.map((entry) => ({ path: entry.path, value: evalUpdateOperand(old, entry.value) }));
  const next: Item = structuredClone(old ?? key);
  const parentOf = (path: PathPart[]): { holder: AV; last: PathPart } => {
    let holder: AV | undefined = { M: next };
    for (const part of path.slice(0, -1)) holder = typeof part === "number" ? holder?.L?.[part] : holder?.M?.[part];
    const last = path[path.length - 1]!;
    if (holder === undefined || (typeof last === "number" ? holder.L === undefined : holder.M === undefined)) throw new ItemError("The document path provided in the update expression is invalid for update");
    return { holder, last };
  };
  for (const { path, value } of sets) {
    const { holder, last } = parentOf(path);
    if (typeof last === "number") holder.L![Math.min(last, holder.L!.length)] = structuredClone(value);
    else holder.M![last] = structuredClone(value);
  }
  for (const path of plan.removes) {
    const { holder, last } = parentOf(path);
    if (typeof last === "number") holder.L!.splice(last, 1);
    else delete holder.M![last];
  }
  for (const { path, value } of adds) {
    const { holder, last } = parentOf(path);
    if (typeof last === "number") throw new ItemError("ADD on a list element");
    const current = holder.M![last];
    holder.M![last] = current === undefined ? structuredClone(value) : addNumbers(current, value, "+");
  }
  return next;
}

// ---- The table ----

export interface FakeDynamoDbOptions {
  tableName: string;
  indexes?: readonly IndexDefinition[];
  ttlAttribute?: string;
  /** Where a query page ends by size. Default 1 MB (DynamoDB's). */
  pageBytes?: number;
  /** First stream sequence number. Default 9999999990, so the text grows a digit within a test (as real ones do over time). */
  firstSequence?: bigint;
}

type Fault = { operation: string; make: () => unknown };

export class FakeDynamoDb implements DynamoDbSender {
  readonly tableName: string;
  readonly indexes: readonly IndexDefinition[];
  readonly ttlAttribute: string | undefined;
  readonly #items = new Map<string, Item>();
  readonly #listeners: ((record: DynamoStreamRecord) => void)[] = [];
  readonly #faults: Fault[] = [];
  #unprocessed = 0;
  #sequence: bigint;
  readonly #pageBytes: number;
  /** Every command received, by operation name, in order. */
  readonly requests: { operation: string; input: unknown }[] = [];

  constructor(options: FakeDynamoDbOptions) {
    this.tableName = options.tableName;
    this.indexes = options.indexes ?? [];
    this.ttlAttribute = options.ttlAttribute;
    this.#pageBytes = options.pageBytes ?? 1_048_576;
    this.#sequence = options.firstSequence ?? 9_999_999_990n;
  }

  /** Every stream record, at commit, in commit order. */
  onStream(listener: (record: DynamoStreamRecord) => void): void {
    this.#listeners.push(listener);
  }

  /** The next command of this operation throws what `make` returns. */
  failNext(operation: "GetItem" | "BatchGetItem" | "PutItem" | "UpdateItem" | "DeleteItem" | "Query" | "TransactWriteItems", make: () => unknown, times = 1): void {
    for (let index = 0; index < times; index += 1) this.#faults.push({ operation, make });
  }

  /** The next BatchGetItem leaves this many of its keys unprocessed. */
  leaveUnprocessed(count: number): void {
    this.#unprocessed = count;
  }

  /** Removes every item whose time-to-live attribute is a number of seconds at or before `nowSeconds`, as the service does. */
  sweepExpired(nowSeconds = Math.floor(Date.now() / 1_000)): number {
    if (this.ttlAttribute === undefined) return 0;
    let removed = 0;
    for (const [id, item] of [...this.#items]) {
      const expiry = item[this.ttlAttribute]?.N;
      if (expiry !== undefined && Number(expiry) <= nowSeconds) {
        this.#items.delete(id);
        this.#emit(item, undefined, true);
        removed += 1;
      }
    }
    return removed;
  }

  /** The raw item, for tests that look at the stored form. */
  raw(pk: string, sk: string): Item | undefined {
    const item = this.#items.get(`${pk}\u0000${sk}`);
    return item === undefined ? undefined : structuredClone(item);
  }

  /** Stores an item as another writer would (the hosted broker's own code), with the same checks, and its stream record. */
  seed(item: Item): void {
    this.#checkItem(item);
    const id = this.#id(item);
    const old = this.#items.get(id);
    this.#items.set(id, structuredClone(item));
    this.#emit(old, item, false);
  }

  async send(command: DynamoDbCommand): Promise<unknown> {
    await Promise.resolve();
    const operation = command instanceof GetItemCommand ? "GetItem" : command instanceof BatchGetItemCommand ? "BatchGetItem" : command instanceof PutItemCommand ? "PutItem"
      : command instanceof UpdateItemCommand ? "UpdateItem" : command instanceof DeleteItemCommand ? "DeleteItem" : command instanceof QueryCommand ? "Query" : command instanceof TransactWriteItemsCommand ? "TransactWriteItems" : "Unknown";
    this.requests.push({ operation, input: structuredClone(command.input) });
    const fault = this.#faults.findIndex((entry) => entry.operation === operation);
    if (fault >= 0) throw this.#faults.splice(fault, 1)[0]!.make();
    if (command instanceof GetItemCommand) return this.#get(command.input);
    if (command instanceof BatchGetItemCommand) return this.#batchGet(command.input);
    if (command instanceof PutItemCommand) return this.#put(command.input);
    if (command instanceof UpdateItemCommand) return this.#update(command.input);
    if (command instanceof DeleteItemCommand) return this.#delete(command.input);
    if (command instanceof QueryCommand) return this.#query(command.input);
    if (command instanceof TransactWriteItemsCommand) return this.#transact(command.input);
    throw validation("unsupported operation");
  }

  // ---- operations ----

  #get(input: GetItemCommand["input"]): unknown {
    this.#table(input.TableName);
    const id = this.#keyId(input.Key);
    const item = this.#items.get(id);
    return { Item: item === undefined ? undefined : structuredClone(item), $metadata: {} };
  }

  #batchGet(input: BatchGetItemCommand["input"]): unknown {
    const tables = Object.entries(input.RequestItems ?? {});
    if (tables.length !== 1) throw validation("one table per request in this double");
    const [name, request] = tables[0]!;
    this.#table(name);
    const keys = request.Keys ?? [];
    if (keys.length === 0 || keys.length > 100) throw validation("Too many items requested for the BatchGetItem call");
    const ids = keys.map((key) => this.#keyId(key));
    if (new Set(ids).size !== ids.length) throw validation("Provided list of item keys contains duplicates");
    const leave = Math.min(this.#unprocessed, keys.length);
    this.#unprocessed = 0;
    const served = ids.slice(leave);
    // DynamoDB answers in no particular order: this double answers in reverse to catch a caller that relies on order.
    const items = served.map((id) => this.#items.get(id)).filter((item): item is Item => item !== undefined).reverse().map((item) => structuredClone(item));
    return { Responses: { [name]: items }, UnprocessedKeys: leave === 0 ? {} : { [name]: { Keys: keys.slice(0, leave), ConsistentRead: request.ConsistentRead } }, $metadata: {} };
  }

  #put(input: PutItemCommand["input"]): unknown {
    this.#table(input.TableName);
    const item = input.Item ?? {};
    const scope = new Placeholders(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    const condition = input.ConditionExpression === undefined ? undefined : parseCondition(input.ConditionExpression, scope);
    scope.assertAllUsed();
    this.#checkItem(item);
    const id = this.#id(item);
    const old = this.#items.get(id);
    if (condition !== undefined && !evalCondition(old, condition)) throw new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
    this.#items.set(id, structuredClone(item));
    this.#emit(old, item, false);
    return { Attributes: input.ReturnValues === "ALL_OLD" && old !== undefined ? structuredClone(old) : undefined, $metadata: {} };
  }

  #update(input: UpdateItemCommand["input"]): unknown {
    this.#table(input.TableName);
    const id = this.#keyId(input.Key);
    if (input.UpdateExpression === undefined) throw validation("UpdateExpression is required in this double");
    const scope = new Placeholders(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    const plan = parseUpdate(input.UpdateExpression, scope);
    const condition = input.ConditionExpression === undefined ? undefined : parseCondition(input.ConditionExpression, scope);
    scope.assertAllUsed();
    checkUpdatePlan(plan);
    const old = this.#items.get(id);
    if (condition !== undefined && !evalCondition(old, condition)) throw new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
    let next: Item;
    try {
      next = applyUpdate(old, structuredClone(input.Key!), plan);
      this.#checkItem(next);
    } catch (error) {
      if (error instanceof ItemError) throw validation(error.message);
      throw error;
    }
    this.#items.set(id, next);
    this.#emit(old, next, false);
    const attributes = input.ReturnValues === "ALL_NEW" ? next : input.ReturnValues === "ALL_OLD" ? old : undefined;
    return { Attributes: attributes === undefined ? undefined : structuredClone(attributes), $metadata: {} };
  }

  #delete(input: DeleteItemCommand["input"]): unknown {
    this.#table(input.TableName);
    const id = this.#keyId(input.Key);
    const scope = new Placeholders(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    const condition = input.ConditionExpression === undefined ? undefined : parseCondition(input.ConditionExpression, scope);
    scope.assertAllUsed();
    const old = this.#items.get(id);
    if (condition !== undefined && !evalCondition(old, condition)) throw new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
    if (old !== undefined) {
      this.#items.delete(id);
      this.#emit(old, undefined, false);
    }
    return { Attributes: input.ReturnValues === "ALL_OLD" && old !== undefined ? structuredClone(old) : undefined, $metadata: {} };
  }

  #query(input: QueryCommand["input"]): unknown {
    this.#table(input.TableName);
    const index = input.IndexName === undefined ? undefined : this.indexes.find((each) => each.name === input.IndexName);
    if (input.IndexName !== undefined && index === undefined) throw validation("The table does not have the specified index");
    if (index !== undefined && input.ConsistentRead === true) throw validation("Consistent reads are not supported on global secondary indexes");
    if (input.KeyConditionExpression === undefined) throw validation("KeyConditionExpression is required in this double");
    const scope = new Placeholders(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    const keyCondition = parseCondition(input.KeyConditionExpression, scope);
    const filter = input.FilterExpression === undefined ? undefined : parseCondition(input.FilterExpression, scope);
    scope.assertAllUsed();
    const partitionAttribute = index?.partitionAttribute ?? "pk";
    const sortAttribute = index === undefined ? "sk" : index.sortAttribute;
    const sortType = index === undefined ? "S" : (index.sortType ?? "string") === "number" ? "N" : "S";
    const { partition, sort } = splitKeyCondition(keyCondition, partitionAttribute, sortAttribute, sortType);
    const limit = input.Limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw validation("Limit must be at least 1");

    // The candidates in the index's order: by sort value, then (for an index, whose order of ties is not defined) by table key.
    const placed = [...this.#items.values()].filter((item) => item[partitionAttribute]?.S === partition && (sortAttribute === undefined || (item[sortAttribute] !== undefined && typeOf(item[sortAttribute]) === sortType)));
    const order = (a: Item, b: Item): number => {
      if (sortAttribute !== undefined) { const c = avCompare(a[sortAttribute], b[sortAttribute]) ?? 0; if (c !== 0) return c; }
      return Math.sign(Buffer.compare(utf8(a.pk!.S!), utf8(b.pk!.S!))) || Math.sign(Buffer.compare(utf8(a.sk!.S!), utf8(b.sk!.S!)));
    };
    let candidates = placed.filter((item) => sort === undefined || evalCondition(item, sort)).sort(order);
    if (input.ScanIndexForward === false) candidates = candidates.reverse();
    const start = input.ExclusiveStartKey;
    if (start !== undefined) {
      const position = start as Item;
      const forward = input.ScanIndexForward !== false;
      candidates = candidates.filter((item) => { const c = order(item, position); return forward ? c > 0 : c < 0; });
    }
    const items: Item[] = [];
    let evaluated = 0;
    let bytes = 0;
    let last: Item | undefined;
    let cut = false;
    for (const item of candidates) {
      evaluated += 1;
      bytes += itemSize(item);
      last = item;
      if (filter === undefined || evalCondition(item, filter)) items.push(structuredClone(item));
      if ((limit !== undefined && evaluated >= limit) || bytes >= this.#pageBytes) { cut = true; break; }
    }
    const lastKey = cut && last !== undefined ? this.#positionOf(last, index) : undefined;
    return { Items: items, Count: items.length, ScannedCount: evaluated, ...(lastKey === undefined ? {} : { LastEvaluatedKey: lastKey }), $metadata: {} };
  }

  #transact(input: TransactWriteItemsCommand["input"]): unknown {
    const steps = input.TransactItems ?? [];
    if (steps.length === 0 || steps.length > 100) throw validation("Member must have length less than or equal to 100");
    type Planned = { id: string; key: Item; kind: "put" | "update" | "delete" | "check"; item?: Item; plan?: UpdatePlan; condition?: Cond | undefined };
    const planned: Planned[] = [];
    let bytes = 0;
    for (const step of steps) {
      const action = step.Put ?? step.Update ?? step.Delete ?? step.ConditionCheck;
      if (action === undefined || [step.Put, step.Update, step.Delete, step.ConditionCheck].filter((entry) => entry !== undefined).length !== 1) throw validation("A TransactWriteItem has exactly one action");
      this.#table(action.TableName);
      const scope = new Placeholders(action.ExpressionAttributeNames, action.ExpressionAttributeValues);
      const condition = action.ConditionExpression === undefined ? undefined : parseCondition(action.ConditionExpression, scope);
      if (step.Put !== undefined) {
        scope.assertAllUsed();
        this.#checkItem(step.Put.Item ?? {});
        bytes += itemSize(step.Put.Item ?? {});
        planned.push({ id: this.#id(step.Put.Item ?? {}), key: { pk: step.Put.Item!.pk!, sk: step.Put.Item!.sk! }, kind: "put", item: step.Put.Item!, condition });
      } else if (step.Update !== undefined) {
        const plan = parseUpdate(step.Update.UpdateExpression ?? "", scope);
        scope.assertAllUsed();
        checkUpdatePlan(plan);
        planned.push({ id: this.#keyId(step.Update.Key), key: step.Update.Key!, kind: "update", plan, condition });
      } else if (step.Delete !== undefined) {
        scope.assertAllUsed();
        planned.push({ id: this.#keyId(step.Delete.Key), key: step.Delete.Key!, kind: "delete", condition });
      } else {
        if (condition === undefined) throw validation("A ConditionCheck needs a ConditionExpression");
        scope.assertAllUsed();
        planned.push({ id: this.#keyId(step.ConditionCheck!.Key), key: step.ConditionCheck!.Key!, kind: "check", condition });
      }
    }
    if (new Set(planned.map((entry) => entry.id)).size !== planned.length) throw validation("Transaction request cannot include multiple operations on one item");
    if (bytes > 4 * 1_024 * 1_024) throw validation("Transaction size has exceeded the maximum allowed size");
    const reasons: CancellationReason[] = [];
    const results: { id: string; old: Item | undefined; next: Item | undefined; write: boolean }[] = [];
    for (const entry of planned) {
      const old = this.#items.get(entry.id);
      if (entry.condition !== undefined && !evalCondition(old, entry.condition)) {
        reasons.push({ Code: "ConditionalCheckFailed", Message: "The conditional request failed" });
        results.push({ id: entry.id, old, next: old, write: false });
        continue;
      }
      try {
        const next = entry.kind === "put" ? entry.item! : entry.kind === "update" ? applyUpdate(old, structuredClone(entry.key), entry.plan!) : entry.kind === "delete" ? undefined : old;
        if (next !== undefined && entry.kind !== "check") this.#checkItem(next);
        reasons.push({ Code: "None" });
        results.push({ id: entry.id, old, next, write: entry.kind !== "check" });
      } catch (error) {
        // (The SDK's exception base class resets the prototype, so a validation error is known by its name.)
        if (!(error instanceof ItemError) && (error as Error).name !== "ValidationException") throw error;
        reasons.push({ Code: "ValidationError", Message: (error as Error).message });
        results.push({ id: entry.id, old, next: old, write: false });
      }
    }
    if (reasons.some((reason) => reason.Code !== "None")) {
      throw new TransactionCanceledException({ message: `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.map((reason) => reason.Code).join(", ")}]`, $metadata: {}, CancellationReasons: reasons });
    }
    for (const result of results) {
      if (!result.write) continue;
      if (result.next === undefined) this.#items.delete(result.id);
      else this.#items.set(result.id, structuredClone(result.next));
      this.#emit(result.old, result.next, false);
    }
    return { $metadata: {} };
  }

  // ---- checks and the stream ----

  #table(name: string | undefined): void {
    if (name !== this.tableName) throw new DynamoDBServiceException({ name: "ResourceNotFoundException", $fault: "client", $metadata: {}, message: "Requested resource not found" });
  }

  #keyId(key: Item | undefined): string {
    if (key === undefined || Object.keys(key).length !== 2 || key.pk?.S === undefined || key.sk?.S === undefined) throw validation("The provided key element does not match the schema");
    if (key.pk.S === "" || key.sk.S === "") throw validation("One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value");
    return `${key.pk.S}\u0000${key.sk.S}`;
  }

  #id(item: Item): string {
    return this.#keyId({ pk: item.pk!, sk: item.sk! });
  }

  #checkItem(item: Item): void {
    if (item.pk?.S === undefined || item.sk?.S === undefined) throw validation("One or more parameter values were invalid: Missing the key pk or sk in the item");
    if (item.pk.S === "" || item.sk.S === "") throw validation("One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value");
    if (utf8(item.pk.S).length > 2_048) throw validation("Hash primary key size exceeded 2048 bytes");
    if (utf8(item.sk.S).length > 1_024) throw validation("Range primary key size exceeded 1024 bytes");
    for (const [name, value] of Object.entries(item)) {
      if (name === "") throw validation("Empty attribute name");
      assertValue(value, 0);
    }
    if (itemSize(item) > 400 * 1_024) throw validation("Item size has exceeded the maximum allowed size");
    for (const index of this.indexes) {
      const partition = item[index.partitionAttribute];
      if (partition !== undefined && (partition.S === undefined || partition.S === "")) throw validation(`One or more parameter values were invalid: Type mismatch for Index Key ${index.partitionAttribute}`);
      if (index.sortAttribute === undefined) continue;
      const sort = item[index.sortAttribute];
      if (sort === undefined) continue;
      const wanted = (index.sortType ?? "string") === "number" ? "N" : "S";
      if (typeOf(sort) !== wanted || sort.S === "") throw validation(`One or more parameter values were invalid: Type mismatch for Index Key ${index.sortAttribute}`);
    }
  }

  #positionOf(item: Item, index: IndexDefinition | undefined): Item {
    const key: Item = { pk: structuredClone(item.pk!), sk: structuredClone(item.sk!) };
    if (index !== undefined) {
      key[index.partitionAttribute] = structuredClone(item[index.partitionAttribute]!);
      if (index.sortAttribute !== undefined) key[index.sortAttribute] = structuredClone(item[index.sortAttribute]!);
    }
    return key;
  }

  #emit(old: Item | undefined, next: Item | undefined, expired: boolean): void {
    if (old !== undefined && next !== undefined && itemEqual(old, next)) return; // DynamoDB writes no record for a write that changed nothing
    const any = (next ?? old)!;
    this.#sequence += 1n;
    const record: DynamoStreamRecord = {
      eventID: `event-${this.#sequence}`,
      eventName: old === undefined ? "INSERT" : next === undefined ? "REMOVE" : "MODIFY",
      dynamodb: {
        Keys: { pk: structuredClone(any.pk!), sk: structuredClone(any.sk!) },
        ...(next === undefined ? {} : { NewImage: structuredClone(next) }),
        ...(old === undefined ? {} : { OldImage: structuredClone(old) }),
        SequenceNumber: String(this.#sequence),
      },
      ...(expired ? { userIdentity: { type: "Service", principalId: "dynamodb.amazonaws.com" } } : {}),
    };
    for (const listener of this.#listeners) listener(structuredClone(record));
  }
}

/** Splits a key condition into the partition value and the sort-key test, refusing what DynamoDB refuses in a key condition. */
function splitKeyCondition(condition: Cond, partitionAttribute: string, sortAttribute: string | undefined, sortType: string): { partition: string; sort: Cond | undefined } {
  const parts = condition.k === "and" ? [condition.a, condition.b] : [condition];
  if (parts.some((part) => part.k === "and" || part.k === "or" || part.k === "not" || part.k === "in")) throw validation("Invalid KeyConditionExpression: only AND of key tests");
  const onAttribute = (part: Cond, attribute: string | undefined): boolean => {
    const first = part.k === "fn" ? part.args[0] : part.k === "cmp" || part.k === "between" ? part.a : undefined;
    return first?.k === "path" && first.path.length === 1 && first.path[0] === attribute;
  };
  const head = parts.find((part) => onAttribute(part, partitionAttribute));
  if (head === undefined || head.k !== "cmp" || head.op !== "=" || head.b.k !== "value" || head.b.value.S === undefined) throw validation("Query condition missed key schema element");
  const rest = parts.filter((part) => part !== head);
  if (rest.length > 1) throw validation("Invalid KeyConditionExpression");
  const sort = rest[0];
  if (sort !== undefined) {
    if (sortAttribute === undefined || !onAttribute(sort, sortAttribute)) throw validation("Query key condition not supported");
    const bounds = sort.k === "cmp" ? [sort.b] : sort.k === "between" ? [sort.lo, sort.hi] : sort.k === "fn" && sort.name === "begins_with" ? [sort.args[1]] : undefined;
    if (bounds === undefined || (sort.k === "cmp" && sort.op === "<>")) throw validation("Query key condition not supported");
    for (const bound of bounds) if (bound?.k !== "value" || typeOf(bound.value) !== sortType) throw validation("One or more parameter values were invalid: Condition parameter type does not match schema type");
    if (sort.k === "between" && (avCompare((sort.lo as { value: AV }).value, (sort.hi as { value: AV }).value) ?? 0) > 0) throw validation("Invalid KeyConditionExpression: The BETWEEN operator requires upper bound to be greater than or equal to lower bound");
  }
  return { partition: head.b.value.S, sort };
}
