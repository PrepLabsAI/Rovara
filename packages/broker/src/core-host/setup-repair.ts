// Engine host (lead 4 L4-SR2; owner DEC 254zzl, 254zzt, 254zzy): the HOSTED automatic repair draft. When the free re-check settles "setup broken" (core/setup-agent/recheck.ts), the project's setup run is started by Rovara
// itself, as the project's SYSTEM OWNER, behind every lock; it stores a candidate setup, checks it on a fresh machine, and shows the maintainers "Approve new setup". It never approves anything.
//
// What stands before any money is spent (each is read now and fails closed; the first four are `startRepairDraft`'s, the rest the door's and the access rule's):
//   1. the company's EFFECTIVE system-runs gate (the operator's `CoreSystemRuns` ceiling AND the company's consent) is on;
//   2. the project's upkeep switch is ON (a page-only act by an owner, admin or project administrator);
//   3. a dollar cap is ENFORCED on this install (the registered Admission declares `enforcesCost: true`) and the project's upkeep cap has ROOM for the whole run (`room`, the gateway's reading: absent or unreadable = no room =
//      no start; the gateway holds the real cap on every model call whatever this says, through the work origin `nightly`);
//   4. one draft per (project, broken setup revision), outside the cooldown, nothing else going on the project;
//   5. the audit record (`system_run.requested`, kind `repair_draft`, actor the project's system owner) is written BEFORE the run starts;
//   6. Admission says yes to `automation.run` (its hold released on every path where nothing started);
//   7. the access rule accepts the system owner for a `setup_agent` task only with the origin `nightly` at the start, the project's setup pointer at every step, and the project's upkeep switch read now.
// `starter` is the setup run's start as the project's system owner (the same `startTask` a person's "Fix setup" uses, with the origin `nightly` set here and nowhere else): it takes a fixed request, never text. The progress pass
// (`advanceAll`, run by the per-minute `automation-stop` job) moves every draft on and stops one whose lock went off.
import { AGENTX_NAME_PATTERN, ROVARA_CODE_AGENT_ID, UPKEEP_ORIGIN, agentXError, systemOwnerIdOf, systemOwnerName, type Admission, type OrgId, type UpkeepPauseReason } from "@agentx/contracts";
import { admissionEnforcesCost, type AutomatedRunStarter, type UnattendedStartDeps } from "../core/automation/run-seam.js";
import { setupAgentRequestText, type SetupAgentDeps } from "../core/setup-agent/agent.js";
import { setupLimitSettingReader } from "../core/setup-agent/limits.js";
import { advanceInFlightRepairDraft, repairDraftHook, startRepairDraft, type RepairDraftDeps, type RepairRow, type UpkeepGate } from "../core/setup-agent/repair-draft.js";
import { systemPrincipalOf } from "../core/system-runs/access.js";
import type { SystemRunsGate } from "../core/system-runs/consent.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { startIdempotencyKey } from "../core/task-flow/keys.js";
import { startTask } from "../core/task-flow/start.js";
import { upkeepAutomationSwitch } from "../core/upkeep/wiring.js";
import { upkeepIsOn } from "../core/upkeep/settings.js";
import { ensureCoreInUse } from "./engine-stamp.js";
import { companyProjects } from "./lessons.js";
import { hostedUnattendedTasks } from "./wiki-refresh.js";

export interface HostedSetupRepairInputs {
  /** The company's own task flow deps. The start goes through its REAL access rule: the system owner is accepted for a setup run only with the marks. */
  flow: TaskFlowDeps;
  companyId: OrgId;
  now: () => number;
  /** The company's effective system runs gate (ceiling AND consent), read now. */
  gate: SystemRunsGate;
  admission: Admission;
  /** The install's model gateway is configured. False: nothing is started. */
  modelAccessConfigured: () => boolean;
  /** The code host's file read at a commit, for re-reading the proposal's citations before the candidate is stored (as a person's "Use this setup"). */
  readFile: SetupAgentDeps["readFile"];
  /** Whole cents of the project's monthly upkeep cap still free, as the gateway says now. Absent or undefined: no room, so nothing starts (the manual "Fix setup" stays). */
  room?: ((project: string) => Promise<number | undefined>) | undefined;
  /** N1: the admins' notice of a pause (`upkeepPauseHooks(...).onRunPaused`). Never throws. */
  onUpkeepPaused?: ((scope: { orgId: OrgId; project: string }, reason: UpkeepPauseReason) => Promise<void>) | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface HostedSetupRepair {
  /** The hook for `TaskFlowDeps.afterSetupBroken`: one draft per broken revision, only where every lock is open. */
  readonly hook: (project: string, recheckKey: string) => Promise<void>;
  /** One project's repair dependencies (bound to the project: the door's switch is THIS project's upkeep row, the starter starts only THIS project's setup run). */
  depsFor(project: string): RepairDraftDeps;
  /** The progress pass: every project of the company with a draft IN FLIGHT is moved on (and stopped where a lock went off). A project with none costs one read and nothing else. Bounded by `budgetMs`. */
  advanceAll(budgetMs: number): Promise<{ projects: number; advanced: number }>;
}

/** The principal of a project's repair draft: its system owner, which signs in nowhere, with the work origin `nightly` set here and nowhere else (the gateway counts every model call of the run under the project's upkeep cap). */
const systemCaller = (companyId: OrgId, project: string): TaskStartCaller => ({ principal: systemPrincipalOf(companyId, project, systemOwnerName(project)), client: "system", origin: UPKEEP_ORIGIN });

/**
 * The hosted setup-repair starter for ONE project: the only starter that declares `startsSetupRepair`. It takes the door's request and builds the task itself from stored facts: the fixed request sentence of the setup run
 * (never the request's text), the project's own limits the draft read, the system owner as the developer. A request that is not for this project, not the Rovara Code agent, not origin `nightly`, or that carries anything of an
 * agent run, a chain, a trigger or a model-free job is refused before anything is read or written.
 */
export function createHostedSetupRepairStarter(inputs: Pick<HostedSetupRepairInputs, "flow" | "companyId" | "modelAccessConfigured">, project: string): AutomatedRunStarter {
  const { flow, companyId } = inputs;
  if (flow.companyId !== companyId || !AGENTX_NAME_PATTERN.test(project)) throw agentXError("CONFIG_INVALID", "the repair starter is not for this company's project");
  const owner = systemOwnerIdOf(companyId, project);
  const read = async (requestId: string): Promise<{ taskId: string } | undefined> => {
    const found = await flow.store.get(startIdempotencyKey(owner, requestId));
    return typeof found?.["taskId"] === "string" ? { taskId: found["taskId"] } : undefined;
  };
  return {
    startsSetupRepair: true,
    read,
    async start(request) {
      const repair = request.setupRepair;
      if (repair === undefined || request.project !== project || request.origin !== UPKEEP_ORIGIN || request.agent.agentId !== ROVARA_CODE_AGENT_ID || request.automatic !== undefined || request.chain !== undefined || request.trigger !== undefined) {
        throw agentXError("NOT_AVAILABLE_HERE", "this install starts only a project's own setup repair draft here");
      }
      // A repeat of the request answers the first run (the system owner cannot "load" its own task through the task flow's owner read, so the repeat is answered here).
      const earlier = await read(request.requestId);
      if (earlier !== undefined) return { taskId: earlier.taskId, duplicate: true };
      // The run spends model money by the minute: it needs the gateway that meters it. Nothing is written otherwise.
      if (!inputs.modelAccessConfigured()) throw agentXError("RUNTIME_UNAVAILABLE", "setting up a project with Rovara needs this installation's model proxy");
      await ensureCoreInUse(flow.store, companyId);
      const started = await startTask(flow, systemCaller(companyId, project), { requestId: request.requestId, project, instructions: setupAgentRequestText(project), title: `Set up ${project}` }, { setupAgent: { limits: repair.limits, seenTaskId: repair.seenTaskId } });
      return { taskId: started.task.taskId, duplicate: started.duplicate };
    },
  };
}

/** The hosted automatic repair draft for one company (see the file header). */
export function createHostedSetupRepair(inputs: HostedSetupRepairInputs): HostedSetupRepair {
  const { flow, companyId, now } = inputs;
  if (flow.companyId !== companyId) throw new Error("the repair is not for this company's flow");
  const enforces = { dollars: admissionEnforcesCost(inputs.admission) };
  const upkeep: UpkeepGate = {
    enabled: (project) => upkeepIsOn({ store: flow.store, companyId }, project),
    roomCents: async (project) => (inputs.room === undefined ? undefined : await inputs.room(project)),
  };
  const depsFor = (project: string): RepairDraftDeps => {
    const run: UnattendedStartDeps = {
      // The door's switch is THIS project's upkeep row: a project that never turned it on, or turned it off, starts nothing.
      automation: upkeepAutomationSwitch({ store: flow.store, companyId }, project), companyId, admission: inputs.admission, audit: flow.audit,
      starter: createHostedSetupRepairStarter(inputs, project), enforces, store: flow.store, tasks: hostedUnattendedTasks(flow), now,
      ...(inputs.log === undefined ? {} : { log: inputs.log }),
    };
    return {
      store: flow.store, companyId, now, flow,
      starter: undefined, modelAccessConfigured: inputs.modelAccessConfigured(), readFile: inputs.readFile,
      // The project's own run limits (cut to the company's cap): Rovara's repair draft is a setup run too, so it is held to what the owner set.
      limitSetting: setupLimitSettingReader({ store: flow.store, companyId }),
      async latest(name) {
        const found = await flow.projects.latest(name);
        return found === undefined ? undefined : { revision: found.definition.revision, definition: found.definition };
      },
      systemRuns: inputs.gate, upkeep, run,
      onUpkeepPaused: async (name, reason) => { await inputs.onUpkeepPaused?.({ orgId: companyId, project: name }, reason); },
    };
  };
  const hook = async (project: string, recheckKey: string): Promise<void> => {
    if (!AGENTX_NAME_PATTERN.test(project)) return;
    await startRepairDraft(depsFor(project), project, recheckKey);
  };
  return {
    hook, depsFor,
    async advanceAll(budgetMs) {
      const deadline = now() + budgetMs;
      const projects = await companyProjects(flow.store, companyId);
      let advanced = 0;
      for (const project of projects) {
        if (now() >= deadline) break;
        try {
          const row: RepairRow | undefined = await advanceInFlightRepairDraft(depsFor(project), project);
          if (row !== undefined) advanced += 1;
        } catch (error) {
          inputs.log?.({ component: "setup-repair", event: "setup_repair.pass_failed", error: error instanceof Error ? error.name : "unknown" });
        }
      }
      return { projects: projects.length, advanced };
    },
  };
}

export { repairDraftHook };
