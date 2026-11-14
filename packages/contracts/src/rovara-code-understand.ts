// Rovara Code (Plan 6 Task 4): reading what the Understand step answered. The model's answer is untrusted: it is cut out of a fenced `rovara-intent` block, checked against
// `IntentAssessmentSchema`, cleaned of control characters and credentials, and checked again after that, before it can pick the Quick or Full path or put a question to
// a person. The worker reads its own answer with this (so it can ask once more), and the broker reads what the worker saved with the same function (it never trusts the
// worker's check). Not for the web app: it reaches `task-workflow.ts` (and so `node:crypto`) through the fenced-block reader; the shapes the web reads are in `rovara-code.ts`.
import { redactText } from "./redaction.js";
import { IntentAssessmentSchema, intentAssessmentDuplicateIds, type IntentAssessment } from "./rovara-code.js";
import { lastFencedBlock } from "./workflow-proposed-checks.js";

/** The info string of the fenced block that holds an `IntentAssessment`. */
export const INTENT_BLOCK_INFO_STRING = "rovara-intent";
/** The artifact the worker saves the checked assessment as. */
export const UNDERSTAND_ARTIFACT_NAME = "intent.json";
/** The most bytes of an assessment read from the model or from the saved artifact. */
export const UNDERSTAND_ARTIFACT_MAX_BYTES = 32_768;

export type IntentRead = { ok: true; assessment: IntentAssessment } | { ok: false; errors: string[] };

const ERRORS_MAX = 5;
const ERROR_MAX_CHARS = 200;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

/** Every string in the value cleaned: credentials redacted, and control characters (a newline in an answer's text aside) made spaces. Objects and arrays keep their shape. */
function cleaned(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    const redacted = redactText(value);
    return key === "answer" ? redacted.replace(/\r\n?/gu, "\n").replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? "\n" : " ")) : redacted.replace(CONTROL, " ");
  }
  if (Array.isArray(value)) return value.map((entry) => cleaned(entry));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, cleaned(entry, name)]));
  return value;
}

const messages = (issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string[] =>
  issues.slice(0, ERRORS_MAX).map((issue) => `${issue.path.map(String).join(".") || "the block"}: ${issue.message}`.slice(0, ERROR_MAX_CHARS));

/**
 * An `IntentAssessment` from a parsed value (the saved artifact's JSON, or the block's), or the problems found, in plain words. Checked twice: as given, and again after it
 * was cleaned (a redaction can only make a string shorter, but nothing here relies on that).
 */
export function checkIntentAssessment(value: unknown): IntentRead {
  const first = IntentAssessmentSchema.safeParse(value);
  if (!first.success) return { ok: false, errors: messages(first.error.issues) };
  const second = IntentAssessmentSchema.safeParse(cleaned(first.data));
  if (!second.success) return { ok: false, errors: messages(second.error.issues) };
  const duplicates = intentAssessmentDuplicateIds(second.data);
  return duplicates.length > 0 ? { ok: false, errors: duplicates } : { ok: true, assessment: second.data };
}

/** The saved artifact's text as an assessment: bounded, parsed, checked. */
export function readIntentArtifact(text: string): IntentRead {
  if (byteLength(text) > UNDERSTAND_ARTIFACT_MAX_BYTES) return { ok: false, errors: ["the assessment is too long"] };
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, errors: ["the assessment is not valid JSON"] }; }
  return checkIntentAssessment(json);
}

/** The model's answer as an assessment: its last `rovara-intent` block, bounded, parsed, checked. The errors are for the model's one more try. */
export function readIntentBlock(answer: string): IntentRead {
  const block = lastFencedBlock(answer, INTENT_BLOCK_INFO_STRING);
  if (block === undefined) return { ok: false, errors: [`Your answer has no ${INTENT_BLOCK_INFO_STRING} block. End it with a fenced block whose info string is ${INTENT_BLOCK_INFO_STRING}.`] };
  if (block === null) return { ok: false, errors: [`Your ${INTENT_BLOCK_INFO_STRING} block is not closed. End it with a line holding only three backticks.`] };
  if (byteLength(block) > UNDERSTAND_ARTIFACT_MAX_BYTES) return { ok: false, errors: [`Your ${INTENT_BLOCK_INFO_STRING} block is too long.`] };
  let json: unknown;
  try { json = JSON.parse(block); } catch { return { ok: false, errors: [`The ${INTENT_BLOCK_INFO_STRING} block is not valid JSON.`] }; }
  return checkIntentAssessment(json);
}
