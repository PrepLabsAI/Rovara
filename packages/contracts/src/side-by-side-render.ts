// TE-F10: the two renderings of a side-by-side summary, and the seam that maps it to a `pairs` part for the evidence writer (A2b).
//   public: fixed words, counts and verdict words ONLY (B12's rule: no sentence a repository, a person, an agent or a customer wrote reaches the output). No input, no output, no prompt, no case name, no model name.
//   full:   the same headline and at most three examples, each answer cut and made inert (`inertEvidenceText`: links, images, mentions, issue references, HTML, block starts and hidden characters neutralised), never in a code block.
// Pure and browser-safe. No callers yet.
import { ArtifactRefSchema, type ArtifactRef } from "./evidence.js";
import { inertEvidenceText } from "./evidence-inert.js";
import { redactText } from "./redaction.js";
import { judgeIdentityWords, verifySideBySideJudgeIdentity } from "./side-by-side-judge-pin.js";
import { SIDE_BY_SIDE_CHECK_KIND, SIDE_BY_SIDE_EXAMPLES_MAX, type SideBySideCaseOutcome, type SideBySideSummary } from "./side-by-side.js";

export type SideBySideMode = "public" | "full";
/** How much of one answer a full rendering shows. */
const ANSWER_SHOWN_CHARS = 280;
const SENTENCE_SHOWN_CHARS = 160;
const NOT_RUN_LISTED = 5;

const whole = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** The one line both renderings start with. Every part of it is a fixed word or a number. */
function headline(summary: SideBySideSummary): string {
  const counts = summary.counts;
  const planned = whole(counts.planned);
  const verdicts = ([["same", counts.same], ["better", counts.better], ["worse", counts.worse], ["unclear", counts.unclear]] as const).flatMap(([word, count]) => (whole(count) > 0 ? [`${String(whole(count))} ${word}`] : []));
  const sentences = [`Old vs new prompt on ${String(planned)} ${planned === 1 ? "input" : "inputs"}, compared by an independent judge: ${verdicts.length === 0 ? "no verdicts" : verdicts.join(", ")}.`];
  if (whole(counts.notRun) > 0) sentences.push(`${String(whole(counts.notRun))} not run.`);
  if (whole(counts.callFailed) > 0) sentences.push(`${String(whole(counts.callFailed))} failed to answer.`);
  if (whole(counts.judgeNotRun) > 0) sentences.push(`The judge did not run for ${String(whole(counts.judgeNotRun))}.`);
  if (whole(counts.possiblySteering) > 0) sentences.push(`${String(whole(counts.possiblySteering))} possibly steering the judge.`);
  if (whole(counts.refused) > 0) sentences.push(`${String(whole(counts.refused))} skipped because the two sides did not match.`);
  return sentences.join(" ");
}

type Shown = Extract<SideBySideCaseOutcome, { status: "judged" | "judge_not_run" }>;
const RANK: Record<string, number> = { worse: 0, unclear: 1, better: 2, same: 3, judge_not_run: 4 };
/** The cases as a list, whatever the summary held (it may have come from storage). */
function casesOf(summary: SideBySideSummary): readonly SideBySideCaseOutcome[] {
  const held: unknown = summary.cases;
  return Array.isArray(held) ? (held as SideBySideCaseOutcome[]) : [];
}

/** The cases worth showing, worst news first, at most three; ties keep the order the cases ran in. */
function examplesOf(summary: SideBySideSummary): Shown[] {
  const shown = casesOf(summary).filter((item): item is Shown => item.status === "judged" || item.status === "judge_not_run");
  const rank = (item: Shown): number => RANK[item.status === "judged" ? item.verdict : "judge_not_run"] ?? 5;
  return shown.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).slice(0, SIDE_BY_SIDE_EXAMPLES_MAX).map((entry) => entry.item);
}

export function renderSideBySide(summary: SideBySideSummary, options: { readonly mode: SideBySideMode }): string {
  const first = headline(summary);
  // The judge's pinned identity is part of what is printed, in both renderings (DECISIONS 170): every part of it is a fixed word, a checked name or a number.
  const judge = judgeIdentityWords(summary.judge);
  if (options.mode !== "full") return `${first} ${judge}`;
  const lines = [first, judge];
  const examples = examplesOf(summary);
  if (examples.length > 0) lines.push("Examples (answers cut and made inert):");
  examples.forEach((item, index) => {
    lines.push(`- Example ${String(index + 1)} (judge: ${item.status === "judged" ? item.verdict : "not run"}${item.possiblySteering === true ? "; possibly steering the judge" : ""})`);
    lines.push(`  - Old: ${inertEvidenceText(item.oldText, ANSWER_SHOWN_CHARS)}`);
    lines.push(`  - New: ${inertEvidenceText(item.newText, ANSWER_SHOWN_CHARS)}`);
  });
  const missing = casesOf(summary).filter((item) => item.status === "not_run" || item.status === "call_failed");
  for (const item of missing.slice(0, NOT_RUN_LISTED)) {
    lines.push(`- ${item.status === "not_run" ? "Not run" : "No answer"} (${item.side} prompt): ${inertEvidenceText(item.sentence, SENTENCE_SHOWN_CHARS)}`);
  }
  return lines.join("\n");
}

/** Stores one answer and gives back the artifact ref the pack holds (A2b's writer supplies this; it is the only thing that touches a store). */
export type SideBySideAnswerWriter = (answer: { readonly pairId: string; readonly side: "old" | "new"; readonly text: string }) => ArtifactRef | undefined;

export interface SideBySidePairsPart {
  readonly kind: typeof SIDE_BY_SIDE_CHECK_KIND;
  readonly label: string;
  readonly pairs: ReadonlyArray<{ readonly id: string; readonly before?: ArtifactRef; readonly after?: ArtifactRef }>;
}
/** The start of the check's label; the judge's identity follows it. */
export const SIDE_BY_SIDE_CHECK_LABEL = "Old vs new prompt";

/**
 * The `pairs` part of a `side_by_side` check: at most three pairs, each the old and new answer as artifact refs (never text), with no trust class and no proof basis. Public mode has no pairs: an artifact is customer data. Texts go to the writer
 * redacted. A ref the pack's schema would refuse, a writer that throws and a writer that stores nothing all leave that side out.
 */
export function sideBySidePairsPart(summary: SideBySideSummary, options: { readonly mode: SideBySideMode }, write: SideBySideAnswerWriter): SideBySidePairsPart {
  const pairs: Array<{ id: string; before?: ArtifactRef; after?: ArtifactRef }> = [];
  if (options.mode === "full") {
    const store = (pairId: string, side: "old" | "new", text: string): ArtifactRef | undefined => {
      try {
        const parsed = ArtifactRefSchema.safeParse(write({ pairId, side, text: redactText(text) }));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    };
    examplesOf(summary).forEach((item, index) => {
      const id = `pair-${String(index + 1)}`;
      const before = store(id, "old", item.oldText);
      const after = store(id, "new", item.newText);
      if (before !== undefined || after !== undefined) pairs.push({ id, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
    });
  }
  const judge = summary.judge;
  const verified = verifySideBySideJudgeIdentity(judge);
  return { kind: SIDE_BY_SIDE_CHECK_KIND, label: verified ? `${SIDE_BY_SIDE_CHECK_LABEL} (judge: ${inertEvidenceText(judge.model, 128)} ${inertEvidenceText(judge.version, 128)}, ${judge.independence === "different_family" ? "different model family" : "spot-checked against human labels"})` : `${SIDE_BY_SIDE_CHECK_LABEL} (judge identity could not be verified)`, pairs };
}
