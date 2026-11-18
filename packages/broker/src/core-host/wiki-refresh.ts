// Engine host (lead 4 L4-P2; owner DEC 254zzl, 254zzt): the HOSTED wiki refresh starter, the one AI kind of system-started runs that is live. The upkeep night (core/upkeep/night.ts, step 3) asks it to refresh the
// stale pages of a project's wiki, with the project's SYSTEM OWNER as the starter and the work origin `nightly`, so every model call is counted by the gateway against the project's upkeep cap (Cloud #125).
//
// What stands before any money is spent, each failing closed (nothing is started, nothing is held):
//   1. the company's EFFECTIVE system runs gate (the operator's ceiling AND the company's consent) is on now;
//   2. the project exists in THIS company and is not archived (`prepareUnattendedWikiRefresh` re-checks), and the project's upkeep switch is ON (`startUpkeepWikiRefresh` reads it as the unattended door's switch);
//   3. a dollar cap is ENFORCED on this install: the registered Admission declares `enforcesCost: true` (the per-run stop is wired). Otherwise `startUnattendedRun` refuses (`AGENT_BUDGET_REQUIRED`) and the answer is `no_cost_cap`;
//   4. Admission says yes to `automation.run`, its hold keyed by the night's own request id (a repeat of the key is the same hold, `heldBefore`), released on every path where nothing started;
//   5. THE AUDIT RECORD (`system_run.requested`, kind `wiki_refresh`, actor the project's system owner) is written BEFORE the task starts: a record that cannot be written starts nothing and gives the hold back.
// The task then runs under the access rule's wiki-refresh marks (core/system-runs/access.ts): the work origin `nightly` at the start, the build pointer's `unattended` mark at every step. It has no person's standing:
// each page asks whether the project's upkeep is still ON and the company's system runs still on (`upkeepOn`), and ends `access_lost` when not.
import { SYSTEM_RUN_AUDIT, UPKEEP_ORIGIN, WikiProjectSchema, agentXError, systemOwnerIdOf, systemOwnerName, type Admission, type OrgId, type WikiFileMap } from "@agentx/contracts";
import { admissionEnforcesCost, sweepUnattendedRuns, type UnattendedStartDeps, type UnattendedTasks } from "../core/automation/run-seam.js";
import { cancelTask } from "../core/task-flow/cancel.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { taskKey } from "../core/task-flow/keys.js";
import { systemPrincipalOf } from "../core/system-runs/access.js";
import { systemRunsGateSaysOn, type SystemRunsGate } from "../core/system-runs/consent.js";
import { startUpkeepWikiRefresh, type UpkeepRefreshAnswer } from "../core/upkeep/refresh.js";
import type { FileMapRepository } from "../core/wiki/file-map.js";
import { createWikiStore } from "../core/wiki/store.js";
import { createUpkeepWikiStarter } from "../core/wiki-build/starter.js";
import type { WikiBuildDeps } from "../core/wiki-build/run.js";
import type { CoreService } from "./core-runtime.js";
import { hostOf, wikiMapServiceOf, type HostedWikiMapWiring } from "./wiki-map-routes.js";

export interface HostedWikiRefreshInputs {
  /** The company's own task flow deps (store, audit, projects, access, ...). The start goes through its REAL access rule: the system owner is accepted there only with the wiki-refresh marks. */
  flow: TaskFlowDeps;
  companyId: OrgId;
  now: () => number;
  /** The company's effective system runs gate (ceiling AND consent). */
  gate: SystemRunsGate;
  /** The company's registered Admission: its `enforcesCost` decides whether any AI starts, and it holds and settles the run's money. */
  admission: Admission;
  /** The install's model gateway is configured. False: nothing is started (`needs_ai_key`). */
  modelAccessConfigured: boolean;
  /** Whether the company has an AI key, when the host can tell. Absent: unknown (the gateway refuses at the first call). */
  aiKey?: (() => Promise<"connected" | "missing" | "unknown">) | undefined;
  /** The same file map wiring the wiki controls use (one kept map service). */
  map: HostedWikiMapWiring;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** The task rows' end and wait states, as the unattended door sweeps them. Hosted: no person closes a system run; a stop cancels the running step. */
export function hostedUnattendedTasks(flow: TaskFlowDeps): UnattendedTasks {
  return {
    async read(taskId) {
      const task = await flow.store.get(taskKey(taskId)) as { closedAt?: unknown; purpose?: unknown; setupAgentResult?: { status?: unknown } | null; workflow?: { stage?: unknown; state?: unknown } } | undefined;
      if (task === undefined) return undefined;
      // A setup run (a repair draft, L4-SR2) ends with its stored result, not with a stage: the reservation is settled as soon as the run reported (a run closed by a cancel reads as cancelled below).
      const setupEnd = task.purpose === "setup_agent" && task.setupAgentResult !== undefined && task.setupAgentResult !== null ? (task.setupAgentResult.status === "ready" ? "succeeded" : "failed") : undefined;
      const end = task.workflow?.stage === "MERGED" ? "succeeded" : task.closedAt !== undefined || task.workflow?.stage === "CLOSED" ? "cancelled" : setupEnd;
      return { ...(end === undefined ? {} : { end }), waiting: end === undefined && (task.workflow?.state === "WAITING" || task.workflow?.state === "BLOCKED") };
    },
    async cancel(taskId) { await cancelTask(flow, taskId); },
  };
}

/** The principal of a project's nightly wiki refresh: its system owner, which signs in nowhere. */
const systemCaller = (companyId: OrgId, project: string): TaskStartCaller => ({ principal: systemPrincipalOf(companyId, project, systemOwnerName(project)), client: "system", origin: UPKEEP_ORIGIN });

/**
 * The upkeep night's `refresh` for one company (`UpkeepNightDeps.refresh`). Always answers an outcome; a refusal the door gives for want of a cap is `no_cost_cap`, every other refusal is thrown as the door threw it
 * (the night records it `failed`).
 */
export function createHostedWikiRefresh(inputs: HostedWikiRefreshInputs): (project: string, day: string, options: { includeUnwritten: boolean }) => Promise<UpkeepRefreshAnswer> {
  const { flow, companyId, now } = inputs;
  if (flow.companyId !== companyId) throw new Error("the refresh is not for this company's flow");
  const wiki = createWikiStore({ store: flow.store, companyId, now });
  const service = wikiMapServiceOf(inputs.map, now, inputs.log);
  const enforces = { dollars: admissionEnforcesCost(inputs.admission) };
  return async (project, day, options) => {
    if (!WikiProjectSchema.safeParse(project).success) throw agentXError("CONFIG_INVALID", "the request is not valid");
    // 1. Both locks, now.
    if (!(await systemRunsGateSaysOn(inputs.gate))) return { outcome: "unavailable" };
    const caller = systemCaller(companyId, project);
    const readMap = async (name: string): Promise<WikiFileMap | undefined> => {
      const latest = await flow.projects.latest(name);
      if (latest === undefined) return undefined;
      const targets: FileMapRepository[] = latest.definition.repositories.map((repository) => ({ name: repository.name, url: repository.url, defaultBranch: repository.defaultBranch, host: hostOf(inputs.map, repository) }));
      return await service.make(companyId, name, targets, { orgId: companyId });
    };
    const inner = createUpkeepWikiStarter({ flow, caller, cancel: async (request) => { await cancelTask(flow, request.taskId); } });
    // 5. The audit record first: it names the kind and the night's own request id, never a repository's words.
    const starter: NonNullable<WikiBuildDeps["starter"]> = {
      start: async (request) => {
        try {
          await flow.audit.record({
            eventId: `system-run-started:${companyId}:${project}:wiki_refresh:${request.requestId}`, companyId, at: new Date(now()).toISOString(), actor: { type: "system", id: systemOwnerIdOf(companyId, project) },
            action: SYSTEM_RUN_AUDIT.requested, subject: { type: "project", id: project }, details: { kind: "wiki_refresh", reason: "nightly", requestId: request.requestId },
          });
        } catch { throw agentXError("AUDIT_UNAVAILABLE", "That could not be recorded, so nothing was started."); }
        return inner.start(request);
      },
      cancel: (request) => inner.cancel(request),
    };
    const build: WikiBuildDeps = {
      store: flow.store, companyId, now, starter,
      // The run has no person: the page loop reads `upkeepOn` for it. A person's standing is never read here.
      standing: async () => ({ access: "none" }),
      modelAccessConfigured: inputs.modelAccessConfigured,
      aiKey: async () => (inputs.aiKey === undefined ? "unknown" : await inputs.aiKey()),
      fileMap: readMap,
      defaultBranchHeads: async (name) => (await readMap(name))?.repositories.flatMap((repository) => (repository.status === "unavailable" || repository.commit === undefined ? [] : [{ repo: repository.name, commit: repository.commit }])) ?? [],
      async requireNewWork(name) {
        const found = await flow.projects.latest(name);
        if (found === undefined || found.archived === true) throw agentXError("PROJECT_ARCHIVED", "This project is archived. Restore it to start new work.");
      },
      recordBuild: (record) => wiki.writeBuild(project, record),
    };
    return await startUpkeepWikiRefresh({
      build, wiki,
      run: { companyId, admission: inputs.admission, audit: flow.audit, enforces, store: flow.store, tasks: hostedUnattendedTasks(flow), now, ...(inputs.log === undefined ? {} : { log: inputs.log }) },
    }, { project, day, includeUnwritten: options.includeUnwritten });
  };
}

/**
 * The `automation-stop` job's hosted service for a company the system runs ceiling covers: it settles the reservation of each open unattended run whose task ended and stops one that outlived its minutes
 * (`sweepUnattendedRuns`). Nothing opens a run except the wiki refresh, so on a company with none it reads an empty partition.
 */
export function createHostedAutomationStop(inputs: {
  flow: TaskFlowDeps; companyId: OrgId; admission: Admission; now: () => number; log?: ((entry: Record<string, unknown>) => void) | undefined;
  /** L4-SR2: the repair drafts' progress pass (core-host/setup-repair.ts), run in the same per-minute job after the sweep. A fault there is logged and never fails the sweep. */
  repairs?: { advanceAll(budgetMs: number): Promise<{ projects: number; advanced: number }> } | undefined;
}): CoreService {
  const deps: UnattendedStartDeps = {
    automation: { enabled: () => false }, companyId: inputs.companyId, admission: inputs.admission, audit: inputs.flow.audit,
    starter: { start: async () => { throw agentXError("NOT_AVAILABLE_HERE", "this sweep starts nothing"); }, read: async () => undefined },
    enforces: { dollars: admissionEnforcesCost(inputs.admission) }, store: inputs.flow.store, tasks: hostedUnattendedTasks(inputs.flow), now: inputs.now, ...(inputs.log === undefined ? {} : { log: inputs.log }),
  };
  return {
    pass: async ({ budgetMs }) => {
      const swept = await sweepUnattendedRuns(deps);
      if (inputs.repairs === undefined) return { ...swept };
      try {
        return { ...swept, repairs: { ...(await inputs.repairs.advanceAll(budgetMs)) } };
      } catch (error) {
        inputs.log?.({ component: "setup-repair", event: "setup_repair.pass_failed", error: error instanceof Error ? error.name : "unknown" });
        return { ...swept, repairs: "failed" };
      }
    },
  };
}

