import { createHash } from "node:crypto";
import type { ActionPolicy, ConnectorCatalog } from "@agentx/contracts";
import { ClassifierError, type ActionClassifier, type ClassifierUsage } from "./action-classifier.js";

export type { ActionClassifier } from "./action-classifier.js";
import { evaluatePolicy, itemReference, type ActionClass, type SettledAction, type ToolFacts } from "./action-policy.js";
import type { WorkerAccess } from "./orchestration-tools.js";

/** Why a call waits for a person. "yes to all" skips only classifier asks (FR-019, D4). */
export type AskKind = "classifier" | "destructive" | "admin" | "bulk" | "hint";

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
  onDecision?: ((decision: GateDecision) => void) | undefined;
  maxClassifierCalls?: number | undefined;
}

/** Bounds the classifier's cost and delay per turn; later unsettled writes ask. */
export const MAX_CLASSIFIER_CALLS_PER_TURN = 8;

export function createGateSession(requesterId: string, options: { approvals?: readonly GateApproval[]; yesToAll?: boolean } = {}): GateSession {
  return { requesterId, approvals: [...(options.approvals ?? [])], yesToAll: options.yesToAll ?? false, asks: [], decisions: [] };
}

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
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
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

/** What the model is told when a call is not run. */
export function blockReason(decision: GateDecision, session: GateSession, summary: string): string {
  if (decision.outcome === "deny") {
    return `Not run: ${decision.reason}. An administrator's rule blocks this action; do not retry it. Tell the member why.`;
  }
  const again = decision.differsFromConfirmation ? " Its arguments differ from the call they confirmed, so AgentX asked again." : "";
  return `Not run yet: AgentX asked <@${session.requesterId}> in the Slack thread to confirm ${summary}.${again} ` +
    "Do not call this tool again or try another way in this turn. Tell the member you are waiting for their confirmation.";
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
    const evaluation = evaluatePolicy({ name: call.toolName, args: call.input, facts, policy: this.options.policy, worker: this.options.worker });
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
      session.asks.push({ toolCallId: call.toolCallId, tool: call.toolName, argumentsHash: hash, summary: describeCall(call.toolName, call.input), kind: decision.kind as AskKind });
    }
    this.record(decision);
    return decision;
  }

  /** A gate failure blocks the call and is recorded; the tool never runs unchecked. */
  failed(call: { toolCallId: string; toolName: string; input: Record<string, unknown> }, error: unknown): GateDecision {
    const decision: GateDecision = {
      toolCallId: call.toolCallId, tool: call.toolName, actionClass: "change", outcome: "deny", source: "gate_error",
      reason: `AgentX could not check this action (${error instanceof Error ? error.name : "unknown error"})`, argumentsHash: argumentsHash(call.toolName, call.input),
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
    const limit = this.options.maxClassifierCalls ?? MAX_CLASSIFIER_CALLS_PER_TURN;
    if (this.classifierCalls >= limit) return unavailable(`this turn already used its ${limit} classifier checks`);
    this.classifierCalls += 1;
    const started = this.now();
    try {
      const verdict = await classifier({
        memberMessages: context.memberMessages(),
        call: { tool: call.toolName, summary: describeCall(call.toolName, call.input), arguments: call.input, ...(item === undefined ? {} : { item }) },
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const result = {
        outcome: verdict.decision, source: "classifier" as const, ...(verdict.decision === "ask" ? { kind: "classifier" as const } : {}),
        reason: verdict.reason, classifierMs: this.now() - started, ...(verdict.usage === undefined ? {} : { usage: verdict.usage }),
      };
      this.verdicts.set(hash, { outcome: result.outcome, source: result.source, ...(result.kind === undefined ? {} : { kind: result.kind }), reason: result.reason });
      return result;
    } catch (error) {
      // A model that answered unusably still cost something; record it with the decision.
      const usage = error instanceof ClassifierError && error.usage !== undefined ? { usage: error.usage } : {};
      return { ...unavailable(`the classifier could not decide: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`), classifierMs: this.now() - started, ...usage };
    }
  }
}
