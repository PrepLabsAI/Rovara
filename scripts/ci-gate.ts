// CI's gate. The `plan` job (scripts/ci-plan.ts) decides what a run needs; `quick`, `build`, the test shards, the Linux runtime check and the `ci-mode (full)` check run as
// separate jobs; the job called `local` waits for all of them and is the one check a pull request needs. GitHub counts a skipped job as a pass, so a plain `needs` would let
// a pull request go green with a job missing. This reads the plan's answers and holds each job to them: a job the plan skipped by design must have been skipped (it counts as
// a pass), a job the plan required must have succeeded, and a full run must have run everything. Node runs this file directly, so it imports only Node's own modules.

export interface GateVerdict { ok: boolean; reason: string }

/** The plan's outputs, as GitHub hands them over (strings). */
export type PlanOutputs = Readonly<Record<string, string | undefined>>;

/** The jobs `local` judges besides `plan`, in the order they are reported. */
export const GATED_JOBS = ["quick", "build", "test", "linux-runtime", "ci-mode"] as const;

/** The shard list of a run that executes the whole suite (scripts/ci-plan.ts FULL_SHARDS). */
export const FULL_SHARD_LIST = "[1,2,3,4,5,6,7,8]";
const MODES = ["full", "affected", "reuse"];
/** #1181: the run a reuse stands on (scripts/ci-plan.ts findReuse). */
const REUSED_RUN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/u;
const SCOPES = ["all", "changed", "none"];
const BOOLEANS = ["true", "false"];

/** What each job's result must be, from the plan: "success" when the plan needs the job, "skipped" when it skipped the job by design. Or a reason the plan itself is not trusted. */
export function expectedResults(plan: PlanOutputs): { expected: Record<string, "success" | "skipped"> } | { problem: string } {
  const { mode, docs_only: docsOnly, tests, lint, linux, release } = plan;
  if (mode === undefined || !MODES.includes(mode)) return { problem: `the plan's mode is ${JSON.stringify(mode)}, not full, affected or reuse` };
  // #1181: a reuse runs nothing but the plan, ci-mode (full), port-guard and this gate, and must name the full run it stands on.
  if (mode === "reuse") {
    if (!(tests === "none" && lint === "none" && linux === "false" && release === "false" && docsOnly === "false")) return { problem: `the plan says reuse but still runs part of the suite (tests ${tests}, lint ${lint}, linux ${linux}, release ${release}, docs_only ${docsOnly})` };
    if (plan.reuse_run === undefined || !REUSED_RUN.test(plan.reuse_run)) return { problem: `the plan says reuse but names no run (${JSON.stringify(plan.reuse_run)})` };
    return { expected: { quick: "skipped", build: "skipped", test: "skipped", "linux-runtime": "skipped", "ci-mode": "success" } };
  }
  if (tests === undefined || !SCOPES.includes(tests)) return { problem: `the plan's tests is ${JSON.stringify(tests)}, not all, changed or none` };
  if (lint === undefined || !SCOPES.includes(lint)) return { problem: `the plan's lint is ${JSON.stringify(lint)}, not all, changed or none` };
  for (const [name, value] of [["docs_only", docsOnly], ["linux", linux], ["release", release]] as const) {
    if (value === undefined || !BOOLEANS.includes(value)) return { problem: `the plan's ${name} is ${JSON.stringify(value)}, not true or false` };
  }
  // A full run runs everything but the Linux runtime check, which runs when its area changes, per batch, nightly or on request (#1185, ci-plan.ts linuxRuns);
  // a plan that says full but also skips anything else is not one to trust.
  if (mode === "full" && !(tests === "all" && lint === "all" && release === "true" && docsOnly === "false")) {
    return { problem: `the plan says full but also skips part of the run (tests ${tests}, lint ${lint}, release ${release}, docs_only ${docsOnly})` };
  }
  // The whole suite is eight shards: a plan that says so but lists fewer would run only part of it.
  if (tests === "all" && plan.shards !== FULL_SHARD_LIST) return { problem: `the plan runs the whole suite but its shard list is ${JSON.stringify(plan.shards)}, not ${FULL_SHARD_LIST}` };
  if (docsOnly === "true" && (mode !== "affected" || tests !== "none")) return { problem: "the plan says Markdown-only but still runs tests" };
  return {
    expected: {
      quick: docsOnly === "true" ? "skipped" : "success",
      build: tests === "none" ? "skipped" : "success",
      test: tests === "none" ? "skipped" : "success",
      "linux-runtime": linux === "true" ? "success" : "skipped",
      "ci-mode": mode === "full" ? "success" : "skipped",
    },
  };
}

/** `results` maps each job the gate waited for to its result: success, failure, cancelled or skipped. */
export function gateVerdict(input: { plan: PlanOutputs; results: Readonly<Record<string, string>> }): GateVerdict {
  const { plan, results } = input;
  if (results.plan !== "success") return { ok: false, reason: `plan was ${results.plan ?? "missing"}, not success` };
  const decided = expectedResults(plan);
  if ("problem" in decided) return { ok: false, reason: decided.problem };
  for (const job of GATED_JOBS) {
    const result = results[job];
    const expected = decided.expected[job]!;
    if (result === undefined) return { ok: false, reason: `${job} was missing` };
    if (result === expected) continue;
    if (expected === "skipped") return { ok: false, reason: `${job} was ${result}, but the plan skipped it` };
    if (result === "skipped") return { ok: false, reason: `${job} was skipped, but the plan needs it to succeed` };
    return { ok: false, reason: `${job} was ${result}, not success` };
  }
  const ran = GATED_JOBS.filter((job) => decided.expected[job] === "success");
  const skipped = GATED_JOBS.filter((job) => decided.expected[job] === "skipped");
  const mode = plan.mode === "full" ? "FULL run" : plan.mode === "reuse" ? `reuse of the full pass of ${plan.reuse_run ?? "?"} (byte-identical code)` : plan.docs_only === "true" ? "Markdown-only change" : "affected run";
  return { ok: true, reason: `${mode}; ${ran.length} jobs succeeded${skipped.length > 0 ? `, ${skipped.length} skipped by design (${skipped.join(", ")})` : ""}` };
}

interface Need { result?: unknown; outputs?: Record<string, unknown> }

/** The verdict for the JSON of GitHub's `needs` context (`toJSON(needs)`). */
export function needsVerdict(needsJson: string): GateVerdict {
  let needs: unknown;
  try {
    needs = JSON.parse(needsJson);
  } catch {
    return { ok: false, reason: "the needs context is not JSON" };
  }
  if (typeof needs !== "object" || needs === null) return { ok: false, reason: "the needs context is not an object" };
  const entries = Object.entries(needs as Record<string, Need>);
  const results = Object.fromEntries(entries.map(([job, need]) => [job, String(need?.result)]));
  const outputs = (needs as Record<string, Need>).plan?.outputs ?? {};
  const plan = Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, typeof value === "string" ? value : undefined]));
  return gateVerdict({ plan, results });
}

// Usage: NEEDS='<toJSON(needs)>' node scripts/ci-gate.ts
if (process.argv[1]?.endsWith("ci-gate.ts")) {
  const verdict = needsVerdict(process.env.NEEDS ?? "");
  console.log(verdict.ok ? `CI passed: ${verdict.reason}.` : `CI did not pass: ${verdict.reason}.`);
  process.exitCode = verdict.ok ? 0 : 1;
}
