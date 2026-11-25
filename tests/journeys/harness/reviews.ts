// The reviewers' side of journey 14: what the two reviewers (code and security) answer on the real worker, per role and per call, whatever order the worker asks them in. The core runs both reviewers inside one REVIEW step
// and asks a reviewer whose answer it could not read to answer again, so a prose answer takes two calls (list it twice to fail the review).
import { fauxAssistantMessage, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { firstUserText } from "../../support/faux-scripts.js";
import { reviewerHangs } from "../../support/model-fixtures.js";

export interface ReviewFinding { text: string; origin: "INTRODUCED" | "PRE_EXISTING"; severity?: "HIGH" | "MEDIUM" | "LOW"; file?: string; line?: number; advisory?: boolean }
/** One reviewer call: its findings, a prose answer the core cannot read, or no answer until the worker's time limit stops it. */
export type ReviewerCall = ReviewFinding[] | "PROSE" | "HANG";
export type ReviewerScript = Partial<Record<"CODE" | "SECURITY", ReviewerCall[]>>;

const PROSE = "I reviewed the change carefully. Overall it looks good and I found nothing blocking.";

/** The model steps of one REVIEW step: each reviewer takes the next call of its own list (a clean pass when its list is used up), whichever reviewer the worker asks first. */
export function reviewerSteps(script: ReviewerScript): FauxResponseStep[] {
  const next = { CODE: [...(script.CODE ?? [])], SECURITY: [...(script.SECURITY ?? [])] };
  const step: FauxResponseStep = (context: TranscriptContext, options, state, model) => {
    // The step's first model call is the task conversation's own (the planning conversation is reopened), not a reviewer's: it is answered with a clean report and uses up no reviewer call.
    const named = /Review role: (CODE|SECURITY)/u.exec(firstUserText(context));
    if (named === null) return fauxAssistantMessage(JSON.stringify({ findings: [] }));
    const call = next[named[1] as "CODE" | "SECURITY"].shift() ?? [];
    if (call === "HANG") return (reviewerHangs as (...args: unknown[]) => Promise<ReturnType<typeof fauxAssistantMessage>>)(context, options, state, model);
    return fauxAssistantMessage(call === "PROSE" ? PROSE : JSON.stringify({ findings: call }));
  };
  return Array.from({ length: 12 }, () => step);
}

/** `count` blocking findings the change introduced, each on its own line of the file, so each is its own finding. */
export const findings = (role: string, count: number, extra: Partial<ReviewFinding> = {}): ReviewFinding[] => Array.from({ length: count }, (_, index) => (
  { text: `${role} finding ${String(index + 1)}: line ${String(index + 1)} is not trimmed.`, origin: "INTRODUCED", severity: "MEDIUM", file: "health.txt", line: 1, ...extra }));
