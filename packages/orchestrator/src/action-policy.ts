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
  "state", "stateId", "status", "statusId", "resolution", "transition", "transitionId", "transitionName", "archived", "closed", "completed", "trashed", "duplicateOf",
]);

const IN_HOUSE_READS: ReadonlySet<string> = new Set(["agentx_follow_up", "agentx_task_status", "agentx_task_result"]);
const DESTRUCTIVE_PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set(["close", "replace", "revert"]);

/** The words of a tool name: split at underscores, hyphens and lower-to-upper case changes, lowercased. */
export function nameWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(/[\s_-]+/u).filter(Boolean).map((word) => word.toLowerCase());
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * The lifecycle key a call sets: at the top level, inside an object argument (such as `fields`), or
 * inside an object that holds one of the tool's nested item paths (each object of `tasks[]` for
 * `tasks[].task`, R19). Reads no deeper than those paths' own steps.
 */
function lifecycleKeySet(args: Record<string, unknown>, itemArguments: readonly string[] = []): string | undefined {
  for (const [key, value] of Object.entries(args)) {
    if (LIFECYCLE_KEYS.has(key) && isSet(value)) return key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (LIFECYCLE_KEYS.has(inner) && isSet(innerValue)) return `${key}.${inner}`;
      }
    }
  }
  for (const path of itemArguments) {
    const cut = path.lastIndexOf(".");
    // A top-level path's holder is the arguments themselves, already read above.
    if (cut < 0) continue;
    for (const holder of itemPathHolders(args, path)) {
      for (const [key, value] of Object.entries(holder)) {
        if (LIFECYCLE_KEYS.has(key) && isSet(value)) return `${path.slice(0, cut)}.${key}`;
      }
    }
  }
  return undefined;
}

/** Why a call is destructive, or undefined: a destructive word in the tool's name, or a lifecycle key it sets. */
export function destructiveSignal(toolName: string, args: Record<string, unknown>, itemArguments?: readonly string[]): string | undefined {
  const word = nameWords(toolName).find((entry) => DESTRUCTIVE_WORDS.has(entry));
  if (word !== undefined) return `the tool's name says "${word}"`;
  const key = lifecycleKeySet(args, itemArguments);
  return key === undefined ? undefined : `the call sets "${key}"`;
}

/** The existing items a call names, as `path=value` (several values joined by commas), when the connector declares how. */
export function itemReference(facts: ToolFacts | undefined, args: Record<string, unknown>): string | undefined {
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
 *   its name says it destroys.
 */
export function baseClass(name: string, facts: ToolFacts | undefined, args: Record<string, unknown>, worker?: { prepared(): boolean }): ActionClass {
  if (facts === undefined) {
    if (name === "agentx_submit_task") return worker !== undefined && !worker.prepared() ? "change" : "read";
    if (IN_HOUSE_READS.has(name)) return "read";
    if (name === "agentx_create_pull_request") return "change";
    if (name === "agentx_manage_pull_request") return DESTRUCTIVE_PULL_REQUEST_ACTIONS.has(String(args.action)) ? "destructive" : "change";
    return destructiveSignal(name, args) === undefined ? "change" : "destructive";
  }
  if (facts.access === "read" && facts.hints?.readOnlyHint !== false && facts.hints?.destructiveHint !== true) return "read";
  if (destructiveSignal(facts.upstreamName, args, facts.itemArguments) !== undefined) return "destructive";
  if (facts.itemArguments === undefined) return "change";
  return facts.itemArguments.some((path) => itemPathValues(args, path).length > 0) ? "change" : "create";
}

/** The number of items a call touches: the length of its longest array, looking at most two levels into the arguments. */
export function itemCount(value: unknown, depth = 0): number {
  if (depth > 2) return 0;
  const children = Array.isArray(value) ? value : value !== null && typeof value === "object" ? Object.values(value as Record<string, unknown>) : [];
  return Math.max(Array.isArray(value) ? value.length : 0, ...children.map((child) => itemCount(child, depth + 1)));
}

function ruleMatches(rule: ActionPolicyRule, name: string, facts: ToolFacts | undefined, args: Record<string, unknown>): boolean {
  if (rule.connector !== undefined) {
    if (facts?.connector !== rule.connector || !toolPatternMatches(rule.tool, facts.upstreamName)) return false;
  } else if (!toolPatternMatches(rule.tool, name)) {
    return false;
  }
  return rule.whenArguments === undefined || rule.whenArguments.some((key) => isSet(args[key]));
}

/**
 * Classifies a call and settles it by rules, then by the built-in defaults. treatAs rules apply in
 * the order listed, the first match winning. Outcome rules apply deny, then ask, then allow,
 * whatever their order. Undefined `settled` means the classifier decides.
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
  const reclassified = matching.find(({ rule }) => rule.treatAs !== undefined);
  const actionClass = reclassified?.rule.treatAs ?? baseClass(input.name, input.facts, input.args, input.worker);
  const evaluation: PolicyEvaluation = { actionClass, ...(reclassified === undefined ? {} : { classRule: reclassified.number }) };
  for (const outcome of ["deny", "ask", "allow"] as const) {
    const hit = matching.find(({ rule }) => rule.outcome === outcome);
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
  const items = itemCount(input.args);
  if (items > BULK_ITEM_LIMIT) {
    return { ...evaluation, settled: { outcome: "ask", source: "default", kind: "bulk", reason: `this write touches ${items} items; more than ${BULK_ITEM_LIMIT} always asks` } };
  }
  if (actionClass === "create") return { ...evaluation, settled: { outcome: "allow", source: "default", kind: "create", reason: "the call names no existing item, so it creates one" } };
  if (input.facts !== undefined && input.facts.itemArguments === undefined && input.facts.hints?.destructiveHint === true) {
    return { ...evaluation, settled: { outcome: "ask", source: "default", kind: "hint", reason: "the vendor marks this tool destructive and AgentX cannot tell what it changes" } };
  }
  return evaluation;
}
