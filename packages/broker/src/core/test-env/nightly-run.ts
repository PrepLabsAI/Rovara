// The nightly run on the workers, broker side (switch: the test environment and nightly health).
//
// The fire (nightly.ts `handleNightlyFire`) decides WHETHER a night runs; this module is how it STARTS one, as the ports `NightlyRunPort` asks for:
//   admit    the night may run: the `Admission` seam's answer with the project as the thing charged (Code's own admission allows everything; a refusal reads as a skipped night, never as a fault);
//   headOf   the branch's head commit as the code host says (the commit the run will test; the worker refuses a workspace that holds any other);
//   startRun the task flow's automatic start (injected as `startAutomaticRun`): a workspace with a read-only preparation of the default branch, exactly as any task meets the workspace limits. The task has purpose
//            `nightly_run`, origin `nightly` (the PROJECT pays, whatever its AI settings say about paying for tasks) and carries what it was started to run. Its first operation is the verification mode
//            (CHECKS) with the payload `nightlyRun`: no model is asked, so no model key is minted (the capability has no `model-access`).
//
// Who it runs as: THE PROJECT'S SYSTEM OWNER ("Rovara (project: X)"), never a person. The person who APPROVED the environment revision is read from the revision's record for the audit trail
// ("automatic: nightly") and nothing else: if they have left, the night still runs.
//
// The task ends like a setup run: `nightlyEndItems` sets `agentRunEnd`, which gives back its workspace slot and workspace, and the run never feeds the cost estimates (it has a purpose).
import { createHash } from "node:crypto";
import { NIGHTLY_RUN_ORIGIN, NIGHTLY_RUN_PURPOSE, ROVARA_CODE_AGENT_ID, agentXError, change, when, type Admission, type NightlyRunPayload, type NightlyRunWire, type NightlySkipReason, type OrgId, type TransactItem } from "@agentx/contracts";
import { taskKey } from "../../developer/task-records.js";
import { admissionRefusal } from "../task-flow/admission.js";
import type { TestEnvDeps } from "./deps.js";
import { readApprovedBy, readApprovedTestEnvironment } from "./environment.js";
import { nightFailedItem } from "./night-status.js";
import { BUDGET_CODES, type NightlyRunPort } from "./nightly.js";

/**
 * What this module reads of a nightly task's record. The task flow writes these fields on the task a nightly run starts (`purpose: "nightly_run"`, `nightlyRun`: the four facts the fire fixed), beside the
 * fields every task has.
 */
export interface NightlyTaskFacts {
  taskId: string;
  project: string;
  orgId?: OrgId | undefined;
  workspaceId?: string | undefined;
  purpose?: string | undefined;
  nightlyRun?: NightlyRunWire | undefined;
  closedAt?: string | undefined;
}

/** The words of the task's request, which are also its title in every list and notification: it says plainly that it is the nightly run, and names the project; nothing from a repository. */
export const nightlyRunText = (project: string): string => `Nightly test run for the project ${project}.`;

/** The start's request id: one per slot, so a retried fire starts one run and the repeat answers the first. A version 4 shaped id made from the slot. */
export function nightlyRequestId(slotId: string): string {
  const hex = [...createHash("sha256").update(`nightly-run:${slotId}`).digest("hex").slice(0, 32)];
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

/** What the task flow's automatic start is asked to start: one model-free nightly run, with the facts the broker fixed. */
export interface NightlyAutomaticRun {
  orgId: OrgId;
  project: string;
  job: "nightly";
  /** One per slot (`nightlyRequestId`), so a retried fire starts one run and the repeat answers the first. */
  requestId: string;
  agent: { agentId: typeof ROVARA_CODE_AGENT_ID };
  input: { text: string };
  origin: typeof NIGHTLY_RUN_ORIGIN;
  purpose: typeof NIGHTLY_RUN_PURPOSE;
  /** Who approved the setup this night runs (the person's id, for the record), or undefined. */
  setupApprovedBy: string | undefined;
  nightlyRun: NightlyRunWire;
}

export interface NightlyRunDependencies extends TestEnvDeps {
  /** May the night run? Throws the refusal's own error when there is no room (`admitNightly` binds the Admission seam). */
  admitProject(input: { orgId: OrgId; project: string }): Promise<void>;
  /** The project's repository's default branch, or undefined when it cannot be read. */
  defaultBranchOf(input: { orgId: OrgId; project: string }): Promise<string | undefined>;
  /** Whether the project uses private package registries, or undefined when it cannot be read. */
  usesRegistries(input: { orgId: OrgId; project: string }): Promise<boolean | undefined>;
  /** The head commit of the branch, or undefined when it cannot be read. */
  headOf(input: { orgId: OrgId; project: string; branch: string }): Promise<string | undefined>;
  /**
   * Starts the run through the task flow (a task of the project's system owner with a read-only preparation and a CHECKS first step). Answers `{ skipped }` when the night cannot run at all today and throws an
   * error with its own code for a refusal (`skipReasonOf` reads it) or a fault that may pass.
   */
  startAutomaticRun(input: NightlyAutomaticRun): Promise<void | { skipped: NightlySkipReason }>;
}

/**
 * `NightlyRunDependencies.admitProject` over the `Admission` seam: asks for `nightly.run` with the project as the subject. A refusal is thrown with the code the task flow gives it (`budget_exhausted` is
 * BUDGET_EXCEEDED), so a full budget skips the night. The key names the project and the UTC day, so a retried fire holds one allowance.
 */
export function admitNightly(admission: Pick<Admission, "admit">, now: () => number = Date.now): NightlyRunDependencies["admitProject"] {
  return async ({ orgId, project }) => {
    const decision = await admission.admit({ companyId: orgId, idempotencyKey: `nightly.run:${orgId}:${project}:${new Date(now()).toISOString().slice(0, 10)}`, action: "nightly.run", projectName: project, subject: { type: "project", id: project } });
    if (!decision.allowed) throw admissionRefusal(decision);
  };
}

/** Why a start was refused as a night that cannot run today (not a fault the scheduler's retry would cure). */
export function skipReasonOf(error: unknown): NightlySkipReason | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code !== "string") return undefined;
  if (BUDGET_CODES.has(code) || code.startsWith("TASK_STOP_")) return "budget";
  if (code === "WORKSPACE_LIMIT") return "workspace_limit";
  if (code === "FORBIDDEN" || code === "PROJECT_ARCHIVED" || code === "PROJECT_NOT_FOUND" || code === "NOT_FOUND") return "owner_unavailable";
  return undefined;
}

export function nightlyRunPort(deps: NightlyRunDependencies): NightlyRunPort {
  return {
    admit: (input) => deps.admitProject({ orgId: input.orgId, project: input.project }),
    defaultBranchOf: (input) => deps.defaultBranchOf(input),
    usesRegistries: (input) => deps.usesRegistries(input),
    headOf: (input) => deps.headOf(input),
    async startRun(input) {
      // Only for the record: who approved the setup this night runs. A revision that names nobody, or a person who has since left, changes nothing about whether the night runs.
      const approver = await readApprovedBy(deps, input.orgId, input.project, input.envRevision).catch(() => undefined);
      const nightlyRun: NightlyRunWire = { slotId: input.slotId, envRevision: input.envRevision, branch: input.branch, headSha: input.headSha };
      try {
        const outcome = await deps.startAutomaticRun({
          orgId: input.orgId, project: input.project, job: "nightly", requestId: nightlyRequestId(input.slotId), agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: nightlyRunText(input.project) },
          origin: NIGHTLY_RUN_ORIGIN, purpose: NIGHTLY_RUN_PURPOSE, setupApprovedBy: approver, nightlyRun,
        });
        if (outcome !== undefined && "skipped" in outcome) return { skipped: outcome.skipped };
      } catch (error) {
        const reason = skipReasonOf(error);
        if (reason !== undefined) return { skipped: reason };
        throw error;
      }
      return undefined;
    },
  };
}

// ---- who gets the nightly action

/** Whether an operation is granted the nightly action (and sent `nightlyRun`): the verification operation of a nightly task, and no other operation of any task. One place, so the capability and the payload cannot differ. */
export const isNightlyOperation = (task: Pick<NightlyTaskFacts, "purpose"> | undefined, workflowMode: string | undefined): boolean => task?.purpose === NIGHTLY_RUN_PURPOSE && workflowMode === "CHECKS";

// ---- what the worker is sent

/**
 * The payload of the nightly operation: what the task was started to run, with the APPROVED environment of that revision read from the broker's own record now. A revision that is not there (or whose nightly branch is
 * not the one the run was started for) means the environment changed after the fire: the operation is not made, and the next fire starts from what is approved then.
 */
export async function nightlyRunPayloadOf(deps: TestEnvDeps, orgId: OrgId, project: string, run: NightlyRunWire): Promise<NightlyRunPayload> {
  const approved = await readApprovedTestEnvironment(deps, orgId, project, run.envRevision);
  if (approved === undefined || approved.environment.nightly.branch !== run.branch) throw agentXError("CHANGE_STALE", "the environment changed since this nightly run was started");
  return { ...run, environment: approved.environment };
}

// ---- the end of the task

/**
 * The steps that end a nightly task, for the transaction of its terminal result: its `agentRunEnd`, which gives back its workspace. Never conditioned on anything but the task being there, and the first value is
 * kept, so a late or repeated end changes nothing. A task that is not a nightly run, or an operation that is not the run's own (or its preparation failing), writes nothing.
 */
export function nightlyEndItems(
  task: Pick<NightlyTaskFacts, "taskId" | "purpose" | "project" | "nightlyRun"> & { orgId?: OrgId | undefined },
  operation: { kind: string; workflowMode?: string | undefined },
  outcome: { status: string },
  now: string,
): TransactItem[] {
  if (task.purpose !== NIGHTLY_RUN_PURPOSE) return [];
  const own = operation.kind === "task" && operation.workflowMode === "CHECKS";
  const prepareFailed = operation.kind === "prepare" && outcome.status !== "SUCCEEDED";
  if (!own && !prepareFailed) return [];
  const state = outcome.status === "SUCCEEDED" ? "COMPLETE" : outcome.status === "CANCELLED" ? "CANCELLED" : "FAILED";
  // An operation that ends in failure with no word from the worker (a crash, a lost machine) is an infrastructure failure of the night: the row says so unless the worker already said something else. A person's stop writes none.
  const failedNight = state === "FAILED" && task.orgId !== undefined && task.nightlyRun !== undefined
    ? [nightFailedItem({ orgId: task.orgId, project: task.project, slotId: task.nightlyRun.slotId, reason: "infra", nowIso: now })] : [];
  return [...failedNight, { kind: "update", key: taskKey(task.taskId), ops: [change.setIfAbsent("agentRunEnd", { state, at: now }), change.set("updatedAt", now)], condition: when.present() }];
}
