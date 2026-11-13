// The public, redacted summary of an evidence pack (TE-B12, O53): what a pull request description or a Check shows to a reviewer who has no Rovara account. Anyone who can see the pull request can read it, so it is built
// as an ALLOW-LIST and nothing else: `publicEvidenceView` reads a fixed set of fields out of the pack and keeps only a COUNT, a true/false, or a member of a fixed table (a result, a level, a producer, a trust class, an
// outcome, a change type); `renderEvidencePublic` prints that view in fixed words. No sentence a repository, a person, an agent or a customer wrote reaches the output: no check label, test name, file path, command, dependency
// or service name, reason, actor, measure name, sample, screenshot reference, link or amount spent. A field a later writer adds to the pack, and a part this build does not know, are not on the list, so they are dropped, and
// all the output says about them is the fixed "newer evidence" line. The "Full details" pointer goes behind sign-in (O27, O53); screenshots, thumbnails and details are not here. Every line is made inert anyway (defence in
// depth: nothing in it can mention, link, embed or open a block), the one exception being the sign-in link itself, which must be a plain https address with no query, fragment or credentials (never a signed URL).
// Pure and browser-safe. It is not wired to any caller yet (the pull request body and the Check summary call it when the Cloud half lands).
import { EVIDENCE_TRUST_CLASSES, EVIDENCE_TRUST_CLASS_WORDS, SCRIPTED_AI_PROOF_WORDS, type EvidenceTrustClass } from "./check-kinds.js";
import { EVIDENCE_CHECK_OUTCOMES, EVIDENCE_ISOLATIONS, EVIDENCE_LEVELS, EVIDENCE_RESULTS, hasNewerEvidence, noNewerEvidence, type EvidencePackV2, type EvidencePackV2Read, type NewerEvidence } from "./evidence.js";
import { inertEvidenceText } from "./evidence-inert.js";
import { EVIDENCE_PRODUCER_WORDS, evidenceFirstLine } from "./evidence-render.js";
import { NEWER_EVIDENCE_WORDS } from "./forward-reader.js";

/** The kinds of change the public summary can name (O43, O61). The change type is decided by Rovara, so a caller gives it; the pack holds none yet. Anything else is not shown. */
export const PUBLIC_CHANGE_TYPE_WORDS = {
  bug_fix: "Bug fix",
  feature: "Feature",
  refactor: "Refactor",
  dependency_upgrade: "Dependency upgrade",
  config_only: "Config only",
  test_only: "Test only",
  docs_only: "Docs only",
} as const;
export type PublicChangeType = keyof typeof PUBLIC_CHANGE_TYPE_WORDS;

/** The only "weakest stage" words a public summary prints, written here word for word (the writer's CI words). Any other stage words may hold anything, so the summary says only that there is one. */
export const PUBLIC_WEAKEST_WORDS: readonly string[] = ["No CI on this repository", "CI not readable"];
const WEAKEST_NOT_SHOWN_WORDS = "weakest stage: open in Rovara";

/** The residual of a run that is not sealed, in fixed words (O44, DECISIONS 163b D3): it is on every sandbox run, so a reader never takes "checked" for "walled off". */
export const PUBLIC_NOT_SEALED_WORDS = "Not sealed: outside network access was not fully closed off in this run";
/** Where the details are (behind sign-in, O27). */
export const PUBLIC_DETAILS_WORDS = "Full details, screenshots and test output are behind sign-in";

export const PUBLIC_RENDER_LIMITS = { lineMax: 300, linkMax: 300 } as const;

/** What the public summary may know about a pack: counts, flags and members of fixed tables. There is NOT ONE free-text field in it, by construction. */
export interface PublicEvidenceView {
  result: (typeof EVIDENCE_RESULTS)[number] | "newer";
  reached: (typeof EVIDENCE_LEVELS)[number] | "newer";
  isolation: (typeof EVIDENCE_ISOLATIONS)[number] | "newer";
  /** Some check's proof rests on scripted AI replies. */
  scripted: boolean;
  /** "ci_none" and "ci_unreadable" are the two weakest-stage words the summary prints; "other" is any other words (not printed); undefined: no weakest stage. */
  weakest: "ci_none" | "ci_unreadable" | "other" | undefined;
  checks: {
    total: number;
    byOutcome: Record<(typeof EVIDENCE_CHECK_OUTCOMES)[number] | "newer", number>;
    tests: { total: number; failed: number; added: number } | undefined;
    coverage: { linesChanged: number; linesCovered: number } | undefined;
    /** How many checks are worded as scripted AI replies, and how many carry each trust class (only checks that carry one). */
    scripted: number;
    byTrust: Record<EvidenceTrustClass | "newer", number>;
  };
  dependencies: { total: number; byTrust: Record<EvidenceTrustClass | "newer", number>; oldestRecordedOn: string | undefined };
  proof: { proven: number; loadFailureOnOld: number; heldDraft: boolean; markedReadyAnyway: boolean } | undefined;
  weakening: {
    instructionFiles: number; ciExecutedFiles: number; absentOnNew: number; skipRise: number; removedTests: number; changedTestConfig: number; changedSnapshots: number; changedFixtures: number;
  };
  notTested: number;
  newer: boolean;
}

// ---- reading a pack without trusting it: every value is checked to be what the view says, and nothing else is read.
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: unknown, key: string): unknown => (isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** The largest count printed (a count above it is not a count anyone could have made; it keeps a line short whatever a pack says). */
const COUNT_MAX = 1e12;
/** A count: a finite whole number of zero or more, at most `COUNT_MAX`, else zero. */
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(COUNT_MAX, Math.floor(value)) : 0);
const lengthOf = (value: unknown): number => list(value).length;
/** A member of a fixed list, else "newer". The value is never printed: only the member is. */
function member<T extends string>(table: readonly T[], value: unknown): T | "newer" {
  return typeof value === "string" && (table as readonly string[]).includes(value) ? (value as T) : "newer";
}
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const emptyTrust = (): Record<EvidenceTrustClass | "newer", number> => ({ real: 0, recorded: 0, simulated: 0, made_by_rovara: 0, no_outside_calls: 0, newer: 0 });
const OUTCOMES = EVIDENCE_CHECK_OUTCOMES;

/**
 * The allow-list: the fields of a pack the public summary reads, and what is kept of each. Everything else in the pack is not looked at. Only the shapes below leave this function.
 * producer.isolation, level.reached, result; level.weakest.words (only as one of two fixed phrases); checks[].after, .proofBasis, .trust, .tests.{total,failed,errored,newTests (length)}, .coverage.{linesChanged,linesCovered};
 * dependencies[].trust, .recordedOn / .recording.recordedOn (only as a date); proof.{provenCount,loadFailureOnOld,heldDraft,override (present or not)}; weakening.* and flags.* (lengths and counts only); notTested (length only).
 */
export function publicEvidenceView(input: EvidencePackV2 | EvidencePackV2Read, newer: NewerEvidence = noNewerEvidence()): PublicEvidenceView {
  const pack: unknown = input;
  const checks = list(own(pack, "checks"));
  const dependencies = list(own(pack, "dependencies"));
  const weakestWords = own(own(own(pack, "level"), "weakest"), "words");
  const byOutcome: PublicEvidenceView["checks"]["byOutcome"] = { passed: 0, failed: 0, timed_out: 0, unknown: 0, not_run: 0, newer: 0 };
  const checkTrust = emptyTrust();
  let scriptedChecks = 0;
  let tests: PublicEvidenceView["checks"]["tests"];
  let coverage: PublicEvidenceView["checks"]["coverage"];
  for (const check of checks) {
    byOutcome[member(OUTCOMES, own(check, "after"))] += 1;
    if (own(check, "proofBasis") !== undefined) scriptedChecks += 1;
    else if (own(check, "trust") !== undefined) checkTrust[member(EVIDENCE_TRUST_CLASSES, own(check, "trust"))] += 1;
    const t = own(check, "tests");
    if (isRecord(t)) tests = { total: (tests?.total ?? 0) + count(t.total), failed: (tests?.failed ?? 0) + count(t.failed) + count(t.errored), added: (tests?.added ?? 0) + lengthOf(t.newTests) };
    const c = own(check, "coverage");
    if (isRecord(c)) coverage = { linesChanged: (coverage?.linesChanged ?? 0) + count(c.linesChanged), linesCovered: (coverage?.linesCovered ?? 0) + count(c.linesCovered) };
  }
  const depTrust = emptyTrust();
  let oldest: string | undefined;
  for (const dependency of dependencies) {
    const trust = member(EVIDENCE_TRUST_CLASSES, own(dependency, "trust"));
    depTrust[trust] += 1;
    if (trust !== "recorded") continue;
    const day = own(dependency, "recordedOn") ?? own(own(dependency, "recording"), "recordedOn");
    if (typeof day === "string" && DAY.test(day) && (oldest === undefined || day < oldest)) oldest = day;
  }
  const proofRaw = own(pack, "proof");
  const weakening = own(pack, "weakening");
  const flags = own(pack, "flags");
  const skip = own(weakening, "skipRise");
  const skipRise = Math.max(0, count(own(skip, "after")) - count(own(skip, "before")));
  const absent = Math.max(count(own(weakening, "absentOnNewCount")), lengthOf(own(weakening, "absentOnNew")));
  return {
    result: member(EVIDENCE_RESULTS, own(pack, "result")),
    reached: member(EVIDENCE_LEVELS, own(own(pack, "level"), "reached")),
    isolation: member(EVIDENCE_ISOLATIONS, own(own(pack, "producer"), "isolation")),
    scripted: scriptedChecks > 0,
    weakest: own(own(pack, "level"), "weakest") === undefined ? undefined : weakestWords === PUBLIC_WEAKEST_WORDS[0] ? "ci_none" : weakestWords === PUBLIC_WEAKEST_WORDS[1] ? "ci_unreadable" : "other",
    checks: { total: checks.length, byOutcome, tests, coverage, scripted: scriptedChecks, byTrust: checkTrust },
    dependencies: { total: dependencies.length, byTrust: depTrust, oldestRecordedOn: oldest },
    proof: isRecord(proofRaw)
      ? { proven: count(proofRaw.provenCount), loadFailureOnOld: count(proofRaw.loadFailureOnOld), heldDraft: proofRaw.heldDraft === true, markedReadyAnyway: own(proofRaw, "override") !== undefined }
      : undefined,
    weakening: {
      instructionFiles: lengthOf(own(flags, "instructionFiles")), ciExecutedFiles: lengthOf(own(flags, "ciExecutedFiles")), absentOnNew: absent, skipRise,
      removedTests: lengthOf(own(weakening, "removedTests")), changedTestConfig: lengthOf(own(weakening, "changedTestConfig")), changedSnapshots: lengthOf(own(weakening, "changedSnapshots")), changedFixtures: lengthOf(own(weakening, "changedFixtures")),
    },
    notTested: lengthOf(own(pack, "notTested")),
    newer: hasNewerEvidence(newer) || checks.some((check) => member(OUTCOMES, own(check, "after")) === "newer"),
  };
}

export interface PublicEvidenceOptions {
  /** What `readEvidencePack` reported, for the "newer evidence" line. */
  newer?: NewerEvidence | undefined;
  /** The kind of change, as Rovara decided it (O61). Shown only when it is one of `PUBLIC_CHANGE_TYPE_WORDS`. */
  changeType?: string | undefined;
  /** Where the details are: a plain https address behind sign-in (the task page). Used only when it is one: no query, fragment, credentials or characters that could break the link. Otherwise the line says "open in Rovara". */
  detailsUrl?: string | undefined;
}
export interface PublicEvidenceRendering {
  firstLine: string;
  body: string[];
  text: string;
}

/** https, a host, an optional port and a path of plain characters: no credentials, no query (no signed address), no fragment, nothing that could end a link early. */
const DETAILS_URL = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]{0,200})?$/u;
export const isPublicDetailsUrl = (value: unknown): value is string => typeof value === "string" && value.length <= PUBLIC_RENDER_LIMITS.linkMax && DETAILS_URL.test(value);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const num = (value: number): string => count(value).toLocaleString("en-US");
const noun = (value: number, one: string, many = `${one}s`): string => `${num(value)} ${value === 1 ? one : many}`;
/** Every line is made inert (a defence in depth: the words are fixed) and cut. A list item is marked after that, so its marker is not read as a block start. */
const text = (words: string): string => inertEvidenceText(words, PUBLIC_RENDER_LIMITS.lineMax);
const item = (words: string): string => `- ${text(words)}`;
const dayWords = (day: string): string => {
  const match = DAY.exec(day);
  const month = match === null ? undefined : MONTHS[Number(match[2]) - 1];
  return match === null || month === undefined ? "" : `${String(Number(match[3]))} ${month}`;
};
const TRUST_ORDER = [...EVIDENCE_TRUST_CLASSES, "newer"] as const;
const trustWords = (trust: EvidenceTrustClass | "newer"): string => (trust === "newer" ? NEWER_EVIDENCE_WORDS : EVIDENCE_TRUST_CLASS_WORDS[trust]);

/** The view as fixed words. Pure; the same view and options always give the same text. */
export function renderPublicView(view: PublicEvidenceView, options: PublicEvidenceOptions = {}): PublicEvidenceRendering {
  const weakestWords = view.weakest === "ci_none" ? PUBLIC_WEAKEST_WORDS[0] : view.weakest === "ci_unreadable" ? PUBLIC_WEAKEST_WORDS[1] : undefined;
  const first = evidenceFirstLine({ result: view.result, reached: view.reached, isolation: view.isolation, scripted: view.scripted, weakestWords });
  const firstLine = view.weakest === "other" ? text(`${first} · ${WEAKEST_NOT_SHOWN_WORDS}`) : first;
  const producer = view.isolation === "newer" ? NEWER_EVIDENCE_WORDS : EVIDENCE_PRODUCER_WORDS[view.isolation];
  const body: string[] = [text(producer)];
  if (view.isolation === "sandbox") body.push(text(PUBLIC_NOT_SEALED_WORDS));
  const changeType = typeof options.changeType === "string" && Object.hasOwn(PUBLIC_CHANGE_TYPE_WORDS, options.changeType) ? PUBLIC_CHANGE_TYPE_WORDS[options.changeType as PublicChangeType] : undefined;
  if (changeType !== undefined) body.push(text(`Change type: ${changeType}`));

  const weak = view.weakening;
  if (weak.instructionFiles > 0) body.push(text(`${noun(weak.instructionFiles, "Rovara instruction file")} changed (a flag, not an approval)`));
  if (weak.ciExecutedFiles > 0) body.push(text(`${noun(weak.ciExecutedFiles, "file")} that CI runs changed (a flag, not an approval)`));

  const checks = view.checks;
  if (checks.total === 0) body.push("Checks: none");
  else {
    const parts = [...OUTCOMES, "newer" as const].flatMap((outcome) => (checks.byOutcome[outcome] === 0 ? [] : [`${num(checks.byOutcome[outcome])} ${outcome === "newer" ? NEWER_EVIDENCE_WORDS.toLowerCase() : outcome === "timed_out" ? "timed out" : outcome === "unknown" ? "not checked" : outcome === "not_run" ? "not run" : outcome}`]));
    body.push(text(`Checks: ${num(checks.total)} (${parts.join(", ")})`));
  }
  if (checks.tests !== undefined) body.push(text(`Tests: ${noun(checks.tests.total, "test")} run, ${num(checks.tests.failed)} failed, ${num(checks.tests.added)} new`));
  if (checks.coverage !== undefined && checks.coverage.linesChanged > 0) body.push(text(`${num(Math.round((Math.min(checks.coverage.linesCovered, checks.coverage.linesChanged) / checks.coverage.linesChanged) * 100))}% of changed lines covered`));
  const checkTrust = [...(checks.scripted > 0 ? [`${noun(checks.scripted, "check")} ${SCRIPTED_AI_PROOF_WORDS}`] : []), ...TRUST_ORDER.flatMap((trust) => (checks.byTrust[trust] === 0 ? [] : [`${trustWords(trust)} ${num(checks.byTrust[trust])}`]))];
  if (checkTrust.length > 0) body.push(text(`Checks by trust: ${checkTrust.join(" · ")}`));

  const proof = view.proof;
  if (proof !== undefined) {
    body.push(text(`Change proof: ${num(proof.proven)} ${view.scripted ? SCRIPTED_AI_PROOF_WORDS : "proven"}${proof.loadFailureOnOld > 0 ? `, ${num(proof.loadFailureOnOld)} could not load on the old code` : ""}`));
    if (proof.heldDraft) body.push("Held as a draft until the change is proven");
    if (proof.markedReadyAnyway) body.push("Marked ready anyway by a person");
  }

  const weakLines = [
    ...(weak.absentOnNew > 0 ? [`${noun(weak.absentOnNew, "test")} ran before and not now`] : []),
    ...(weak.skipRise > 0 ? [`${num(weak.skipRise)} more ${weak.skipRise === 1 ? "test" : "tests"} skipped than before`] : []),
    ...(weak.removedTests > 0 ? [`${noun(weak.removedTests, "test")} removed`] : []),
    ...(weak.changedTestConfig > 0 ? [`${noun(weak.changedTestConfig, "test config file")} changed`] : []),
    ...(weak.changedSnapshots > 0 ? [`${noun(weak.changedSnapshots, "snapshot file")} changed`] : []),
    ...(weak.changedFixtures > 0 ? [`${noun(weak.changedFixtures, "fixture file")} changed`] : []),
  ];
  if (weakLines.length > 0) body.push("Tests may be weaker:", ...weakLines.map(item));

  const deps = view.dependencies;
  if (deps.total > 0) {
    const classes = TRUST_ORDER.flatMap((trust) => {
      if (deps.byTrust[trust] === 0) return [];
      const recorded = trust === "recorded" && deps.oldestRecordedOn !== undefined ? dayWords(deps.oldestRecordedOn) : "";
      return [`${trustWords(trust)} ${num(deps.byTrust[trust])}${recorded === "" ? "" : ` (oldest recorded ${recorded})`}`];
    });
    body.push(text(`Dependencies: ${num(deps.total)} (${classes.join(" · ")})`));
  }
  if (view.notTested > 0) body.push(text(`Not tested: ${noun(view.notTested, "item")} (the list is in Rovara)`));
  if (view.newer) body.push(NEWER_EVIDENCE_WORDS);
  body.push(isPublicDetailsUrl(options.detailsUrl) ? `${text(PUBLIC_DETAILS_WORDS)}: [Open in Rovara](${options.detailsUrl})` : `${text(PUBLIC_DETAILS_WORDS)}: open in Rovara`);
  return { firstLine, body, text: [firstLine, ...body].join("\n") };
}

/** The public summary of a v2 pack: the allow-listed view of it, in fixed words. */
export function renderEvidencePublic(input: EvidencePackV2 | EvidencePackV2Read, options: PublicEvidenceOptions = {}): PublicEvidenceRendering {
  return renderPublicView(publicEvidenceView(input, options.newer), options);
}
