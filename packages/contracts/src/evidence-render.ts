// The one renderer of an evidence pack (TE-A2a, design testing-build-plan section 3.1): the first line and the body block of the pull request, the Check Run summary, the task page model and Code's local report all
// come from here, so both editions say the same thing in the same words. It is PURE (a pack in, text out; no clock, no network, no storage) and it has NO CALLERS yet: the broker still writes and prints v1 (TE-A2b/TE-A2-cl switch it).
// Every word that a repository, a person or an agent wrote (a check label, a dependency name, a not-tested reason) is made inert here (no hidden characters, mention, link, image, issue reference, closing key or HTML), and every
// list and line is bounded, with the rest counted ("and 52 more checks"), so the block stays inside a pull request description however large the pack is. Browser-safe: nothing here imports a Node module.
import { EVIDENCE_TRUST_CLASSES, EVIDENCE_TRUST_CLASS_WORDS, PROOF_BASES, SCRIPTED_AI_PROOF_WORDS, checkKindWords, trustLabelWords, type ProofBasis, type EvidenceTrustClass } from "./check-kinds.js";
import { inertEvidenceText } from "./evidence-inert.js";
import type { EVIDENCE_LEVELS, EVIDENCE_RESULTS } from "./evidence.js";
import { hasNewerEvidence, noNewerEvidence, type EvidencePackRead, type EvidencePackV2, type EvidencePackV2Read, type NewerEvidence } from "./evidence.js";
import { weakeningLines } from "./evidence-weakening.js";
import { NEWER_EVIDENCE_WORDS } from "./forward-reader.js";

export const EVIDENCE_RENDER_LIMITS = { lineMax: 300, bulletMax: 200, textMax: 9_000, checksListed: 12, dependenciesListed: 8, notTestedListed: 10, measuresListed: 3 } as const;

/** The result axis, in words (the v1 axis kept). */
export const EVIDENCE_RESULT_WORDS: Record<(typeof EVIDENCE_RESULTS)[number], string> = {
  verified: "Verified",
  code_failed: "Code failed checks",
  partially_verified: "Partly verified",
  blocked_by_environment: "Blocked by the environment",
};
/** The five levels, in words. Never better than the weakest required stage (the writer's rule; the renderer only prints the level it is given). */
export const EVIDENCE_LEVEL_WORDS: Record<(typeof EVIDENCE_LEVELS)[number], string> = {
  rovara_real_run: "Real run by Rovara",
  their_ci: "Checked by your CI",
  sandbox_only: "Sandbox only, no sealed run",
  no_ci: "No CI to check against",
  ci_not_readable: "Your CI results could not be read",
};
/** The level words for a pack that claims a real run but ran somewhere that is not a sealed round, or whose proof rests on scripted AI replies (DECISIONS 156: never "Real"). */
const NOT_SEALED_LEVEL_WORDS = "Run by Rovara, not sealed";
const SCRIPTED_AI_LEVEL_WORDS = "Run against scripted AI replies";
/** Where the checks ran (O26, O44). */
export const EVIDENCE_PRODUCER_WORDS = {
  developer_machine: "Ran on a developer machine",
  sealed: "Checked in a sealed round",
  sandbox: "Checked in the agent's sandbox (not sealed)",
  imported: "Imported from your CI (not run by Rovara)",
} as const;
const OUTCOME_WORDS: Record<string, string> = { passed: "passed", failed: "failed", timed_out: "timed out", unknown: "not checked", not_run: "not run" };
const OUTCOME_ORDER = ["passed", "failed", "timed_out", "unknown", "not_run"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Slots other lanes fill: the time-target line (TE-D9) and the "Rovara problem" line (TE-B8). Each is shown only when it is present and not blank. */
export interface EvidenceRenderOptions {
  timeTargetLine?: string | undefined;
  rovaraProblemLine?: string | undefined;
  /** What `readEvidencePack` reported, for the "newer evidence" line. */
  newer?: NewerEvidence | undefined;
}
export interface EvidenceRendering {
  /** The line a pull request or a check summary leads with. */
  firstLine: string;
  /** Where the checks ran. Also `body[0]`. */
  producerLine: string;
  /** Everything after the first line. */
  body: string[];
  /** `firstLine` and `body`, one per line. */
  text: string;
}

const cut = (text: string, max: number) => {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
};
/** A count for a line. Anything that is not a finite number prints "?" (a reader's data is checked, but the renderer never trusts a value to be a number). */
const number = (count: number) => (typeof count === "number" && Number.isFinite(count) ? count.toLocaleString("en-US") : "?");
const plural = (count: number, one: string, many = `${one}s`) => `${number(count)} ${count === 1 ? one : many}`;
const dollars = (amount: number) => (typeof amount === "number" && Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "$?");

const inert = inertEvidenceText;
const line = (text: string) => cut(text, EVIDENCE_RENDER_LIMITS.lineMax);
const bullet = (text: string) => `- ${cut(text, EVIDENCE_RENDER_LIMITS.bulletMax)}`;

const wordOf = <T extends string>(table: Record<T, string>, value: unknown): string => (typeof value === "string" && Object.hasOwn(table, value) ? table[value as T] : NEWER_EVIDENCE_WORDS);

/** "12 Nov" from "2026-11-12". */
function dayWords(day: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/u.exec(day);
  const month = match === null ? undefined : MONTHS[Number(match[1]) - 1];
  return match === null || month === undefined ? inert(day, 12) : `${String(Number(match[2]))} ${month}`;
}

type Check = EvidencePackV2Read["checks"][number];
type Dependency = NonNullable<EvidencePackV2Read["dependencies"]>[number];

function checkLine(check: Check): string {
  const kind = typeof check.kind === "string" ? check.kind : "";
  const words = checkKindWords(kind);
  const head = `${words}: ${inert(check.label, 80)}: ${wordOf(OUTCOME_WORDS, check.after)}`;
  const details: string[] = [];
  const tests = check.tests;
  if (tests !== undefined) {
    details.push(plural(tests.total, "test") + (tests.newTests.length > 0 ? ` (${number(tests.newTests.length)} new)` : ""));
    if (tests.failed + tests.errored > 0) details.push(`${number(tests.failed + tests.errored)} failed`);
  }
  if (check.coverage !== undefined && check.coverage.linesChanged > 0) details.push(`${number(Math.round((check.coverage.linesCovered / check.coverage.linesChanged) * 100))}% of changed lines covered`);
  for (const measure of (check.measures ?? []).slice(0, EVIDENCE_RENDER_LIMITS.measuresListed)) {
    const round = (value: number) => (typeof value === "number" && Number.isFinite(value) ? String(Number(value.toFixed(2))) : "?");
    details.push(`${inert(measure.name, 40)} ${round(measure.head)} ${inert(measure.unit, 10)} (was ${round(measure.base)} ${inert(measure.unit, 10)})`);
  }
  if ((check.measures?.length ?? 0) > EVIDENCE_RENDER_LIMITS.measuresListed) details.push(`and ${number(check.measures!.length - EVIDENCE_RENDER_LIMITS.measuresListed)} more measures`);
  if (check.pairs !== undefined && check.pairs.length > 0) details.push(plural(check.pairs.length, "before and after pair"));
  const basis = (PROOF_BASES as readonly string[]).includes(check.proofBasis as string) ? (check.proofBasis as ProofBasis) : undefined;
  const trust = (EVIDENCE_TRUST_CLASSES as readonly string[]).includes(check.trust as string) ? (check.trust as EvidenceTrustClass) : undefined;
  const trustWords = trustLabelWords(trust, basis);
  if (trustWords !== undefined) details.push(trustWords);
  return bullet(details.length === 0 ? head : `${head}, ${details.join(", ")}`);
}

function checksLines(checks: readonly Check[]): string[] {
  if (checks.length === 0) return ["Checks: none"];
  const counts = OUTCOME_ORDER.flatMap((outcome) => {
    const count = checks.filter((check) => check.after === outcome).length;
    return count === 0 ? [] : [`${number(count)} ${OUTCOME_WORDS[outcome]}`];
  });
  const other = checks.filter((check) => !(OUTCOME_ORDER as readonly string[]).includes(check.after)).length;
  if (other > 0) counts.push(`${number(other)} ${NEWER_EVIDENCE_WORDS.toLowerCase()}`);
  const listed = checks.slice(0, EVIDENCE_RENDER_LIMITS.checksListed).map(checkLine);
  const measuresSource = checks.slice(0, EVIDENCE_RENDER_LIMITS.checksListed).some((check) => (check.measures?.length ?? 0) > 0)
    ? ["Measures: reported by the project's test runner, not measured by Rovara"] : [];
  const more = checks.length - listed.length;
  return [line(`Checks: ${number(checks.length)} (${counts.join(", ")})`), ...measuresSource, ...listed, ...(more > 0 ? [bullet(`and ${plural(more, "more check")}`)] : [])];
}

function trustOf(entry: Dependency): EvidenceTrustClass | undefined {
  return (EVIDENCE_TRUST_CLASSES as readonly string[]).includes(entry.trust) ? (entry.trust as EvidenceTrustClass) : undefined;
}
function recordedOnOf(entry: Dependency): string | undefined {
  return entry.recordedOn ?? entry.recording?.recordedOn;
}
function dependencyWords(entry: Dependency): string {
  const trust = trustOf(entry);
  if (trust === undefined) return NEWER_EVIDENCE_WORDS;
  const recorded = recordedOnOf(entry);
  return trust === "recorded" && recorded !== undefined ? `${EVIDENCE_TRUST_CLASS_WORDS.recorded} (${dayWords(recorded)})` : EVIDENCE_TRUST_CLASS_WORDS[trust];
}

function dependencyLines(dependencies: readonly Dependency[]): string[] {
  if (dependencies.length === 0) return [];
  const classes = EVIDENCE_TRUST_CLASSES.flatMap((trust) => {
    const of = dependencies.filter((entry) => trustOf(entry) === trust);
    if (of.length === 0) return [];
    if (trust === "recorded") {
      // The least fresh recording names the date (as `testRecordedOn` does for a test).
      const days = of.flatMap((entry) => (recordedOnOf(entry) === undefined ? [] : [recordedOnOf(entry)!])).sort();
      return [days[0] === undefined ? EVIDENCE_TRUST_CLASS_WORDS.recorded : `${EVIDENCE_TRUST_CLASS_WORDS.recorded} (${dayWords(days[0])})`];
    }
    if (trust === "made_by_rovara") {
      const now = of.filter((entry) => entry.mock?.madeIn === "this_task").length;
      return [now === 0 ? EVIDENCE_TRUST_CLASS_WORDS.made_by_rovara : `${EVIDENCE_TRUST_CLASS_WORDS.made_by_rovara} (${number(now)} made during this task)`];
    }
    return [EVIDENCE_TRUST_CLASS_WORDS[trust]];
  });
  if (dependencies.some((entry) => trustOf(entry) === undefined)) classes.push(NEWER_EVIDENCE_WORDS);
  const listed = dependencies.slice(0, EVIDENCE_RENDER_LIMITS.dependenciesListed).map((entry) => bullet(`${inert(entry.name, 80)}: ${dependencyWords(entry)}`));
  const more = dependencies.length - listed.length;
  return [line(`Dependencies: ${classes.join(" · ")}`), ...listed, ...(more > 0 ? [bullet(`and ${plural(more, "more dependency", "more dependencies")}`)] : [])];
}

function proofLines(proof: NonNullable<EvidencePackV2Read["proof"]>, scripted: boolean): string[] {
  const lines = [line(`Change proof: ${number(proof.provenCount)} ${scripted ? SCRIPTED_AI_PROOF_WORDS : "proven"}${proof.loadFailureOnOld > 0 ? `, ${number(proof.loadFailureOnOld)} could not load on the old code` : ""}`)];
  if (proof.heldDraft) lines.push("Held as a draft until the change is proven");
  if (proof.override !== undefined) lines.push(line(`Marked ready anyway by ${inert(proof.override.actorId, 60)}${proof.override.reason === undefined ? "" : `: ${inert(proof.override.reason, 120)}`}`));
  return lines;
}

/** The flag lines (instruction files and CI-executed files, shown right after the producer line) and the "tests may be weaker" lines of a pack: the words are `weakeningLines` (evidence-weakening.ts), shared with the pull request description. */
function weakeningPart(pack: EvidencePackV2Read): { flags: string[]; weakening: string[] } {
  const weakening = pack.weakening;
  const lines = weakeningLines({
    ...(weakening === undefined ? {} : { skipRise: weakening.skipRise, removedTests: weakening.removedTests, absentOnNew: weakening.absentOnNew, absentOnNewCount: weakening.absentOnNewCount, changedTestConfig: weakening.changedTestConfig, changedSnapshots: weakening.changedSnapshots, changedFixtures: weakening.changedFixtures }),
    ...(pack.flags === undefined ? {} : { instructionFiles: pack.flags.instructionFiles, ciExecutedFiles: pack.flags.ciExecutedFiles }),
  });
  return { flags: lines.flags.map(bullet), weakening: lines.weakening.length === 0 ? [] : ["Tests may be weaker:", ...lines.weakening.map(bullet)] };
}

/** The first line and the body of a v2 pack. Pure; the same pack and options always give the same text. */
export function renderEvidence(input: EvidencePackV2 | EvidencePackV2Read, options: EvidenceRenderOptions = {}): EvidenceRendering {
  const pack = input as EvidencePackV2Read;
  const isolation = pack.producer.isolation as string;
  const weakest = pack.level.weakest;
  const scripted = pack.checks.some((entry) => entry.proofBasis !== undefined);
  // The first line is never better than where the checks ran: a "real run" claimed by a pack that ran in the sandbox, on a laptop or elsewhere, or whose proof rests on scripted AI replies, is worded as what it was.
  const level = pack.level.reached === "rovara_real_run" && scripted ? SCRIPTED_AI_LEVEL_WORDS : pack.level.reached === "rovara_real_run" && isolation !== "sealed" ? NOT_SEALED_LEVEL_WORDS : wordOf(EVIDENCE_LEVEL_WORDS, pack.level.reached);
  const firstLine = line([
    wordOf(EVIDENCE_RESULT_WORDS, pack.result),
    level,
    ...(weakest === undefined ? [] : [`weakest: ${inert(weakest.words, 100)}`]),
    ...(isolation === "sandbox" && !level.includes("not sealed") ? ["not sealed"] : []),
  ].join(" · "));
  const producerLine = wordOf(EVIDENCE_PRODUCER_WORDS, isolation);
  const slot = (text: string | undefined) => (text === undefined || inert(text, 1).length === 0 ? [] : [line(inert(text, EVIDENCE_RENDER_LIMITS.lineMax))]);
  const newer = options.newer ?? noNewerEvidence();
  const notTested = pack.notTested;
  const flagged = weakeningPart(pack);
  const body = [
    producerLine,
    ...flagged.flags,
    ...slot(options.rovaraProblemLine),
    ...slot(options.timeTargetLine),
    ...checksLines(pack.checks),
    ...(pack.proof === undefined ? [] : proofLines(pack.proof, scripted)),
    ...flagged.weakening,
    ...dependencyLines(pack.dependencies ?? []),
    ...(pack.meters === undefined ? [] : [line(`Spent: ${dollars(pack.meters.modelUsd)} model, ${plural(pack.meters.machineMinutes, "machine minute")} (${dollars(pack.meters.machineUsd)})`)]),
    ...(notTested.length === 0 ? [] : [
      "Not tested:",
      ...notTested.slice(0, EVIDENCE_RENDER_LIMITS.notTestedListed).map((entry) => bullet(`${inert(entry.what, 120)} (${inert(entry.reason, 60)})`)),
      ...(notTested.length > EVIDENCE_RENDER_LIMITS.notTestedListed ? [bullet(`and ${number(notTested.length - EVIDENCE_RENDER_LIMITS.notTestedListed)} more`)] : []),
    ]),
    ...(hasNewerEvidence(newer) ? [NEWER_EVIDENCE_WORDS] : []),
  ];
  return { firstLine, producerLine, body, text: [firstLine, ...body].join("\n") };
}

/**
 * What to print for whatever `readEvidencePack` gave. A v2 pack is rendered; a v1 pack has no level or producer, so only says it is older (the broker's own v1 lines are unchanged); a later version and a pack that
 * cannot be read say so, and send the reader to Rovara.
 */
export function renderEvidenceRead(read: EvidencePackRead, options: EvidenceRenderOptions = {}): EvidenceRendering {
  if (read.status === "v2") return renderEvidence(read.pack, { ...options, newer: read.newer });
  const firstLine =
    read.status === "newer" ? NEWER_EVIDENCE_WORDS
      : read.status === "v1" ? "Evidence from an older Rovara, open in Rovara for the level"
        : "Evidence could not be read, open in Rovara";
  return { firstLine, producerLine: "", body: [], text: firstLine };
}
