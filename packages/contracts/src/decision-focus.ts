// Decision journey (slice 1): how a link names one decision card on its task page, and the fixed words on a decision's buttons. Kept apart from `decision-cards.ts` (and free of zod) so the first
// page of the web app (Home) can read a card's task page without loading the card schemas, which only the lazy decision views need.

/** A card id's shape (`<kind>:<subject>`); `DecisionCardIdSchema` in decision-cards.ts is the full check. */
const CARD_ID = /^[a-z_]{1,40}:[A-Za-z0-9_-]{1,150}$/u;

/** The query parameter a link to a task page uses to name the decision card on it (`?decision=<card id>`): the page scrolls to that card and marks it. */
export const DECISION_FOCUS_PARAM = "decision";

/**
 * The fixed words on a decision's buttons, one table for every surface (the web card, its inline high-risk Approve, the projector's actions, Slack). One vocabulary (owner, "Task decision journey"):
 * Approve, Request changes, Answer, Retry, Merge; "Open" goes to the card where it is decided; "Show the evidence" opens what a medium card needs looked at first; "Not now" only where it truly defers.
 */
export const DECISION_LABELS = {
  approve: "Approve",
  approveWithReason: "Approve with a reason",
  requestChanges: "Request changes",
  answer: "Answer",
  retry: "Retry",
  /** Slice 3: a merge decides on the card (high after a recent sign-in), so the button says what it does. */
  merge: "Merge",
  open: "Open",
  openInRovara: "Open in Rovara",
  showEvidence: "Show the evidence",
  moreEvidence: "More evidence",
  notNow: "Not now",
  signInAgain: "Sign in again",
} as const;

/** Shown next to Approve on a requirements or coding plan card (slice 2) and in its "What Approve takes" detail: OWNER DECISION 18, what the decision sends (only changed answers are sent; the workflow decision gives every other question the plan's recommendation; exactly the ticked comments go). Never a pointer to the plan review page, which forwards to the task page with the cards on. */
export const DECISION_APPROVE_TAKES = "Your answers on the card and the ticked comments go with your decision. A question left on Rovara's recommendation takes that answer; an unticked comment stays open for the next version.";

const TASK_PAGE = /^\/app\/sessions\/(ses_[0-9a-z]{20})(?:\?|$)/u;
/** The task page with one card on it, focused: `<sessionPath>?decision=<card id>`. Only a bare task session page path (`/app/sessions/ses_...`, no query) is anchored; anything else is answered unchanged. */
export function decisionFocusPath(openPath: string, cardId: string): string {
  if (!TASK_PAGE.test(openPath) || openPath.includes("?") || !CARD_ID.test(cardId)) return openPath;
  return `${openPath}?${DECISION_FOCUS_PARAM}=${encodeURIComponent(cardId)}`;
}
/** The task session a card's open link goes to (`/app/sessions/ses_...`, with or without `?decision=`), or undefined for any other page. */
export function decisionTaskSessionOf(href: string): string | undefined {
  return TASK_PAGE.exec(href)?.[1];
}
