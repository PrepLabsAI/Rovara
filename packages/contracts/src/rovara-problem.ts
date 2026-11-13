// TE-B8 (O22): the "Rovara problem" line. When a fault of Rovara's own (not the code's) holds a pull request, the line names the cause in plain words, says what was already tried, and says the next step, worded by what is
// LIVE today: a step a later lane will add is not promised until that lane flips the row's `liveToday` (`nextBefore` is the words until then). It is never a bare "infrastructure problem". Pure and browser-safe (no clock, no network);
// the renderer (evidence-render.ts) prints it, and Cloud's classifier gives it the kind and the measured detail once the pin holds this file (7a). Every word a repository, a person or a model wrote (a check, a service, a step,
// a provider's code) goes through `inertEvidenceText`; every number is checked finite and inside its bound before it is printed. The words name no screen, so a laptop and a hosted install say the same thing; a button is only a label.
import { inertEvidenceText } from "./evidence-inert.js";

/** The kinds of fault, one row each in `ROVARA_PROBLEM_WORDS` (adding a kind without a row fails the build). */
export const ROVARA_PROBLEM_KINDS = ["out_of_memory", "round_time_ran_out", "service_did_not_start", "machine_lost", "image_pull_failed", "code_host_unreachable", "model_provider_error", "budget_reached"] as const;
export type RovaraProblemKind = (typeof ROVARA_PROBLEM_KINDS)[number];

/** What the cause sentence may be made from: each already inert and bounded (or "?" for a number that is not usable). Empty when the caller gave nothing. */
export interface RovaraProblemDetails {
  check?: string;
  used?: string;
  limit?: string;
  minutes?: string;
  service?: string;
  step?: string;
  code?: string;
  budgetWords?: string;
  unit?: string;
  id?: string;
}

export interface RovaraProblemRow {
  /** The cause, as a sentence without a full stop. */
  cause: (details: RovaraProblemDetails) => string;
  /** True when the automatic next step in `next` exists today. False: the line says `nextBefore` until the lane that adds the step flips this. */
  liveToday: boolean;
  /** How many automatic retries the step makes before it waits for a person (0: none). Used only when `liveToday`. */
  autoRetries: number;
  /** The next step as it can be worded today (no promise of anything not yet built). */
  nextBefore: string;
  /** The next step once it is live. */
  next: string;
  /** The person's action label while the row is not live, and once it is. */
  buttonBefore: string;
  button: string;
}

const named = (value: string | undefined, fallback: string) => (value === undefined || value === "" ? fallback : value);
const optional = (value: string | undefined, wrap: (inner: string) => string) => (value === undefined || value === "" ? "" : wrap(value));

export const ROVARA_PROBLEM_WORDS: Record<RovaraProblemKind, RovaraProblemRow> = {
  out_of_memory: {
    cause: (d) => `the test machine ran out of memory in ${named(d.check, "a check")} (${named(d.used, "?")} of ${named(d.limit, "?")} GB)`,
    liveToday: false,
    autoRetries: 1,
    nextBefore: "ask a maintainer to pick a larger machine",
    next: "retrying once on the next machine size",
    buttonBefore: "Retry now",
    button: "Retry now",
  },
  round_time_ran_out: {
    cause: (d) => `${named(d.check, "a check")} did not finish in the ${named(d.minutes, "?")}-minute limit`,
    liveToday: false,
    autoRetries: 1,
    nextBefore: "re-run with a longer round",
    next: "running it as the full-suite follow-up",
    buttonBefore: "Retry now",
    button: "Run follow-up now",
  },
  service_did_not_start: {
    cause: (d) => `${named(d.service, "a service")} did not start${optional(d.step, (step) => ` (${step})`)}`,
    liveToday: false,
    autoRetries: 1,
    nextBefore: "ask a maintainer to check the service's setup",
    next: "retrying once, then asking a maintainer to fix the setup",
    buttonBefore: "Open setup",
    button: "Open setup",
  },
  machine_lost: {
    cause: () => "the test machine stopped responding",
    // The one infrastructure retry that exists today: a run lost to the machine is run again once on a new machine, then waits for a person (workflow-autofix: `run-lost`, `dispatch-exhausted`).
    liveToday: true,
    autoRetries: 1,
    nextBefore: "ask a maintainer to retry it",
    next: "retrying on a new machine",
    buttonBefore: "Retry now",
    button: "Retry now",
  },
  image_pull_failed: {
    cause: () => "the setup image could not be fetched",
    liveToday: false,
    autoRetries: 1,
    nextBefore: "try again in a few minutes",
    next: "retrying once, then starting from a fresh setup",
    buttonBefore: "Retry now",
    button: "Retry now",
  },
  code_host_unreachable: {
    cause: () => "the code host did not answer",
    liveToday: false,
    autoRetries: 3,
    nextBefore: "try again in a few minutes",
    next: "retrying with a growing wait",
    buttonBefore: "Retry now",
    button: "Retry now",
  },
  model_provider_error: {
    cause: (d) => `the model provider refused or failed${optional(d.code, (code) => ` (${code})`)}`,
    liveToday: false,
    autoRetries: 1,
    nextBefore: "try again in a few minutes",
    next: "retrying after the provider's wait",
    buttonBefore: "Retry now",
    button: "Retry now",
  },
  budget_reached: {
    cause: (d) => `the task reached its ${named(d.budgetWords, "")}${d.budgetWords === undefined || d.budgetWords === "" ? "" : " "}budget (${named(d.used, "?")} of ${named(d.limit, "?")}${d.unit ?? ""})`,
    liveToday: false,
    autoRetries: 0,
    nextBefore: "ask someone who sets budgets to raise it",
    next: "stopping until someone raises the budget",
    buttonBefore: "Raise budget",
    button: "Raise budget",
  },
};

/** A kind this build does not know (a later writer's): said as what it is, with its id when the id is a plain word. */
export const ROVARA_PROBLEM_UNKNOWN: RovaraProblemRow = {
  cause: (d) => `an unexpected Rovara fault (${named(d.id, "unknown")})`,
  liveToday: false,
  autoRetries: 0,
  nextBefore: "tell a maintainer, and try again",
  next: "we've been alerted",
  buttonBefore: "Retry now",
  button: "Retry now",
};

/** What the line is made from. Everything but `kind` is optional and untrusted: a name is made inert, a number is checked, and a value that is not usable prints "?" or is left out. */
export interface RovaraProblemFacts {
  kind: unknown;
  /** How many times it was already retried. Anything but a whole number from 0 up says "what was tried is not recorded". */
  retries?: number | undefined;
  /** The check or round the fault hit ("the full suite"). */
  check?: string | undefined;
  /** Out of memory: used and limit, in GB. */
  usedGb?: number | undefined;
  limitGb?: number | undefined;
  /** Round time ran out: the limit, in minutes. */
  minutes?: number | undefined;
  service?: string | undefined;
  step?: string | undefined;
  /** The model provider's error code. */
  code?: string | undefined;
  /** Budget reached: which budget, and used and cap (dollars for `model`, machine minutes for `machine`). */
  budget?: unknown;
  used?: number | undefined;
  cap?: number | undefined;
  /** When the automatic retry is due, in epoch milliseconds. Said only for a live step that has retries left. */
  nextAtMs?: number | undefined;
}

export interface RovaraProblemOutput {
  /** One line, already inert. */
  line: string;
  /** The person's action, as a label (the page or the Check puts the button; the text of a pull request has none). */
  button: string;
}

const LINE_MAX = 300;
const NAME_MAX = 60;
const BOUNDS = { gb: 4_096, minutes: 10_080, dollars: 10_000_000, machineMinutes: 10_000_000 } as const;
const RETRIES_NAMED_MAX = 99;
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/u;

/** A number for a line: a finite number from 0 up to `max`, with at most one decimal; anything else (NaN, negative, huge, not a number) is "?". */
function bounded(value: unknown, max: number): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? String(Number(value.toFixed(1))) : "?";
}
/** A whole number of minutes. */
const wholeMinutes = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? bounded(value, BOUNDS.minutes) : "?");
const dollars = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= BOUNDS.dollars ? `$${value.toFixed(2)}` : "$?");
const inert = (value: unknown, max: number) => (typeof value === "string" ? inertEvidenceText(value, max) : "");

/** `HH:MM UTC` of a time, or undefined when it is not a usable time. */
function clock(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 8.64e15) return undefined;
  const at = new Date(value);
  return `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function triedWords(retries: unknown): string {
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0) return "What was tried is not recorded.";
  if (retries === 0) return "Not retried yet.";
  if (retries === 1) return "Retried once.";
  return retries > RETRIES_NAMED_MAX ? `Retried more than ${RETRIES_NAMED_MAX} times.` : `Retried ${retries} times.`;
}

/** The line and the button label for a fault. `table` is `ROVARA_PROBLEM_WORDS`; a test passes another to flip a row. */
export function rovaraProblem(facts: RovaraProblemFacts, table: Record<RovaraProblemKind, RovaraProblemRow> = ROVARA_PROBLEM_WORDS): RovaraProblemOutput {
  const kind = facts.kind;
  const known = typeof kind === "string" && Object.hasOwn(table, kind);
  const row = known ? table[kind as RovaraProblemKind] : ROVARA_PROBLEM_UNKNOWN;
  const budgetKind = facts.budget === "model" || facts.budget === "machine" ? facts.budget : undefined;
  const budgetMoney = budgetKind === "model";
  const details: RovaraProblemDetails = {
    check: inert(facts.check, NAME_MAX),
    used: known && kind === "out_of_memory" ? bounded(facts.usedGb, BOUNDS.gb) : budgetMoney ? dollars(facts.used) : bounded(facts.used, BOUNDS.machineMinutes),
    limit: known && kind === "out_of_memory" ? bounded(facts.limitGb, BOUNDS.gb) : budgetMoney ? dollars(facts.cap) : bounded(facts.cap, BOUNDS.machineMinutes),
    minutes: wholeMinutes(facts.minutes),
    service: inert(facts.service, NAME_MAX),
    step: inert(facts.step, NAME_MAX),
    code: inert(facts.code, 30),
    budgetWords: budgetKind ?? "",
    unit: budgetKind === "machine" ? " machine minutes" : "",
    id: typeof kind === "string" && PLAIN_ID.test(kind) ? kind : "unknown",
  };
  // A step that exists today and still has a retry left is said as the step, at its time when one is known; once its retries are used up, only a person can go on.
  const retries = typeof facts.retries === "number" && Number.isInteger(facts.retries) && facts.retries >= 0 ? facts.retries : undefined;
  const live = row.liveToday;
  const spent = live && retries !== undefined && retries >= row.autoRetries;
  const at = clock(facts.nextAtMs);
  const next = !live ? row.nextBefore : spent ? "it is waiting for you to retry it" : `${row.next}${at === undefined ? "" : ` at ${at}`}`;
  const line = `Held back: Rovara problem, not your code: ${row.cause(details)}. ${triedWords(facts.retries)} Next: ${next}.`;
  return { line: Array.from(line).length <= LINE_MAX ? line : `${Array.from(line).slice(0, LINE_MAX - 1).join("")}…`, button: live ? row.button : row.buttonBefore };
}
