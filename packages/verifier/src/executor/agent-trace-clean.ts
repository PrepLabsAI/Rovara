import { E2E_AGENT_TRACE_ANCHORS_MAX, E2E_AGENT_TRACE_ANCHOR_TEXT_MAX, E2E_AGENT_TRACE_SUMMARY, E2E_MODEL_ROUTE_DEFAULT_BUDGETS, e2eAgentValueDigest } from "@agentx/contracts";

/**
 * What a recording of an AI navigation step may keep (Task 4.6a, CAPTURE46): e2e's own `ActionTrace` reduced, field by field, to what the action ledger's rules allow, before it is
 * hidden, scanned, sized, written or uploaded.
 *
 * It is a whitelist, not a scrub. Whatever e2e adds to its trace in another release is dropped with the field, and a recording that holds anything this module does not know how to
 * keep is dropped whole (`undefined`): that can only lose a replay input, never change a verdict.
 *
 * Kept: the action names the ledger has (`tap`, `type`, `select`, `press`, `scroll`, `navigate`), each action's target as `{ role, name, testId }`, typed values (the caller applies the
 * goal-literal-or-keyed-digest rule to them), a key, a scroll direction and count, a same-origin path with no query or fragment, the run's provenance (digests and identifiers) and the
 * end anchors as postconditions. Replaced: every prose summary, by a fixed sentence (the recorded run's own is model text). Removed: a target's text, placeholder, selector, container,
 * position and input purpose; an anchor's selector, container, position and input purpose; the scroll `spans`. Refused (the trace is dropped): an off-origin URL, a query, a fragment or a
 * credential in a URL; any other action; a truncated recording; more anchors or longer anchor text than the owner's bound.
 */
type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

/** The ledger's own rule for an app path (`appRelativePath` in the contracts): one leading slash, no scheme or host, no query, no fragment. */
const APP_PATH = /^\/(?!\/)[^\s\\?#]*$/;
const KEY = /^[A-Za-z0-9+_ -]{1,32}$/;
const DIRECTIONS: ReadonlySet<string> = new Set(["up", "down", "left", "right"]);
const ANCHOR_STATES: ReadonlySet<string> = new Set(["checked", "expanded", "pressed", "selected"]);
const KEY_CONTEXT_STRINGS = ["cacheSchema", "policyVersion", "project", "platform", "engineName", "appIdentity", "agentContextDigest"] as const;
const PROVENANCE_STRINGS = ["testId", "targetId", "instructionDigest", "paramsDigest", "agent"] as const;
const IDENTIFIER_MAX = 600;
/** A literal the ledger would keep is at most this long (the contract's `valueLiteral`). */
const LITERAL_MAX = 256;
const TYPED_VALUE_MAX = 4096;
const ANCHORS_PER_SIDE = E2E_AGENT_TRACE_ANCHORS_MAX / 2;

export type TraceCleanOptions = {
  /** The application's origin: an absolute `navigate` URL is kept only when it is exactly this origin plus an app path. A relative path needs none. */
  origin?: string;
  /** The goals of the agent steps this process has run: an anchor's input value that is text of one is kept, any other becomes its keyed digest. */
  goals: readonly string[];
  /** The run's value key. Without one, a trace with an anchor value that is not goal text is dropped. */
  valueKey?: string;
};

const bounded = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length <= max ? value : undefined);

/** A target as `{ role, name, testId }`, or undefined when it holds none of them or one is out of bound. */
function cleanTarget(raw: unknown): Rec | undefined {
  if (!isRec(raw)) return undefined;
  const target: Rec = {};
  for (const field of ["role", "name", "testId"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    const text = bounded(value, E2E_AGENT_TRACE_ANCHOR_TEXT_MAX);
    if (text === undefined) return undefined;
    if (text !== "") target[field] = text;
  }
  return Object.keys(target).length === 0 ? undefined : target;
}

/** The anchor's own fields; its input value follows the goal-literal-or-keyed-digest rule at once. Undefined when it is out of bound or empty. */
function cleanAnchor(raw: unknown, options: TraceCleanOptions): Rec | undefined {
  if (!isRec(raw)) return undefined;
  const anchor: Rec = {};
  for (const field of ["role", "name", "text", "testId", "placeholder"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    const text = bounded(value, E2E_AGENT_TRACE_ANCHOR_TEXT_MAX);
    if (text === undefined) return undefined;
    if (text !== "") anchor[field] = text;
  }
  if (raw["states"] !== undefined) {
    if (!Array.isArray(raw["states"]) || raw["states"].some((state) => typeof state !== "string" || !ANCHOR_STATES.has(state))) return undefined;
    if (raw["states"].length > 0) anchor["states"] = [...raw["states"] as string[]];
  }
  if (raw["value"] !== undefined) {
    const value = bounded(raw["value"], E2E_AGENT_TRACE_ANCHOR_TEXT_MAX);
    if (value === undefined) return undefined;
    if (value !== "") {
      if (value.length <= LITERAL_MAX && options.goals.some((goal) => goal.includes(value))) anchor["value"] = value;
      else if (options.valueKey === undefined) return undefined;
      else anchor["value"] = `hmac-sha256:${e2eAgentValueDigest(options.valueKey, value)}`;
    }
  }
  return Object.keys(anchor).length === 0 ? undefined : anchor;
}

function cleanAnchors(raw: unknown, options: TraceCleanOptions): Rec[] | undefined {
  // e2e itself reads at most eight anchors a side, so a longer list could never replay; the owner's bound is the sixteen in all that the caller checks.
  if (!Array.isArray(raw) || raw.length > ANCHORS_PER_SIDE) return undefined;
  const anchors: Rec[] = [];
  for (const item of raw) {
    const anchor = cleanAnchor(item, options);
    if (anchor === undefined) return undefined;
    anchors.push(anchor);
  }
  return anchors;
}

/** A navigated URL as it may be kept: an app path, or exactly the application's origin followed by one. */
function cleanUrl(raw: unknown, origin: string | undefined): string | undefined {
  const url = bounded(raw, 600);
  if (url === undefined) return undefined;
  if (APP_PATH.test(url)) return url;
  if (origin === undefined) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  let expected: URL;
  try { expected = new URL(origin); } catch { return undefined; }
  if (parsed.origin !== expected.origin || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || !APP_PATH.test(parsed.pathname)) return undefined;
  // Spelled as the browser spelled it, so the kept URL is a plain concatenation of the origin and a path and nothing else.
  return url === `${parsed.origin}${parsed.pathname}` ? url : undefined;
}

function cleanAction(raw: unknown, options: TraceCleanOptions): Rec | undefined {
  if (!isRec(raw) || typeof raw["name"] !== "string") return undefined;
  const name = raw["name"];
  const summary = `The ${name} action.`;
  switch (name) {
    case "tap": {
      const target = cleanTarget(raw["target"]);
      return target === undefined ? undefined : { name, summary, target };
    }
    case "type": case "select": {
      const target = cleanTarget(raw["target"]);
      const value = bounded(raw["value"], TYPED_VALUE_MAX);
      return target === undefined || value === undefined ? undefined : { name, summary, target, value };
    }
    case "press": {
      const target = cleanTarget(raw["target"]);
      const key = bounded(raw["key"], 32);
      return target === undefined || key === undefined || !KEY.test(key) ? undefined : { name, summary, target, key };
    }
    case "scroll": {
      const direction = bounded(raw["direction"], 8);
      if (direction === undefined || !DIRECTIONS.has(direction)) return undefined;
      const action: Rec = { name, summary, direction };
      if (raw["target"] !== undefined) {
        const target = cleanTarget(raw["target"]);
        if (target === undefined) return undefined;
        action["target"] = target;
      }
      if (raw["times"] !== undefined) {
        const times = raw["times"];
        if (typeof times !== "number" || !Number.isInteger(times) || times < 1 || times > 50) return undefined;
        action["times"] = times;
      }
      return action;
    }
    case "navigate": {
      const url = cleanUrl(raw["url"], options.origin);
      return url === undefined ? undefined : { name, summary, url };
    }
    default: return undefined;
  }
}

/** The cleaned recording, or undefined when it cannot be kept. The input is not changed. */
export function cleanE2EAgentTrace(trace: unknown, options: TraceCleanOptions): Rec | undefined {
  if (!isRec(trace) || !Array.isArray(trace["actions"]) || trace["actions"].length > E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxActionsPerStep) return undefined;
  if (trace["truncated"] === true) return undefined;
  const actions: Rec[] = [];
  for (const raw of trace["actions"]) {
    const action = cleanAction(raw, options);
    if (action === undefined) return undefined;
    actions.push(action);
  }
  const cleaned: Rec = { actions, summary: E2E_AGENT_TRACE_SUMMARY };
  const executor = trace["executor"];
  if (!isRec(executor)) return undefined;
  const executorName = bounded(executor["name"], 120);
  const executorVersion = executor["version"] === undefined ? undefined : bounded(executor["version"], 60);
  if (executorName === undefined || executorName === "" || (executor["version"] !== undefined && executorVersion === undefined)) return undefined;
  cleaned["executor"] = executorVersion === undefined ? { name: executorName } : { name: executorName, version: executorVersion };
  if (trace["recordedFor"] !== undefined) {
    const raw = trace["recordedFor"];
    if (!isRec(raw)) return undefined;
    const recordedFor: Rec = {};
    for (const field of PROVENANCE_STRINGS) {
      if (raw[field] === undefined) { if (field === "paramsDigest" || field === "agent") continue; return undefined; }
      const value = bounded(raw[field], IDENTIFIER_MAX);
      if (value === undefined || value === "") return undefined;
      recordedFor[field] = value;
    }
    if (raw["callIndex"] !== undefined) {
      const callIndex = raw["callIndex"];
      if (typeof callIndex !== "number" || !Number.isInteger(callIndex) || callIndex < 0 || callIndex > 1000) return undefined;
      recordedFor["callIndex"] = callIndex;
    }
    cleaned["recordedFor"] = recordedFor;
  }
  for (const field of ["startPath", "endPath"] as const) {
    if (trace[field] === undefined) continue;
    const path = bounded(trace[field], 600);
    if (path === undefined || !APP_PATH.test(path)) return undefined;
    cleaned[field] = path;
  }
  let anchorCount = 0;
  for (const field of ["endAnchors", "goneAnchors"] as const) {
    if (trace[field] === undefined) continue;
    const anchors = cleanAnchors(trace[field], options);
    if (anchors === undefined) return undefined;
    anchorCount += anchors.length;
    cleaned[field] = anchors;
  }
  if (anchorCount > E2E_AGENT_TRACE_ANCHORS_MAX) return undefined;
  if (trace["endWaitMs"] !== undefined) {
    const wait = trace["endWaitMs"];
    if (typeof wait !== "number" || !Number.isInteger(wait) || wait < 0 || wait > 120_000) return undefined;
    cleaned["endWaitMs"] = wait;
  }
  if (trace["keyedBy"] !== undefined) {
    const raw = trace["keyedBy"];
    if (!isRec(raw)) return undefined;
    const keyedBy: Rec = {};
    for (const field of KEY_CONTEXT_STRINGS) {
      const value = bounded(raw[field], IDENTIFIER_MAX);
      if (value === undefined || value === "") return undefined;
      keyedBy[field] = value;
    }
    const spi = raw["engineSpiVersion"];
    if (typeof spi !== "number" || !Number.isInteger(spi) || spi < 0 || spi > 1000) return undefined;
    keyedBy["engineSpiVersion"] = spi;
    cleaned["keyedBy"] = keyedBy;
  }
  return cleaned;
}
