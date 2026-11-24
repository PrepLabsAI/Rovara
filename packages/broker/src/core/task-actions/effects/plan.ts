// S1: deciding the document a task waits on (a plan, the requirements or a design) as registry effects: approve, request changes, reject. The decision goes through the SAME approval gate as the web's, with the chat's method
// (`chat-slack`): the live person, the task's owner by the `owner` rule, the project grant, the risk ladder and the stale-revision refusal are the gate's. This file only turns the registry's press into the gate's request, with what
// the person saw (revision and document digest). Cut 1 offers low and medium risk only: a high risk document is decided on the web until the second cut.
import { agentXError, type ActionBinding, type ActionValues, type ConfirmLines, type InputField, type TaskActionRisk } from "@agentx/contracts";
import { currentDocumentType, waitingDocumentDigest } from "../../decisions/workflow-subject.js";
import type { TaskRecord } from "../../task-flow/records.js";
import type { ActionEnv, ActionCaller, Description, PlanFacts, PressContext, Performed } from "../types.js";
import { inert, listOf, textOf } from "./values.js";
import { taskIsOpen } from "./moves.js";

/** What a plan decision refused for, as the registry's reasons: the gate's own words are never shown. */
const REFUSAL_REASON: Record<string, "stale" | "not_yours" | "not_offered"> = {
  stale: "stale", not_found: "stale", not_waiting: "stale", expired: "stale", invalid_outcome: "not_offered", unsupported: "not_offered", invalid: "not_offered",
  // The chat's method is not offered for this document or this risk (a high risk plan is decided on the web): the move is not on offer.
  method_not_allowed: "not_offered",
};
function refusalOf(reason: string): Error {
  const mapped = REFUSAL_REASON[reason] ?? "not_yours";
  const code = mapped === "stale" ? "TASK_ACTION_STALE" : mapped === "not_offered" ? "TASK_ACTION_NOT_OFFERED" : "FORBIDDEN";
  return agentXError(code, "the decision was not taken", { reason: mapped, writes: "none" });
}

const documentWaiting = (task: TaskRecord) => {
  const workflow = task.workflow;
  if (!taskIsOpen(task) || workflow === undefined || workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return undefined;
  const digest = waitingDocumentDigest(workflow);
  return digest === undefined ? undefined : { workflow, digest };
};

/**
 * The plan entries are offered while the document waits. With a person (a press, a describe) the card's facts are asked as that person: a high risk document is not offered in this cut, and a person who may not decide it is
 * offered nothing. Without one (the card the thread is given) the state alone decides, and the card's own writer leaves a high risk document without buttons.
 */
export async function planWhen(env: ActionEnv, task: TaskRecord, caller: ActionCaller | undefined): Promise<ActionBinding | undefined> {
  const waiting = documentWaiting(task);
  if (waiting === undefined || env.plan === undefined) return undefined;
  if (caller !== undefined) {
    const facts = await env.plan.facts(caller, task).catch(() => undefined);
    if (facts === undefined || facts.risk === "high") return undefined;
  }
  return { revision: waiting.workflow.revision, digest: waiting.digest };
}

/** A limit-raising approval: the run limit approving sets is above the one the task has. */
export const raisesLimit = (facts: PlanFacts | undefined): boolean => facts?.runLimit !== undefined && facts.runLimit.proposedUsd > (facts.runLimit.currentUsd ?? 0);

export const planApproveRisk = (_task: TaskRecord, _values: ActionValues, facts?: PlanFacts): TaskActionRisk => (raisesLimit(facts) ? "money" : "routine");

function optionalChecks(task: TaskRecord): InputField | undefined {
  const policy = task.workflow?.checkPolicy;
  if (policy === undefined || policy.optional.length === 0 || currentDocumentType(task.workflow!) !== "plan") return undefined;
  return { kind: "pick-many", id: "checks", label: "Optional checks to run", min: 0, max: Math.min(100, policy.optional.length),
    options: policy.optional.map((check) => ({ value: check.id, label: inert(check.label, 100), selected: policy.selectedOptionalIds.includes(check.id) })) };
}

const dollars = (usd: number): string => `$${usd.toFixed(2)}`;

export async function describeApprove(env: ActionEnv, caller: ActionCaller, task: TaskRecord): Promise<Description> {
  const facts = await env.plan!.facts(caller, task);
  const fields: InputField[] = [];
  const checks = optionalChecks(task);
  if (checks !== undefined) fields.push(checks);
  if (facts?.reasonRequired === true) fields.push({ kind: "text", id: "reason", label: "A line on why (this design has an open blocker)", required: true, max: 500 });
  if (facts === undefined || !raisesLimit(facts)) return { spec: { fields } };
  const proposed = facts.runLimit!.proposedUsd;
  fields.push({ kind: "choice", id: "limit_ack", label: "Run limit", required: true, options: [{ value: String(proposed), label: `Accept a run limit of ${dollars(proposed)}` }] });
  const lines = [
    `Risk: ${facts.risk}.`, ...facts.riskReasons.slice(0, 5).map((reason) => `- ${inert(reason, 120)}`),
    `Run limit now: ${facts.runLimit!.currentUsd === undefined ? "none" : dollars(facts.runLimit!.currentUsd)}. Approving sets it to ${dollars(proposed)}.`,
    ...(facts.filesTouched === undefined ? [] : [`Files this plan touches: ${String(facts.filesTouched)}.`]),
    ...(facts.next === undefined ? [] : [`Approving starts: ${inert(facts.next, 160)}`]),
  ];
  const confirm: ConfirmLines = { title: "Approve and raise the run limit", lines, button: "Approve", danger: false };
  return { spec: { fields }, confirm, bound: { limit: proposed } };
}

export async function performApprove(ctx: PressContext): Promise<Performed> {
  const host = ctx.env.plan!;
  const facts = await host.facts(ctx.caller, ctx.task);
  if (facts === undefined || facts.risk === "high") throw agentXError("TASK_ACTION_NOT_OFFERED", "this plan is decided on the web", { reason: "not_offered", writes: "none" });
  const acknowledged = raisesLimit(facts) ? Number(textOf(ctx.values, "limit_ack")) : undefined;
  if (acknowledged !== undefined && acknowledged !== facts.runLimit!.proposedUsd) throw agentXError("TASK_ACTION_NEEDS_INPUT", "accept the new run limit first", { reason: "needs_input", writes: "none" });
  const reason = textOf(ctx.values, "reason");
  if (facts.reasonRequired && reason === "") throw agentXError("TASK_ACTION_NEEDS_INPUT", "a line on why is needed", { reason: "needs_input", writes: "none" });
  const checks = ctx.values["checks"] === undefined ? undefined : listOf(ctx.values, "checks");
  const result = await host.decide({
    caller: ctx.caller, task: ctx.task, outcome: "approve", binding: ctx.binding, requestId: ctx.requestId,
    ...(reason === "" ? {} : { reason }), ...(checks === undefined ? {} : { selectedOptionalCheckIds: checks }), ...(acknowledged === undefined ? {} : { acknowledgedRunLimitUsd: acknowledged }),
  });
  if (result.status === "refused") throw refusalOf(result.reason);
  return { status: result.status === "replayed" ? "replayed" : "started" };
}

const reasonField = (label: string): InputField => ({ kind: "text", id: "reason", label, required: true, max: 500, multiline: true });
export const describeRequestChanges = async (): Promise<Description> => ({ spec: { fields: [reasonField("What should change?")] } });
export const describeReject = async (): Promise<Description> => ({ spec: { fields: [reasonField("Why reject it?")] } });

async function decideWith(ctx: PressContext, outcome: "request_changes" | "reject"): Promise<Performed> {
  const reason = textOf(ctx.values, "reason");
  if (reason === "") throw agentXError("TASK_ACTION_NEEDS_INPUT", "say why", { reason: "needs_input", writes: "none" });
  const result = await ctx.env.plan!.decide({ caller: ctx.caller, task: ctx.task, outcome, binding: ctx.binding, requestId: ctx.requestId, reason });
  if (result.status === "refused") throw refusalOf(result.reason);
  return { status: result.status === "replayed" ? "replayed" : "done" };
}
export const performRequestChanges = (ctx: PressContext): Promise<Performed> => decideWith(ctx, "request_changes");
export const performReject = (ctx: PressContext): Promise<Performed> => decideWith(ctx, "reject");
