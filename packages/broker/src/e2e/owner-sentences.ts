import type { E2EAgentUnknownCode } from "@agentx/verifier";
import type { E2E_DISPLAY_ASSERTION_KINDS } from "@agentx/contracts";

/**
 * M1.4 Tasks 4.4b and 4.4c: every sentence the owner reads about AI navigation, in one place. Change the wording here and nowhere else. The display, the Slack summary and the task page
 * all take their words from this map; none of them builds an owner-facing sentence of its own for AI navigation.
 *
 * Nothing here is ever built from what a worker or the model said. A sentence is chosen by a fixed code, and the only things put into one are a count, a page element's role and
 * name from the verified ledger (already redacted by the caller) and the title of an approved scenario.
 */

type AssertionKind = (typeof E2E_DISPLAY_ASSERTION_KINDS)[number];

/** How a kind of approved assertion is named in "the CSV check decided". */
const ASSERTION_WORD = Object.freeze({ csv: "CSV", text: "text", visible: "visibility", "http-status": "status code", json: "JSON", state: "state", file: "file" } satisfies Record<AssertionKind, string>);

export const E2E_OWNER_SENTENCES = Object.freeze({
  /**
   * Why a scenario could not be decided, for the codes the collector gives a case whose AI navigation was not clean (`E2E_AGENT_UNKNOWN_CODES`). Every code has a sentence; the type
   * makes a new code a compile error until it is worded here.
   */
  agentCode: Object.freeze({
    "model-receipts-mismatch": "The AI navigation record didn't match what was run, so this check can't be trusted; retry the checks",
    "model-prompt-credential-match": "The AI navigator stopped because the page held a test credential, and the model was not shown it; this check could not be decided",
    "model-route-budget-exhausted": "The AI navigation budget for these checks ran out before they finished; retry the checks",
    "model-unavailable": "The AI model couldn't be reached, so this AI-navigated check could not run; retry the checks",
    "agent-timeout": "The AI navigator ran out of time before it finished; retry the checks",
    "agent-budget-exhausted": "The AI navigator used all the actions it was allowed without finishing; retry, or check the page has a clear way to the goal",
    "agent-navigation-incomplete": "The AI navigator didn't reach the end of its task; retry, or check the page matches what the check describes",
    "agent-no-download": "The AI navigator didn't find a way to download the CSV; retry, or check the button exists",
    "ambiguous-download": "The AI navigator started more than one download, so the CSV check can't tell which file to read; retry, or make the export button clear",
  } satisfies Record<E2EAgentUnknownCode, string>),

  /**
   * Why a whole group could not run, for the group reasons that are put into words (matched exactly on the code before the first colon; the rest of the group's text is never shown).
   * A group code that is not here is not repeated.
   */
  groupCode: Object.freeze({
    "model-route-changed-reapprove": "The AI navigation settings changed after setup was approved. Approve setup again to run these checks.",
    "agent-route-not-approved": "AI navigation isn't approved for this project yet. Approve setup to run the AI-navigated checks.",
  } as Readonly<Record<string, string>>),

  /** Group codes that are said as "could not be verified" and noted for the operator by code only (the environment cannot be told to the owner as a sentence of its own). */
  groupCodeOperatorOnly: Object.freeze(["model-environment-unsafe"] as readonly string[]),

  /** The badge on an AI-navigated row. `clicked` are page element names (at most two are named); `decidedBy` the kinds of assertion that decided the row. */
  badge: (input: { clicked: readonly string[]; decidedBy: readonly AssertionKind[] }): string => {
    const named = input.clicked.slice(0, 2).map((name) => `'${name}'`).join(" and ");
    const more = input.clicked.length - 2;
    const did = input.clicked.length === 0 ? "the model navigated" : `the model clicked ${named}${more > 0 ? ` and ${more} more` : ""}`;
    const kinds = [...new Set(input.decidedBy)];
    const decided = kinds.length === 1 ? `the ${ASSERTION_WORD[kinds[0]!]} check decided` : "the checks decided";
    return `AI-navigated: ${did}; ${decided}`;
  },
  assertionWord: ASSERTION_WORD,

  /** The one Slack line for a round with AI-navigated rows: `AI navigation: 1 step, 3 model calls (checks decide)`. */
  slackLine: (input: { steps: number; modelCalls: number }): string =>
    `AI navigation: ${input.steps} ${input.steps === 1 ? "step" : "steps"}, ${input.modelCalls} model ${input.modelCalls === 1 ? "call" : "calls"} (checks decide)`,

  baseline: Object.freeze({
    /** A baseline that could not run because every scenario of the plan uses AI navigation. */
    agentStepsOnly: "Before the change: not run. Every check here uses AI navigation, which runs only on the change.",
    /** Added to a baseline that did run, when it left AI-navigated scenarios out. */
    skipped: (count: number): string => (count === 1 ? "1 AI-navigated check is not run on the unchanged code." : `${count} AI-navigated checks are not run on the unchanged code.`),
    /** The lead-in of the titles of those scenarios (a list of titles, never rows). */
    skippedListLead: "Not run before the change:",
  }),
});
