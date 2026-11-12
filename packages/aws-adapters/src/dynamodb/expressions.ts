// Convergence lane A1: the port's conditions, updates and key ranges, written as DynamoDB expressions.
//
// Every attribute name goes through a `#n` placeholder and every value through a `:v` placeholder, so no reserved word, dot or odd
// character in a name can change what an expression means. One builder serves one request, so the condition and the update of a
// request share the placeholders (DynamoDB refuses a placeholder that a request defines and does not use, and one it uses and does
// not define; the builder only emits what it used).
import type { AttributePath, Condition, IndexSortRange, SortKeyRange, UpdateOp } from "@agentx/contracts";
import type { JsonValue } from "@agentx/contracts";
import { toWire, type WireItem, type WireValue } from "./attribute-values.js";

export class ExpressionBuilder {
  readonly #names = new Map<string, string>();
  readonly #values: WireItem = {};
  #valueCount = 0;

  name(attribute: string): string {
    let placeholder = this.#names.get(attribute);
    if (placeholder === undefined) {
      placeholder = `#n${this.#names.size}`;
      this.#names.set(attribute, placeholder);
    }
    return placeholder;
  }

  path(path: AttributePath): string {
    return path.map((part) => this.name(part)).join(".");
  }

  value(value: JsonValue): string {
    return this.wire(toWire(value));
  }

  wire(value: WireValue): string {
    const placeholder = `:v${this.#valueCount}`;
    this.#valueCount += 1;
    this.#values[placeholder] = value;
    return placeholder;
  }

  condition(condition: Condition): string {
    switch (condition.op) {
      case "exists": return `attribute_exists(${this.path(condition.path)})`;
      case "notExists": return `attribute_not_exists(${this.path(condition.path)})`;
      case "eq": return `${this.path(condition.path)} = ${this.value(condition.value)}`;
      case "lt": return `${this.path(condition.path)} < ${this.value(condition.value)}`;
      case "lte": return `${this.path(condition.path)} <= ${this.value(condition.value)}`;
      case "gt": return `${this.path(condition.path)} > ${this.value(condition.value)}`;
      case "gte": return `${this.path(condition.path)} >= ${this.value(condition.value)}`;
      case "beginsWith": return `begins_with(${this.path(condition.path)}, ${this.value(condition.prefix)})`;
      case "and":
      case "or": {
        // An empty `and` holds and an empty `or` does not (the port's evaluator: `every` and `some` of nothing). DynamoDB has no literal
        // true or false, so they are written as a test that holds (or fails) whatever the item, present or not.
        if (condition.conditions.length === 0) return condition.op === "and" ? this.alwaysTrue() : `NOT (${this.alwaysTrue()})`;
        return condition.conditions.map((inner) => `(${this.condition(inner)})`).join(condition.op === "and" ? " AND " : " OR ");
      }
      case "not": return `NOT (${this.condition(condition.condition)})`;
    }
  }

  /** A test that holds for any item, present or not: a path is either there or not. */
  alwaysTrue(): string {
    const pk = this.name("pk");
    return `(attribute_exists(${pk}) OR attribute_not_exists(${pk}))`;
  }

  /**
   * An update. `add` is written as `SET p = if_not_exists(p, 0) + n` rather than DynamoDB's `ADD`: the same answer (a missing path counts
   * as 0, a non-number is refused by DynamoDB as a type error) and it works on a nested path the same way as on a top-level one.
   */
  update(ops: readonly UpdateOp[]): string {
    const sets: string[] = [];
    const removes: string[] = [];
    for (const op of ops) {
      const path = this.path(op.path);
      switch (op.op) {
        case "set": sets.push(`${path} = ${this.value(op.value)}`); break;
        case "setIfAbsent": sets.push(`${path} = if_not_exists(${path}, ${this.value(op.value)})`); break;
        case "remove": removes.push(path); break;
        case "add": {
          // A negative amount is written as a subtraction of its size, which reads the same and keeps the literal positive.
          const operator = op.amount < 0 ? "-" : "+";
          sets.push(`${path} = if_not_exists(${path}, ${this.value(0)}) ${operator} ${this.value(Math.abs(op.amount))}`);
          break;
        }
      }
    }
    return [sets.length > 0 ? `SET ${sets.join(", ")}` : "", removes.length > 0 ? `REMOVE ${removes.join(", ")}` : ""].filter((part) => part !== "").join(" ");
  }

  /** `pk = :v [AND <sort test>]` for a table query. */
  tableKey(pk: string, range: SortKeyRange | undefined): string {
    const partition = `${this.name("pk")} = ${this.value(pk)}`;
    if (range === undefined) return partition;
    const sk = this.name("sk");
    switch (range.op) {
      case "eq": return `${partition} AND ${sk} = ${this.value(range.value)}`;
      case "beginsWith": return `${partition} AND begins_with(${sk}, ${this.value(range.prefix)})`;
      case "between": return `${partition} AND ${sk} BETWEEN ${this.value(range.low)} AND ${this.value(range.high)}`;
      case "lt": return `${partition} AND ${sk} < ${this.value(range.value)}`;
      case "lte": return `${partition} AND ${sk} <= ${this.value(range.value)}`;
      case "gt": return `${partition} AND ${sk} > ${this.value(range.value)}`;
      case "gte": return `${partition} AND ${sk} >= ${this.value(range.value)}`;
    }
  }

  /** The key condition of an index query. The caller has checked that the bounds have the index's sort type. */
  indexKey(partitionAttribute: string, partition: string, sortAttribute: string | undefined, range: IndexSortRange | undefined): string {
    const head = `${this.name(partitionAttribute)} = ${this.value(partition)}`;
    if (range === undefined || sortAttribute === undefined) return head;
    const sort = this.name(sortAttribute);
    switch (range.op) {
      case "eq": return `${head} AND ${sort} = ${this.value(range.value)}`;
      case "between": return `${head} AND ${sort} BETWEEN ${this.value(range.low)} AND ${this.value(range.high)}`;
      case "lt": return `${head} AND ${sort} < ${this.value(range.value)}`;
      case "lte": return `${head} AND ${sort} <= ${this.value(range.value)}`;
      case "gt": return `${head} AND ${sort} > ${this.value(range.value)}`;
      case "gte": return `${head} AND ${sort} >= ${this.value(range.value)}`;
    }
  }

  /** The placeholders used so far, ready to spread into a request (absent when empty: DynamoDB refuses an empty map). */
  placeholders(): { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: WireItem } {
    const names = Object.fromEntries([...this.#names].map(([attribute, placeholder]) => [placeholder, attribute]));
    return {
      ...(this.#names.size === 0 ? {} : { ExpressionAttributeNames: names }),
      ...(this.#valueCount === 0 ? {} : { ExpressionAttributeValues: { ...this.#values } }),
    };
  }
}
