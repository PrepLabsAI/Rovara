// The nightly full run, connected to the ports, only while the switches are on.
//
//   - the SCHEDULE follows the approved environment (`nightlyHooks`): when an approval turns the nightly run on, one schedule for that project is put on the `scheduler` port; when it is off, the project's schedule is
//     removed. Nothing is made for a project that never turned it on.
//   - the FIRE is routed (`subscribeNightly`, `fireTestEnvNightly`): the scheduler's delivery reaches `handleNightlyFire`, which decides from what is stored now (see nightly.ts). Off, nothing is read. On, without a way
//     to start a run, nothing is charged or claimed: a schedule that fires costs nothing and holds nothing.
//   - the coverage maps live in the `object-storage` port (`createObjectMapStore`), one object per digest under a prefix of the company and project, so a project's maps are one prefix.
import { createHash } from "node:crypto";
import {
  CoverageMapSchema, ObjectConflictError, canonicalJson,
  type DueSchedule, type ObjectStorage, type OrgId, type ScheduleSubscription, type Scheduler, type TestEnvironment,
} from "@agentx/contracts";
import type { TestEnvDeps } from "./deps.js";
import { nightlyRunsOn } from "./health-switch.js";
import { nightlyMapKey } from "./map-keys.js";
import { NIGHTLY_TARGET_KIND, deleteNightlySchedule, handleNightlyFire, putNightlySchedule, type MapStore, type NightlyFireOutcome, type NightlyRunPort, type NightlyScheduleDependencies } from "./nightly.js";
import { testEnvironmentEnabled } from "./switch.js";

/** A coverage map is read back at most this big (the contract's own limit and some room). */
const MAP_READ_MAX_BYTES = 8 * 1_048_576 + 4_096;
/** The retention class a map is stored with (the adapter maps a class to days; the hosted bucket keeps maps 30 days). */
export const NIGHTLY_MAP_RETENTION = "nightly-map";

/** The coverage map store over the `object-storage` port. A map is stored by its digest, so storing the same map again is the same object and not an error. */
export function createObjectMapStore(objects: ObjectStorage): MapStore {
  return {
    async put(orgId, project, map) {
      const body = canonicalJson(map);
      const digest = createHash("sha256").update(body).digest("hex");
      try {
        await objects.put(nightlyMapKey(orgId, project, digest), new TextEncoder().encode(body), { contentType: "application/json", metadata: { digest }, retention: NIGHTLY_MAP_RETENTION });
      } catch (error) {
        if (!(error instanceof ObjectConflictError)) throw error;
      }
      return digest;
    },
    async get(orgId, project, digest) {
      try {
        const bytes = await objects.get(nightlyMapKey(orgId, project, digest), MAP_READ_MAX_BYTES);
        if (bytes === undefined) return undefined;
        const parsed = CoverageMapSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** What an approval tells the nightly: the route (or the approval's caller) calls `onApproved` after `gate.decide` answered `decided` or `replayed`. */
export interface NightlyApprovalHooks {
  onApproved(orgId: OrgId, project: string, approved: TestEnvironment, approval?: { replayed: boolean }): Promise<void>;
}

/**
 * After an approval: make the project's nightly schedule match the approved environment, and, where a project health is wired, end a repair state (an approved revision is a proved one: `onProved`, not for a
 * replay of an approval that already stood, which proves nothing new). Neither step keeps the other from running; the first failure is thrown after both (the caller logs it and never undoes the approval).
 */
export function nightlyHooks(deps: { scheduling?: NightlyScheduleDependencies | undefined; onProved?: ((orgId: OrgId, project: string) => Promise<void>) | undefined } = {}, env: NodeJS.ProcessEnv = process.env): NightlyApprovalHooks {
  return {
    async onApproved(orgId, project, approved, approval) {
      if (!testEnvironmentEnabled(env)) return;
      let failure: Error | undefined;
      if (deps.onProved !== undefined && approval?.replayed !== true) {
        try { await deps.onProved(orgId, project); } catch (error) { failure = error instanceof Error ? error : new Error("health update failed"); }
      }
      if (deps.scheduling !== undefined) {
        const { nightly } = approved.environment;
        try {
          // Only a project that turned the nightly on has a schedule; a project that never did, or turned it off, has none.
          if (nightly.enabled) await putNightlySchedule(deps.scheduling, { orgId, project, cronUtc: nightly.cronUtc, enabled: true });
          else await deleteNightlySchedule(deps.scheduling, { orgId, project });
        } catch (error) { failure = failure ?? (error instanceof Error ? error : new Error("schedule update failed")); }
      }
      if (failure !== undefined) throw failure;
    },
  };
}

export type TestEnvNightlyAnswer = NightlyFireOutcome | { outcome: "off" } | { outcome: "skipped"; reason: "run_unavailable" };

/**
 * Handles one scheduler fire. Off: nothing is read. On, without a way to start a run: nothing is charged or claimed. On, with `runs`: `handleNightlyFire` decides. A fault that may pass is thrown (the
 * scheduler delivers it again and then gives it up); everything decided is an answer.
 */
export async function fireTestEnvNightly(deps: TestEnvDeps, due: DueSchedule, runs?: NightlyRunPort, env: NodeJS.ProcessEnv = process.env): Promise<TestEnvNightlyAnswer> {
  if (!nightlyRunsOn(env)) return { outcome: "off" };
  if (runs === undefined) return { outcome: "skipped", reason: "run_unavailable" };
  return handleNightlyFire({ ...deps, runs }, due);
}

/**
 * Subscribes the nightly to the scheduler: every delivery whose target is a nightly goes to `fireTestEnvNightly`; any other target is left alone (another feature's schedule on the same scheduler). The caller subscribes
 * once, when the install starts, after it has built `deps` and `runs`. A throw reaches the scheduler, which delivers the fire again; the outcome of every other fire goes to `log` (fixed words only).
 */
export function subscribeNightly(input: { scheduler: Scheduler; deps: TestEnvDeps; runs?: NightlyRunPort | undefined; env?: NodeJS.ProcessEnv; log?: (entry: { event: string; outcome: string; reason?: string; attempt: number }) => void }): ScheduleSubscription {
  const log = input.log ?? (() => undefined);
  return input.scheduler.subscribe(async (due) => {
    if (due.target.kind !== NIGHTLY_TARGET_KIND) return;
    const answer = await fireTestEnvNightly(input.deps, due, input.runs, input.env);
    log({ event: "test_env.nightly_fire", outcome: answer.outcome, ...("reason" in answer ? { reason: answer.reason } : {}), attempt: due.attempt });
  });
}
