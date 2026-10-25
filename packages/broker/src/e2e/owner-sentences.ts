import type { DockerApplicationUnavailableReason, E2EAgentUnknownCode } from "@agentx/verifier";
import { E2E_APPLICATION_SEND_BACK_CODES, KEYED_MODEL_PROVIDERS, isKeyedModelProvider, type E2E_DISPLAY_ASSERTION_KINDS } from "@agentx/contracts";

/**
 * M1.4 Tasks 4.4b and 4.4c: every sentence the owner reads about AI navigation, in one place. Change the wording here and nowhere else. The display, the Slack summary and the task page
 * all take their words from this map; none of them builds an owner-facing sentence of its own for AI navigation.
 *
 * Nothing here is ever built from what a worker or the model said. A sentence is chosen by a fixed code, and the only things put into one are a count, a page element's role and
 * name from the verified ledger (already redacted by the caller), the title of an approved scenario and (Task 4.10B) the provider's name and the model id of the route definition the
 * broker stored for the admitted revision (`modelSentenceContext`: never a worker's account of its route).
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

/** The provider and the model a sentence names: from the stored route definition only. */
export type ModelSentenceContext = Readonly<{ providerLabel: string; modelId: string }>;

/** A model id or provider name as a sentence quotes it: the page-element quoting, and a backtick (which closes the code quote) replaced too, cut so a sentence fits a row's 300. */
const MODEL_NAME_MAX = 80;
const ROW_MAX = 300;
const quotedName = (name: string, max: number = MODEL_NAME_MAX): string => {
  const clean = sentenceName(name).replaceAll("`", "\u2019");
  const characters = Array.from(clean);
  return characters.length <= max ? clean : `${characters.slice(0, max - 1).join("")}\u2026`;
};

/**
 * The context of a route definition the broker stored (`readAdmittedE2EModelRoute`): its provider's name and its pinned model id. Undefined when there is none (no definition was read, or
 * the route is the scripted double, which has no provider to name), and the sentences then name neither.
 */
export function modelSentenceContext(definition: Readonly<{ provider: string; modelId: string }> | null | undefined): ModelSentenceContext | undefined {
  if (definition === null || definition === undefined) return undefined;
  const providerLabel = definition.provider === "amazon-bedrock" ? "Amazon Bedrock" : isKeyedModelProvider(definition.provider) ? KEYED_MODEL_PROVIDERS[definition.provider].label : undefined;
  return providerLabel === undefined ? undefined : { providerLabel, modelId: definition.modelId };
}

/** The command that runs a model's driving test (Task 4.10C), as the owner-approved sentences name it. */
const DRIVING_TEST_COMMAND = "agentx project model-check test --model <id>";

/** How a sentence names the provider (at the start of a sentence, and inside one) and the model, with a plain fallback when no definition is known. */
type Who = Readonly<{ start: string; mid: string; model: string; named: boolean }>;
const whoOf = (ctx: ModelSentenceContext | undefined, max: number = MODEL_NAME_MAX): Who => {
  if (ctx === undefined) return { start: "The AI provider", mid: "the AI provider", model: "the chosen model", named: false };
  const provider = quotedName(ctx.providerLabel, max);
  return { start: provider, mid: provider, model: `\`${quotedName(ctx.modelId, max)}\``, named: true };
};

/** A sentence that fits a display row: the names are cut to 80 characters, and cut further, as little as it takes, where the approved wording around them is long. */
function fitted(code: E2EAgentUnknownCode, ctx: ModelSentenceContext | undefined): string {
  for (let max = MODEL_NAME_MAX; ; max = Math.max(12, max - 8)) {
    const sentence = AGENT_SENTENCES[code](whoOf(ctx, max));
    if (Array.from(sentence).length <= ROW_MAX || ctx === undefined || max <= 12) return sentence;
  }
}

/**
 * One sentence per AI navigation code. The model codes (Task 4.10B) name the provider and the model, so the owner knows what to fix; `model-unavailable` is the unclassified failure and,
 * with no definition to name, reads exactly as it did before. Every code has a sentence; the type makes a new code a compile error until it is worded here.
 */
const AGENT_SENTENCES = Object.freeze({
  "model-receipts-mismatch": () => "The AI navigation record didn't match what was run, so this check can't be trusted; retry the checks",
  "model-prompt-credential-match": () => "The AI navigator stopped because the page showed a test password, which the AI is never allowed to see; this check could not be decided",
  "model-route-budget-exhausted": () => "The AI navigation budget for these checks ran out before they finished; retry the checks",
  "model-limit-reached": (who: Who) => `${who.start} refused the AI navigation call to ${who.model}: this account's limit for that model is used up or set to zero. Raise the limit, or choose another model and run its driving test (${DRIVING_TEST_COMMAND}), then retry the checks`,
  "model-key-rejected": (who: Who) => `${who.start} did not accept Rovara's access for ${who.model} (the API key, or on Amazon Bedrock the worker role's model access). Fix the access, then retry the checks`,
  "model-not-found": (who: Who) => `${who.start} says ${who.model} does not exist or is not available to this account. Choose another model, run its driving test (${DRIVING_TEST_COMMAND}), and approve setup again`,
  "model-secret-unreadable": (who: Who) => `Rovara could not read its stored access for ${who.mid}. Check that the key's secret exists and Rovara's worker can read it, then retry the checks`,
  "model-not-in-catalog": (who: Who) => `Rovara doesn't know how to call ${who.model} on ${who.mid}. Choose a model from the list Rovara offers`,
  "model-unreachable": (who: Who) => `Rovara could not reach ${who.mid} to call ${who.model}. Check the network path from the runner, then retry the checks`,
  "model-request-rejected": (who: Who) => `${who.start} rejected the AI navigation request to ${who.model}, so this check could not run. Tell Rovara support (code model-request-rejected)`,
  "model-provider-outage": (who: Who) => `${who.start} had a problem answering for ${who.model}. Retry the checks later`,
  "model-unavailable": (who: Who) => (who.named ? `The AI model (${who.start} ${who.model}) couldn't be reached, so this AI-navigated check could not run; retry the checks`
    : "The AI model couldn't be reached, so this AI-navigated check could not run; retry the checks"),
  "agent-timeout": () => "The AI navigator ran out of time before it finished; retry the checks",
  "agent-budget-exhausted": () => "The AI navigator used all the actions it was allowed without finishing; retry, or check the page has a clear way to the goal",
  "agent-navigation-incomplete": () => "The AI navigator didn't reach the end of its task; retry, or check the page matches what the check describes",
  "agent-no-download": () => "The AI navigator didn't find a way to download the CSV; retry, or check the button exists",
  "ambiguous-download": () => "The AI navigator started more than one download, so the CSV check can't tell which file to read; retry, or make the export button clear",
} satisfies Record<E2EAgentUnknownCode, (who: Who) => string>);

/**
 * Every reason a whole group can end with that is put into words (RUN-2). `DockerApplicationUnavailableReason` is the app host's own list: a code added there is a compile error until
 * it is worded below, exactly as `E2EAgentUnknownCode` is for `AGENT_SENTENCES`. The rest are the worker's `evidence too large`, the broker's own `runtime-expired`, the runner's `runtime-environment-drifted`, the model
 * channel's `model-environment-unsafe` and the three route codes.
 */
export type E2EGroupReasonCode = DockerApplicationUnavailableReason | "evidence too large" | "runtime-expired" | "runtime-environment-drifted" | "model-environment-unsafe"
  | "model-route-changed-reapprove" | "agent-route-not-approved" | "model-route-not-tested";

/** What the owner is told to do when it is Rovara's side that stopped the checks: retry, and say which code if it keeps happening. */
const RETRY_THEN_SUPPORT = (code: string): string => `Retry the checks; if it happens again, tell Rovara support (code ${code}).`;

const GROUP_SENTENCES = Object.freeze({
  // The candidate's own faults (Send back to coding is offered for these four).
  "build-failed": "The app didn't install or build with this change. The coding agent needs to fix it.",
  "app-exited": "The app stopped right after it started. The coding agent needs to fix it.",
  "app-unhealthy": "The app didn't answer its health check in time. If it listens on another port, answers on another path, or needs longer to start, change that in the project's browser and API check settings; otherwise the coding agent needs to fix it.",
  "seed-failed": "The app couldn't load its test data. The coding agent needs to fix it.",
  // The test account's sign-in (RUN-7): only an app's own email-and-password form with the accounts Rovara creates is supported.
  "login-failed": "The test account couldn't sign in. Signed-in checks work only with a plain email-and-password form and the test accounts Rovara creates; sign-in through Auth0, Clerk, Google or similar is not supported yet.",
  // Rovara's side or the environment's.
  "deadline-exceeded": `The checks ran out of time before they finished. ${RETRY_THEN_SUPPORT("deadline-exceeded")}`,
  "executor-failed": `The browser runner stopped before it finished. ${RETRY_THEN_SUPPORT("executor-failed")}`,
  "executor-result-mismatch": `The browser runner's report didn't match what was run, so it can't be trusted. ${RETRY_THEN_SUPPORT("executor-result-mismatch")}`,
  "mock-unavailable": `A stand-in for one of the app's outside services couldn't start. ${RETRY_THEN_SUPPORT("mock-unavailable")}`,
  "model-channel-unavailable": `Rovara couldn't set up the AI navigation connection for these checks. ${RETRY_THEN_SUPPORT("model-channel-unavailable")}`,
  cancelled: "The checks were stopped before they finished. Retry the checks.",
  "evidence too large": `The checks produced more evidence than Rovara can keep, so they could not be decided. ${RETRY_THEN_SUPPORT("evidence too large")}`,
  "runtime-expired": "The browser and API runtime's qualification expired. An administrator must qualify it again, then retry the checks.",
  // The runner's kernel (or architecture) is no longer the one the runtime was qualified on (HARDEN-C I-4): the worker refuses at the start, and the broker gives the same code to a round an older worker ran anyway.
  // Infrastructure: it is not in the send-back codes, and only a requalification fixes it.
  "runtime-environment-drifted": "The test machine changed since it was qualified. An administrator must qualify it again, then retry the checks.",
  "model-environment-unsafe": "This runner's setup could let AI model calls be redirected, so AI navigation was not run. Tell Rovara support (code model-environment-unsafe).",
  "model-route-changed-reapprove": "The AI navigation settings changed after setup was approved. Approve setup again to run these checks.",
  "agent-route-not-approved": "AI navigation isn't approved for this project yet. Approve setup to run the AI-navigated checks.",
  "model-route-not-tested": "AI navigation has not passed its driving test yet. Run the driving test, then approve setup again.",
} satisfies Record<E2EGroupReasonCode, string>);

/** The same sentences, read by a code that arrives as text (a lookup by any string). */
const GROUP_SENTENCES_BY_TEXT: Readonly<Record<string, string>> = GROUP_SENTENCES;

/** Every send-back code is one the host reports (the contracts list is checked against the host's type here, where both are known). */
const SEND_BACK_CODES: ReadonlyArray<E2EGroupReasonCode> = E2E_APPLICATION_SEND_BACK_CODES;

export const E2E_OWNER_SENTENCES = Object.freeze({
  /**
   * Why a scenario could not be decided, for the codes the collector gives a case whose AI navigation was not clean (`E2E_AGENT_UNKNOWN_CODES`). `ctx` is the provider and model of the
   * route definition the broker stored for the admitted revision, or undefined when there is none.
   */
  agentCode: (code: E2EAgentUnknownCode, ctx: ModelSentenceContext | undefined): string => fitted(code, ctx),
  /** Whether a text is one of the codes `agentCode` words (matched exactly). */
  isAgentCode: (code: string): code is E2EAgentUnknownCode => Object.hasOwn(AGENT_SENTENCES, code),

  /**
   * Why a whole group could not run, for the group reasons that are put into words (matched exactly on the code before the first colon; the rest of the group's text is never shown).
   * A group code that is not here is not repeated.
   */
  groupCode: GROUP_SENTENCES_BY_TEXT,
  /** The sentence for a group code, or undefined for a code that is not worded here (matched exactly). */
  groupSentence: (code: string): string | undefined => (Object.hasOwn(GROUP_SENTENCES, code) ? GROUP_SENTENCES[code as E2EGroupReasonCode] : undefined),
  /** The group codes the candidate causes: Send back to coding is offered for these and no others. */
  sendBackCodes: SEND_BACK_CODES,

  /** Group codes that are also noted for the operator by code only: the owner reads a plain sentence, the operator's log says which code it was. */
  groupCodeOperatorOnly: Object.freeze(["model-environment-unsafe", "runtime-environment-drifted"] as readonly string[]),

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
