// What the wizard page and the wizard server say to each other (spec 040 FR-003 to FR-006). This
// module is types only: it is imported by the server, by the prompter and by the page's own module,
// so the three cannot drift.
//
// Nothing here ever carries an answer. A question travels to the page; the answer travels back in
// one POST and goes straight to the `Prompter` caller. A secret in particular is never part of any
// state the page can read back (FR-012).
import type { InitStepId } from "../install-state.js";

/** The header a request may carry its session token in; `?t=` carries it for a page load. */
export const WIZARD_TOKEN_HEADER = "x-agentx-wizard-token";
export const WIZARD_TOKEN_QUERY = "t";

export type QuestionKind = "ask" | "choose" | "confirm" | "secret";

export interface WizardChoice { value: string; label: string }

export interface WizardQuestion {
  /** Fresh per question, and again after an inline rejection, so a stale page cannot answer twice. */
  id: string;
  kind: QuestionKind;
  text: string;
  /** ask and choose: the answer an empty field means. */
  defaultValue?: string;
  /** confirm: which button is the default. */
  defaultConfirm?: boolean;
  choices?: WizardChoice[];
  /** secret: the field is masked and its value is never sent back to the page. */
  masked?: boolean;
  multiline?: boolean;
  /** Why the previous answer was refused, shown on the field rather than ending the run (FR-003). */
  error?: string;
}

export type StepStatus = "pending" | "skipped" | "running" | "done" | "waiting";

export interface WizardStep {
  id: InitStepId;
  title: string;
  status: StepStatus;
  /** A waiting step's message: what the operator has to do before the install goes on. */
  message?: string;
}

/** FR-006: what `readInstallProgress` already recorded for a part-finished install. */
export interface WizardResume {
  completed: string[];
  /** The step this run picks up at, when there is one left to run. */
  continueFrom?: string;
}

/** A status card's id: one card per id, and a newer card with the same id replaces it in place.
 * Phase 3 appends the finishing screens' ids. */
export type CardId = "aws" | "prerequisites" | "github" | "slack" | "slack-urls";

export type CardStatus = "info" | "running" | "waiting" | "ok" | "failed";

/** An address the operator opens from the page, in a new tab. Only an `https://` address or this
 * machine's `http://127.0.0.1:<port>/` is ever shown (state.ts's isShowableLink). */
export interface WizardLink { url: string; label: string }

/** One line of a checklist card, such as one prerequisite. */
export interface WizardCheck { label: string; ok: boolean; detail: string }

/** What one part of the install looks like right now. Text only, built by ui/cards.ts from facts a
 * step already has. No card builder takes a secret, so no card can carry one (FR-012). */
export interface WizardCard {
  id: CardId;
  title: string;
  status: CardStatus;
  lines: string[];
  checks?: WizardCheck[];
  link?: WizardLink;
}

export type WizardPhase = "running" | "finished" | "failed";

export interface WizardState {
  env: string;
  phase: WizardPhase;
  steps: WizardStep[];
  question?: WizardQuestion;
  /** `confirmInstallPlan`'s priced plan, shown as the review screen (FR-005). */
  plan?: string;
  resume?: WizardResume;
  /** The connect and finishing screens' cards, in the order each first appeared. */
  cards?: WizardCard[];
  /** The one address the run is waiting on the operator to open, when no card offers it. */
  link?: WizardLink;
  /** How the run ended, once it has. */
  outcome?: string;
}

/** A full state plus the log pane's backlog: the first thing a page (or a reconnecting one) gets. */
export interface WizardSnapshot extends WizardState { log: string[] }

/** The body of `POST /answer`. `value` is the raw field text; `confirm` posts "yes" or "no". */
export interface AnswerRequest { id: string; value: string }

/** The reply to `POST /answer`: accepted, or the message to show on the field. */
export type AnswerReply = { ok: true } | { ok: false; error: string };
