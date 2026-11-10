// Lessons outcomes: a cheap, deterministic pre-filter for the words of a reviewer's pull request comment. Only a comment that reads as a correction is worth a paid judge call against the lessons that were loaded;
// praise, a nit, an acknowledgement and a bare question are not. It errs on the side of leaving a comment out (a comment left out costs nothing and harms no lesson); it never decides that a lesson caused anything.
import { cleanForLearning } from "./guards.js";

const MIN_CHARS = 20;
const PRAISE = /^(?:\W|_)*(?:lgtm|looks?\s+good|looks?\s+great|sgtm|nice|great|good\s+(?:job|catch|work)|thanks?|thank\s+you|thx|ty|\+1|ship\s+it|approved?|done|fixed|ok(?:ay)?|ack(?:nowledged)?|yep|yes|sure|cool|awesome|perfect)\b[^\n]{0,40}$/iu;
const NIT = /^(?:\W|_)*(?:nit(?:pick)?|minor|optional|style|typo|fyi|nb|aside|thought|suggestion|non[-\s]?blocking)\b/iu;
/** Words that make a question a request ("should we use X?", "why not use Y instead?"). */
const DIRECTIVE = /\b(?:should|shouldn'?t|must|instead|rather|don'?t|do\s+not|never|always|wrong|incorrect|bug|breaks?|broken|fails?|use|avoid|remove|replace|need(?:s)?\s+to|has\s+to|why\s+not)\b/iu;

/** Whether a comment's words read as a correction. */
export function looksLikeCorrection(text: string): boolean {
  const clean = cleanForLearning(text, 1500).replace(/^On\s+\S+:\s+/u, "").trim();
  if (clean.length < MIN_CHARS) return false;
  if (PRAISE.test(clean) || NIT.test(clean)) return false;
  if (clean.endsWith("?") && !DIRECTIVE.test(clean)) return false;
  return true;
}
