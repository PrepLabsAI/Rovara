import { itemPathHolders, itemPathValues, toolPatternMatches, type ActionPolicy, type ActionPolicyRule, type ToolHints } from "@agentx/contracts";

/**
 * AgentX's own, vendor-neutral classes (spec 014 D1). A read and a create run; a change runs only
 * when the classifier finds the member asked for it; a destructive action always asks.
 */
export type ActionClass = "read" | "create" | "change" | "destructive";

/** What the gate knows about a connector tool, from its catalog. In-house tools have none. */
export interface ToolFacts {
  connector: string;
  upstreamName: string;
  access: "read" | "write";
  hints?: ToolHints | undefined;
  /**
   * The connector's item argument paths this tool's schema offers (part 1), such as `id` or
   * `tasks[].task`: empty when it offers none, absent when the connector declares none.
   */
  itemArguments?: readonly string[] | undefined;
}

/** A decision the rules or the built-in defaults reached without the classifier. */
export interface SettledAction {
  outcome: "allow" | "ask" | "deny";
  source: "rule" | "default";
  /** Why it asks or runs. "yes to all" never skips admin, destructive, bulk or hint asks. */
  kind: "admin" | "destructive" | "bulk" | "hint" | "read" | "create" | "allowed";
  reason: string;
  /** The 1-based rule number, for a rule decision. */
  rule?: number;
}

export interface PolicyEvaluation {
  actionClass: ActionClass;
  /** The 1-based number of the treatAs rule that set the class, if any. */
  classRule?: number;
  settled?: SettledAction;
}

/** A write touching more items than this asks (FR-015). */
export const BULK_ITEM_LIMIT = 5;

/** Words that end or undo something. One of them as a word of the tool's name makes the call destructive. */
export const DESTRUCTIVE_WORDS: ReadonlySet<string> = new Set([
  "delete", "remove", "archive", "close", "merge", "revert", "cancel", "destroy", "purge", "revoke", "transition", "resolve", "trash",
]);

/** Arguments that move an item through its lifecycle. A call that sets one is destructive. `completed` closes a task in some trackers (R19). */
export const LIFECYCLE_KEYS: ReadonlySet<string> = new Set([
  "state", "stateId", "status", "statusId", "resolution", "transition", "transitionId", "transitionName", "archived", "closed", "completed", "trashed", "duplicateOf", "stateReason",
]);

/** A key compared without case or `_`/`-` separators, so `state_id`, `StateId` and `STATEID` are one key. */
function normalisedKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/gu, "");
}

const NORMALISED_LIFECYCLE_KEYS: ReadonlySet<string> = new Set([...LIFECYCLE_KEYS].map(normalisedKey));

function isLifecycleKey(key: string): boolean {
  return NORMALISED_LIFECYCLE_KEYS.has(normalisedKey(key));
}

/** How deep, counting the arguments object as depth 1, a tool that offers item paths is searched for lifecycle keys. */
const LIFECYCLE_SEARCH_DEPTH = 4;

const IN_HOUSE_READS: ReadonlySet<string> = new Set(["agentx_follow_up", "agentx_task_status", "agentx_task_result"]);
const DESTRUCTIVE_PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set(["close", "replace", "revert"]);

/**
 * The words of a tool name, lowercased: split at underscores, hyphens, lower-to-upper case changes,
 * the end of a capital run (`XMLDelete`, `DELETEItem`) and letter-digit joins (`delete2`, `v2delete`).
 */
export function nameWords(name: string): string[] {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Za-z])(\d)/gu, "$1 $2")
    .replace(/(\d)([A-Za-z])/gu, "$1 $2")
    .split(/[\s_-]+/u).filter(Boolean).map((word) => word.toLowerCase());
}

const INFLECTIONS = ["es", "s", "ed", "d"] as const;

/**
 * The destructive word a name word is, or is a simple inflection of: a plural or past tense
 * (`deletes`, `closes`, `removed`), a gerund (`closing`, `deleting`, `archiving`), or a doubled
 * final "l" before "ed" or "ing" (`cancelled`, `cancelling`). Only a stem in DESTRUCTIVE_WORDS
 * counts, so `string`, `thing`, `setting` and `listing` stay ordinary. Accepted gaps: nouns
 * (`deletion`, `removal`) and words run together without a separator or case change (`bulkdelete`).
 */
function destructiveWord(word: string): string | undefined {
  if (DESTRUCTIVE_WORDS.has(word)) return word;
  for (const suffix of INFLECTIONS) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, -suffix.length);
    if (DESTRUCTIVE_WORDS.has(stem)) return stem;
  }
  for (const suffix of ["ing", "ed"] as const) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, -suffix.length);
    const candidates = [stem, `${stem}e`, ...(stem.endsWith("ll") ? [stem.slice(0, -1)] : [])];
    const found = candidates.find((candidate) => DESTRUCTIVE_WORDS.has(candidate));
    if (found !== undefined) return found;
  }
  return undefined;
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The first lifecycle key set anywhere in the arguments, breadth first so the shallowest wins, in
 * objects and arrays (own keys only), no deeper than LIFECYCLE_SEARCH_DEPTH. Named like `a.b`, with
 * `[]` after an array (`items[].state`).
 */
function deepLifecycleKey(args: Record<string, unknown>): string | undefined {
  let level: Array<{ value: unknown; path: string }> = [{ value: args, path: "" }];
  for (let depth = 1; depth <= LIFECYCLE_SEARCH_DEPTH && level.length > 0; depth += 1) {
    const next: Array<{ value: unknown; path: string }> = [];
    for (const { value, path } of level) {
      if (Array.isArray(value)) {
        for (const element of value) next.push({ value: element, path: `${path}[]` });
      } else if (value !== null && typeof value === "object") {
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
          const named = path === "" ? key : `${path}.${key}`;
          if (isLifecycleKey(key) && isSet(inner)) return named;
          next.push({ value: inner, path: named });
        }
      }
    }
    level = next;
  }
  return undefined;
}

/**
 * The lifecycle key a call sets. A tool that offers item paths, or whose connector declares none
 * (`itemArguments` undefined), may change an existing item anywhere in its arguments, so they are
 * searched to depth LIFECYCLE_SEARCH_DEPTH. A tool that offers no item path (`[]`) creates, so only
 * its top level and object arguments (such as `fields`) are read: a create's array of new items
 * that are already complete stays a create.
 */
function lifecycleKeySet(args: Record<string, unknown>, itemArguments: readonly string[] | undefined): string | undefined {
  if (!isPlainObject(args)) return undefined;
  if (itemArguments === undefined || itemArguments.length > 0) {
    const deep = deepLifecycleKey(args);
    if (deep !== undefined) return deep;
  }
  for (const [key, value] of Object.entries(args)) {
    if (isLifecycleKey(key) && isSet(value)) return key;
    if (isPlainObject(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (isLifecycleKey(inner) && isSet(innerValue)) return `${key}.${inner}`;
      }
    }
  }
  // Item paths deeper than the deep search still have their holders read.
  for (const path of itemArguments ?? []) {
    const cut = path.lastIndexOf(".");
    // A top-level path's holder is the arguments themselves, already read above.
    if (cut < 0) continue;
    for (const holder of itemPathHolders(args, path)) {
      for (const [key, value] of Object.entries(holder)) {
        if (isLifecycleKey(key) && isSet(value)) return `${path.slice(0, cut)}.${key}`;
      }
    }
  }
  return undefined;
}

/**
 * Why a call is destructive, or undefined: a destructive word (or a simple inflection of one) in the
 * tool's name, or a lifecycle key it sets. `itemArguments` as in ToolFacts: undefined searches deeply.
 */
export function destructiveSignal(toolName: string, args: Record<string, unknown>, itemArguments?: readonly string[]): string | undefined {
  for (const entry of nameWords(toolName)) {
    const word = destructiveWord(entry);
    if (word !== undefined) return `the tool's name says "${word}"`;
  }
  const key = lifecycleKeySet(args, itemArguments);
  return key === undefined ? undefined : `the call sets "${key}"`;
}

/** The existing items a call names, as `path=value` (several values joined by commas), when the connector declares how. */
export function itemReference(facts: ToolFacts | undefined, args: Record<string, unknown>): string | undefined {
  if (!isPlainObject(args)) return undefined;
  for (const path of facts?.itemArguments ?? []) {
    const values = itemPathValues(args, path);
    if (values.length > 0) return `${path}=${values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(",").slice(0, 80)}`;
  }
  return undefined;
}

/**
 * The class before any rule (spec 014 D1).
 * - A connector tool approved for reading is a read, unless the vendor says it writes or destroys.
 * - A destructive word in its name, or a lifecycle key it sets, makes it destructive.
 * - It is a change when any of its item argument paths names a present item (a name, `a.b` or
 *   `a[].b`, R19), and a create when none does. When the connector declares no item arguments, it
 *   is a change.
 * - In-house tools are classified here in code: agentx_submit_task is a change only while the
 *   thread has no prepared compute (D5); the other task tools read; publishing is a change; closing,
 *   replacing or reverting a pull request is destructive. Any other unknown tool is a change unless
 *   its name says it destroys. Without a worker (the gate passes a prepared one when the host says
 *   the thread's compute is prepared), agentx_submit_task and agentx_follow_up fail closed as a change.
 * - Arguments that are not a plain object make any call but a read-approved tool a change, so the
 *   classifier decides (fail closed).
 */
export function baseClass(name: string, facts: ToolFacts | undefined, args: Record<string, unknown>, worker?: { prepared(): boolean }): ActionClass {
  if (facts === undefined) {
    if (name === "agentx_submit_task") return worker !== undefined && worker.prepared() ? "read" : "change";
    if (name === "agentx_follow_up") return worker === undefined ? "change" : "read";
    if (IN_HOUSE_READS.has(name)) return "read";
    if (!isPlainObject(args)) return "change";
    if (name === "agentx_create_pull_request") return "change";
    if (name === "agentx_manage_pull_request") return DESTRUCTIVE_PULL_REQUEST_ACTIONS.has(String(args.action)) ? "destructive" : "change";
    return destructiveSignal(name, args) === undefined ? "change" : "destructive";
  }
  if (facts.access === "read" && facts.hints?.readOnlyHint !== false && facts.hints?.destructiveHint !== true) return "read";
  if (!isPlainObject(args)) return "change";
  if (destructiveSignal(facts.upstreamName, args, facts.itemArguments) !== undefined) return "destructive";
  if (facts.itemArguments === undefined) return "change";
  return facts.itemArguments.some((path) => itemPathValues(args, path).length > 0) ? "change" : "create";
}

/** The number of items a call touches: the length of its longest array, looking at most two levels into the arguments. */
export function itemCount(value: unknown, depth = 0): number {
  if (depth > 2) return 0;
  const children = Array.isArray(value) ? value : value !== null && typeof value === "object" ? Object.values(value as Record<string, unknown>) : [];
  // A loop, not Math.max(...children): spreading a very long array overflows the stack.
  let count = Array.isArray(value) ? value.length : 0;
  for (const child of children) count = Math.max(count, itemCount(child, depth + 1));
  return count;
}

/** Whether a rule names one exact tool: only such a rule may allow or reclassify a destructive or bulk call (FR-015, "explicitly"). */
function namesExactTool(rule: ActionPolicyRule): boolean {
  return !rule.tool.includes("*");
}

function ruleMatches(rule: ActionPolicyRule, name: string, facts: ToolFacts | undefined, args: Record<string, unknown>): boolean {
  if (rule.connector !== undefined) {
    if (facts?.connector !== rule.connector || !toolPatternMatches(rule.tool, facts.upstreamName)) return false;
  } else if (!toolPatternMatches(rule.tool, name)) {
    return false;
  }
  // whenArguments matches the call's own top-level argument names only, never nested or inherited keys.
  if (rule.whenArguments === undefined) return true;
  return isPlainObject(args) && rule.whenArguments.some((key) => Object.hasOwn(args, key) && isSet(args[key]));
}

/**
 * Classifies a call and settles it by rules, then by the built-in defaults. treatAs rules apply in
 * the order listed, the first match winning. Outcome rules apply deny, then ask, then allow,
 * whatever their order. A destructive or bulk call is allowed or reclassified only by a rule naming
 * its exact tool (no `*`); a wildcard deny or ask still applies to it. Undefined `settled` means
 * the classifier decides.
 */
export function evaluatePolicy(input: {
  name: string;
  args: Record<string, unknown>;
  facts?: ToolFacts | undefined;
  policy?: ActionPolicy | undefined;
  worker?: { prepared(): boolean } | undefined;
}): PolicyEvaluation {
  const rules = input.policy?.rules ?? [];
  const matching = rules.flatMap((rule, index) => ruleMatches(rule, input.name, input.facts, input.args) ? [{ rule, number: index + 1 }] : []);
  const items = itemCount(input.args);
  const guarded = (actionClass: ActionClass) => actionClass === "destructive" || (actionClass !== "read" && items > BULK_ITEM_LIMIT);
  const base = baseClass(input.name, input.facts, input.args, input.worker);
  const reclassified = matching.find(({ rule }) => rule.treatAs !== undefined && (!guarded(base) || namesExactTool(rule)));
  const actionClass = reclassified?.rule.treatAs ?? base;
  const evaluation: PolicyEvaluation = { actionClass, ...(reclassified === undefined ? {} : { classRule: reclassified.number }) };
  for (const outcome of ["deny", "ask", "allow"] as const) {
    const hit = matching.find(({ rule }) => rule.outcome === outcome && (outcome !== "allow" || !guarded(actionClass) || namesExactTool(rule)));
    if (hit) {
      return {
        ...evaluation,
        settled: {
          outcome, source: "rule", kind: outcome === "allow" ? "allowed" : "admin", rule: hit.number,
          reason: hit.rule.reason ?? `an administrator's ${outcome} rule matches ${hit.rule.tool}`,
        },
      };
    }
  }
  if (actionClass === "read") return { ...evaluation, settled: { outcome: "allow", source: "default", kind: "read", reason: "reads run without asking" } };
  if (actionClass === "destructive") {
    const signal = destructiveSignal(input.facts?.upstreamName ?? input.name, input.args, input.facts?.itemArguments);
    return { ...evaluation, settled: { outcome: "ask", source: "default", kind: "destructive", reason: `${signal === undefined ? "this action is destructive" : signal}; destructive actions always ask` } };
  }
  if (items > BULK_ITEM_LIMIT) {
    return { ...evaluation, settled: { outcome: "ask", source: "default", kind: "bulk", reason: `this write touches ${items} items; more than ${BULK_ITEM_LIMIT} always asks` } };
  }
  if (actionClass === "create") return { ...evaluation, settled: { outcome: "allow", source: "default", kind: "create", reason: "the call names no existing item, so it creates one" } };
  // destructiveHint only tightens a tool whose connector declares no item arguments. Vendors mark
  // ordinary writes destructive (an edit that overwrites a field), so where AgentX can see the item
  // a call names, its own classes decide; the hint speaks only where AgentX cannot tell (spec 014 D1).
  if (input.facts !== undefined && input.facts.itemArguments === undefined && input.facts.hints?.destructiveHint === true) {
    return { ...evaluation, settled: { outcome: "ask", source: "default", kind: "hint", reason: "the vendor marks this tool destructive and AgentX cannot tell what it changes" } };
  }
  return evaluation;
}
