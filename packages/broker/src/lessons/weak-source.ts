// Lead 4 L4-SRC-SL: weak sources. A reply in a chat thread is the one source today whose words were not written TO Rovara as a correction (a teammate talking in a thread), so it is weak evidence:
//   - it is shown to people only after the same point is seen twice, from two different tasks (`earnedAttention`, `process.ts`; the owner's decision names no measured-result exception): nothing waits in front of people on one sighting;
//   - it never goes live by itself, whatever else backs it: not on trial and not by the automatic path (DEC 24: chat text never goes live without a person).
// Pure; reads only a lesson's provenance. `sourceKinds` are the kinds of the spans the lesson CITES, and a merge keeps the union (`curate.ts`).
import type { LessonProvenance } from "./types.js";

/** Kinds that are a person's own correction or choice made to Rovara (or in its review of the work): a lesson that cites one of these is not weak because of a chat reply beside it. */
const STRONG_KINDS: ReadonlySet<string> = new Set(["remembered", "human_edit", "send_back", "close_reason", "plan_comment", "design_comment", "pr_comment"]);

/** Whether a lesson cites a reply in a chat thread. Such a lesson never goes live without a person. */
export const citesSlackReply = (provenance: Pick<LessonProvenance, "sourceKinds">): boolean => provenance.sourceKinds.includes("slack_reply");

/** Whether a chat reply is the ONLY kind of person's evidence a lesson cites: it then waits for a second sighting. */
export const isWeakSlackOnly = (provenance: Pick<LessonProvenance, "sourceKinds">): boolean =>
  citesSlackReply(provenance) && !provenance.sourceKinds.some((kind) => STRONG_KINDS.has(kind));
