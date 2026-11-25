// The hosted SYSTEM STARTER (lead 4 L4-P1; owner DEC 254zzl 1; design system-started-runs.md 2.2). It starts what a project's system owner ("Rovara (project: X)") may start, and ONLY that: a closed list of kinds, built by
// Rovara from stored facts. It takes a KIND and a fixed REASON, never a task request, never free text, never instructions; there is no field through which anyone can hand it work. It starts the FREE kinds:
//   setup_check        the project's setup check at its latest revision, on a fresh machine (the re-check at task start)
//   nightly_check      the same check, started by the project's night. It stands behind the project's own upkeep switch.
//   saved_env_rebuild  a rebuild of the project's saved image (SI-2). It starts only where the starter was given a rebuild start (`deps.rebuild`); without one it is refused like a kind outside the list. It does NOT read the
//                      project's upkeep switch: the install flag and the company's consent are its gate (owner DEC 254zzz490); every other step below applies to it unchanged.
// An unknown kind, an AI kind (P2) or a kind that is not a string is refused before anything is read or written.
//
// Every start, in this order, and each step fails closed (nothing after it runs):
//   1. the request is checked at runtime (kind, reason, request id, project name);
//   2. the company's SystemRuns flag is ON now (default off: nothing is read, written or started);
//   3. the project exists in THIS company and is not archived; for a nightly check its upkeep switch is ON now; for a rebuild the reads that say it can start (a queued job, a free slot, ...) come out clean, so a start that
//      cannot happen takes no place of the month and writes no audit record;
//   4. one place of the project's monthly count of automatic runs is taken (`claimAutomaticRun`: at the cap nothing starts, the pause is recorded once);
//   5. a check of this project already running is "busy" (the place goes back, nothing is written);
//   6. THE AUDIT RECORD (`system_run.requested`) IS WRITTEN FIRST, with the project's system owner as actor and the reason (a start that then does not happen adds `system_run.not_started`); a record that cannot be written gives the place back and starts nothing;
//   7. the run is started as the system owner (a check: `startProjectSetupCheck`; a rebuild: `deps.rebuild.start`; no person is the starter; a repeat of the request id answers the first);
//   8. the run's machine time is attributed to the company and project (`recordSystemRunUsage`).
// It starts a PREPARE-ONLY workspace: no task, no model, no key, no branch, no pull request, no approval. The system owner never signs in and never holds a person's rights.
import { createHash } from "node:crypto";
import {
  AGENTX_NAME_PATTERN, SYSTEM_RUN_AUDIT, SYSTEM_RUN_JOB, SystemRunReasonSchema, systemOwnerIdOf, type FreeSystemRunKind, type SystemRunKind, type SystemRunReason, type SystemRunRefusal,
} from "@agentx/contracts";
import { claimAutomaticRun, eventIdOf, releaseAutomaticRun } from "../automatic-runs/cap.js";
import { startProjectSetupCheck, setupStateOf } from "../setup-agent/check.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { SavedEnvRebuildRun, SavedEnvRunNot } from "../test-env/saved-env-run.js";
import { systemRunsGateSaysOn } from "./consent.js";
import { recordSystemRunUsage } from "./usage.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface SystemStarterDeps {
  /** The company's own task flow deps (store, audit, projects, machines, outbox, now): the same ones a person's start uses. */
  flow: TaskFlowDeps;
  /** Whether this company's system runs are on (L4-P2: the operator's ceiling AND the company's consent), read now. Anything but an explicit `true`, a throw included, is off. */
  enabled(): boolean | Promise<boolean>;
  /** Whether the project's upkeep switch is on, read now (never throws: anything unreadable is off). */
  upkeepOn(project: string): Promise<boolean>;
  /** The saved-image rebuild's start (SI-2). Absent: the kind `saved_env_rebuild` is refused (`kind_not_allowed`) before anything is read or written, and nothing a rebuild writes is ever written. */
  rebuild?: SavedEnvRebuildRun | undefined;
  /** Fixed codes only. */
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** The refusals of a rebuild's start that are not "not now" (a closed list of fixed codes; the pass ends a job that cannot start for one of them). */
export type RebuildNotStarted = Exclude<SavedEnvRunNot, "already_started" | "no_slot" | "setup_check_running">;

/**
 * What a start came to. `started`: a run is going (or, for a repeat of the request id, was started earlier). `skipped`: nothing started and nothing is wrong (`busy` is also a rebuild whose job already has its run or that
 * finds no free slot). `not_started`: a rebuild that has nothing to start for the fixed reason. `refused`: not allowed, with a fixed reason.
 */
export type SystemStartResult =
  | { outcome: "started"; kind: FreeSystemRunKind; workspaceId: string; duplicate: boolean }
  | { outcome: "skipped"; reason: "automatic_cap" | "busy" }
  | { outcome: "not_started"; reason: RebuildNotStarted }
  | { outcome: "refused"; reason: SystemRunRefusal };

export interface SystemStartInput {
  project: string;
  /** Anything at all: only the closed list is accepted. */
  kind: unknown;
  /** Anything at all: only a fixed code and at most one short fact is accepted. */
  reason: unknown;
  /** One run per request id (a version 4 shaped id): a repeat answers the first. */
  requestId: string;
}

/** A version 4 shaped request id made from text, so the same night of the same project is the same request. */
export function systemRunRequestId(...parts: readonly string[]): string {
  const hex = [...createHash("sha256").update("rovara-system-run\0").update(parts.join("\0")).digest("hex").slice(0, 32)];
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

/** What each kind's start answers: the run's workspace, or why a rebuild had nothing to start. */
type StartAnswer = { workspaceId: string; duplicate: boolean } | { notStarted: SavedEnvRunNot };
type KindStart = (input: { project: string; requestId: string; owner: string }) => Promise<StartAnswer>;

const refused = (reason: SystemRunRefusal): SystemStartResult => ({ outcome: "refused", reason });
/** The rebuild's reads, failing CLOSED: a registry row, slot or record that cannot be read now is "not now" (busy), never a throw out of the starter and never a start. */
async function precheckOf(rebuild: SavedEnvRebuildRun, project: string, requestId: string): Promise<SavedEnvRunNot | undefined> {
  try { return await rebuild.precheck(project, requestId); } catch { return "no_slot"; }
}

/** A rebuild that could not start: "not now" is a skip (the job keeps waiting for its slot or its run), anything else says why. */
const notStartedResult = (why: SavedEnvRunNot): SystemStartResult => (why === "already_started" || why === "no_slot" || why === "setup_check_running" ? { outcome: "skipped", reason: "busy" } : { outcome: "not_started", reason: why });

/** The request as the starter reads it: a fixed reason, a project name and a version 4 shaped request id, or undefined. */
function checkedRequest(input: SystemStartInput): { project: string; reason: SystemRunReason } | undefined {
  const reason = SystemRunReasonSchema.safeParse(input.reason);
  if (!reason.success || typeof input.project !== "string" || !AGENTX_NAME_PATTERN.test(input.project) || typeof input.requestId !== "string" || !UUID.test(input.requestId)) return undefined;
  return { project: input.project, reason: reason.data };
}

/** The record that says a start that was "requested" did not happen (best effort; the answer stands whether or not this can be written). */
async function recordNotStarted(flow: TaskFlowDeps, input: { owner: string; project: string; kind: FreeSystemRunKind; requestId: string; code: string; at: number }): Promise<void> {
  await flow.audit.record({
    eventId: eventIdOf("system-run-not-started", flow.companyId, input.project, input.requestId), companyId: flow.companyId, at: new Date(input.at).toISOString(), actor: { type: "system", id: input.owner }, action: SYSTEM_RUN_AUDIT.notStarted,
    subject: { type: "project", id: input.project }, details: { kind: input.kind, requestId: input.requestId, code: input.code.slice(0, 40) },
  }).catch(() => undefined);
}

/** The two kinds every starter can start, and the rebuild only where it was given its start. Anything else (an AI kind, a string that merely looks like a kind, any other type) is not startable. */
const startable = (kind: unknown, rebuild: boolean): kind is FreeSystemRunKind => kind === "setup_check" || kind === "nightly_check" || (kind === "saved_env_rebuild" && rebuild);

export function createSystemStarter(deps: SystemStarterDeps): { start(input: SystemStartInput): Promise<SystemStartResult> } {
  const { flow } = deps;
  const orgId = flow.companyId;
  const nowMs = (): number => (flow.now?.() ?? new Date()).getTime();
  const auto = { store: flow.store, now: nowMs, companyId: orgId, audit: flow.audit };
  const rebuild = deps.rebuild;
  // Each kind's own start (step 7): the two checks are the project's setup check; the rebuild is the registry's queued job. Exhaustive over the free kinds, so a kind added to the list has no start until it is written here.
  const checkStart: KindStart = (input) => startProjectSetupCheck(flow, { project: input.project, requestId: input.requestId, startedBy: input.owner, system: true });
  const starts: Record<FreeSystemRunKind, KindStart> = {
    setup_check: checkStart,
    nightly_check: checkStart,
    saved_env_rebuild: async (input) => {
      if (rebuild === undefined) throw new Error("no rebuild start");
      const answer = await rebuild.start(input.project, input.requestId);
      return answer.started ? { workspaceId: answer.workspaceId, duplicate: answer.duplicate } : { notStarted: answer.why };
    },
  };
  // 7 and 8. The run, as the system owner, and whose machine time it is. A check that started between step 4 and now is "busy" (the place goes back).
  const runAs = async (run: { kind: FreeSystemRunKind; project: string; requestId: string; owner: string }, giveBack: () => Promise<void>): Promise<SystemStartResult> => {
    const { kind, project, requestId, owner } = run;
    const notStarted = async (code: string): Promise<void> => {
      await giveBack();
      await recordNotStarted(flow, { owner, project, kind, requestId, code, at: nowMs() });
    };
    let started: StartAnswer;
    try {
      started = await starts[kind]({ project, requestId, owner });
    } catch (error) {
      await notStarted(typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "FAULT");
      if ((error as { code?: unknown } | null)?.code === "WORKSPACE_BUSY") return { outcome: "skipped", reason: "busy" };
      throw error;
    }
    if ("notStarted" in started) {
      await notStarted(started.notStarted);
      return notStartedResult(started.notStarted);
    }
    // The run exists whether or not this row could be written: a failure is logged by name and a repeat of the request writes it.
    await recordSystemRunUsage(flow, { project, kind, workspaceId: started.workspaceId, requestId })
      .catch((error: unknown) => deps.log?.({ event: "system_run.usage_not_recorded", kind, error: error instanceof Error ? error.name : "unknown" }));
    return { outcome: "started", kind, workspaceId: started.workspaceId, duplicate: started.duplicate };
  };
  return {
    async start(input) {
      // 1. The request, at runtime (never only by type).
      if (!startable(input.kind, rebuild !== undefined)) return refused("kind_not_allowed");
      const kind = input.kind;
      const checked = checkedRequest(input);
      if (checked === undefined) return refused("invalid_request");
      const { project, reason } = checked;
      // 2. The company's flag.
      if (!(await systemRunsGateSaysOn(deps))) return refused("system_runs_off");
      // 3. The project, in this company; its upkeep switch for the nightly kind ONLY (a rebuild never reads it: the flag and the company's consent are its gate).
      let latest;
      try { latest = await flow.projects.latest(project); } catch { return refused("project_unavailable"); }
      if (latest === undefined || latest.archived === true) return refused("project_unavailable");
      if (kind === "nightly_check" && !(await deps.upkeepOn(project))) return refused("upkeep_off");
      // 3b. A rebuild that cannot start (no queued job, a moved approval, no free slot, a run already made for the job) is told so before a place of the month is taken or an audit record written. Reads only.
      if (kind === "saved_env_rebuild") {
        const not = await precheckOf(rebuild!, project, input.requestId);
        if (not !== undefined) return notStartedResult(not);
      }
      // 4. One place of the project's monthly count (a repeat of the request id is the same place, counted once).
      const claim = await claimAutomaticRun(auto, { orgId, project, requestId: input.requestId, job: SYSTEM_RUN_JOB[kind] });
      if (!claim.claimed) return { outcome: "skipped", reason: "automatic_cap" };
      const giveBack = async (): Promise<void> => { if (!claim.replay) await releaseAutomaticRun(auto, { orgId, project, requestId: input.requestId }).catch(() => undefined); };
      // 5. A check already running is not started again (a repeat of the request id is answered by the first start instead): the place goes back and nothing is written. A rebuild reads this before the place is taken (step 3b), so it is not asked again here.
      if (kind !== "saved_env_rebuild" && !claim.replay && (await setupStateOf(flow, project, latest.definition)).status === "checking") { await giveBack(); return { outcome: "skipped", reason: "busy" }; }
      // 6. The audit record, FIRST: the system owner is the actor, the reason is a fixed code.
      const owner = systemOwnerIdOf(orgId, project);
      try {
        await flow.audit.record({
          eventId: eventIdOf("system-run-started", orgId, project, input.requestId), companyId: orgId, at: new Date(nowMs()).toISOString(), actor: { type: "system", id: owner }, action: SYSTEM_RUN_AUDIT.requested,
          subject: { type: "project", id: project }, details: { kind, reason: reason.code, ...(reason.fact === undefined ? {} : { fact: reason.fact }), requestId: input.requestId },
        });
      } catch {
        await giveBack();
        return refused("audit_unavailable");
      }
      return runAs({ kind, project, requestId: input.requestId, owner }, giveBack);
    },
  };
}

export type { SystemRunKind };
