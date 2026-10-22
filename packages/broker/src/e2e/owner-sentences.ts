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

type ActionKind = "tap" | "type" | "press" | "select" | "scroll" | "navigate";
/** What the model did to an element, in the badge's words. */
const ACTION_VERB = Object.freeze({ tap: "clicked", select: "chose", press: "pressed", type: "typed into", scroll: "scrolled", navigate: "went to" } satisfies Record<ActionKind, string>);

/**
 * A page element's name as it is quoted in the badge: control and formatting characters (which include text-direction overrides) become spaces, runs of whitespace one space, and a
 * quote or a semicolon is replaced, so a name can't close the quotation and read as another claim.
 */
const sentenceName = (name: string): string => name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim().replaceAll("'", "\u2019").replaceAll('"', "\u201d").replaceAll(";", ",");

export const E2E_OWNER_SENTENCES = Object.freeze({
  /**
   * Why a scenario could not be decided, for the codes the collector gives a case whose AI navigation was not clean (`E2E_AGENT_UNKNOWN_CODES`). Every code has a sentence; the type
   * makes a new code a compile error until it is worded here.
   */
  agentCode: Object.freeze({
    "model-receipts-mismatch": "The AI navigation record didn't match what was run, so this check can't be trusted; retry the checks",
    "model-prompt-credential-match": "The AI navigator stopped because the page showed a test password, which the AI is never allowed to see; this check could not be decided",
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
    "model-environment-unsafe": "This check could not be verified.",
  } as Readonly<Record<string, string>>),

  /** Group codes that are also noted for the operator by code only: the owner reads a plain sentence, the operator's log says which code it was. */
  groupCodeOperatorOnly: Object.freeze(["model-environment-unsafe"] as readonly string[]),

  /**
   * The badge on an AI-navigated row. `acted` are the page elements the model acted on, in order, each with the kind of action (an action with no recorded kind reads as a click); at most two
   * are named. The first named action decides the verb. `decidedBy` are the kinds of assertion that decided the row.
   */
  badge: (input: { acted: ReadonlyArray<Readonly<{ did?: ActionKind | undefined; name: string }>>; decidedBy: readonly AssertionKind[] }): string => {
    const named = input.acted.slice(0, 2).map((item) => `'${sentenceName(item.name)}'`).join(" and ");
    const more = input.acted.length - 2;
    const verb = input.acted.length === 0 ? undefined : ACTION_VERB[input.acted[0]!.did ?? "tap"];
    const did = verb === undefined ? "the model navigated" : `the model ${verb} ${named}${more > 0 ? ` and ${more} more` : ""}`;
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
    /** The end of a list of titles that was cut: how many are not named. */
    skippedMore: (remaining: number): string => `and ${remaining} more`,
  }),
});
