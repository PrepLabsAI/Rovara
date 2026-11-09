// Plan 6 Task 8: reading the plan critic's answer. The critic is a second model; what it writes is untrusted. It ends its answer with a fenced `rovara-plan-critique` block, and
// this is the one place that reads it, for the worker (which asks once more when the block is unreadable) and the broker (which decides). Nothing in the block is believed: every
// point is redacted, put on one line and cut, the points are counted, and the result can only be advice. It has no way to say "approve".
import { PLAN_CRITIC_POINTS_MAX } from "./rovara-code.js";
import { redactText } from "./redaction.js";
import { lastFencedBlock } from "./workflow-proposed-checks.js";

export const PLAN_CRITIQUE_INFO_STRING = "rovara-plan-critique";
/** The most characters of one point. */
export const PLAN_CRITIQUE_POINT_MAX_CHARS = 500;
/** The header of the block that gives a planner the critic's points: they are advice, and the planner decides what to change. */
export const PLAN_CRITIC_BLOCK_HEADER = "A second model's review of this plan (advice; you decide what to change):";

export interface ReadPlanCritiquePoint {
  id: string;
  severity: "blocking" | "note";
  text: string;
  claimId?: string;
}
export type ReadPlanCritique = { ok: true; verdict: "ok" | "revise"; points: ReadPlanCritiquePoint[] } | { ok: false; error: string };

// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const BIDI_CONTROLS = /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
const PLAIN_ID = /^[A-Za-z0-9._-]{1,32}$/u;
const PLAIN_CLAIM_ID = /^[1-9][0-9]{0,2}(\.[1-9][0-9]{0,2}){0,2}$/u;

function oneLine(value: string): string {
  const flat = redactText(value).replace(BIDI_CONTROLS, "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(flat);
  return characters.length > PLAN_CRITIQUE_POINT_MAX_CHARS ? `${characters.slice(0, PLAN_CRITIQUE_POINT_MAX_CHARS - 1).join("")}…` : flat;
}

/**
 * The critic's verdict and points from the last `rovara-plan-critique` block of its answer. A missing, unclosed or unreadable block, or a verdict that is neither `ok` nor
 * `revise`, is an `error` in words the critic can fix. A point that is not an object, has no text or has an unknown severity is left out; an id or claim id that is not plain
 * is replaced (the id) or left out (the claim id). The points are cut to `PLAN_CRITIC_POINTS_MAX`, blocking ones first, so a long list of notes never hides the one that matters.
 */
export function readPlanCritique(answer: string): ReadPlanCritique {
  const block = lastFencedBlock(answer, PLAN_CRITIQUE_INFO_STRING);
  if (block === undefined) return { ok: false, error: `Your answer has no ${PLAN_CRITIQUE_INFO_STRING} block. End it with a fenced block whose info string is ${PLAN_CRITIQUE_INFO_STRING}.` };
  if (block === null) return { ok: false, error: `Your ${PLAN_CRITIQUE_INFO_STRING} block is not closed. End it with a line holding only three backticks.` };
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return { ok: false, error: `The ${PLAN_CRITIQUE_INFO_STRING} block is not valid JSON.` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: `The ${PLAN_CRITIQUE_INFO_STRING} block must be a JSON object with a verdict and points.` };
  const { verdict, points } = raw as Record<string, unknown>;
  if (verdict !== "ok" && verdict !== "revise") return { ok: false, error: `The ${PLAN_CRITIQUE_INFO_STRING} block's verdict must be "ok" or "revise".` };
  const kept: ReadPlanCritiquePoint[] = [];
  for (const [index, entry] of (Array.isArray(points) ? points : []).entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const { id, severity, text, claimId } = entry as Record<string, unknown>;
    if ((severity !== "blocking" && severity !== "note") || typeof text !== "string") continue;
    const clean = oneLine(text);
    if (clean === "") continue;
    kept.push({
      id: typeof id === "string" && PLAIN_ID.test(id) ? id : `p${index + 1}`, severity, text: clean,
      ...(typeof claimId === "string" && PLAIN_CLAIM_ID.test(claimId) ? { claimId } : {}),
    });
  }
  const ordered = [...kept.filter((entry) => entry.severity === "blocking"), ...kept.filter((entry) => entry.severity === "note")];
  return { ok: true, verdict, points: ordered.slice(0, PLAN_CRITIC_POINTS_MAX) };
}
