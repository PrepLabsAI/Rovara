// Automation, the one door through which unattended work is started. Every automatic start (a trigger's event or schedule, a chain's step, an automatic job) goes through `startUnattendedRun`:
//   1. the switch is on;
//   2. a real cap applies: the install says whether a dollar cap is enforced (the registered `Admission` declares `enforcesCost: true`). A run that carries a dollar limit is REFUSED where none is: a limit
//      nothing enforces is no limit, and unattended paid work is never started on one;
//   3. `Admission` is asked (`automation.run`), before anything is written, with the request's own id as its key: a refusal starts nothing and holds nothing;
//   4. the host's `AutomatedRunStarter` starts the run, with the limits the run is held to;
//   5. the run is recorded as OPEN with its reservation, and `sweepUnattendedRuns` settles the reservation when the run's task ends (and stops a run that outlives its minutes). Every failure path before that
//      releases the reservation.
// Nothing here decides anything for a person: an unattended run never carries an approval, never answers a question and never merges. A plan, a design or a merge it reaches waits for the owner, as for any task.
import { admissionRefusal } from "../task-flow/admission.js";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, change, orgScoped, queryAll, when, type Admission, type AgentId, type AuditSink, type DocumentKey, type DocumentStore, type RunInput } from "@agentx/contracts";
import { iso, text } from "./kit.js";
import { automationIsOn, type AutomationSwitch } from "./switch.js";

/** Where unattended work came from. */
export type AutomatedOrigin = "event" | "schedule" | "chain" | "nightly" | "automatic";

/** What an unattended run is held to. The host's starter honours or refuses them; it never starts a run that exceeds one. */
export interface AutomatedRunLimits {
  /** The most money (US dollars) the run may spend, or undefined when the install has no price list (a run is then held to its time and its counts only). */
  maxRunUsd?: number | undefined;
  /** The most minutes the run may take. */
  maxMinutes: number;
}

export interface AutomatedRunRequest {
  /** One run per request id: a repeat of the start answers the first. A version 4 shaped id. */
  requestId: string;
  project: string;
  agent: { agentId: AgentId; version?: number | undefined };
  input: RunInput;
  origin: AutomatedOrigin;
  /** The trigger that started it (taken from the trigger's own record, never from an event's text). */
  trigger?: { kind: "event" | "schedule"; triggerId: string } | undefined;
  /** The chain step this run is. */
  chain?: { chainRunId: string; stepId: string } | undefined;
  /** An automatic job's mark (the nightly run, an image rebuild): the run is model-free and the starter hands it no model key. */
  automatic?: { job: string; purpose: string; approvedBy?: string | undefined } | undefined;
  limits: AutomatedRunLimits;
  /** The digest of the recipe the run is frozen with (narrowed by the guardrails and the project's rules). A starter that runs an agent reads the frozen recipe by this digest and never re-resolves a wider one. */
  recipeDigest?: string | undefined;
}

export interface AutomatedRunResult {
  taskId: string;
  /** True when this call returned the run an earlier call with the same request id made. */
  duplicate: boolean;
}

/** What the host fills in: how a run is actually started on this install (the task flow, a worker machine). */
export interface AutomatedRunStarter {
  start(request: AutomatedRunRequest): Promise<AutomatedRunResult>;
  /** The run an earlier start with this request id made, or undefined. */
  read(requestId: string): Promise<{ taskId: string } | undefined>;
}

/** What the install can say of a task, for settling a run's reservation and stopping a run that outlives its minutes. */
export interface UnattendedTasks {
  /** Where the task stands: `end` once it ended (and how); `waiting` while it waits for the owner (their approval is not the run's time). `undefined`: the task is gone. */
  read(taskId: string): Promise<{ end?: "succeeded" | "cancelled" | "failed" | undefined; waiting: boolean } | undefined>;
  /** Stops the task (best effort; the first stop stands). */
  cancel(taskId: string): Promise<void>;
  /** What the task actually cost, when the install can tell (US dollars); absent: the run is settled with no figure. */
  costUsd?(taskId: string): Promise<number | undefined>;
}

export interface UnattendedStartDeps {
  automation: AutomationSwitch;
  companyId: string;
  admission: Admission;
  audit: AuditSink;
  starter: AutomatedRunStarter;
  /** Whether a dollar cap is enforced on this install: the registered `Admission` declares `enforcesCost: true`. False (the allow-all default, or any adapter that does not declare it): a run that carries a dollar limit is refused. */
  enforces: { dollars: boolean };
  /** The store the open runs are kept in, and the host's view of tasks. Absent: runs are not recorded (a test, or an install with nothing to settle). */
  store?: DocumentStore | undefined;
  tasks?: UnattendedTasks | undefined;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** The text of an unattended run's request when an event started it (the agent is told the event through its context, never through this text). */
export const UNATTENDED_EVENT_TEXT = "Do your job for this event.";

/** What the owner is told when a run is refused for want of a cap. */
export const NO_CAP_MESSAGE = "This install has no dollar cap for work that starts with no one present (its admission does not declare that it enforces a cost limit), so nothing is started on its own. Install an admission adapter that holds a limit and declares `enforcesCost: true`, then try again.";

const OPEN_RUN_PARTITION = "UNATTENDED_RUN_OPEN";
const RUN_ROW_DAYS = 62;
const openRunKey = (companyId: string, requestId: string): DocumentKey => ({ pk: orgScoped(companyId, OPEN_RUN_PARTITION), sk: requestId });

/** The one rule for "a dollar cap is enforced on this install": the registered `Admission` declares `enforcesCost: true`. Never a name, never a guess; a missing or any other value is false. */
export function admissionEnforcesCost(admission: Pick<Admission, "enforcesCost">): boolean {
  return admission.enforcesCost === true;
}

/**
 * Whether a run may be started on this install: undefined when it may, else the words. EVERY run that can use a model needs a cap that is enforced, whether or not it names a dollar limit (a run with no
 * limit is the one with nothing holding it at all). Only a model-free automatic job (it carries the `automatic` mark and is given no model key) has nothing to cap.
 */
export function capProblem(enforces: { dollars: boolean }, request: Pick<AutomatedRunRequest, "automatic">): string | undefined {
  return !enforces.dollars && request.automatic === undefined ? NO_CAP_MESSAGE : undefined;
}

/**
 * Starts one unattended run. Refuses (and starts nothing) when automation is off, when no cap applies, when `Admission` refuses, or when the starter refuses. The reservation is given back on every path where
 * the run did not start (a refusal, or a fault after which the starter holds no run for the request id); once the run exists it is recorded open with its reservation, and settled when its task ends.
 */
export async function startUnattendedRun(deps: UnattendedStartDeps, request: AutomatedRunRequest): Promise<AutomatedRunResult> {
  if (!(await automationIsOn(deps.automation))) throw agentXError("NOT_AVAILABLE_HERE", "automation is not switched on");
  const earlier = await deps.starter.read(request.requestId);
  if (earlier !== undefined) return { taskId: earlier.taskId, duplicate: true };
  const uncapped = capProblem(deps.enforces, request);
  if (uncapped !== undefined) throw agentXError("AGENT_BUDGET_REQUIRED", uncapped);
  const decision = await deps.admission.admit({
    companyId: deps.companyId,
    idempotencyKey: `automation.run#${request.requestId}`,
    action: "automation.run",
    projectName: request.project,
    subject: { type: "run", id: request.requestId },
    ...(request.limits.maxRunUsd === undefined ? {} : { estimate: { cost: { micros: Math.round(request.limits.maxRunUsd * 1_000_000), currency: "USD" } } }),
  });
  if (!decision.allowed) {
    deps.log?.({ event: "automation.run_refused", project: request.project, origin: request.origin, code: decision.code });
    throw admissionRefusal(decision);
  }
  const release = async (): Promise<void> => {
    if (decision.reservationId !== undefined) await deps.admission.release(decision.reservationId).catch(() => undefined);
  };
  let result: AutomatedRunResult;
  try {
    result = await deps.starter.start(request);
  } catch (error) {
    // A refusal (a coded error) is a start that did not happen. A fault is not known to have failed: the starter is asked whether it holds a run for this request id. If it does, the run is recorded below by the
    // retry of the same request (which finds it); if it does not, nothing was started and the reservation goes back.
    const coded = (error as { code?: unknown } | null)?.code !== undefined;
    const made = coded ? undefined : await deps.starter.read(request.requestId).catch(() => undefined);
    if (made === undefined) await release();
    else await recordOpenRun(deps, request, made.taskId, decision.reservationId);
    throw error;
  }
  await recordOpenRun(deps, request, result.taskId, decision.reservationId);
  return result;
}

/** The run's open record (with its reservation). A failure to write it is logged: the run exists and its reservation then falls back on the adapter's own expiry. */
async function recordOpenRun(deps: UnattendedStartDeps, request: AutomatedRunRequest, taskId: string, reservationId: string | undefined): Promise<void> {
  if (deps.store === undefined) return;
  try {
    await deps.store.put({
      item: {
        ...openRunKey(deps.companyId, request.requestId), entityType: "UNATTENDED_RUN", requestId: request.requestId, taskId, project: request.project, origin: request.origin, startedAt: iso(deps), maxMinutes: request.limits.maxMinutes,
        ...(reservationId === undefined ? {} : { reservationId }), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + RUN_ROW_DAYS * 86_400,
      },
      condition: when.absent(),
    });
  } catch (error) {
    deps.log?.({ event: "automation.run_not_recorded", origin: request.origin, error: error instanceof Error ? error.name : "unknown" });
  }
}

export interface UnattendedSweepReport { settled: number; stopped: number; open: number }

/**
 * Looks at every open unattended run: a run whose task ended has its reservation settled (with what the install can tell it cost) and its record closed; a run that has used more than its minutes (not counting the time its
 * task waited for the owner) is stopped through the host, so it ends and settles on the next pass. A chain step's minutes are held by the chain's own sweep, which knows its retries.
 */
export async function sweepUnattendedRuns(deps: UnattendedStartDeps): Promise<UnattendedSweepReport> {
  const report: UnattendedSweepReport = { settled: 0, stopped: 0, open: 0 };
  if (deps.store === undefined || deps.tasks === undefined) return report;
  for (const row of await queryAll(deps.store, { pk: orgScoped(deps.companyId, OPEN_RUN_PARTITION) })) {
    const key = { pk: text(row["pk"]), sk: text(row["sk"]) };
    const taskId = text(row["taskId"]);
    try {
      const state = await deps.tasks.read(taskId);
      if (state === undefined || state.end !== undefined) {
        const reservationId = typeof row["reservationId"] === "string" ? row["reservationId"] : undefined;
        if (reservationId !== undefined) {
          const cost = state === undefined ? undefined : await deps.tasks.costUsd?.(taskId);
          await deps.admission.settle(reservationId, cost === undefined ? {} : { cost: { micros: Math.round(cost * 1_000_000), currency: "USD" } });
        }
        await deps.store.delete({ key, condition: when.present() });
        deps.audit.record({ eventId: `evt_run_ended_${text(row["requestId"])}`, companyId: deps.companyId, at: iso(deps), actor: { type: "system", id: "rovara" }, action: "automation.run_ended", subject: { type: "run", id: text(row["requestId"]) }, details: { outcome: state?.end ?? "gone", origin: text(row["origin"]) } }).catch(() => undefined);
        report.settled += 1;
        continue;
      }
      report.open += 1;
      if (text(row["origin"]) === "chain") continue;
      const now = deps.now();
      if (state.waiting) {
        // Waiting for the owner is not the run's time: the clock restarts from here.
        await deps.store.update({ key, ops: [change.set(["timeoutBase"], new Date(now).toISOString())], condition: when.present() });
        continue;
      }
      const since = Math.max(Date.parse(text(row["startedAt"])), typeof row["timeoutBase"] === "string" ? Date.parse(row["timeoutBase"]) : 0);
      if (now - since > Number(row["maxMinutes"]) * 60_000) {
        await deps.tasks.cancel(taskId);
        report.stopped += 1;
      }
    } catch (error) {
      deps.log?.({ event: "automation.run_sweep_failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return report;
}
