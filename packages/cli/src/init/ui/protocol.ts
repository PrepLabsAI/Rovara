// What the wizard page and the wizard server say to each other (spec 040 FR-003 to FR-006). This
// module is types only: it is imported by the server, by the prompter and by the page's own module,
// so the three cannot drift.
//
// Nothing here ever carries an answer. A question travels to the page; the answer travels back in
// one POST and goes straight to the `Prompter` caller. A secret in particular is never part of any
// state the page can read back (FR-012).
import type { InitStepId } from "../install-state.js";
import type { JourneyPhaseId, JourneyView } from "./journey.js";

/** The header a request may carry its session token in; `?t=` carries it for a page load. */
export const WIZARD_TOKEN_HEADER = "x-agentx-wizard-token";
export const WIZARD_TOKEN_QUERY = "t";

export type QuestionKind = "ask" | "choose" | "confirm" | "secret" | "actions" | "form";

export interface WizardChoice { value: string; label: string }

/** A button on the page. A confirm has two; an actions question one per choice. */
export interface WizardButton { value: string; label: string; primary: boolean }

/** One field of a form question. A masked field never carries a value back to the page. */
export interface WizardField {
  name: string; label: string; why?: string; example?: string; hint?: string; masked?: boolean; value?: string; error?: string;
  /** A choice field's options and the one an empty answer means. */
  choices?: WizardChoice[];
  defaultValue?: string;
  section?: "advanced";
  group?: string;
  /** Where the value can be copied from (FR-033). */
  link?: WizardLink;
}

export interface WizardQuestion {
  /** Fresh per question, and again after an inline rejection, so a stale page cannot answer twice. */
  id: string;
  kind: QuestionKind;
  /** The terminal's text for the question; the page shows `label` when there is one. */
  text: string;
  label?: string;
  why?: string;
  example?: string;
  learnMoreUrl?: string;
  /** What an empty field means (FR-010). */
  hint?: string;
  /** ask and choose: the answer an empty field means. */
  defaultValue?: string;
  /** confirm: which button is the default. */
  defaultConfirm?: boolean;
  choices?: WizardChoice[];
  buttons?: WizardButton[];
  /** secret: the field is masked and its value is never sent back to the page. */
  masked?: boolean;
  multiline?: boolean;
  /** Why the previous answer was refused, shown on the field rather than ending the run (FR-003). */
  error?: string;
  /** form: its fields, in order. The answer is a JSON object of field name to value. */
  fields?: WizardField[];
  /** form: "Recommended settings" lines (FR-020). */
  summary?: string[];
  /** form: the forward button's label; "Continue" when absent. */
  submitLabel?: string;
}

export type StepStatus = "pending" | "skipped" | "running" | "done" | "waiting" | "failed";

export interface WizardStep {
  id: InitStepId;
  title: string;
  status: StepStatus;
  /** A waiting step's message: what the operator has to do before the install goes on. */
  message?: string;
  /** Spec 048 FR-001 and FR-002: which phase the step belongs to and how long it usually takes. */
  phase: JourneyPhaseId;
  usualSeconds: number;
  usualText: string;
  /** When the step last started (ISO time), so the page can tick its elapsed time. */
  startedAt?: string;
  /** How long a finished step took, in whole seconds. */
  tookSeconds?: number;
}

/** FR-006: what `readInstallProgress` already recorded for a part-finished install. */
export interface WizardResume {
  completed: string[];
  /** The step this run picks up at, when there is one left to run. */
  continueFrom?: string;
}

/** A status card's id: one card per id, and a newer card with the same id replaces it in place.
 * Phase 3 appends the finishing screens' ids. */
export type CardId =
  | "aws" | "account-checks" | "prerequisites" | "github" | "slack" | "slack-urls"
  // Phase 3's finishing screens, appended.
  | "admin" | "project" | "channel" | "connectors" | "alerts" | "reply" | "ready";

export type CardStatus = "info" | "running" | "waiting" | "ok" | "failed";

/** An address the operator opens from the page, in a new tab. Only an `https://` address or this
 * machine's `http://127.0.0.1:<port>/` is ever shown (state.ts's isShowableLink). `note` says it
 * opens in a new tab and to come back (FR-037). */
export interface WizardLink { url: string; label: string; note?: string }

/** Spec 048 FR-029: the plan as the page shows it. `resources` is "Show every resource"; it (and
 * nothing else here) carries stack, role and secret names, so `copy-lint.ts`'s `stateEntries` reads
 * it as technical detail rather than page copy. */
export interface WizardPlan {
  intro: string;
  sections: Array<{ title: string; lines: string[] }>;
  cost: { rows: Array<{ item: string; monthly: string; basis: string }>; total: string; usage: string };
  resources: string[];
}

/** A command shown with a copy button: only on the ready screen and after Stop for now (FR-061).
 * `group` is the subheading it sits under; the page starts a new one where the group changes. */
export interface WizardCommand { label: string; command: string; group?: string }

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
  /** Technical details, shown collapsed: raw messages, IDs, ARNs (FR-027, FR-060). */
  details?: string[];
  commands?: WizardCommand[];
  /** FR-034: an ISO time the page counts down to. */
  waitUntil?: string;
}

/** FR-001: the slim header. */
export interface WizardHeader { installName: string; account?: string; region?: string }

/** FR-060: a failure in three parts. The actions are the question asked with it. */
export interface WizardFailure { title: string; what: string; next: string; details: string[]; link?: WizardLink }

/** "paused": the run ended on a step that waits on someone (a Slack admin's approval, an alert
 * subscription); it is neither finished nor failed, and its step is drawn as waiting. */
export type WizardPhase = "running" | "finished" | "paused" | "failed";

export interface WizardState {
  /** The name the run started with; frozen at that value even after a rename (spec 048 FR-020).
   * The page shows the current name from `header.installName`, which `setInstallName` updates. */
  env: string;
  phase: WizardPhase;
  steps: WizardStep[];
  header: WizardHeader;
  journey: JourneyView;
  /** FR-005: the browser tab's title. */
  pageTitle: string;
  /** A question, a link, a waiting card or a failure: the run waits on the user. */
  waitingOnYou: boolean;
  /** FR-006: the welcome text, while the install is in Get started. */
  welcome?: string[];
  question?: WizardQuestion;
  /** `confirmInstallPlan`'s priced plan, shown as the review screen (FR-005). */
  plan?: WizardPlan;
  resume?: WizardResume;
  /** The connect and finishing screens' cards, in the order each first appeared. */
  cards?: WizardCard[];
  /** The one address the run is waiting on the operator to open, when no card offers it. */
  link?: WizardLink;
  failure?: WizardFailure;
  /** How the run ended, once it has. */
  outcome?: string;
  /** The command to continue later, after Stop for now. */
  commands?: WizardCommand[];
  /** Where the full log is (FR-059, FR-070). */
  logPath?: string;
}

/** A full state plus the log pane's backlog: the first thing a page (or a reconnecting one) gets. */
export interface WizardSnapshot extends WizardState { log: string[] }

/** The body of `POST /answer`. `value` is the raw field text; `confirm` posts "yes" or "no". */
export interface AnswerRequest { id: string; value: string }

/** The reply to `POST /answer`: accepted, or the message to show on the field. */
export type AnswerReply = { ok: true } | { ok: false; error: string };
