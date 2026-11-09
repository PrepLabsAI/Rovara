// Proof and evidence P8: the evidence's lines in a pull request's Proof section. The pull request is public to the repository's readers, so it carries COUNTS, LABELS AND RESULTS only: no test output, no
// request or response body, no image (an image is P9's, and only for a private repository the company allows). Every word a repository or a person wrote (a check label, a service name) goes through `inertLine`;
// every other word is fixed here. The pack is used only when it is bound to the digest of the code the pull request holds, and a check that did not pass is never shown with a tick.
//
// What stays at every shrink level: the Environment line, the not-run line and the mocked or not-tested bullets (a reader must not miss what was not proved), and the link. The counts per kind and the
// changed-line coverage go first, from level 2.
import { evidenceIsFor, type EvidenceMode, type EvidencePack } from "@agentx/contracts";
import { AWS_PERMISSIONS_ITEM_ID } from "./dependency-evidence.js";
import { packDependencyLines } from "./dependency-lines.js";
import { inertLine } from "./inert-text.js";

/** The evidence's part of the Proof context: the pack the broker built, how much of it the pull request shows, and the Rovara page that has the rest. */
export interface ProofEvidenceContext {
  pack?: EvidencePack | undefined;
  /** The mode after `resolveEvidenceMode` (a public or unknown repository never gets `embed`). */
  mode: EvidenceMode;
  /** The task page's address. Used only when it starts with `origin` and is an https address with no spaces, quotes or angle brackets. */
  taskUrl?: string | undefined;
  /** Rovara's own https origin, as configured (`https://host`, no path). Without it no address is shown: the link line still says where to look. */
  origin?: string | undefined;
}

/** The tests the change added or changed that the broker's own TestProof (bound to this code's digest) says fail on the original code, by name. Undefined when the proof has no per-test verdicts. */
export type ProvenTestNames = ReadonlySet<string> | undefined;

const LINE_MAX = 600;
/** The most mocked-service and other not-tested bullets listed; the rest are counted. */
export const EVIDENCE_NOT_TESTED_LISTED = 10;
const number = (count: number) => count.toLocaleString("en-US");
const cutLine = (text: string, max = LINE_MAX) => {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
};

const OUTCOME_WORDS = { passed: "✓", failed: "✗", timed_out: "timed out", unknown: "not checked", not_run: "not run" } as const;
const SELECTION_WORDS = { coverage_map: "coverage map", import_graph: "import graph", declared: "declared selection", full: "full suite" } as const;
const KIND_WORDS = { lint: "lint", typecheck: "type check", build: "build", smoke: "smoke test" } as const;
const TIER_WORDS = { sandbox: "sandbox", preview: "per-task preview environment", shared: "shared pre-prod environment" } as const;
const SERVICE_WORDS = { preprod: "pre-prod", mocked: "mocked", "live-forbidden": "live access refused" } as const;

/** `2026-11-04 02:10 UTC` from a stored timestamp (the pack's schema guarantees it is a datetime). */
function stamp(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC` : "an unknown time";
}

/** The pack, only when it is for exactly this code. */
export function boundEvidence(context: ProofEvidenceContext | undefined, candidateDigest: string | undefined): EvidencePack | undefined {
  return context?.pack !== undefined && candidateDigest !== undefined && evidenceIsFor(context.pack, candidateDigest) ? context.pack : undefined;
}

/** The counts-per-kind line (dropped from shrink level 2): one entry per check, in the pack's order, joined with a middle dot. */
export function testsLine(pack: EvidencePack, proven?: ProvenTestNames): string | undefined {
  const parts: string[] = [];
  for (const check of pack.checks) {
    const label = inertLine(check.label, 60);
    if (check.kind === "test") {
      const tests = check.tests;
      // The outcome word comes first and is always there, so a failed or unfinished check can never read as passed, whatever its counts say.
      const mark = OUTCOME_WORDS[check.after];
      if (tests === undefined) {
        parts.push(`${label} ${mark} (test details not read)`);
        continue;
      }
      const counts = [`${number(tests.passed)} passed`, ...(tests.failed > 0 ? [`${number(tests.failed)} failed`] : []), ...(tests.errored > 0 ? [`${number(tests.errored)} errored`] : []), ...(tests.skipped > 0 ? [`${number(tests.skipped)} skipped`] : [])];
      // "Fails on the original code" is the broker's own TestProof's word, never the worker's per-test verdict in the pack.
      const fails = proven === undefined ? undefined : tests.newTests.filter((id) => proven.has(id)).length;
      const added = tests.newTests.length === 0 ? "" : `; ${number(tests.newTests.length)} new${fails === undefined ? "" : `, ${number(fails)} fail on the original code`}`;
      parts.push(`${label} ${mark}: ${counts.join(", ")}${added}`);
    } else if (check.kind === "security") {
      const findings = check.findings;
      if (check.after !== "passed" && check.after !== "failed") parts.push(`security scan ${OUTCOME_WORDS[check.after]}`);
      else if (findings === undefined) parts.push(`security scan ${OUTCOME_WORDS[check.after]} (findings not read)`);
      else if ((findings.unverified ?? 0) > 0) parts.push(`security scan ${OUTCOME_WORDS[check.after]}: ${number(findings.unverified!)} high or critical finding${findings.unverified === 1 ? "" : "s"} could not be compared with the original code`);
      else parts.push(`security scan ${OUTCOME_WORDS[check.after]}: ${findings.newCount === 0 ? "0 new findings" : `${number(findings.newCount)} new${findings.bySeverity.critical + findings.bySeverity.high > 0 ? ` (${number(findings.bySeverity.critical + findings.bySeverity.high)} high or critical)` : ""}`}`);
    } else if (check.kind === "migration") {
      const migrations = check.migrations;
      if (check.after !== "passed" || migrations === undefined) parts.push(`migrations ${OUTCOME_WORDS[check.after]}`);
      else parts.push(`migrations: ${number(migrations.applied.length)} applied${migrations.rolledBack === true ? " and rolled back cleanly" : migrations.rolledBack === false ? ", rollback failed" : ""}`);
    } else {
      // A lint or type check that wrote SARIF also says how many findings are new (counts only; a finding's text is not on the pull request).
      const found = check.findings;
      const note = found === undefined ? "" : found.newCount === 0 ? " (no new findings)" : ` (${number(found.newCount)} new finding${found.newCount === 1 ? "" : "s"})`;
      parts.push(`${check.kind === "other" ? label : KIND_WORDS[check.kind]} ${OUTCOME_WORDS[check.after]}${note}`);
    }
  }
  if (pack.selection.selected < pack.selection.total) parts.push(`${number(pack.selection.selected)} of ${number(pack.selection.total)} tests selected (${SELECTION_WORDS[pack.selection.method]})`);
  return parts.length === 0 ? undefined : cutLine(`Checks by kind: ${parts.slice(0, 12).join(" · ")}${parts.length > 12 ? ` · and ${parts.length - 12} more` : ""}`);
}

/**
 * The changed-line coverage line (dropped from shrink level 2): the changed lines the tests cover, over every check that measured it. "No coverage report" when a test check ran and none wrote one this round (or the
 * one it wrote could not be read); a report that lists none of the changed lines says so instead of a bare "0 of 0". Replaces: "not measured", which did not say why.
 */
export function coverageLine(pack: EvidencePack): string | undefined {
  const measured = pack.checks.filter((check) => check.coverage !== undefined);
  if (measured.length === 0) return pack.checks.some((check) => check.kind === "test") ? "Changed lines covered by tests: no coverage report" : undefined;
  const changed = measured.reduce((sum, check) => sum + check.coverage!.linesChanged, 0);
  const covered = measured.reduce((sum, check) => sum + check.coverage!.linesCovered, 0);
  // Changed source files the report never names have no line in the counts: said in fixed words, never left out. With several reports a file may be named by another one, so the smallest count is a floor.
  const unlisted = Math.min(...measured.map((check) => check.coverage!.unlistedFiles ?? 0));
  const missing = unlisted === 0 ? "" : `; ${measured.length > 1 ? "at least " : ""}${number(unlisted)} changed source file${unlisted === 1 ? " is" : "s are"} not in the coverage report`;
  if (changed === 0) return `Changed lines covered by tests: the coverage report lists none of the changed lines${missing}`;
  return `Changed lines covered by tests: ${number(covered)} of ${number(changed)} (${Math.round((covered / changed) * 100)}%)${missing}`;
}

/** The Environment line (never dropped; shorter at level 3 and above): the tier, each service's mode (mocked ones with their recording), the accounts' kind and the data. */
export function environmentLine(pack: EvidencePack, level: number): string {
  const env = pack.environment;
  // Revision 0 is "no approved test environment" (the test environment features are a later lane): the line says so instead of claiming synthetic test data nobody checked. Replaces: the pack's "Test data: synthetic" for such a pack.
  if (env.envRevision === 0 && env.services.length === 0 && env.accounts.length === 0) return `Environment: ${TIER_WORDS[env.tier]}. No approved test environment: the project's own test setup was used.`;
  const services = env.services.map((service) => {
    const name = inertLine(service.name, 40);
    const recorded = service.mode === "mocked" && service.recordedAt !== undefined ? ` (recorded ${service.recordedAt.slice(0, 10)}${service.schemaVersion === undefined ? "" : `, schema v${service.schemaVersion}`})` : "";
    const unrecorded = service.unrecordedAnswered !== undefined && service.unrecordedAnswered > 0 ? `, answered ${number(service.unrecordedAnswered)} unrecorded` : "";
    return `${name}: ${SERVICE_WORDS[service.mode]}${level >= 3 ? "" : `${recorded}${unrecorded}`}`;
  });
  const listed = level >= 4 ? 3 : 8;
  const shown = services.slice(0, listed);
  const servicePart = shown.length === 0 ? "" : ` ${shown.join("; ")}${services.length > listed ? ` and ${services.length - listed} more` : ""}.`;
  // Test environment (wire-testenv): an approved environment is named with its revision. Replaces: the bare "Environment: sandbox." for a pack with an approved test environment.
  const approved = env.envRevision > 0 ? `, approved test environment revision ${String(env.envRevision)}` : "";
  return cutLine(`Environment: ${TIER_WORDS[env.tier]}${approved}.${servicePart} Test data: ${env.data}.`);
}

/** The not-run line (never dropped): how many tests were judged unaffected and the last full run. Absent when the whole suite ran. */
export function notRunLine(pack: EvidencePack): string | undefined {
  const selection = pack.selection;
  const notRun = selection.total - selection.selected;
  if (notRun <= 0) return selection.fallbackReason === undefined ? undefined : "The whole test suite ran, because the change touches files that can affect every test.";
  const age = selection.mapAgeHours === undefined ? "" : `, map ${number(selection.mapAgeHours)} h old`;
  const last = selection.lastFullRun === undefined ? "No full run is on record." : `Last full run: ${stamp(selection.lastFullRun.at)}, ${selection.lastFullRun.status} (${number(selection.lastFullRun.passed)}/${number(selection.lastFullRun.total)}${selection.lastFullRun.flaky > 0 ? `; ${number(selection.lastFullRun.flaky)} known flaky` : ""}).`;
  return cutLine(`Not run here: ${number(notRun)} of ${number(selection.total)} tests judged unaffected (${SELECTION_WORDS[selection.method]}${age}). ${last}`);
}

/** The line that points at the rest of the evidence. Absent in `summary` mode, which has no link; a task address that is not an https address Rovara can stand behind is left out and the line still says where to look. */
export function evidenceLinkLine(context: ProofEvidenceContext): string {
  const where = "Rovara task page (sign-in needed)";
  if (context.mode === "summary") return "Full evidence is in Rovara (sign-in needed).";
  const url = context.taskUrl;
  const origin = context.origin;
  const safe = url !== undefined && origin !== undefined && /^https:\/\/[^\s<>"'`/?#]{1,253}$/u.test(origin) && url.startsWith(`${origin}/`) && /^https:\/\/[^\s<>"'`]{1,2000}$/u.test(url);
  return `Full evidence (screenshots, API samples, video, logs): ${where}${safe ? `: ${url}` : ""}`;
}

const NOUNS = { claim: "Requirement", scenario: "Scenario", check: "Check", mocked_service: "Mocked service", not_selected: "Tests", environment: "Detail" } as const;

/**
 * The not-tested bullets the pack adds to the table's own (the table already lists claims and scenarios, so those kinds are left to it): mocked services, tests not selected, environment details that could
 * not be read, and checks that skipped more tests. Bounded to ten, with the rest counted; never dropped by the shrink levels, which only shorten their words.
 */
export function evidenceNotTestedLines(pack: EvidencePack, level: number, exclude: ReadonlySet<string> = new Set()): string[] {
  // The "AWS permissions were not checked" item is for the Evidence tab; the pull request says it once through `dependencyLines`, which never drops it (so it is not counted among these ten).
  const items = pack.notTested.filter((item) => item.kind !== "claim" && item.kind !== "scenario" && !exclude.has(`${item.kind}:${item.id}`) && !(item.kind === "environment" && item.id === AWS_PERMISSIONS_ITEM_ID));
  const lines = items.slice(0, EVIDENCE_NOT_TESTED_LISTED).map((item) => {
    const name = level >= 4 ? inertLine(item.id, 40) : inertLine(item.text === "" ? item.id : item.text, 80);
    return `- ${NOUNS[item.kind]} ${name} (${inertLine(item.reason, 100)})`;
  });
  if (items.length > EVIDENCE_NOT_TESTED_LISTED) lines.push(`- and ${items.length - EVIDENCE_NOT_TESTED_LISTED} more not tested`);
  return lines;
}

/**
 * The evidence lines of the Proof section at a shrink level (0..4): counts per kind and coverage at levels 0 and 1, then the Environment line, the not-run line and the link at every level. The not-tested
 * bullets are returned apart (`notTested`) because the Proof section puts them under "What wasn't tested". Without a pack bound to this code there is nothing: stale evidence is never shown as current.
 */
export function evidenceLines(context: ProofEvidenceContext | undefined, candidateDigest: string | undefined, level: number, extra: { proven?: ProvenTestNames; alreadyListed?: ReadonlySet<string> } = {}): { lines: string[]; notTested: string[] } {
  const pack = boundEvidence(context, candidateDigest);
  if (context === undefined || pack === undefined) return { lines: [], notTested: [] };
  const full = level <= 1;
  // Test services: what backed each dependency, in the fixed words of the honesty labels (nothing for a pack without dependencies, so such a pull request reads as it did).
  const dependencies = packDependencyLines(pack, level);
  const lines = [
    ...(full ? [testsLine(pack, extra.proven), coverageLine(pack)] : []),
    environmentLine(pack, level),
    ...dependencies.lines,
    notRunLine(pack),
    evidenceLinkLine(context),
  ].filter((line): line is string => line !== undefined);
  return { lines, notTested: [...evidenceNotTestedLines(pack, level, extra.alreadyListed), ...dependencies.notTested] };
}
