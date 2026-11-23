// After the model has answered, Code checks the answer (lead 4, J1; DEC 254z-amend). The model's sentences are only candidates:
//  - every citation's COMMIT is filled in by Code from the repository-to-commit map this answer was bound to; whatever the model wrote about a commit is never read;
//  - W1's shared module (`checkClaims`, strict prose mode) re-reads every cited place at that commit: a line is required, the quote (20+ characters) must be at that line, and every code name in the
//    sentence must be in one of its quotes;
//  - NUMBERS (J1's own rule on top of W1's): every number in a sentence must be a number in one of that sentence's quotes;
//  - the re-read refuses secret-shaped files (the same refusal as the code lookup), so the check cannot tell a model what a secret file holds;
//  - a sentence that fails any of it is removed. A check that could not finish (a read failed, a limit was reached) never counts as a pass: its sentences are removed.
import { ANSWER_LIMITS, type AnswerCitation } from "@agentx/contracts";
import { checkClaims, hasCodeToken, type CitationFileReader, type CitationRef, type ClaimToCheck } from "../citations/citation-check.js";
import { neutralizeSourceMarkers, plainLine } from "./frame.js";
import type { FinalAnswer } from "./protocol.js";
import { holdsPrivateKey, redactedLines, secretShapedPath } from "./secret-files.js";

// ---- The numbers rule ----------------------------------------------------------------------------------------------------------------------------------------------------------------
//
// Strict on the QUOTE side, lenient on the SENTENCE side, so a miss can only remove a sentence, never let a wrong number through:
//  - in a quote a number is a run of digits (with `.` or `,` groups) that is not part of a longer word: `v2`, `sha256` and `base64` are names there (the code-name rule handles names);
//  - in a sentence every run of digits counts, wherever it sits: `$5000`, `300ms`, `512MB`, `-42`, `3-5` (3 and 5). A word with digits in it (`sha256`) is a name, not a number, only when a quote holds it as a whole token;
//  - a comma is a thousands separator only in groups of three (`1,000`); `1,5` is the numbers 1 and 5;
//  - a digit that is not an ASCII digit (Arabic-Indic, for one) cannot be compared, so such a sentence is not kept.
const STRICT_NUMBER = /(?<![\p{L}\p{N}_.$-])\d+(?:[.,]\d+)*(?![\p{L}\p{N}_]|\.\d)/gu;
const ANY_NUMBER = /\d+(?:[.,]\d+)*/gu;
const DIGIT_WORD = /[\p{L}_$][\p{L}\p{N}_$]*\p{N}[\p{L}\p{N}_$]*/gu;
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u;
const THOUSANDS = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u;

/** One run of digits as the numbers it stands for, without leading zeros: `1,000` is 1000, `1,5` is 1 and 5. */
function valuesOf(raw: string): string[] {
  const parts = THOUSANDS.test(raw) ? [raw.replace(/,/gu, "")] : raw.split(",");
  return parts.map((part) => part.replace(/^0+(?=\d)/u, ""));
}

/** The numbers a QUOTE holds (strictly). */
export function numbersOf(text: string): string[] {
  return [...new Set([...text.normalize("NFKC").matchAll(STRICT_NUMBER)].flatMap((match) => valuesOf(match[0])))];
}

/** The numbers a SENTENCE states (leniently), leaving out names a quote holds whole. */
export function sentenceNumbersOf(sentence: string, quotes: readonly string[]): string[] {
  const folded = sentence.normalize("NFKC");
  const withoutNames = folded.replace(DIGIT_WORD, (word) => (quotes.some((quote) => hasCodeToken(quote, word)) ? " " : word));
  return [...new Set([...withoutNames.matchAll(ANY_NUMBER)].flatMap((match) => valuesOf(match[0])))];
}

/** Whether every number of the sentence is a number in one of its quotes. A sentence with no number passes; one with a digit that cannot be compared does not. */
export function numbersInQuotes(sentence: string, quotes: readonly string[]): boolean {
  if (NON_ASCII_DIGIT.test(sentence.normalize("NFKC"))) return false;
  const wanted = sentenceNumbersOf(sentence, quotes);
  if (wanted.length === 0) return true;
  const found = new Set(quotes.flatMap(numbersOf));
  return wanted.every((number) => found.has(number));
}

// ---- The check ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The longest a kept sentence is (characters): twelve of them with their markers fit the answer record's 6,000. */
export const SENTENCE_CHARS = 400;

export type SentenceDropReason = "uncited" | "source_not_found" | "unreadable" | "code_name_not_in_quote" | "numbers_not_in_quote" | "over_source_limit" | "other";

export interface KeptSentence {
  text: string;
  /** Indexes into `sources`. */
  sources: number[];
}

type CodeSource = Omit<Extract<AnswerCitation, { repo: string }>, "n"> & { quote: string };
type TaskSource = Omit<Extract<AnswerCitation, { kind: "task_state" }>, "n">;

export interface AnswerCheck {
  kept: KeptSentence[];
  sources: Array<CodeSource | TaskSource>;
  /** How many sentences the model wrote (after the bound) and how many were removed, with fixed reasons. */
  written: number;
  dropped: SentenceDropReason[];
  /** The places (repository and path) cited by sentences removed because their quote was not at the cited line or the file was not there (J5 looks for wiki claims that cite the same place). */
  droppedPlaces: Array<{ repo: string; path: string }>;
  /** False when any citation could not be checked (a read failed, a limit was reached). */
  complete: boolean;
}

/**
 * The reader every check uses. It never opens a secret-shaped file and answers as a file that is not there; a file that holds a private key block is the same; and what it returns is redacted line by line
 * (the text the model was shown), so a quote that carries a guessed secret does not match: the check cannot be used to confirm a secret that the lookup hides.
 */
export const refusingSecrets = (read: CitationFileReader): CitationFileReader => async (repository, path, commit, options) => {
  if (secretShapedPath(path)) return undefined;
  const text = await read(repository, path, commit, options);
  if (typeof text !== "string") return text;
  return holdsPrivateKey(text) ? undefined : redactedLines(text);
};

export async function checkAnswer(input: { final: FinalAnswer; heads: ReadonlyMap<string, string>; read: CitationFileReader; now?: (() => number) | undefined; task?: { taskId: string; shown: string } | undefined }): Promise<AnswerCheck> {
  const sentences = input.final.sentences.slice(0, ANSWER_LIMITS.sentences).map((sentence) => ({ ...sentence, text: plainLine(sentence.text, SENTENCE_CHARS) }));
  const claims: ClaimToCheck[] = sentences.map((sentence) => ({
    sentence: sentence.text,
    // The commit is the bound one, whatever the model wrote; a repository with no bound commit gets one that never matches.
    citations: sentence.cites.slice(0, ANSWER_LIMITS.citationsPerSentence).filter((cite) => "repo" in cite).map((cite): CitationRef => ({ repo: cite.repo, path: cite.path, commit: input.heads.get(cite.repo) ?? "unbound", line: cite.line, quote: cite.quote })),
  }));
  const checked = await checkClaims(refusingSecrets(input.read), claims, { mode: "prose", commits: input.heads, ...(input.now === undefined ? {} : { now: input.now }) });
  const sources: AnswerCheck["sources"] = [];
  const kept: KeptSentence[] = [];
  const dropped: SentenceDropReason[] = [];
  const droppedPlaces: AnswerCheck["droppedPlaces"] = [];
  const result: AnswerCheck = { kept, sources, dropped, droppedPlaces, written: sentences.length, complete: checked.complete };
  checked.claims.forEach((claim, index) => {
    const sentence = sentences[index]!;
    if (sentence.cites.some((cite) => "kind" in cite)) keepTaskSentence(sentence, input.task, result);
    else keepCodeSentence(claim, claims[index]!, result);
  });
  return { kept, sources, written: sentences.length, dropped, droppedPlaces, complete: checked.complete };
}


function keepTaskSentence(sentence: FinalAnswer["sentences"][number], task: { taskId: string; shown: string } | undefined, result: AnswerCheck): void {
  const taskCites = sentence.cites.filter((cite) => "kind" in cite);
  // Only exact data shown is evidence. Never combine task and code citations in one sentence.
  if (task === undefined || taskCites.length !== sentence.cites.length || taskCites.some((cite) => cite.quote.trim().length < 20 || !task.shown.includes(cite.quote))) { result.dropped.push("source_not_found"); return; }
  if (!numbersInQuotes(sentence.text, taskCites.map((cite) => cite.quote))) { result.dropped.push("numbers_not_in_quote"); return; }
  const next = taskCites.filter((cite, at) => taskCites.findIndex((other) => other.quote === cite.quote) === at);
  const fresh = next.filter((cite) => !result.sources.some((source) => "kind" in source && source.quote === cite.quote));
  if (result.sources.length + fresh.length > ANSWER_LIMITS.sources) { result.dropped.push("over_source_limit"); return; }
  result.sources.push(...fresh.map((cite) => ({ kind: "task_state" as const, taskId: task.taskId, quote: cite.quote })));
  result.kept.push({ text: neutralizeSourceMarkers(sentence.text), sources: next.map((cite) => result.sources.findIndex((source) => "kind" in source && source.quote === cite.quote)) });
}

function keepCodeSentence(claim: Awaited<ReturnType<typeof checkClaims>>["claims"][number], ownClaim: ClaimToCheck, result: AnswerCheck): void {
  const { sources, kept, dropped, droppedPlaces } = result;
    if (!claim.kept && claim.dropped === "source_not_found") for (const cite of ownClaim.citations) if (!droppedPlaces.some((place) => place.repo === cite.repo && place.path === cite.path)) droppedPlaces.push({ repo: cite.repo, path: cite.path });
    if (!claim.kept) { dropped.push(claim.dropped === "uncited" || claim.dropped === "source_not_found" || claim.dropped === "unreadable" || claim.dropped === "code_name_not_in_quote" ? claim.dropped : "other"); return; }
    const mine = ownClaim.citations;
    if (!numbersInQuotes(claim.sentence, mine.map((citation) => citation.quote ?? ""))) { dropped.push("numbers_not_in_quote"); return; }
    const own: number[] = [];
    const added: number[] = [];
    for (const citation of mine) {
      let at = sources.findIndex((source) => "repo" in source && source.repo === citation.repo && source.path === citation.path && source.line === citation.line);
      if (at === -1) {
        if (sources.length >= ANSWER_LIMITS.sources) { for (const done of added.reverse()) sources.splice(done, 1); dropped.push("over_source_limit"); return; }
        sources.push({ repo: citation.repo, path: citation.path, line: citation.line!, commit: citation.commit, quote: citation.quote ?? "" });
        at = sources.length - 1;
        added.push(at);
      }
      own.push(at);
    }
    kept.push({ text: neutralizeSourceMarkers(claim.sentence), sources: [...new Set(own)] });
}
