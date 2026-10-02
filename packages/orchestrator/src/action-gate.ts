import { createHash } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { redactText, type ActionPolicy, type ConnectorCatalog } from "@agentx/contracts";
import { ClassifierError, usableClassifierTimeout, type ActionClassifier, type ClassifierUsage, type ClassifierVerdict } from "./action-classifier.js";

export type { ActionClassifier } from "./action-classifier.js";
import { evaluatePolicy, itemReference, type ActionClass, type SettledAction, type ToolFacts } from "./action-policy.js";
import type { WorkerAccess } from "./orchestration-tools.js";

/**
 * Why a call waits for a person. "yes to all" skips only classifier asks (FR-019, D4).
 * `unchecked` (#215): the classifier could not check the call (none configured, it failed, or the
 * turn used its checks), so the member is asked without being told AgentX doubts the request.
 * A decision still records such an ask as `classifier`; only the ask and its confirmation differ.
 * `deny` (owner decision 2026-10-02): the classifier judged the member did not ask for this at all,
 * which is a stronger doubt than an ordinary `classifier` ask; the gate still only asks, since only
 * an administrator's rule can deny a call outright.
 */
export type AskKind = "classifier" | "unchecked" | "destructive" | "admin" | "bulk" | "hint" | "deny";

/** A call the requester confirmed with "yes": it runs once, with exactly these arguments. */
export interface GateApproval { tool: string; argumentsHash: string; summary: string }

/** A call the gate blocked until the requester confirms it. */
export interface PendingAsk { toolCallId: string; tool: string; argumentsHash: string; summary: string; kind: AskKind }

export type DecisionSource = "confirmation" | "rule" | "default" | "yes_to_all" | "classifier" | "classifier_unavailable" | "gate_error";

/** One gate decision, recorded for every tool call (FR-021). */
export interface GateDecision {
  toolCallId: string;
  tool: string;
  connector?: string;
  actionClass: ActionClass;
  outcome: "allow" | "ask" | "deny";
  source: DecisionSource;
  kind?: AskKind | SettledAction["kind"];
  reason: string;
  /** The 1-based action policy rule that decided, or that set the class. */
  rule?: number;
  argumentsHash: string;
  /** The requester confirmed this tool with other arguments, so the gate evaluated it afresh. */
  differsFromConfirmation?: true;
  classifierMs?: number;
  usage?: ClassifierUsage;
}

/** One Slack turn's gate state. The Slack service sets it up; the gate fills in asks and decisions. */
export interface GateSession {
  requesterId: string;
  approvals: GateApproval[];
  /** The requester said "yes to all in this thread". */
  yesToAll: boolean;
  asks: PendingAsk[];
  decisions: GateDecision[];
  /**
   * Tool calls this turn that the gate let through and that then ran, whether they succeeded or
   * failed. The Slack service lets a confirmation stand as the whole reply only when none did.
   */
  ran: number;
}

export interface ActionGateOptions {
  session: GateSession;
  policy?: ActionPolicy | undefined;
  /** Absent, every write no rule settles asks. */
  classifier?: ActionClassifier | undefined;
  /** Connector tools by presented name, from this turn's catalogs. */
  facts: ReadonlyMap<string, ToolFacts>;
  /** The thread's lazy worker (spec 014 phase 14b), present only while the thread has no prepared compute. */
  worker?: WorkerAccess | undefined;
  /**
   * The host's positive signal that this thread's compute is already prepared (spec 014 D5): then
   * agentx_submit_task and agentx_follow_up run as reads. Used only when no worker is given (a
   * worker's own prepared() wins); absent with no worker, they fail closed as a change.
   */
  computePrepared?: boolean | undefined;
  onDecision?: ((decision: GateDecision) => void) | undefined;
  maxClassifierCalls?: number | undefined;
  /** The gate's own deadline for one classifier check: the configured classifier timeout, else 8 seconds. */
  classifierTimeoutMs?: number | undefined;
}

/** Stands in for the worker when the host says the thread's compute is already prepared. */
const PREPARED_COMPUTE = { prepared: () => true };

/** Bounds the classifier's cost and delay per turn; later unsettled writes ask. */
export const MAX_CLASSIFIER_CALLS_PER_TURN = 8;

export function createGateSession(requesterId: string, options: { approvals?: readonly GateApproval[]; yesToAll?: boolean } = {}): GateSession {
  return { requesterId, approvals: [...(options.approvals ?? [])], yesToAll: options.yesToAll ?? false, asks: [], decisions: [], ran: 0 };
}

// The hash assumes JSON-shaped tool input (what a model's tool call carries): a cycle or a BigInt
// throws, and values JSON cannot represent (functions, symbols) are dropped or become null.
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => [key, sortedKeys(record[key])]));
}

/** A call's identity for confirmation: the tool and its arguments, independent of key order. */
export function argumentsHash(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([tool, sortedKeys(args)])).digest("hex");
}

/** What the gate knows about each connector tool this turn offers. */
export function connectorToolFacts(catalogs: readonly ConnectorCatalog[]): Map<string, ToolFacts> {
  return new Map(catalogs.flatMap((catalog) => catalog.tools.map((tool) => [tool.name, {
    connector: catalog.connector, upstreamName: tool.upstreamName, access: tool.access,
    ...(tool.hints === undefined ? {} : { hints: tool.hints }),
    ...(tool.itemArguments === undefined ? {} : { itemArguments: tool.itemArguments }),
  }] as const)));
}

/** The members' own messages from a session branch: user messages only, never tool results or AgentX's replies. */
export function memberMessages(entries: readonly unknown[]): string[] {
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { type, message } = entry as { type?: unknown; message?: unknown };
    if (type !== "message" || !message || typeof message !== "object") return [];
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "user") return [];
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((block: unknown) => {
            const part = block as { type?: unknown; text?: unknown } | null;
            return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
          }).join("\n")
        : "";
    return text.trim().length > 0 ? [text] : [];
  });
}

const SLACK_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Text safe inside a Slack message: one line, no backticks, and no mentions or links it could smuggle in. */
function slackSafe(text: string, limit: number): string {
  const flat = text.replace(/[`\s]+/gu, " ").replace(/[&<>]/gu, (character) => SLACK_ESCAPES[character] ?? character).trim();
  // A cut never leaves half an escape such as `&am`.
  return flat.length > limit ? `${flat.slice(0, limit - 1).replace(/&[a-z]{0,3}$/u, "")}…` : flat;
}

const SHOWN_ARGUMENTS = 6;

/** The action and its target, for the confirmation message: the tool, its target and its first arguments. */
export function describeCall(tool: string, args: Record<string, unknown>): string {
  const { target, ...rest } = args;
  const entries = Object.entries(rest).filter(([, value]) => value !== undefined && value !== null);
  const shown = entries.slice(0, SHOWN_ARGUMENTS).map(([key, value]) => {
    if (typeof value === "string") return value.length > 80 ? `${key}=(${value.length} characters)` : `${key}=${value}`;
    if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`;
    return Array.isArray(value) ? `${key}=(${value.length} items)` : `${key}=(object)`;
  });
  const more = entries.length > SHOWN_ARGUMENTS ? `, and ${entries.length - SHOWN_ARGUMENTS} more` : "";
  const where = typeof target === "string" ? ` in ${target}` : "";
  return slackSafe(`${tool}${where}${shown.length > 0 ? `: ${shown.join(", ")}${more}` : ""}`, 300);
}

const PROMPT_SHOWN = 200;
const VALUE_SHOWN = 80;

/**
 * A value shortened for a person to read: never a count of its characters (#215). Redacted first:
 * the text is posted in the thread and stored with the confirmation.
 */
function shortened(text: string, limit: number): string {
  const flat = redactText(text).replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** An identifier in words: `close_item`, `createIssue` and `pull-request` become "close item", "create issue", "pull request". */
function words(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_\-.]+/gu, " ").trim().toLowerCase();
}

/** What each pull request action does, as the start of a sentence. */
const PULL_REQUEST_VERBS: Readonly<Record<string, string>> = {
  edit: "Edit", append: "Push the new commits to", sync: "Update", close: "Close", reopen: "Reopen", replace: "Replace", revert: "Revert",
};

function quoted(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? `"${shortened(value, limit)}"` : undefined;
}

function inHouseAction(tool: string, args: Record<string, unknown>): string | undefined {
  const prompt = quoted(args.prompt, PROMPT_SHOWN);
  const repository = typeof args.repository === "string" ? ` in ${shortened(args.repository, VALUE_SHOWN)}` : "";
  const title = quoted(args.title, VALUE_SHOWN);
  switch (tool) {
    case "agentx_submit_task": return `Start a coding task${prompt === undefined ? "" : `: ${prompt}`}`;
    case "agentx_follow_up": return `Continue the coding task${prompt === undefined ? "" : `: ${prompt}`}`;
    case "agentx_create_pull_request": return `Open a pull request${repository}${title === undefined ? "" : `: ${title}`}`;
    case "agentx_manage_pull_request": {
      const action = typeof args.action === "string" ? args.action : "";
      const number = typeof args.pullRequestNumber === "number" ? ` #${args.pullRequestNumber}` : "";
      const verb = PULL_REQUEST_VERBS[action] ?? `${words(action) || "Change"}`;
      const tail = action === "sync" ? " with its base branch" : "";
      const titled = (action === "edit" || action === "replace" || action === "revert") && title !== undefined ? `: ${title}` : "";
      return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} pull request${number}${repository}${tail}${titled}`;
    }
    case "agentx_task_status": return "Check the status of an earlier coding task";
    case "agentx_task_result": return "Get the result of an earlier coding task";
    default: return undefined;
  }
}

/** One argument for a person: its name in words and its value, shortened, never counted in characters. */
function shownArgument(key: string, value: unknown): string {
  const name = words(key);
  if (typeof value === "string") return `${name} ${shortened(value, VALUE_SHOWN)}`;
  if (typeof value === "number" || typeof value === "boolean") return `${name} ${String(value)}`;
  if (Array.isArray(value)) return `${name} ${value.length} item${value.length === 1 ? "" : "s"}`;
  return `${name} (details)`;
}

/**
 * #215: what a blocked call will do, in plain words, for the member's confirmation. It never shows
 * a tool's name or a count of characters: coding work shows its prompt (shortened when long), pull
 * request work says what happens to which pull request, and a connector's action reads as
 * "Use <connector> to <action in words>" with its arguments' values. One Slack-safe line.
 */
export function describeAction(tool: string, args: Record<string, unknown>): string {
  const inHouse = inHouseAction(tool, args);
  if (inHouse !== undefined) return slackSafe(inHouse, 300);
  const { target, ...rest } = args;
  const entries = Object.entries(rest).filter(([, value]) => value !== undefined && value !== null);
  const shown = entries.slice(0, SHOWN_ARGUMENTS).map(([key, value]) => shownArgument(key, value));
  const more = entries.length > SHOWN_ARGUMENTS ? `, and ${entries.length - SHOWN_ARGUMENTS} more` : "";
  const where = typeof target === "string" ? ` in ${target}` : "";
  const split = tool.indexOf("__");
  // An in-house tool not described above is never named, even in words.
  const action = split > 0 ? `Use ${tool.slice(0, split)} to ${words(tool.slice(split + 2))}` : tool.startsWith("agentx_") ? "Run an AgentX action" : `Run ${words(tool)}`;
  return slackSafe(`${action}${where}${shown.length > 0 ? `: ${shown.join(", ")}${more}` : ""}`, 300);
}

/** Told to the model when the gate itself could not decide or record a call: fixed words, no error text. */
export const GATE_FAILURE_REASON = "Not run: AgentX could not check this action. Do not retry it in this turn. Tell the member AgentX could not check it.";

/**
 * What the model is told when a call is not run. A gate failure's recorded reason (with the error's
 * name) stays out of it, and an ask names no tool or argument value: AgentX has already posted the
 * confirmation to the member, so the model must not restate it (the member would read it twice).
 */
export function blockReason(decision: GateDecision): string {
  if (decision.source === "gate_error") return GATE_FAILURE_REASON;
  if (decision.outcome === "deny") {
    return `Not run: ${decision.reason}. An administrator's rule blocks this action; do not retry it. Tell the member why.`;
  }
  const again = decision.differsFromConfirmation ? " Its arguments differ from the call they confirmed, so AgentX asked again." : "";
  return "Not run yet: AgentX has already posted a confirmation request for this action to the member in the Slack thread, with Approve and Cancel buttons." +
    `${again} Do not call this tool again or try another way in this turn. ` +
    "Do not restate, summarise or mention this action, its details or the confirmation in your reply: the member already sees the request. " +
    "Report only anything else you did or found in this turn.";
}

/** A failure path must not throw: arguments that are not JSON-shaped get a fixed hash. */
function safeHash(tool: string, args: Record<string, unknown>): string {
  try {
    return argumentsHash(tool, args);
  } catch {
    return "unhashable";
  }
}

/** Why the gate stopped waiting for the classifier: its own deadline or the turn's cancellation. */
class GateWaitError extends Error {}

/** A usable verdict: exactly "allow", "ask" or "deny", with a reason. Anything else is treated as a failure. */
function usableVerdict(verdict: unknown): ClassifierVerdict | undefined {
  if (!verdict || typeof verdict !== "object") return undefined;
  const { decision, reason } = verdict as { decision?: unknown; reason?: unknown };
  if ((decision !== "allow" && decision !== "ask" && decision !== "deny") || typeof reason !== "string") return undefined;
  return verdict as ClassifierVerdict;
}

/** One turn's gate: rules, then defaults, then the classifier; confirmations and "yes to all" from the session. */
export class ActionGate {
  private classifierCalls = 0;
  private readonly verdicts = new Map<string, Pick<GateDecision, "outcome" | "source" | "kind" | "reason">>();
  /** The confirmations this turn started with, to tell the model when a call differs from them. */
  private readonly confirmed: readonly GateApproval[];

  constructor(private readonly options: ActionGateOptions, private readonly now: () => number = Date.now) {
    this.confirmed = [...options.session.approvals];
  }

  async decide(
    call: { toolCallId: string; toolName: string; input: Record<string, unknown> },
    context: { memberMessages: () => readonly string[]; signal?: AbortSignal | undefined },
  ): Promise<GateDecision> {
    const { session } = this.options;
    const facts = this.options.facts.get(call.toolName);
    const hash = argumentsHash(call.toolName, call.input);
    const evaluation = evaluatePolicy({ name: call.toolName, args: call.input, facts, policy: this.options.policy,
      // Fail closed: a present worker always decides; computePrepared applies only without one.
      worker: this.options.worker ?? (this.options.computePrepared === true ? PREPARED_COMPUTE : undefined) });
    const base = {
      toolCallId: call.toolCallId, tool: call.toolName, ...(facts === undefined ? {} : { connector: facts.connector }),
      actionClass: evaluation.actionClass, argumentsHash: hash, ...(evaluation.classRule === undefined ? {} : { rule: evaluation.classRule }),
    };
    const approval = session.approvals.findIndex((entry) => entry.tool === call.toolName && entry.argumentsHash === hash);
    const differs = this.confirmed.some((entry) => entry.tool === call.toolName) && !this.confirmed.some((entry) => entry.argumentsHash === hash)
      ? { differsFromConfirmation: true as const }
      : {};
    let decision: GateDecision;
    if (approval >= 0 && evaluation.settled?.outcome !== "deny") {
      session.approvals.splice(approval, 1);
      decision = { ...base, outcome: "allow", source: "confirmation", reason: `<@${session.requesterId}> confirmed this call` };
    } else if (evaluation.settled) {
      const { outcome, source, kind, reason, rule } = evaluation.settled;
      decision = { ...base, ...differs, outcome, source, kind, reason, ...(rule === undefined ? {} : { rule }) };
    } else if (session.yesToAll) {
      decision = { ...base, outcome: "allow", source: "yes_to_all", reason: "the member said yes to all in this thread" };
    } else {
      decision = { ...base, ...differs, ...await this.classify(call, hash, context, itemReference(facts, call.input)) };
    }
    if (decision.outcome === "ask") {
      // #215: the member reads the ask, so it says what will happen in words; the classifier still
      // reads describeCall. A classifier that answered "ask" doubts the request; one that answered
      // "deny" is sure the member did not ask for it, which reads a stronger note in Slack (owner
      // decision 2026-10-02); one that failed, or answered anything else, checked nothing, so it is
      // unchecked.
      const kind = decision.source === "classifier_unavailable" ? "unchecked" : decision.kind as AskKind;
      session.asks.push({ toolCallId: call.toolCallId, tool: call.toolName, argumentsHash: hash, summary: describeAction(call.toolName, call.input), kind });
    }
    this.record(decision);
    return decision;
  }

  /** A gate failure blocks the call and is recorded; the tool never runs unchecked. */
  failed(call: { toolCallId: string; toolName: string; input: Record<string, unknown> }, error: unknown): GateDecision {
    const decision: GateDecision = {
      toolCallId: call.toolCallId, tool: call.toolName, actionClass: "change", outcome: "deny", source: "gate_error",
      reason: `AgentX could not check this action (${error instanceof Error ? error.name : "unknown error"})`, argumentsHash: safeHash(call.toolName, call.input),
    };
    this.record(decision);
    return decision;
  }

  private record(decision: GateDecision): void {
    this.options.session.decisions.push(decision);
    try {
      this.options.onDecision?.(decision);
    } catch {
      // Logging a decision must never change it.
    }
  }

  private async classify(
    call: { toolName: string; input: Record<string, unknown> },
    hash: string,
    context: { memberMessages: () => readonly string[]; signal?: AbortSignal | undefined },
    item: string | undefined,
  ): Promise<Pick<GateDecision, "outcome" | "source" | "kind" | "reason" | "classifierMs" | "usage">> {
    const cached = this.verdicts.get(hash);
    if (cached) return cached;
    const unavailable = (reason: string) => ({ outcome: "ask" as const, source: "classifier_unavailable" as const, kind: "classifier" as const, reason });
    const classifier = this.options.classifier;
    if (!classifier) return unavailable("no classifier is configured");
    const configured = this.options.maxClassifierCalls;
    const limit = configured !== undefined && Number.isInteger(configured) && configured >= 0 ? configured : MAX_CLASSIFIER_CALLS_PER_TURN;
    if (this.classifierCalls >= limit) return unavailable(`this turn already used its ${limit} classifier checks`);
    this.classifierCalls += 1;
    const started = this.now();
    // The gate keeps its own deadline and honours the turn's cancellation, whatever the classifier does.
    const deadlineMs = usableClassifierTimeout(this.options.classifierTimeoutMs);
    const controller = new AbortController();
    const signal = context.signal === undefined ? controller.signal : AbortSignal.any([context.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GateWaitError(`it did not answer within ${deadlineMs} ms`));
      }, deadlineMs);
      onAbort = () => {
        controller.abort();
        reject(new GateWaitError("the turn was cancelled"));
      };
      if (context.signal?.aborted) onAbort();
      else context.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (context.signal?.aborted) await stop;
      const answer = await Promise.race([classifier({
        memberMessages: context.memberMessages(),
        call: { tool: call.toolName, summary: describeCall(call.toolName, call.input), arguments: call.input, ...(item === undefined ? {} : { item }) },
        // Without a turn signal the input carries none, as before; the gate's deadline still bounds the wait.
        ...(context.signal === undefined ? {} : { signal }),
      }), stop]);
      const verdict = usableVerdict(answer);
      if (!verdict) {
        const usage = (answer as { usage?: ClassifierUsage } | undefined)?.usage;
        return { ...unavailable("the classifier could not decide: its verdict was not allow, ask or deny"), classifierMs: this.now() - started, ...(usage === undefined ? {} : { usage }) };
      }
      // A deny verdict still only asks: only an administrator's rule can deny a call outright. Its
      // kind marks the stronger doubt for the member's confirmation (owner decision 2026-10-02).
      const outcome: "allow" | "ask" = verdict.decision === "allow" ? "allow" : "ask";
      const kind: "classifier" | "deny" | undefined = verdict.decision === "ask" ? "classifier" : verdict.decision === "deny" ? "deny" : undefined;
      const result = {
        outcome, source: "classifier" as const, ...(kind === undefined ? {} : { kind }),
        reason: verdict.reason, classifierMs: this.now() - started, ...(verdict.usage === undefined ? {} : { usage: verdict.usage }),
      };
      this.verdicts.set(hash, { outcome: result.outcome, source: result.source, ...(result.kind === undefined ? {} : { kind: result.kind }), reason: result.reason });
      return result;
    } catch (error) {
      // A model that answered unusably still cost something; record it with the decision. Only the
      // classifier's own messages are shown: another error's message could carry anything.
      const usage = error instanceof ClassifierError && error.usage !== undefined ? { usage: error.usage } : {};
      const reason = error instanceof ClassifierError || error instanceof GateWaitError
        ? `the classifier could not decide: ${error.message.slice(0, 120)}`
        : `the classifier could not decide (${error instanceof Error ? error.name : "unknown error"})`;
      return { ...unavailable(reason), classifierMs: this.now() - started, ...usage };
    } finally {
      clearTimeout(timer);
      if (onAbort) context.signal?.removeEventListener("abort", onAbort);
      // The stop promise may reject after the race is settled; that rejection is expected.
      stop.catch(() => undefined);
    }
  }
}

/** The custom message type of the gate's note to the model. */
export const GATE_MESSAGE_TYPE = "agentx-action-gate";

/** Told to the model at the start of a turn in which the requester confirmed calls. */
export function confirmationNote(session: GateSession): string | undefined {
  if (session.approvals.length === 0) return undefined;
  return [
    `<@${session.requesterId}> confirmed the action${session.approvals.length === 1 ? "" : "s"} AgentX asked about:`,
    // The summary is in words for the member (#215), so the model is also told each call's tool.
    ...session.approvals.map((approval, index) => `${index + 1}. ${approval.summary} (tool ${approval.tool})`),
    "Call each confirmed tool again now with exactly the same arguments as before. AgentX runs only an exact match, once; any other call is checked afresh.",
  ].join("\n");
}

/**
 * The gate as a hidden Pi extension. Pi runs `tool_call` for every tool call, in-house or
 * connector, before the tool executes; sibling calls in one assistant message are checked one
 * after another. A handler that throws also blocks the call, but Pi then shows the model the
 * error's message, so this handler never throws: every failure blocks with fixed words.
 */
export function actionGateExtension(options: ActionGateOptions): InlineExtension {
  const gate = new ActionGate(options);
  return {
    name: "agentx-action-gate",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", () => {
        const content = confirmationNote(options.session);
        return content === undefined ? undefined : { message: { customType: GATE_MESSAGE_TYPE, content, display: false } };
      });
      // A blocked call also ends (as an error), so only calls the gate let through count as ran.
      const blocked = new Set<string>();
      pi.on("tool_execution_end", (event) => {
        if (!blocked.has(event.toolCallId)) options.session.ran += 1;
      });
      pi.on("tool_call", async (event, ctx) => {
        const verdict = await check(event, ctx);
        if (verdict !== undefined) blocked.add(event.toolCallId);
        return verdict;
      });
      const check = async (event: { toolCallId: string; toolName: string; input: unknown }, ctx: { sessionManager: { getBranch(): Parameters<typeof memberMessages>[0] }; signal?: AbortSignal | undefined }) => {
        try {
          const call = { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input as Record<string, unknown> };
          let decision: GateDecision;
          try {
            decision = await gate.decide(call, { memberMessages: () => memberMessages(ctx.sessionManager.getBranch()), signal: ctx.signal });
          } catch (error) {
            decision = gate.failed(call, error);
          }
          if (decision.outcome === "allow") return undefined;
          if (decision.outcome === "ask" || decision.outcome === "deny") {
            return { block: true, reason: blockReason(decision) };
          }
          return { block: true, reason: GATE_FAILURE_REASON };
        } catch {
          return { block: true, reason: GATE_FAILURE_REASON };
        }
      };
    },
  };
}
