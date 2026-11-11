// The nightly full baseline (the broker side), on the ports. A schedule per project fires at the environment's `cronUtc`; the fire decides, from what is stored NOW, whether a run starts; the run's result is
// recorded and feeds test selection (the coverage map), the "already failing" set (a known failure is not a regression of a task) and the flaky set.
//
// A fire starts a run only when: the project has an approved environment with `nightly.enabled`; the fire is not old (an hour, the scheduler's own retry horizon); something merged since the last recorded run
// (the branch head moved; an unreadable head is a skip, never a run, so cost stays bounded); no run for this project is still in flight; and this slot has not been handled. The slot is claimed with a conditional
// write BEFORE the run starts, so two fires of one slot start one run. The run itself is started through `startRun` (the worker's CHECKS mode, wired by the caller), which this module only asks.
//
// Schedule: the `scheduler` port, one schedule per project. The environment's five-field cron (UTC) goes to the port as it is; a cron that sets both the day of the month and the day of the week is refused, as
// every scheduler refuses it. The adapter turns the rule into its own (the hosted adapter into the scheduler service's six fields; the local timer reads the five). The port delivers each fire to `handleNightlyFire`
// (`subscribeNightly` in nightly-wiring.ts), which is idempotent per slot: a scheduler that fires twice, late or after a restart does no harm.
//
// What changed from Cloud: spend is the `Admission` seam's answer (the caller binds `admit`), the scheduler is a port instead of the hosted product's own scheduler, the rows are written through `DocumentStore` (same keys), and the
// fire arrives as a `DueSchedule`. Every decision of the fire is the same.
import { createHash } from "node:crypto";
import {
  CoverageMapSchema,
  NIGHTLY_FAILED_MAX,
  NIGHTLY_FLAKY_MAX,
  NIGHTLY_SOURCE,
  NightlyBaselineSchema,
  NightlyFireSchema,
  NightlyResultSchema,
  StoredNightlyHealthSchema,
  agentXError,
  canonicalJson,
  projectPk,
  when,
  type CoverageMapData,
  type DocumentKey,
  type DueSchedule,
  type NightlyBaseline,
  type NightlyResult,
  type NightlySkipReason,
  type OrgId,
  type Scheduler,
  type StoredNightlyHealth,
} from "@agentx/contracts";
import { documentOf, expiryOf, type TestEnvDeps } from "./deps.js";
import { readApprovedTestEnvironment } from "./environment.js";
import { classifyNightlyHealth } from "./nightly-health.js";
import { recordNightUnavailable, sameDayRetryOf } from "./night-status.js";

const HOUR_MS = 3_600_000;
/** A fire older than this is not run: the scheduler retries for an hour at most. */
export const NIGHTLY_FIRE_MAX_AGE_MS = HOUR_MS;
/** A claimed run that has not reported in this long is over (a nightly of an hour and a half, with room). */
export const NIGHTLY_RUN_MAX_MS = 6 * HOUR_MS;
const BASELINE_TTL_MS = 90 * 24 * HOUR_MS;
const FRESH_MAP_FLOOR = 0;

type Item = Record<string, unknown>;
const keyOf = (orgId: OrgId, project: string, sk: string): DocumentKey => ({ pk: projectPk(orgId, project), sk });
const sha = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const readItem = async (deps: Pick<TestEnvDeps, "store">, key: DocumentKey): Promise<Item | undefined> => await deps.store.get(key);

/** How far ahead of the broker's clock a result may be dated: the worker's clock may be a little off. */
export const NIGHTLY_CLOCK_SKEW_MS = 5 * 60_000;
const TRANSIENT_NAMES: ReadonlySet<string> = new Set(["DocumentStoreError", "TimeoutError", "RequestTimeout"]);
/** A fault that a repeat may cure: a write that met another write (`CHANGE_STALE`), or an unavailable or throttled store. Everything else (a damaged item, a refused input) would only fail again. */
const mayPass = (error: unknown): boolean => {
  if ((error as { code?: unknown } | undefined)?.code === "CHANGE_STALE") return true;
  if (error instanceof Error && error.name === "DocumentStoreError") return (error as { retryable?: unknown }).retryable === true;
  return TRANSIENT_NAMES.has(errorName(error));
};

/** The slot a fire is: the same project and the same scheduled time are one slot. */
export const nightlySlotId = (orgId: string, project: string, scheduledAt: string): string => sha([orgId, project, new Date(scheduledAt).toISOString()]);

/** The schedule's name: stable per project, and a legal schedule id (letters, digits, `-` and `_`, at most 64). */
export function nightlyScheduleName(orgId: string, project: string): string {
  return `tenightly-${sha([orgId, project]).slice(0, 40)}`;
}

// ---- the schedule

const FIELD = /^[0-9*/,-]+$/u;
/** Throws CONFIG_INVALID for a cron the environment may not hold: not five fields, characters other than digits and `* / , -`, or both the day of the month and the day of the week set. The adapter checks the numbers' ranges itself. */
export function validateNightlyCron(cronUtc: string): void {
  const fields = cronUtc.trim().split(/\s+/u);
  if (fields.length !== 5 || !fields.every((field) => FIELD.test(field))) throw agentXError("CONFIG_INVALID", "the nightly time is not a five-field cron");
  const [, , dom, , dow] = fields as [string, string, string, string, string];
  if (dom !== "*" && dow !== "*") throw agentXError("CONFIG_INVALID", "set the day of the month or the day of the week, not both");
}

export interface NightlyScheduleDependencies { scheduler: Scheduler }

/** Creates or replaces the project's nightly schedule. Idempotent. `enabled: false` leaves it in place, off. */
export async function putNightlySchedule(deps: NightlyScheduleDependencies, input: { orgId: OrgId; project: string; cronUtc: string; enabled: boolean }): Promise<void> {
  validateNightlyCron(input.cronUtc);
  await deps.scheduler.put({
    companyId: input.orgId, scheduleId: nightlyScheduleName(input.orgId, input.project), when: { kind: "cron", cron: input.cronUtc.trim().replace(/\s+/gu, " "), timezone: "UTC" }, enabled: input.enabled,
    target: { kind: NIGHTLY_TARGET_KIND, ref: { project: input.project } }, maxLateSeconds: HOUR_MS / 1000, description: "Rovara nightly test baseline",
  });
}

export async function deleteNightlySchedule(deps: NightlyScheduleDependencies, input: { orgId: OrgId; project: string }): Promise<void> {
  await deps.scheduler.remove(input.orgId, nightlyScheduleName(input.orgId, input.project));
}

/** Makes the schedule match an approved environment: on and at its time when `nightly.enabled`, off otherwise. Call after every approval. */
export async function syncNightlySchedule(deps: NightlyScheduleDependencies, input: { orgId: OrgId; project: string; nightly: { enabled: boolean; cronUtc: string } }): Promise<void> {
  await putNightlySchedule(deps, { orgId: input.orgId, project: input.project, cronUtc: input.nightly.cronUtc, enabled: input.nightly.enabled });
}

/** What a nightly schedule's target says (`DueSchedule.target.kind`). */
export const NIGHTLY_TARGET_KIND = "nightly";

// ---- one fire

/** The spend refusals a nightly can meet (the ledger's own codes for a full budget): the night is skipped, not retried. */
export const BUDGET_CODES: ReadonlySet<string> = new Set(["ORG_BUDGET_EXCEEDED", "BUDGET_EXCEEDED", "PROJECT_BUDGET_EXCEEDED", "AGENT_BUDGET_EXCEEDED", "AGENT_BUDGET_REQUIRED", "CHAIN_BUDGET_EXCEEDED", "CHAIN_BUDGET_REQUIRED", "TEST_ALLOWANCE_USED", "TRIAL_LOCKED", "MACHINE_TIME_EXCEEDED"]);
/** At most one nightly run per project in this long, whatever the cron says: a cron of `* * * * *` or a busy repo cannot make more. */
export const NIGHTLY_MIN_GAP_MS = 20 * HOUR_MS;

export interface NightlyRunPort {
  /**
   * Asks whether the night may run, charged to the PROJECT (shown as "nightly baseline"): the caller binds this to the `Admission` seam (`admitNightly` in nightly-run.ts). Throws an error with the refusal's own code
   * when there is no room (a code in `BUDGET_CODES` skips the night). Code's own admission allows everything.
   */
  admit(input: { orgId: OrgId; project: string; purpose: "nightly_baseline" }): Promise<void>;
  /**
   * The repository's own default branch (the main branch only). The preparation clones the default branch, so a nightly whose `nightly.branch` is any other would test one branch and report it as another:
   * the fire is skipped (`branch_not_default`) unless the two are the same. Undefined when it cannot be read (the fire is then `head_unreadable`). Left out by a port that does not know.
   */
  defaultBranchOf?(input: { orgId: OrgId; project: string }): Promise<string | undefined>;
  /**
   * Whether the project uses private package registries. The nightly's preparation is read-only (the Prove sequence runs the project's setup itself, in the sandbox), and a read-only preparation carries no registry
   * pointer or credential exchange, so setup would fail on a 401 and read as a broken environment. Until nightly preparations can carry the pointer safely, such a project is skipped (`registries_unsupported`), which is
   * never "needs repair". Undefined when it cannot be read (`head_unreadable`). Left out by a port that does not know.
   */
  usesRegistries?(input: { orgId: OrgId; project: string }): Promise<boolean | undefined>;
  /** The branch's head commit now, or undefined when it cannot be read. */
  headOf(input: { orgId: OrgId; project: string; branch: string }): Promise<string | undefined>;
  /**
   * Starts the full run (CHECKS mode on the default branch). Throws when it cannot be started for a reason that may pass; answers `{ skipped }` when the night cannot run at all today (nobody to run it as, no
   * workspace room, a budget with no room): the claims are then given back and the scheduler is not asked to retry.
   */
  startRun(input: { orgId: OrgId; project: string; branch: string; headSha: string; envRevision: number; slotId: string; payer: { kind: "project"; project: string }; source: "nightly_baseline" }): Promise<void | { skipped: NightlySkipReason }>;
}

export interface NightlyDeps extends TestEnvDeps { runs: NightlyRunPort }

export type NightlyFireOutcome = { outcome: "started"; slotId: string } | { outcome: "skipped"; reason: NightlySkipReason };

const skip = (reason: NightlySkipReason): NightlyFireOutcome => ({ outcome: "skipped", reason });
/** A night that cannot run at all today: a note the project's health page and Home read (night-status.ts), and a skip. The note is best effort. */
async function unavailable(deps: TestEnvDeps, orgId: OrgId, project: string, scheduledAt: string, reason: "services_unsupported" | "registries_unsupported" | "branch_not_default"): Promise<NightlyFireOutcome> {
  await recordNightUnavailable(deps, { orgId, project, slotId: nightlySlotId(orgId, project, scheduledAt), reason }).catch(() => undefined);
  return skip(reason);
}

const baselineLatestKey = (orgId: OrgId, project: string): DocumentKey => keyOf(orgId, project, "TESTENV#BASELINE#LATEST");

/** The last recorded baseline, or undefined. A stored item that does not read back is an error: a damaged baseline is never "no baseline". */
export async function readNightlyBaseline(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<NightlyBaseline | undefined> {
  const item = await readItem(deps, baselineLatestKey(orgId, project));
  if (item === undefined) return undefined;
  const parsed = NightlyBaselineSchema.safeParse(item["baseline"]);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "the nightly baseline could not be read");
  return parsed.data;
}

/** The fire a due schedule is, in the contract's own shape (the company is the due's, the project is the target's). Throws CONFIG_INVALID for a due that is not a nightly's. */
export function nightlyFireOf(due: DueSchedule): ReturnType<typeof NightlyFireSchema.parse> {
  const project = due.target.ref["project"];
  if (due.target.kind !== NIGHTLY_TARGET_KIND || typeof project !== "string") throw agentXError("CONFIG_INVALID", "not a nightly fire");
  const fire = NightlyFireSchema.safeParse({ source: NIGHTLY_SOURCE, orgId: due.companyId, project, scheduledAt: due.scheduledAt });
  if (!fire.success) throw agentXError("CONFIG_INVALID", "not a nightly fire");
  return fire.data;
}

/**
 * Handles one scheduler fire. Throws only for a fault that may pass (so the scheduler delivers it again and then gives it up): the claim write, or starting the run. Everything decided is returned as an outcome.
 * Idempotent per slot: the slot is the one the fire's own time makes (`nightlySlotId`), claimed with a conditional write before anything starts.
 */
export async function handleNightlyFire(deps: NightlyDeps, due: DueSchedule): Promise<NightlyFireOutcome> {
  const { orgId, project, scheduledAt } = nightlyFireOf(due);
  const now = deps.now();
  const at = Date.parse(scheduledAt);
  if (now - at > NIGHTLY_FIRE_MAX_AGE_MS || at - now > 5 * 60_000) return skip("stale_fire");
  const env = await readApprovedTestEnvironment(deps, orgId, project);
  if (env === undefined) return skip("environment_missing");
  if (!env.environment.nightly.enabled) return skip("nightly_off");
  // Services (mocks, pre-prod probes) cannot be started by a nightly run yet: no preparation, no task, and a neutral reason (never "needs repair").
  if (env.environment.services.length > 0) return unavailable(deps, orgId, project, scheduledAt, "services_unsupported");
  const branch = env.environment.nightly.branch;
  if (deps.runs.defaultBranchOf !== undefined) {
    const defaultBranch = await deps.runs.defaultBranchOf({ orgId, project }).catch(() => undefined);
    if (defaultBranch === undefined) return skip("head_unreadable");
    if (defaultBranch !== branch) return unavailable(deps, orgId, project, scheduledAt, "branch_not_default");
  }
  if (deps.runs.usesRegistries !== undefined) {
    const registries = await deps.runs.usesRegistries({ orgId, project }).catch(() => undefined);
    if (registries === undefined) return skip("head_unreadable");
    if (registries) return unavailable(deps, orgId, project, scheduledAt, "registries_unsupported");
  }
  const head = await deps.runs.headOf({ orgId, project, branch }).catch(() => undefined);
  if (head === undefined || !/^[a-f0-9]{40}$/u.test(head)) return skip("head_unreadable");
  const last = await readNightlyBaseline(deps, orgId, project);
  if (last !== undefined && last.headSha === head && last.branch === branch && last.envRevision === env.revision) return skip("no_merges");

  // At most one run a day: the last recorded run, or a run claimed and not yet reported, that is under the gap old means this fire is skipped, whatever the cron is.
  if (last !== undefined && now - Date.parse(last.finishedAt) < NIGHTLY_MIN_GAP_MS) return skip("ran_recently");

  // Charged to the project before anything is claimed: a project with no room is skipped (and the Home failure card says why), a fault that may pass is thrown for the scheduler to retry.
  try {
    await deps.runs.admit({ orgId, project, purpose: "nightly_baseline" });
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && BUDGET_CODES.has(code)) return skip("budget");
    throw error;
  }

  // At most one retry the same UTC day, only after an infrastructure-class failure: the failed night's claims are given back so this fire may take the day (night-status.ts `sameDayRetryOf`).
  const retrying = await sameDayRetryOf(deps, orgId, project).catch(() => undefined);
  if (retrying !== undefined) await releaseNightly(deps, orgId, project, retrying, true);

  const slotId = nightlySlotId(orgId, project, scheduledAt);
  const dayClaim = keyOf(orgId, project, `TESTENV#NIGHTLY#DAY#${new Date(now).toISOString().slice(0, 10)}`);
  const lock = keyOf(orgId, project, "TESTENV#NIGHTLY#ACTIVE");
  const claim = keyOf(orgId, project, `TESTENV#NIGHTLY#SLOT#${slotId}`);
  const claimed = await deps.store.put({
    item: documentOf({ ...claim, entityType: "TEST_ENV_NIGHTLY_SLOT", orgId, project, slotId, claimedAt: new Date(now).toISOString(), ...expiryOf(now + 7 * 24 * HOUR_MS) }),
    condition: when.absent(),
  });
  if (!claimed.applied) return skip("already_handled");
  const locked = await deps.store.put({
    item: documentOf({ ...lock, entityType: "TEST_ENV_NIGHTLY_ACTIVE", orgId, project, slotId, startedAtMs: now, ...expiryOf(now + NIGHTLY_RUN_MAX_MS + 3_600_000) }),
    // Free, or held by a run that has outlived its longest time.
    condition: when.or(when.absent(), when.lt("startedAtMs", now - NIGHTLY_RUN_MAX_MS)),
  });
  if (!locked.applied) {
    await releaseNightly(deps, orgId, project, slotId, true);
    return skip("still_running");
  }
  // One run per project per UTC day, claimed in the store, so two fires that raced past the checks above still start one.
  const day = await deps.store.put({
    item: documentOf({ ...dayClaim, entityType: "TEST_ENV_NIGHTLY_DAY", orgId, project, slotId, ...expiryOf(now + 3 * 24 * HOUR_MS) }),
    condition: when.or(when.absent(), when.eq("slotId", slotId)),
  });
  if (!day.applied) {
    await releaseNightly(deps, orgId, project, slotId, true);
    return skip("ran_recently");
  }
  let refused: { skipped: NightlySkipReason } | undefined;
  try {
    const started = await deps.runs.startRun({ orgId, project, branch, headSha: head, envRevision: env.revision, slotId, payer: { kind: "project", project }, source: "nightly_baseline" });
    if (started !== undefined) refused = started;
  } catch (error) {
    // The run did not start: let the scheduler's retry try again (the slot claim stays, so a retry would be "already handled"; release both).
    await releaseNightly(deps, orgId, project, slotId, true);
    throw error;
  }
  // The night cannot run today and nothing was started: every claim is given back, so tomorrow's fire (or a later one today) is not shut out by it.
  if (refused !== undefined) {
    await releaseNightly(deps, orgId, project, slotId, true);
    return skip(refused.skipped);
  }
  return { outcome: "started", slotId };
}

export async function releaseNightly(deps: TestEnvDeps, orgId: OrgId, project: string, slotId: string, alsoSlot: boolean): Promise<void> {
  const quietly = <T>(work: Promise<T>) => work.catch(() => undefined);
  await quietly(deps.store.delete({ key: keyOf(orgId, project, "TESTENV#NIGHTLY#ACTIVE"), condition: when.eq("slotId", slotId) }));
  if (alsoSlot) {
    await quietly(deps.store.delete({ key: keyOf(orgId, project, `TESTENV#NIGHTLY#SLOT#${slotId}`) }));
    await quietly(deps.store.delete({ key: keyOf(orgId, project, `TESTENV#NIGHTLY#DAY#${new Date(deps.now()).toISOString().slice(0, 10)}`), condition: when.eq("slotId", slotId) }));
  }
}

// ---- recording a result

export interface MapStore {
  /** Stores the map and returns its digest (the digest of its canonical JSON). */
  put(orgId: OrgId, project: string, map: CoverageMapData): Promise<string>;
  get(orgId: OrgId, project: string, digest: string): Promise<unknown>;
}

export const coverageMapDigest = (map: CoverageMapData): string => sha(CoverageMapSchema.parse(map));

/** What `recordNightlyResult` tells its optional listener once the baseline is stored (the project's health, where it is wired, is bound to it). */
export interface NightlyRecorded { orgId: OrgId; project: string; slotId: string; baseline: NightlyBaseline; health: StoredNightlyHealth | undefined }

/**
 * What the night's step words say, classified by the broker's own rules: nothing the worker says in words is read. Undefined for a result that carries no step words (an older worker), which then
 * stores nothing new. A report whose counts are not the result's own counts disagrees with itself and reads as unclear, never as passed.
 */
export function nightlyHealthOf(result: NightlyResult, context: { noSmokeCheck?: boolean } = {}): StoredNightlyHealth | undefined {
  if (result.health === undefined) return undefined;
  const { ranFrom, ...report } = result.health;
  const agrees = report.tests.total === result.tests.total && report.tests.passed === result.tests.passed && report.tests.skipped === result.tests.skipped && report.tests.failures + report.tests.errors === result.tests.failed;
  const verdict = agrees ? classifyNightlyHealth(report, context) : ({ class: "unclear", cause: "steps_disagree" } as const);
  return { class: verdict.class, ...("cause" in verdict ? { cause: verdict.cause } : {}), ...(verdict.class === "tests" ? { setupProved: verdict.setupProved } : {}), ranFrom: ranFrom ?? "fresh" };
}

/**
 * Records a finished run. Accepted only for the slot the project's active run holds (so a stale or invented result changes nothing), for the environment's revision and branch, and only once. The failing set is capped;
 * when it does not fit it is kept empty-and-truncated, which excuses nothing. A coverage map is accepted only if the digest the result names is the map's own.
 */
export async function recordNightlyResult(
  deps: TestEnvDeps,
  maps: MapStore,
  input: { orgId: OrgId; project: string; result: unknown; coverageMap?: unknown },
  onRecorded?: (recorded: NightlyRecorded) => Promise<void>,
): Promise<{ recorded: true; flakyCount: number; failingCount: number }> {
  const parsed = NightlyResultSchema.safeParse(input.result);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the nightly result could not be read");
  const result = parsed.data;
  // The worker's clock is not trusted: a result dated in the future would freeze the "ran recently" gap (and the health's order) for as long as it says. Nothing is read or claimed for it.
  const horizon = deps.now() + NIGHTLY_CLOCK_SKEW_MS;
  if (Date.parse(result.finishedAt) > horizon || Date.parse(result.startedAt) > horizon) throw agentXError("CONFIG_INVALID", "the nightly result is dated in the future");
  const lock = await readItem(deps, keyOf(input.orgId, input.project, "TESTENV#NIGHTLY#ACTIVE"));
  if (lock === undefined || lock["slotId"] !== result.slotId) throw agentXError("CHANGE_STALE", "no nightly run is waiting for this result");
  let coverageMapBuiltAt: string | undefined;
  if (input.coverageMap !== undefined) {
    const map = CoverageMapSchema.safeParse(input.coverageMap);
    if (!map.success || result.coverageMapRef === undefined || coverageMapDigest(map.data) !== result.coverageMapRef) throw agentXError("CONFIG_INVALID", "the coverage map does not match the result");
    // A map older than its own run was not built by it.
    if (Date.parse(map.data.builtAt) > Date.parse(result.finishedAt) + 60_000) throw agentXError("CONFIG_INVALID", "the coverage map does not match the result");
    const stored = await maps.put(input.orgId, input.project, map.data);
    if (stored !== result.coverageMapRef) throw agentXError("RUNTIME_UNAVAILABLE", "the coverage map could not be stored");
    coverageMapBuiltAt = map.data.builtAt;
  } else if (result.coverageMapRef !== undefined) {
    throw agentXError("CONFIG_INVALID", "the result names a coverage map it did not send");
  }
  const env = await readApprovedTestEnvironment(deps, input.orgId, input.project);
  if (env === undefined || env.revision !== result.envRevision || env.environment.nightly.branch !== result.branch) throw agentXError("CHANGE_STALE", "the environment changed since this nightly started");
  const previous = await readNightlyBaseline(deps, input.orgId, input.project);
  const now = deps.now();
  const baseline = NightlyBaselineSchema.parse({
    recordedAt: new Date(now).toISOString(), envRevision: result.envRevision, branch: result.branch, headSha: result.headSha, finishedAt: result.finishedAt, tests: result.tests,
    failed: result.failed.slice(0, NIGHTLY_FAILED_MAX), flaky: result.flaky.slice(0, NIGHTLY_FLAKY_MAX),
    ...(result.failedUnlisted === undefined || result.failedUnlisted === 0 ? {} : { failedUnlisted: result.failedUnlisted }),
    // Keep the last good map when this run recorded none: selection reads its own age, so an old map falls back to the full suite by itself.
    ...(result.coverageMapRef !== undefined && coverageMapBuiltAt !== undefined ? { coverageMapRef: result.coverageMapRef, coverageMapBuiltAt } : previous?.coverageMapRef === undefined || previous.coverageMapBuiltAt === undefined ? {} : { coverageMapRef: previous.coverageMapRef, coverageMapBuiltAt: previous.coverageMapBuiltAt }),
  });
  // The health sits BESIDE the baseline, not inside it: an older broker still reads the baseline. A result without step words stores exactly what it always did.
  // A skipped smoke step is fine only when the approved environment of THIS night's revision defines no smoke check (read here, from the broker's own record).
  const health = nightlyHealthOf(result, { noSmokeCheck: !env.environment.repos.some((repo) => repo.checks.some((check) => check.kind === "smoke")) });
  const healthField = health === undefined ? {} : { health };
  const history = { ...keyOf(input.orgId, input.project, `TESTENV#BASELINE#${result.finishedAt}`), entityType: "TEST_ENV_BASELINE", orgId: input.orgId, project: input.project, baseline, ...healthField, ...(result.coverageMapSkipped === undefined ? {} : { coverageMapSkipped: result.coverageMapSkipped }), slowest: result.slowest, durationMs: result.durationMs, ...expiryOf(now + BASELINE_TTL_MS) };
  await deps.store.put({ item: documentOf(history) });
  await deps.store.put({ item: documentOf({ ...baselineLatestKey(input.orgId, input.project), entityType: "TEST_ENV_BASELINE_LATEST", orgId: input.orgId, project: input.project, baseline, ...healthField }) });
  // Before the run is released: a listener that fails leaves the run claimed, so the worker's retry records the same result again (every write above and in the listener is repeatable).
  if (onRecorded !== undefined) {
    try {
      await onRecorded({ orgId: input.orgId, project: input.project, slotId: result.slotId, baseline, health });
    } catch (error) {
      // The health is advisory: a listener never fails the record. Only a fault that may pass (a stale write, a throttled or unavailable table) is thrown, so the worker's retry records the result again.
      console.log(JSON.stringify({ component: "broker", level: "warn", event: "test_env.nightly_health_failed", orgId: input.orgId, error: errorName(error) }));
      if (mayPass(error)) throw error;
    }
  }
  await releaseNightly(deps, input.orgId, input.project, result.slotId, false);
  return { recorded: true, flakyCount: result.flaky.length, failingCount: result.tests.failed };
}

/**
 * Whether a baseline's failing set is whole: every failing test is either listed in `failed` or counted in `failedUnlisted` (its id is not valid, so it can be neither excused nor marked, and no other test is it).
 * A set the cap cut, or that no longer adds up, is not whole and excuses nothing. One odd id does NOT make the baseline unusable: only that test loses its excuse.
 */
export const failingSetIsWhole = (baseline: Pick<NightlyBaseline, "failed" | "failedUnlisted" | "tests">): boolean => baseline.failed.length + (baseline.failedUnlisted ?? 0) === baseline.tests.failed;

// ---- what the baseline feeds

/** The last night's classification with the baseline it belongs to. `health` is undefined when that night carried no step words; a stored classification that does not read back is "unclear", never absent and never passed. */
export async function readLatestNightlyHealth(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<{ baseline: NightlyBaseline; health: StoredNightlyHealth | undefined } | undefined> {
  const item = await readItem(deps, baselineLatestKey(orgId, project));
  if (item === undefined) return undefined;
  const baseline = NightlyBaselineSchema.safeParse(item["baseline"]);
  if (!baseline.success) throw agentXError("RUNTIME_UNAVAILABLE", "the nightly baseline could not be read");
  if (item["health"] === undefined) return { baseline: baseline.data, health: undefined };
  const health = StoredNightlyHealthSchema.safeParse(item["health"]);
  return { baseline: baseline.data, health: health.success ? health.data : { class: "unclear", cause: "unreadable", ranFrom: "fresh" } };
}

/**
 * The tests that already fail on the default branch, for the check classifier ("not a regression of this task"). Fail closed: an unreadable baseline, or one whose failing set did not fit (more failures than
 * the cap), excuses nothing.
 */
export async function alreadyFailingTests(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<string[]> {
  const baseline = await readNightlyBaseline(deps, orgId, project).catch(() => undefined);
  if (baseline === undefined || !failingSetIsWhole(baseline)) return [];
  return [...baseline.failed];
}

/** The last nightly's failures, which a selection always runs again. Not the cap-excused set: when the set is truncated, what is listed still runs. */
export async function lastNightlyFailures(deps: TestEnvDeps, orgId: OrgId, project: string): Promise<string[]> {
  const baseline = await readNightlyBaseline(deps, orgId, project).catch(() => undefined);
  return baseline === undefined ? [] : [...baseline.failed];
}

/** The stored coverage map the baseline points at, checked against its digest; undefined when there is none, it cannot be read, or it does not hash to what the baseline recorded. */
export async function readCoverageMap(deps: TestEnvDeps, maps: MapStore, orgId: OrgId, project: string): Promise<CoverageMapData | undefined> {
  const baseline = await readNightlyBaseline(deps, orgId, project).catch(() => undefined);
  if (baseline?.coverageMapRef === undefined) return undefined;
  try {
    const parsed = CoverageMapSchema.safeParse(await maps.get(orgId, project, baseline.coverageMapRef));
    return parsed.success && coverageMapDigest(parsed.data) === baseline.coverageMapRef ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Counts the days since the map was built, for the Home failure card ("nothing ran for 7 days"). Undefined when there is no map. */
export function mapAgeDays(baseline: NightlyBaseline | undefined, nowMs: number): number | undefined {
  if (baseline?.coverageMapBuiltAt === undefined) return undefined;
  const built = Date.parse(baseline.coverageMapBuiltAt);
  return Number.isFinite(built) ? Math.max(FRESH_MAP_FLOOR, Math.floor((nowMs - built) / (24 * HOUR_MS))) : undefined;
}

/** Flaky bookkeeping for a result: a test is flaky when it failed once and passed on the rerun. Tests are given as the first run's failures and the rerun's failures. */
export function splitFailures(firstRunFailures: readonly string[], rerunFailures: readonly string[]): { failed: string[]; flaky: string[] } {
  const again = new Set(rerunFailures);
  const first = [...new Set(firstRunFailures)];
  return { failed: first.filter((id) => again.has(id)).sort(), flaky: first.filter((id) => !again.has(id)).sort() };
}

