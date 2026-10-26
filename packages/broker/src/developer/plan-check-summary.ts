import { builtinFileCheckOf, canonicalJson, notChangingReference, redactText, type PlanDocument, type PlanQualityFinding } from "@agentx/contracts";
import { NOT_CHECKED_SENTENCE, type PlanSelfCheckView } from "./plan-self-check.js";
import { NOT_TRIED_SENTENCES, NO_EXPECTATION_SUFFIX } from "./plan-check-tried.js";

/**
 * PLANVIEW: what a coding plan's checks say, in plain words, from structured fields only. Pure: the Slack card, the task
 * page, the full-plan route and the MCP tool all read this one summary. Every value that came from the plan (a label, an
 * expected value, a file name) is the plan's own text: it is redacted, put on one line and cut here, and the caller
 * escapes it for its own medium (Slack, HTML). Sentence frames are fixed text. Form values typed into fields are never
 * shown (they can hold a password); the model's own steps are shown as what they do.
 */

/** An expected value is cut to this many characters on a card; the task page, which has the room, shows 400. */
export const PLAN_VALUE_MAX = 80;
/** How much of the plan's own words a summary shows: the card's short form, or the task page's fuller one. */
interface Limits { value: number; rows: number; goal: number; steps: number; columns: boolean; lineMax: number }
const CARD_LIMITS: Limits = { value: PLAN_VALUE_MAX, rows: 6, goal: 30, steps: 3, columns: false, lineMax: 280 };
const PAGE_LIMITS: Limits = { value: 400, rows: 40, goal: 400, steps: 30, columns: true, lineMax: Number.POSITIVE_INFINITY };
const QUESTION_MAX = 100;
const OPTION_MAX = 80;

/** Plan text on one line, secrets removed, cut to `max` characters. */
function plain(value: string, max: number): string {
  const characters = Array.from(redactText(value).replace(/\s+/gu, " ").trim());
  return characters.length <= max ? characters.join("") : `${characters.slice(0, max - 1).join("")}…`;
}

/** A value of the plan's own, quoted: the quotes tell a reader it is the plan's word, not AgentX's. */
const quoted = (value: string, max: number): string => `"${plain(value, max)}"`;

type Scenario = NonNullable<PlanDocument["e2e"]>["scenarios"][number];
type Step = Scenario["steps"][number];
type Assertion = Scenario["assertions"][number];

function stepText(step: Step, limits: Limits): string {
  const v = limits.value;
  switch (step.kind) {
    case "navigate": return `opens ${plain(step.path, v)}`;
    case "click": case "tap": return `clicks ${plain(step.testId, v)}`;
    case "fill": return `fills in ${plain(step.testId, v)}`;
    case "agent": return `an AI step (${quoted(step.goal, limits.goal)}, up to ${step.maxActions} actions)`;
    case "request": return `sends ${step.method} ${plain(step.path, v)}`;
    case "invoke-contract": return `calls ${plain(step.operationId, v)}`;
    case "inspect-contract": return `reads the exports of ${plain(step.operationId, v)}`;
    case "launch-app": return "starts the app";
    case "restart-app": return "restarts the app";
    case "swipe": return `swipes ${step.direction}`;
    case "deep-link": return `opens the link ${plain(step.path, v)}`;
    case "set-permission": return `${step.value === "grant" ? "grants" : step.value === "deny" ? "denies" : "resets"} the ${plain(step.permission, 40)} permission`;
    case "choose-file": return `chooses the file ${plain(step.fixtureFileId, 40)}`;
    default: return "does a step";
  }
}

/** One expected result as a phrase; the rows of a CSV are shown, each cut to the value limit. */
function assertionText(assertion: Assertion, limits: Limits): string {
  const v = limits.value;
  switch (assertion.kind) {
    case "text": return `the text of ${plain(assertion.testId, v)} is ${quoted(assertion.equals, v)}`;
    case "visible": return `${plain(assertion.testId, v)} is ${assertion.equals ? "shown" : "hidden"}`;
    case "csv": {
      if (!limits.columns) {
        // Compact, for a card: the row count, then each row with its first two cells and its last when it has more than three.
        const compact = (row: readonly string[]) => plain((row.length > 3 ? [...row.slice(0, 2), "…", row.at(-1)!] : row).join(","), v);
        const shown = assertion.rows.slice(0, limits.rows).map(compact);
        const more = assertion.rows.length > limits.rows ? ` and ${assertion.rows.length - limits.rows} more rows` : "";
        return `the download ${plain(assertion.downloadName, v)} has ${assertion.rows.length === 0 ? "no rows" : `${assertion.rows.length} ${assertion.rows.length === 1 ? "row" : "rows"}: ${shown.join("; ")}${more}`}`;
      }
      const rows = assertion.rows.slice(0, limits.rows).map((row) => plain(row.join(","), v));
      const more = assertion.rows.length > limits.rows ? ` and ${assertion.rows.length - limits.rows} more` : "";
      return `the download ${plain(assertion.downloadName, v)} has the columns ${plain(assertion.columns.join(", "), v)} and ${assertion.rows.length === 0 ? "no rows" : `the rows ${rows.map((row) => `"${row}"`).join("; ")}${more}`}`;
    }
    case "http-status": return `${assertion.method} ${plain(assertion.path, v)} answers ${assertion.equals}`;
    case "json": return `the response ${plain(assertion.responseId, v)} equals ${quoted(canonicalJson(assertion.equals), v)}`;
    case "state": return `the state ${plain(assertion.probeId, v)} equals ${quoted(canonicalJson(assertion.equals), v)}`;
    case "file": return `the file ${plain(assertion.relativePath, v)} has the expected content`;
    default: return "an expected result holds";
  }
}

/** "claim 2" or "Not changing 1": what a check or scenario proves, by number. */
function provedName(id: string): string {
  const position = notChangingReference(id);
  return position === undefined ? `claim ${plain(id, 12)}` : `Not changing ${position}`;
}

const joinWords = (items: readonly string[]): string => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`);

export interface PlanScenarioSummary {
  scenarioId: string;
  /** The account the steps run as and the targets they run on, as the plan names them. */
  account: string;
  targets: string[];
  /** Every step, as what it does. */
  steps: string[];
  /** Every expected result. */
  expects: string[];
  /** Stand-in services the plan selects for this scenario's targets, as "<component> on <target>"; empty when it selects none. */
  mocks: string[];
  /** The components the scenario says must run for real. */
  requiredReal: string[];
  /** Components that are both required to run for real and selected as stand-ins on one of the scenario's targets (approval refuses that). */
  realAndStandIn: string[];
  /** The most actions any AI step may take; absent when no step is an AI step. */
  maxActions?: number;
  proves: string[];
  /** The one-line form: who and where, what it expects, what it proves, its stand-ins, then its steps; the least important parts are cut first. */
  line: string;
}

export interface PlanCheckItemSummary {
  checkId: string;
  label: string;
  /** What it does: a built-in file check in words, any other check as its command. */
  does: string;
  builtin: boolean;
  proves: string[];
  /** What the planner expects of this check on the unchanged code (its `expectOnBase`), when it said. */
  expectedOnBase?: "pass" | "fail";
  /** The expectation in words: which result is right before the change, so a check written backwards can be seen. */
  direction?: string;
  /** What a try on the unchanged code gave, when one is known. */
  tried?: string;
  line: string;
}

export interface PlanDecisionAnswer { id: string; question: string; answer: string }

export interface PlanCheckSummary {
  scenarios: PlanScenarioSummary[];
  checks: PlanCheckItemSummary[];
  /** The plan said no check applies, and why. */
  noneReason?: string;
  /** What approving without opening the page uses: AgentX's recommended option of each decision. */
  decisions: PlanDecisionAnswer[];
  /** Scenario lines, then check lines: what a card lists. */
  lines: string[];
  /** The self-check findings' sentences for the owner, when findings are given. */
  findingSentences: string[];
  /**
   * What AgentX's plan check says of this plan, to show the owner: the fixed sentences of its findings and notes (the ones a person must settle first), or the one
   * line "Not checked by AgentX's plan check." when there is no usable record. Empty only when the check ran and found nothing to say.
   */
  selfCheckLines: string[];
}

export interface PlanCheckSummaryInput {
  /** "card" (the default) cuts the plan's words short; "page" keeps far more of them, for the task page and the full-plan answer. */
  detail?: "card" | "page" | undefined;
  /** What a try of each proposed check on the unchanged code gave; absent for a check that was not tried. */
  triedOnCurrentCode?: Readonly<Record<string, "passed" | "failed" | "broken">> | undefined;
  findings?: readonly PlanQualityFinding[] | undefined;
  /** What the plan self-check stored for this document (`loadPlanSelfCheck`); absent reads as "not checked". */
  selfCheck?: PlanSelfCheckView | undefined;
}

/** Which result is right for a check before the change, in the words a card and the page use. */
const DIRECTION_WORDS = { fail: "should fail now and pass after the change", pass: "should pass now and after the change" } as const;

function triedText(outcome: "passed" | "failed" | "broken", expected: "pass" | "fail" | undefined): string {
  if (outcome === "broken") return "tried on current code: could not run";
  const word = outcome === "passed" ? "passed" : "failed";
  if (expected === undefined) return `tried on current code: ${word}${NO_EXPECTATION_SUFFIX}`;
  return (outcome === "passed") === (expected === "pass") ? `tried on current code: ${word} as expected` : `tried on current code: ${word}, not as expected`;
}

/**
 * A target made for a second account (`e2eApplicationAccountTargetId`) is named by a hash of its base target and account: it has no readable name, and the plan
 * does not carry the base target. Such a target is left out of a line instead of shown as the hash.
 */
const OPAQUE_TARGET_ID = /^account-target-[0-9a-f]{8,}$/u;
const readableTargetIds = (ids: readonly string[]): string[] => ids.filter((id) => !OPAQUE_TARGET_ID.test(id)).map((id) => plain(id, 60));

function scenarioSummary(plan: PlanDocument, scenario: Scenario, limits: Limits): PlanScenarioSummary {
  const intent = plan.e2e!;
  const targets = readableTargetIds(scenario.requestedTargetIds);
  const refs = (intent.mockFixtureRefs ?? []).filter((ref) => scenario.requestedTargetIds.includes(ref.requestedTargetId));
  const mocks = refs.map((ref) => (OPAQUE_TARGET_ID.test(ref.requestedTargetId) ? plain(ref.componentId, 60) : `${plain(ref.componentId, 60)} on ${plain(ref.requestedTargetId, 60)}`));
  const standIns = [...new Set(refs.map((ref) => plain(ref.componentId, 60)))];
  const requiredReal = scenario.requiredRealComponentIds.map((id) => plain(id, 60));
  const realAndStandIn = requiredReal.filter((id) => standIns.includes(id));
  const agentActions = scenario.steps.flatMap((step) => (step.kind === "agent" ? [step.maxActions] : []));
  const proves = (plan.scenarioProves?.[scenario.scenarioId] ?? []).map(provedName);
  const account = plain(scenario.accountProfileId, 60);
  const steps = scenario.steps.map((step) => stepText(step, limits));
  const expectsAt = (value: number) => scenario.assertions.map((assertion) => assertionText(assertion, { ...limits, value }));
  const expects = expectsAt(limits.value);
  // The line, most important first: expected values, what it proves, the stand-in and real services (a missing stand-in and a
  // real-and-stand-in clash must show), then the steps. When it is too long the steps go first, then the names of the services,
  // and the expected values are shortened last.
  const head = `As ${account}${targets.length === 0 ? "" : ` on ${joinWords(targets)}`}:`;
  const build = (expectList: readonly string[], stepsPart: string, servicesPart: string): string => [
    `expects ${expectList.join("; ")}`, proves.length === 0 ? "proves no claim" : `proves ${joinWords(proves)}`,
    ...(realAndStandIn.length === 0 ? [] : [`${joinWords(realAndStandIn)} must be real but is also a stand-in`]),
    ...(agentActions.length === 0 ? [] : [`AI steps take up to ${Math.max(...agentActions)} actions`]),
    servicesPart, ...(stepsPart === "" ? [] : [`steps: ${stepsPart}`])].join("; ");
  const services = (named: boolean): string => [
    standIns.length === 0 ? "no stand-ins" : named ? `stand-ins: ${joinWords(standIns)}` : `${standIns.length} ${standIns.length === 1 ? "stand-in" : "stand-ins"}`,
    ...(requiredReal.length === 0 ? [] : [named ? `real: ${joinWords(requiredReal)}` : `${requiredReal.length} real`])].join("; ");
  const stepsFull = steps.length === 0 ? "" : [...steps.slice(0, limits.steps), ...(steps.length > limits.steps ? [`and ${steps.length - limits.steps} more steps`] : [])].join(", ");
  const attempts = [
    () => build(expects, stepsFull, services(true)),
    () => build(expects, steps.length === 0 ? "" : `${steps.length} ${steps.length === 1 ? "step" : "steps"}`, services(true)),
    () => build(expects, "", services(true)),
    () => build(expects, "", services(false)),
    () => build(expectsAt(40), "", services(false)),
    () => build(expectsAt(20), "", services(false)),
  ];
  let body = attempts[0]!();
  for (const attempt of attempts) {
    body = attempt();
    if (head.length + 1 + body.length <= limits.lineMax) break;
  }
  const line = `${head} ${body}`;
  return {
    scenarioId: plain(scenario.scenarioId, 120), account, targets, steps, expects, mocks, requiredReal, realAndStandIn,
    ...(agentActions.length === 0 ? {} : { maxActions: Math.max(...agentActions) }), proves,
    line: line.length <= limits.lineMax ? line : plain(line, limits.lineMax),
  };
}

function checkSummary(plan: PlanDocument, input: PlanCheckSummaryInput, limits: Limits, check: NonNullable<PlanDocument["checks"]>["proposed"][number]): PlanCheckItemSummary {
  const builtin = builtinFileCheckOf(check.command);
  const does = builtin === undefined
    ? `runs ${plain([check.command.executable, ...check.command.args].join(" "), 100)}`
    : `checks that ${plain(builtin.path, limits.value)} ${builtin.kind === "file-contains" ? "contains" : "does not contain"} ${quoted(builtin.text, limits.value)}`;
  const proves = (plan.checks?.proves[check.id] ?? []).map(provedName);
  const outcome = input.triedOnCurrentCode?.[check.id] ?? input.selfCheck?.tried[check.id];
  const expectedOnBase = plan.checks?.expectOnBase?.[check.id];
  const notTried = outcome === undefined ? input.selfCheck?.notTried[check.id] : undefined;
  const tried = outcome !== undefined ? triedText(outcome, expectedOnBase) : notTried === undefined ? undefined : NOT_TRIED_SENTENCES[notTried];
  const direction = expectedOnBase === undefined ? undefined : DIRECTION_WORDS[expectedOnBase];
  const label = plain(check.label, 80);
  return {
    checkId: check.id, label, does, builtin: builtin !== undefined, proves, ...(expectedOnBase === undefined ? {} : { expectedOnBase }),
    ...(direction === undefined ? {} : { direction }), ...(tried === undefined ? {} : { tried }),
    line: `Check "${label}" ${does}${proves.length === 0 ? "" : `; proves ${joinWords(proves)}`}${direction === undefined ? "" : `; ${direction}`}${tried === undefined ? "" : `; ${tried}`}`,
  };
}

/** One line per scenario and per proposed check, the decision answers an Approve in Slack uses, and the self-check sentences. */
export function planCheckSummary(plan: PlanDocument, input: PlanCheckSummaryInput = {}): PlanCheckSummary {
  const limits = input.detail === "page" ? PAGE_LIMITS : CARD_LIMITS;
  const scenarios = (plan.e2e?.scenarios ?? []).map((scenario) => scenarioSummary(plan, scenario, limits));
  const checks = (plan.checks?.proposed ?? []).map((check) => checkSummary(plan, input, limits, check));
  const decisions = plan.decisions.map((decision) => ({
    id: plain(decision.id, 12), question: plain(decision.question, QUESTION_MAX),
    answer: plain(decision.options.find((option) => option.id === decision.recommended)?.label ?? decision.recommended, OPTION_MAX),
  }));
  return {
    scenarios, checks, decisions,
    ...(plan.checks?.noneReason === undefined ? {} : { noneReason: plain(plan.checks.noneReason, 300) }),
    lines: [...scenarios.map((scenario) => scenario.line), ...checks.map((check) => check.line)],
    findingSentences: (input.findings ?? []).map((finding) => finding.ownerSentence),
    selfCheckLines: input.selfCheck === undefined || !input.selfCheck.checked ? [NOT_CHECKED_SENTENCE] : [...input.selfCheck.sentences],
  };
}

export const PLAN_UNREADABLE_CATEGORIES = ["e2e-shape", "checks-shape", "claims-shape", "too-long", "wrong-e2e-version", "work-breakdown", "other"] as const;
export type PlanUnreadableCategory = (typeof PLAN_UNREADABLE_CATEGORIES)[number];

/** What the owner is told when a plan could not be read: one fixed sentence per category, never the validator's words. */
export const PLAN_UNREADABLE_SENTENCES: Readonly<Record<PlanUnreadableCategory, string>> = {
  "e2e-shape": "the browser and API checks part did not match the required format",
  "checks-shape": "the checks it proposed did not match the required format",
  "claims-shape": "the claims or decisions did not match the required format",
  "too-long": "the plan was longer than the limit",
  "wrong-e2e-version": "the browser and API checks part used a format version this project does not offer",
  "work-breakdown": "the work breakdown did not match the required format",
  "other": "its answer did not match the required format",
};

/**
 * The category of an unreadable plan, from the fixed field words the validator puts at the start of each problem (its
 * `<subject>: <field> <problem>` form) and from the broker's own fixed sentences (too long, version not offered, ordered work, the task graph's checks), never from the model's own text. Several categories: the most telling one wins.
 */
export function planUnreadableCategory(errors: readonly string[]): PlanUnreadableCategory {
  const found = new Set<PlanUnreadableCategory>();
  for (const error of errors) {
    const whole = error.trim();
    const colon = whole.indexOf(": ");
    const rest = colon < 0 ? whole : whole.slice(colon + 2);
    if (/^e2e schemaVersion (?:must be|\d+ was not offered)\b/u.test(rest)) found.add("wrong-e2e-version");
    else if (whole === "the answer is too long" || whole === "the plan is too long once saved") found.add("too-long");
    else if (/^ordered work is available only\b/u.test(whole) || /^graph(?:\.|:)/u.test(whole)) found.add("work-breakdown");
    else if (/^(?:e2e\b|E2E intent\b|scenarioProves\b)/u.test(rest) || /^scenarioProves\b/u.test(whole)) found.add("e2e-shape");
    else if (/^checks?\b/u.test(rest) || /^check\s/u.test(whole)) found.add("checks-shape");
    else if (/^work(?:Breakdown|\s+breakdown)\b/u.test(rest)) found.add("work-breakdown");
    else if (/^(?:the plan|claim|decision)\b/u.test(whole) || /^(?:why|title|claims|decisions|notChanging|risks)\b/u.test(rest)) found.add("claims-shape");
    else found.add("other");
  }
  return (["wrong-e2e-version", "e2e-shape", "checks-shape", "work-breakdown", "too-long", "claims-shape", "other"] as const).find((category) => found.has(category)) ?? "other";
}
