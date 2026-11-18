// Engine host (lead 4 L4-P1; owner DEC 254zzl): system-started runs on the core engine of a deployed install, for ONE company. What a project's system owner may start is a closed list (core/system-runs); this file is the
// hosted wiring of that list, and nothing in it is on by itself:
//
//   THE FLAG   `ROVARA_CORE_SYSTEM_RUNS` (stack parameter `CoreSystemRuns`): `off` (or absent, or empty: the DEFAULT), `on` (every company the core serves) or `on:<company id>[:<company id>]`. Anything else is OFF and reported
//              (a typo never switches a company on). It is SEPARATE from the hidden Automation feature (triggers, chains, custom agents), which stays off on hosted: this opens the four fixed kinds and nothing more.
//   OFF        the company has no system starter and no night service (nothing is built), the free re-check at task start does not run, and the system owner is refused by the access rule.
//   THE NIGHT  the `upkeep-night` job (core-host/jobs.ts, hourly) calls `service.pass`: each project that is DUE (its hash hour in 07:00-11:00 UTC, upkeep ON, not claimed today) is started through the system starter. This install
//              has no enforced dollar cap for system runs yet, so no AI is started here (P1): the night is the free nightly check only.
import { SYSTEM_RUNS_VARIABLE, agentXError, type DocumentStore, type OrgId } from "@agentx/contracts";
import { effectiveSystemRunsGate } from "../core/system-runs/consent.js";
import { createSystemStarter, type SystemStartResult } from "../core/system-runs/starter.js";
import { runUpkeepNightPass } from "../core/system-runs/night-pass.js";
import { systemRunRequestId } from "../core/system-runs/starter.js";
import { commitsOf, readCurrentSetupFiles } from "../core/setup-agent/snapshot.js";
import { upkeepIsOn } from "../core/upkeep/settings.js";
import { runUpkeepNight, type UpkeepNightDeps } from "../core/upkeep/night.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import { companyProjects } from "./lessons.js";
import type { CoreService } from "./core-runtime.js";
import { parseCoreSwitch, switchCovers, type CoreSwitch } from "./flags.js";

export { SYSTEM_RUNS_VARIABLE };

/** The flag from a function's environment. `drain` has no meaning here and reads as off. Fail closed: anything that is not exactly a switch value is off, with a problem that never echoes it. */
export function readSystemRunsSwitch(env: NodeJS.ProcessEnv = process.env): { value: CoreSwitch; problem?: string } {
  const parsed = parseCoreSwitch(env[SYSTEM_RUNS_VARIABLE]);
  if (parsed.drain === true) return { value: { mode: "off" }, problem: "not off, on or on:<company ids> (the engine's wind-down value has no meaning for system runs)" };
  return parsed.problem === undefined ? { value: parsed.value } : { value: parsed.value, problem: parsed.problem };
}

/** The operator's CEILING for this company as a gate (the install flag alone: it only ALLOWS). Nothing runs on this alone since L4-P2: use `effectiveSystemRunsGateOf`. */
export function systemRunsGateOf(flag: CoreSwitch, companyId: string): { enabled(): boolean } {
  return { enabled: () => switchCovers(flag, companyId) };
}

/**
 * The EFFECTIVE gate the task flow, the access rule, the starter and the night read on every use (L4-P2, owner DEC 254zzt option A): the operator's ceiling (`flag` covers the company) AND the company's stored consent
 * (read now from the company's own store; a read that fails is off). The one place the AND is made.
 */
export function effectiveSystemRunsGateOf(flag: CoreSwitch, companyId: OrgId, store: Pick<DocumentStore, "get">): { enabled(): Promise<boolean> } {
  return effectiveSystemRunsGate({ ceiling: () => switchCovers(flag, companyId), store, companyId });
}

/**
 * L4-P1/L4-P2 (owner DEC 254zzl, 254zzt): puts the company's EFFECTIVE system-runs gate (the operator's ceiling AND the company's consent) on a task flow's deps. A hosted runtime ALWAYS gets one (flag off or no consent =
 * `enabled()` false), because an ABSENT gate means ON (the laptop's rule) and every hosted company would then get Rovara's automatic re-checks. The broker root calls this for every company's runtime, and so does the
 * dispatcher's (the dispatcher's setup gate before a build can RETRY a re-check, which must stop when the flag or the consent goes off). tests/unit/system-runs-hosted-gate.test.ts holds the function and both calls.
 */
export function hostedSystemRunsFor(deps: { systemRuns?: { enabled(): boolean | Promise<boolean> }; store: Pick<DocumentStore, "get"> }, companyId: OrgId, flag: CoreSwitch): { enabled(): Promise<boolean> } {
  const gate = effectiveSystemRunsGateOf(flag, companyId, deps.store);
  deps.systemRuns = gate;
  return gate;
}

/**
 * Whether nightly upkeep REALLY runs for a company on this install (what the setup page's upkeep switch is told, `HostedUpkeepWiring.available`): the system starter and the `upkeep-night` job are both wired exactly
 * where the company's SystemRuns flag covers it (the same flag builds the starter, wires the night service and enables the schedule). So availability IS the flag: off (the default), the switch stays hidden and a change is
 * refused; no company is ever reported available that has no starter. It is read from the flag each time, never remembered.
 */
export function upkeepAvailableFor(flag: CoreSwitch): (companyId: string) => boolean {
  return (companyId) => switchCovers(flag, companyId);
}

export interface HostedSystemRunsOptions {
  flow: TaskFlow;
  companyId: OrgId;
  /** The flag (`readSystemRunsSwitch`). Nothing is built where it does not cover `companyId`. */
  flag: CoreSwitch;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface HostedSystemRuns {
  readonly starter: ReturnType<typeof createSystemStarter>;
  /** The `upkeep-night` job's service (one company): each due project is started through the starter. */
  readonly service: CoreService;
}

/** The hosted system starter and the night service for one company, or undefined when the flag does not cover it (nothing is built). */
export function createHostedSystemRuns(options: HostedSystemRunsOptions): HostedSystemRuns | undefined {
  const { flow, companyId, now } = options;
  if (!switchCovers(options.flag, companyId)) return undefined;
  const deps = flow.deps;
  // Both locks, read now: the ceiling (`flag`) AND the company's consent.
  const gate = effectiveSystemRunsGateOf(options.flag, companyId, deps.store);
  const enabled = (): Promise<boolean> => gate.enabled();
  const log = (entry: Record<string, unknown>): void => options.log?.({ component: "system-runs", companyId, ...entry });
  const starter = createSystemStarter({ flow: deps, enabled, upkeepOn: (project) => upkeepIsOn({ store: deps.store, companyId }, project), log });
  const store = deps.store;
  const night = (project: string): ReturnType<typeof runUpkeepNight> => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const nightDeps: UpkeepNightDeps = {
      store, companyId, now,
      // No dollar cap is enforced for system runs in this phase: the wiki refresh (AI) is not started, and the night says so (`no_cost_cap`).
      enforces: { dollars: false },
      // The default branch's head of each repository, as the code host says now. A host that cannot answer is thrown, and the night then counts it as "something changed" (an unreadable head is never "nothing new").
      heads: async (name) => {
        const latest = await deps.projects.latest(name);
        if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
        const read = await readCurrentSetupFiles(deps, latest.definition);
        const commits = read.status === "read" ? commitsOf(read.repositories) : undefined;
        if (commits === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the code host could not be read");
        return Object.entries(commits).map(([repo, commit]) => ({ repo, commit }));
      },
      setupCheck: async (name) => {
        const answer: SystemStartResult = await starter.start({ project: name, kind: "nightly_check", reason: { code: "nightly" }, requestId: systemRunRequestId(companyId, name, "nightly_check", day) });
        // A refusal is a night that could not start its check (reported failed); a busy or capped night is not a fault.
        if (answer.outcome === "refused") throw new Error(`system_run_${answer.reason}`);
      },
      refresh: async () => ({ outcome: "no_cost_cap" }),
      paused: async () => undefined,
      log,
    };
    return runUpkeepNight(nightDeps, { project });
  };
  const service: CoreService = {
    pass: async ({ budgetMs }) => ({ ...(await runUpkeepNightPass({ store, companyId, now, enabled, projects: () => companyProjects(store, companyId), night, log }, { budgetMs })) }),
  };
  return { starter, service };
}
