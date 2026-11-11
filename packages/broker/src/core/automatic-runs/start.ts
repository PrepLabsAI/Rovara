// Starting an automatic run as a project's system owner. THE one function every automatic job calls to start a run: the nightly run and, from the saved-environments work, a saved image's rebuild and a
// scheduled check. It does, in this order:
//   1. takes one place of the project's monthly cap (`claimAutomaticRun`): at the cap the run is NOT started and the answer is `{ skipped: "automatic_cap" }` (the project page says automatic runs are paused);
//   2. starts the run through the one unattended door (`startUnattendedRun`: the switch, `Admission`, the host's starter) as the project's system owner, with no one as starter: nothing about it is a person's;
//   3. gives the place back when the run was not started (a refusal or a fault), and records the start ("automatic: <job>", with the person who approved the setup it runs).
// It never reads who approved the setup to decide whether the run happens: an approver who left changes nothing but a reminder on the project page.
import { createHash } from "node:crypto";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, projectPk, type AgentId, type AutomaticJob, type AutomaticRunPurpose, type NightlyRunWire, type OrgId, type RunInput } from "@agentx/contracts";
import { iso, putRow } from "../automation/kit.js";
import { startUnattendedRun, type AutomatedRunResult, type UnattendedStartDeps } from "../automation/run-seam.js";
import { putAutomaticRunWatch } from "./end.js";
import { AUTOMATIC_RUNS_STARTED_PREFIX, claimAutomaticRun, eventIdOf, releaseAutomaticRun, type AutomaticRunsDeps } from "./cap.js";

/** An automatic run's own time limit (minutes). The session sweep ends a run that outlives it. */
export const AUTOMATIC_RUN_MINUTES = 120;

export interface AutomaticRunDependencies extends AutomaticRunsDeps {
  /** The unattended door's own dependencies (the switch, admission, the host's starter). */
  run: UnattendedStartDeps;
}

export interface AutomaticRunInput {
  orgId: OrgId;
  project: string;
  job: AutomaticJob;
  /** One run per request id: a retried start answers the first and counts once. A version 4 shaped id. */
  requestId: string;
  agent: { agentId: AgentId };
  input: RunInput;
  /** `nightly` for the nightly run, `automatic` for any other automatic job. */
  origin: "nightly" | "automatic";
  /** The person who approved the setup this run runs (kept for the audit trail and the reminder; they own nothing). */
  setupApprovedBy?: string | undefined;
  /** What the run is for, and it must be model-free: an automatic run is given no model key. `nightly_run` needs `nightlyRun`; `saved_env_rebuild` prepares the workspace and queues no model prompt. */
  purpose: AutomaticRunPurpose;
  /** The nightly run's facts: required for the `nightly_run` purpose, and for no other. */
  nightlyRun?: NightlyRunWire | undefined;
  /** Where the start logs what it could not record (the run does not wait on it). */
  log?: (entry: Record<string, unknown>) => void;
}

export type AutomaticRunOutcome = { started: AutomatedRunResult } | { skipped: "automatic_cap" };

/** Starts an automatic run, or says the project's cap has paused them. Anything else that stops the start is thrown as the shared start threw it (the caller maps a refusal; a fault may pass). */
export async function startAutomaticRun(deps: AutomaticRunDependencies, input: AutomaticRunInput): Promise<AutomaticRunOutcome> {
  // Every automatic start declares a model-free purpose, before anything is taken or written.
  if ((input.purpose === "nightly_run") !== (input.nightlyRun !== undefined)) throw agentXError("CONFIG_INVALID", "purpose: the nightly purpose goes with what the night was started to run, and only with it");
  const claim = await claimAutomaticRun(deps, { orgId: input.orgId, project: input.project, requestId: input.requestId, job: input.job });
  if (!claim.claimed) return { skipped: "automatic_cap" };
  let started: AutomatedRunResult;
  try {
    started = await startUnattendedRun(deps.run, {
      requestId: input.requestId, project: input.project, agent: input.agent, input: input.input, origin: input.origin,
      automatic: { job: input.job, purpose: input.purpose, ...(input.setupApprovedBy === undefined ? {} : { approvedBy: input.setupApprovedBy }) },
      limits: { maxMinutes: AUTOMATIC_RUN_MINUTES },
    });
  } catch (error) {
    // The place is given back only when the run was NOT started: a fault after the task committed (the answer was lost) leaves a run that is the month's, and the retry of the same request finds and counts it once.
    const made = await deps.run.starter.read(input.requestId).catch(() => undefined);
    if (made === undefined) await releaseAutomaticRun(deps, { orgId: input.orgId, project: input.project, requestId: input.requestId }).catch(() => undefined);
    throw error;
  }
  const log = input.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  // Its watch (the session sweep ends a run that outlives its time and gives the slot back) and its record on the project page; neither makes the run wait, and neither fails silently.
  await putAutomaticRunWatch(deps, { orgId: input.orgId, project: input.project, job: input.job, taskId: started.taskId, startedAt: iso(deps) })
    .catch((error: unknown) => log({ event: "automatic_run.watch_not_written", job: input.job, error: error instanceof Error ? error.name : "unknown" }));
  await recordStart(deps, input, claim.used, claim.cap, started.taskId).catch((error: unknown) => log({ event: "automatic_run.start_not_recorded", job: input.job, error: error instanceof Error ? error.name : "unknown" }));
  return { started };
}

/** The record of the start, once per request id: the page's own record of the run (its job, when and which task) and the audit event ("automatic: <job>", the actor is Rovara) in the same write. */
async function recordStart(deps: AutomaticRunDependencies, input: AutomaticRunInput, used: number, cap: number, taskId: string): Promise<void> {
  const at = iso(deps);
  const event = deps.audit.stage({
    eventId: eventIdOf("automatic-run-started", input.orgId, input.project, input.requestId), companyId: deps.companyId, at, actor: { type: "system", id: "rovara" }, action: "automatic_run.started",
    subject: { type: "project", id: input.project }, details: { job: input.job, runsThisMonth: used, cap, ...(input.setupApprovedBy === undefined ? {} : { setupApprovedBy: input.setupApprovedBy }) },
  });
  const marker = { pk: projectPk(input.orgId, input.project), sk: `${AUTOMATIC_RUNS_STARTED_PREFIX}${createHash("sha256").update(input.requestId).digest("hex").slice(0, 32)}` };
  const row = putRow(marker, "AUTOMATIC_RUN_STARTED", { orgId: input.orgId, project: input.project, job: input.job, taskId, at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((deps.now() + 62 * 86_400_000) / 1000) });
  // The marker is there already when this start was recorded before (a retry): the transaction is refused and nothing more is written.
  await deps.store.transact([row, ...event]);
}
