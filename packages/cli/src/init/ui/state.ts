// The wizard's state, with no HTTP in it: the step checklist built from the `InitEvent` stream, the
// log pane's backlog from `write(line)`, the review and resume screens, and the one question the
// run is waiting on. The server pushes what changes here to the page; `browserPrompter` asks
// through `ask`.
//
// FR-012: an answer is never kept. `ask` hands its value straight to the caller and the hub forgets
// it, so no secret can reach a snapshot, a log line, an `InitEvent` or a progress note through here.
import { randomUUID } from "node:crypto";
import type { InitStepId } from "../install-state.js";
import type { InitEvent } from "../steps.js";
import type { WizardPhase, WizardQuestion, WizardResume, WizardSnapshot, WizardState, WizardStep } from "./protocol.js";

/** How many log lines the page is given on connect; the terminal keeps all of them either way. */
export const LOG_BACKLOG = 1000;

/** Checks and normalizes one posted answer. `error` is shown on the field and the question is asked
 * again; `value` is what the `Prompter` caller receives. */
export type AnswerCheck = (raw: string) => { value: string } | { error: string };

export interface WizardListener {
  state(state: WizardState): void;
  log(line: string): void;
  /** The run is over and the server is closing; no more events follow. */
  closed(): void;
}

export interface WizardHub {
  snapshot(): WizardSnapshot;
  state(): WizardState;
  subscribe(listener: WizardListener): () => void;
  /** One line for the log pane (the same line `agentx init` writes to stderr). */
  log(line: string): void;
  /** The checklist, in the order the steps run, before any of them has. */
  setSteps(steps: ReadonlyArray<{ id: InitStepId; title: string }>): void;
  applyEvent(event: InitEvent): void;
  showPlan(text: string): void;
  showResume(resume: WizardResume): void;
  /** Publishes a question and resolves with the answer the page posts, once `check` accepts it. */
  ask(question: NewQuestion, check: AnswerCheck): Promise<string>;
  /** The page's answer. Returns the message to show on the field, or undefined when accepted. */
  answer(id: string, value: string): string | undefined;
  finish(outcome: string, phase?: Exclude<WizardPhase, "running">): void;
  /** Rejects any question still waiting, then tells every listener the run is over. */
  close(reason?: Error): void;
}

/** A question as `browserPrompter` writes it: the hub mints the id and carries any inline error. */
export type NewQuestion = Omit<WizardQuestion, "id" | "error">;

interface Pending {
  /** What was published, id and all: an answer has to name this id. */
  question: WizardQuestion;
  /** The same question as `browserPrompter` wrote it, to republish after a rejection. */
  asked: NewQuestion;
  check: AnswerCheck;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

export function createWizardHub(env: string): WizardHub {
  let phase: WizardPhase = "running";
  let steps: WizardStep[] = [];
  let question: WizardQuestion | undefined;
  let plan: string | undefined;
  let resume: WizardResume | undefined;
  let outcome: string | undefined;
  const log: string[] = [];
  const listeners = new Set<WizardListener>();
  let pending: Pending | undefined;
  let closed = false;

  const state = (): WizardState => ({
    env,
    phase,
    steps,
    ...(question === undefined ? {} : { question }),
    ...(plan === undefined ? {} : { plan }),
    ...(resume === undefined ? {} : { resume }),
    ...(outcome === undefined ? {} : { outcome }),
  });
  const publish = () => { const current = state(); for (const listener of listeners) listener.state(current); };
  const changeStep = (id: InitStepId, title: string, change: Partial<Omit<WizardStep, "id">>) => {
    const known = steps.some((step) => step.id === id) ? steps : [...steps, { id, title, status: "pending" as const }];
    steps = known.map((step) => (step.id === id ? { ...step, title, ...change } : step));
    publish();
  };
  // A question is republished under a new id after a rejection, so the page that sent the refused
  // answer cannot resend it and an answer in flight for the old id is ignored.
  const publishQuestion = (next: NewQuestion, error?: string): WizardQuestion => {
    question = { ...next, id: randomUUID(), ...(error === undefined ? {} : { error }) };
    publish();
    return question;
  };

  return {
    state,
    snapshot: () => ({ ...state(), log: log.slice(-LOG_BACKLOG) }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    log(line) {
      log.push(line);
      if (log.length > LOG_BACKLOG * 2) log.splice(0, log.length - LOG_BACKLOG);
      for (const listener of listeners) listener.log(line);
    },
    setSteps(next) {
      steps = next.map((step) => ({ id: step.id, title: step.title, status: "pending" }));
      publish();
    },
    applyEvent(event) {
      switch (event.kind) {
        case "step-skipped": return changeStep(event.id, event.title, { status: "skipped" });
        case "step-started": return changeStep(event.id, event.title, { status: "running" });
        case "step-done": return changeStep(event.id, event.title, { status: "done" });
        case "step-waiting": return changeStep(event.id, event.title, { status: "waiting", message: event.message });
      }
    },
    showPlan(text) { plan = text; publish(); },
    showResume(next) { resume = next; publish(); },
    async ask(next, check) {
      if (closed) throw new Error("the install wizard has closed");
      if (pending !== undefined) throw new Error("the install wizard is already waiting on a question");
      const published = publishQuestion(next);
      return new Promise<string>((resolve, reject) => {
        pending = { question: published, asked: next, check, resolve, reject };
      });
    },
    answer(id, value) {
      const waiting = pending;
      // A stale id (a second tab, a resent answer, a page that reloaded mid-question) changes
      // nothing: the page is told to look at the question the state now holds.
      if (waiting === undefined) return "that question has already been answered";
      if (waiting.question.id !== id) return "that question is out of date; answer the one shown above";
      const checked = waiting.check(value);
      if ("error" in checked) {
        // Never echo `value`: it may be a secret. Only the check's own message reaches the page.
        pending = { ...waiting, question: publishQuestion(waiting.asked, checked.error) };
        return checked.error;
      }
      pending = undefined;
      question = undefined;
      publish();
      waiting.resolve(checked.value);
      return undefined;
    },
    finish(next, ended = "finished") {
      phase = ended;
      outcome = next;
      question = undefined;
      publish();
    },
    close(reason) {
      if (closed) return;
      closed = true;
      const waiting = pending;
      pending = undefined;
      waiting?.reject(reason ?? new Error("the install wizard closed before the question was answered"));
      for (const listener of listeners) listener.closed();
      listeners.clear();
    },
  };
}
