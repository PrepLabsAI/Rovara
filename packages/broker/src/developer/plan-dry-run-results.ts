import { createHash } from "node:crypto";
import {
  PLAN_DRY_RUN_FEATURE, PlanDryRunReportSchema, planDryRunCommandSha256, planQualityFinding,
  type OriginalCodeResult, type PlanDryRunClass, type PlanDryRunUnavailableReason, type PlanQualityFinding,
} from "@agentx/contracts";

/**
 * PLANDRYRUN, the control plane's side: reads what the planning worker reported about trying a coding plan's proposed checks on the unchanged code, and turns it into the
 * plan self-check's findings. Pure functions; the self-check wiring (T5) calls them with the operation's events and the plan it stored.
 *
 * The report is accepted only for the exact plan text it names (its digest), and each result is attributed to a proposed check by the digest of the command that ran, so a
 * report of another plan version, another command or a different numbering never lands on the wrong check. Whatever is not readable, not matching or not there is "not
 * tried" with a fixed reason: it can add a warning, never a finding, and never block anything.
 */

export interface DryRunProposedCheck { id: string; command: { cwd: string; executable: string; args: readonly string[] } }

export type PlanDryRunNotTriedReason = "no-proposed-checks" | "worker-cannot" | "no-report" | "report-for-another-plan" | "report-unreadable" | "worker-unavailable";

export type PlanDryRunOutcome =
  | { status: "NOT_TRIED"; reason: PlanDryRunNotTriedReason; workerReason?: PlanDryRunUnavailableReason }
  | { status: "TRIED"; results: ReadonlyArray<{ checkId: string; class: PlanDryRunClass }> };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** True when a worker that lists these features does the dry run (and so the planner may be asked for `expectOnBase`). */
export function workerTriesProposedChecks(features: readonly string[] | undefined): boolean {
  return features?.includes(PLAN_DRY_RUN_FEATURE) === true;
}

/**
 * The outcome for the plan version just stored. `events` are the planning operation's events (only `progress` events are read, the last report wins), `planText` is the exact
 * text of the plan the worker uploaded, and `proposed` are the proposed checks the broker read from that plan. `workerFeatures` is what the worker listed when the run was sent.
 */
export function readPlanDryRunOutcome(input: {
  events: ReadonlyArray<{ type: string; payload: unknown }>;
  planText: string;
  proposed: readonly DryRunProposedCheck[];
  workerFeatures?: readonly string[] | undefined;
}): PlanDryRunOutcome {
  if (input.proposed.length === 0) return { status: "NOT_TRIED", reason: "no-proposed-checks" };
  if (!workerTriesProposedChecks(input.workerFeatures)) return { status: "NOT_TRIED", reason: "worker-cannot" };
  let raw: unknown;
  let found = false;
  for (const event of input.events) {
    if (event.type !== "progress" || event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
    if (!Object.hasOwn(event.payload, "planDryRun")) continue;
    raw = (event.payload as { planDryRun?: unknown }).planDryRun;
    found = true;
  }
  if (!found) return { status: "NOT_TRIED", reason: "no-report" };
  const parsed = PlanDryRunReportSchema.safeParse(raw);
  if (!parsed.success) return { status: "NOT_TRIED", reason: "report-unreadable" };
  const report = parsed.data;
  if (report.planSha256 !== sha256(input.planText)) return { status: "NOT_TRIED", reason: "report-for-another-plan" };
  if (report.status === "UNAVAILABLE") return { status: "NOT_TRIED", reason: "worker-unavailable", workerReason: report.reason };
  const pool = [...report.checks];
  const results = input.proposed.map((check) => {
    const digest = planDryRunCommandSha256(check.command);
    const at = pool.findIndex((entry) => entry.commandSha256 === digest);
    // A check the report has no entry for was not tried: never read as a pass.
    if (at < 0) return { checkId: check.id, class: "not-run" as const };
    const [entry] = pool.splice(at, 1);
    // The report's durations stay with the worker's logs: a free-form number the code under test can steer never reaches a prompt, a card or a page.
    return { checkId: check.id, class: entry!.class };
  });
  return { status: "TRIED", results };
}

/**
 * The findings the dry run gives. `check-broken-on-base`: the command could not run at all (not an assertion that failed). `check-base-mismatch`: it ran and did not do what
 * `expectOnBase` said (a check with no prediction is never a mismatch). Both are revisable; each lists its check IDs once, in plan order.
 */
export function planDryRunFindings(input: { outcome: PlanDryRunOutcome; expectOnBase?: Readonly<Record<string, "pass" | "fail">> | undefined }): PlanQualityFinding[] {
  if (input.outcome.status !== "TRIED") return [];
  const broken = input.outcome.results.filter((result) => result.class === "broken").map((result) => result.checkId);
  const mismatched = input.outcome.results.filter((result) => {
    const expected = input.expectOnBase?.[result.checkId];
    return (expected === "pass" && result.class === "failed") || (expected === "fail" && result.class === "passed");
  }).map((result) => result.checkId);
  return [
    ...(broken.length === 0 ? [] : [planQualityFinding({ code: "check-broken-on-base", checkIds: broken })]),
    ...(mismatched.length === 0 ? [] : [planQualityFinding({ code: "check-base-mismatch", checkIds: mismatched })]),
  ];
}

/** The warnings the approval card and page show when checks were not (all) tried: fixed sentences, no detail from the worker. */
export function planDryRunWarnings(outcome: PlanDryRunOutcome): string[] {
  if (outcome.status === "NOT_TRIED") return outcome.reason === "no-proposed-checks" ? [] : ["None of the proposed checks were tried on the current code."];
  const untried = outcome.results.filter((result) => result.class === "not-run" || result.class === "not-checked").length;
  const total = outcome.results.length;
  return untried === 0 ? [] : [`${untried} of ${total} proposed ${total === 1 ? "check" : "checks"} ${untried === 1 ? "was" : "were"} not tried on the current code.`];
}

/**
 * Each tried check's result on the original code, in the shape automatic fixing reads (`AutoFixFacts.checkOriginal`): `passed`, `failed`, or `cannot-run` for a check that
 * was broken. Empty when nothing was tried, so an unknown result stays unknown.
 */
export function planDryRunOriginalResults(outcome: PlanDryRunOutcome): Record<string, OriginalCodeResult> {
  if (outcome.status !== "TRIED") return {};
  // A check that was not tried is left out: its result is unknown, which is not the same as "cannot run".
  return Object.fromEntries(outcome.results.filter((result) => result.class !== "not-run" && result.class !== "not-checked")
    .map((result) => [result.checkId, result.class === "passed" ? "passed" as const : result.class === "failed" ? "failed" as const : "cannot-run" as const]));
}
