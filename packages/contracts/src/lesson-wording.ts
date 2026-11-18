// Agent knowledge, step (a): how a lesson reads, with NO change to the lesson contract (`LearnedLesson` keeps its fields and limits).
//   title        one imperative statement ("Do X." or "Do not do Y; do Z."), at most 80 characters
//   description  the reason, one sentence, at most 160 characters
//   body         starts with when it applies, "When <situation>:", then what to do, at most 600 characters; where it applies is the scope (path globs)
// The hints below are the one text for the drafting prompt and for the Keep and Edit screens. The check is SOFT: it returns fixed codes a screen may show, and it never refuses a lesson, old or new.
// Pure; no I/O. Browser-safe.

export const LESSON_WORDING_HINTS = {
  title: "Say what to do, in one sentence that starts with a verb. Example: \"Build the client with makeFakeBilling() in tests.\" or \"Do not call the billing API from tests; use FakeBilling.\"",
  description: "Say why, in one sentence. The reason lets an agent judge edge cases.",
  body: "Start with when it applies, like \"When writing a test under src/billing/:\", then say what to do. Put the files or folders it applies to in the scope, as globs.",
} as const;

/** The lines the drafter's system prompt carries (fixed words, so a golden test pins them). */
export const LESSON_WORDING_PROMPT_LINES: readonly string[] = [
  "How a lesson reads: \"title\" is one imperative sentence of at most 80 characters (\"Do X.\" or \"Do not do Y; do Z.\"), one idea only.",
  "\"description\" is the reason in one sentence of at most 160 characters; it is not a second statement.",
  "\"body\" starts with when it applies, \"When <situation>:\", then what to do (at most 600 characters). Put the files or folders where it applies in scope.paths as globs.",
];

export const LESSON_WORDING_WARNINGS = ["title_not_imperative", "no_reason", "body_no_when"] as const;
export type LessonWordingWarning = (typeof LESSON_WORDING_WARNINGS)[number];

/** Words that start a description of a thing, not an instruction. A title that starts with one is a statement about the world. */
const NOT_A_VERB = new Set(["the", "a", "an", "this", "that", "these", "those", "we", "our", "it", "its", "there", "they", "their", "you", "your", "i", "my", "some", "all", "every", "each", "no", "not", "is", "are", "was", "were"]);
const firstWord = (text: string): string => /^[^\p{L}\p{N}]*([\p{L}\p{N}'’-]+)/u.exec(text)?.[1]?.toLowerCase() ?? "";
const squash = (text: string): string => text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase().replace(/[.!]+$/u, "");

/**
 * The ways a lesson departs from the shape, as fixed codes in a fixed order. Heuristic and soft: it only reads the three texts, never throws, and a lesson with warnings is used and shown as it is. An empty list
 * means "reads as designed". The scope is not judged: an empty scope is a lesson for the whole project.
 */
export function lessonWordingWarnings(lesson: { title: string; description: string; body: string }): LessonWordingWarning[] {
  const out: LessonWordingWarning[] = [];
  const word = firstWord(lesson.title);
  // "Using X in tests" is a heading, not an instruction: a gerund opener (a verb in -ing) reads as a topic. Short words such as "bring" or "string" are not.
  if (word === "" || NOT_A_VERB.has(word) || (word.length > 4 && word.endsWith("ing") && word !== "bring")) out.push("title_not_imperative");
  const reason = squash(lesson.description);
  if (reason === "" || reason === squash(lesson.title)) out.push("no_reason");
  if (!/^\s*when\s[^:\n]{1,200}:\s*\S/iu.test(lesson.body)) out.push("body_no_when");
  return out;
}
