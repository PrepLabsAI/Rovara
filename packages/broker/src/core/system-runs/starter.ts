// The hosted SYSTEM STARTER (lead 4 L4-P1; owner DEC 254zzl 1; design system-started-runs.md 2.2). It starts what a project's system owner ("Rovara (project: X)") may start, and ONLY that: a closed list of kinds, built by
// Rovara from stored facts. It takes a KIND and a fixed REASON, never a task request, never free text, never instructions; there is no field through which anyone can hand it work. P1 starts the two FREE kinds:
//   setup_check    the project's setup check at its latest revision, on a fresh machine (the re-check at task start)
//   nightly_check  the same check, started by the project's night. It stands behind the project's own upkeep switch.
// An unknown kind, an AI kind (P2) or a kind that is not a string is refused before anything is read or written.
//
// Every start, in this order, and each step fails closed (nothing after it runs):
//   1. the request is checked at runtime (kind, reason, request id, project name);
//   2. the company's SystemRuns flag is ON now (default off: nothing is read, written or started);
//   3. the project exists in THIS company and is not archived; for a nightly check its upkeep switch is ON now;
//   4. one place of the project's monthly count of automatic runs is taken (`claimAutomaticRun`: at the cap nothing starts, the pause is recorded once);
//   5. a check of this project already running is "busy" (the place goes back, nothing is written);
//   6. THE AUDIT RECORD IS WRITTEN FIRST, with the project's system owner as actor and the reason; a record that cannot be written gives the place back and starts nothing;
//   7. the check is started as the system owner (`startProjectSetupCheck`: no person is the starter; a repeat of the request id answers the first);
//   8. the run's machine time is attributed to the company and project (`recordSystemRunUsage`).
// It starts a PREPARE-ONLY workspace: no task, no model, no key, no branch, no pull request, no approval. The system owner never signs in and never holds a person's rights.
import { createHash } from "node:crypto";
import {
  AGENTX_NAME_PATTERN, SYSTEM_RUN_AUDIT, SYSTEM_RUN_JOB, SystemRunReasonSchema, isFreeSystemRunKind, systemOwnerIdOf, type FreeSystemRunKind, type SystemRunKind, type SystemRunRefusal,
} from "@agentx/contracts";
import { claimAutomaticRun, eventIdOf, releaseAutomaticRun } from "../automatic-runs/cap.js";
import { startProjectSetupCheck, setupStateOf } from "../setup-agent/check.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { recordSystemRunUsage } from "./usage.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface SystemStarterDeps {
  /** The company's own task flow deps (store, audit, projects, machines, outbox, now): the same ones a person's start uses. */
  flow: TaskFlowDeps;
  /** Whether this company's SystemRuns flag is on, read now. */
  enabled(): boolean;
  /** Whether the project's upkeep switch is on, read now (never throws: anything unreadable is off). */
  upkeepOn(project: string): Promise<boolean>;
  /** Fixed codes only. */
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** What a start came to. `started`: a check is running (or, for a repeat of the request id, was started earlier). `skipped`: nothing started and nothing is wrong. `refused`: not allowed, with a fixed reason. */
export type SystemStartResult =
  | { outcome: "started"; kind: FreeSystemRunKind; workspaceId: string; duplicate: boolean }
  | { outcome: "skipped"; reason: "automatic_cap" | "busy" }
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

const refused = (reason: SystemRunRefusal): SystemStartResult => ({ outcome: "refused", reason });

export function createSystemStarter(deps: SystemStarterDeps): { start(input: SystemStartInput): Promise<SystemStartResult> } {
  const { flow } = deps;
  const orgId = flow.companyId;
  const nowMs = (): number => (flow.now?.() ?? new Date()).getTime();
  const auto = { store: flow.store, now: nowMs, companyId: orgId, audit: flow.audit };
  return {
    async start(input) {
      // 1. The request, at runtime (never only by type).
      if (!isFreeSystemRunKind(input.kind)) return refused("kind_not_allowed");
      const kind: FreeSystemRunKind = input.kind;
      const reason = SystemRunReasonSchema.safeParse(input.reason);
      if (!reason.success || typeof input.project !== "string" || !AGENTX_NAME_PATTERN.test(input.project) || typeof input.requestId !== "string" || !UUID.test(input.requestId)) return refused("invalid_request");
      const project = input.project;
      // 2. The company's flag.
      if (!deps.enabled()) return refused("system_runs_off");
      // 3. The project, in this company; its upkeep switch for the nightly kind.
      let latest;
      try { latest = await flow.projects.latest(project); } catch { return refused("project_unavailable"); }
      if (latest === undefined || latest.archived === true) return refused("project_unavailable");
      if (kind === "nightly_check" && !(await deps.upkeepOn(project))) return refused("upkeep_off");
      // 4. One place of the project's monthly count (a repeat of the request id is the same place, counted once).
      const claim = await claimAutomaticRun(auto, { orgId, project, requestId: input.requestId, job: SYSTEM_RUN_JOB[kind] });
      if (!claim.claimed) return { outcome: "skipped", reason: "automatic_cap" };
      const giveBack = async (): Promise<void> => { if (!claim.replay) await releaseAutomaticRun(auto, { orgId, project, requestId: input.requestId }).catch(() => undefined); };
      // 5. A check already running is not started again (a repeat of the request id is answered by the first start instead): the place goes back and nothing is written.
      if (!claim.replay && (await setupStateOf(flow, project, latest.definition)).status === "checking") { await giveBack(); return { outcome: "skipped", reason: "busy" }; }
      // 6. The audit record, FIRST: the system owner is the actor, the reason is a fixed code.
      const owner = systemOwnerIdOf(orgId, project);
      try {
        await flow.audit.record({
          eventId: eventIdOf("system-run-started", orgId, project, input.requestId), companyId: orgId, at: new Date(nowMs()).toISOString(), actor: { type: "system", id: owner }, action: SYSTEM_RUN_AUDIT.started,
          subject: { type: "project", id: project }, details: { kind, reason: reason.data.code, ...(reason.data.fact === undefined ? {} : { fact: reason.data.fact }), requestId: input.requestId },
        });
      } catch {
        await giveBack();
        return refused("audit_unavailable");
      }
      // 7. The check, as the system owner. A check that started between step 4 and now is "busy" (the place goes back).
      let started: { workspaceId: string; duplicate: boolean };
      try {
        started = await startProjectSetupCheck(flow, { project, requestId: input.requestId, startedBy: owner });
      } catch (error) {
        await giveBack();
        if ((error as { code?: unknown } | null)?.code === "WORKSPACE_BUSY") return { outcome: "skipped", reason: "busy" };
        throw error;
      }
      // 8. Whose machine time it is. The run exists whether or not this row could be written: a failure is logged by name and a repeat of the request writes it.
      await recordSystemRunUsage(flow, { project, kind, workspaceId: started.workspaceId, requestId: input.requestId })
        .catch((error: unknown) => deps.log?.({ event: "system_run.usage_not_recorded", kind, error: error instanceof Error ? error.name : "unknown" }));
      return { outcome: "started", kind, workspaceId: started.workspaceId, duplicate: started.duplicate };
    },
  };
}

export type { SystemRunKind };
