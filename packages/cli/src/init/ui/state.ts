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
import type { WizardCard, WizardLink, WizardPhase, WizardQuestion, WizardResume, WizardSnapshot, WizardState, WizardStep } from "./protocol.js";

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
  /** How many pages are connected now (their event streams). */
  connected(): number;
  /** One line for the log pane (the same line `agentx init` writes to stderr). */
  log(line: string): void;
  /** The checklist, in the order the steps run, before any of them has. */
  setSteps(steps: ReadonlyArray<{ id: InitStepId; title: string }>): void;
  applyEvent(event: InitEvent): void;
  showPlan(text: string): void;
  showResume(resume: WizardResume): void;
  /** Shows a card, or replaces the one with the same id where it stands. */
  showCard(card: WizardCard): void;
  /** The address the run now waits on the operator to open. Cleared on every step event (a step
   * started, done, skipped or waiting), and when the card that offered the same address is
   * replaced by one that no longer offers it. */
  showLink(link: WizardLink): void;
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

/** Logged, without the address, when a link fails isShowableLink. */
export const LINK_REFUSED = "the installer left out a link it could not check (only https:// addresses are shown)";

const LOOPBACK_LINK = /^http:\/\/127\.0\.0\.1:(\d{1,5})\//;

/** This machine's 127.0.0.1 listener, on a port a listener can have (1 to 65535). */
function isLoopbackLink(url: string): boolean {
  const port = Number(LOOPBACK_LINK.exec(url)?.[1] ?? "0");
  if (port < 1 || port > 65535) return false;
  try {
    return new URL(url).hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/** True for an address the page may offer as a link: this machine's 127.0.0.1 listener, or an
 * https:// address with a host and no user name or password in it. */
export function isShowableLink(url: string): boolean {
  if (isLoopbackLink(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname !== "" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

/** The card without its link. */
function withoutLink(card: WizardCard): WizardCard {
  return { id: card.id, title: card.title, status: card.status, lines: card.lines, ...(card.checks === undefined ? {} : { checks: card.checks }) };
}

export function createWizardHub(env: string): WizardHub {
  let phase: WizardPhase = "running";
  let steps: WizardStep[] = [];
  let question: WizardQuestion | undefined;
  let plan: string | undefined;
  let resume: WizardResume | undefined;
  let outcome: string | undefined;
  let cards: WizardCard[] = [];
  let link: WizardLink | undefined;
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
    ...(cards.length === 0 ? {} : { cards }),
    ...(link === undefined ? {} : { link }),
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
  const appendLog = (line: string) => {
    log.push(line);
    if (log.length > LOG_BACKLOG * 2) log.splice(0, log.length - LOG_BACKLOG);
    for (const listener of listeners) listener.log(line);
  };

  return {
    state,
    snapshot: () => ({ ...state(), log: log.slice(-LOG_BACKLOG) }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connected: () => listeners.size,
    log: appendLog,
    setSteps(next) {
      steps = next.map((step) => ({ id: step.id, title: step.title, status: "pending" }));
      publish();
    },
    applyEvent(event) {
      // The link belonged to the step that just started or ended.
      link = undefined;
      switch (event.kind) {
        case "step-skipped": return changeStep(event.id, event.title, { status: "skipped" });
        case "step-started": return changeStep(event.id, event.title, { status: "running" });
        case "step-done": return changeStep(event.id, event.title, { status: "done" });
        case "step-waiting": return changeStep(event.id, event.title, { status: "waiting", message: event.message });
      }
    },
    showPlan(text) { plan = text; publish(); },
    showResume(next) { resume = next; publish(); },
    showCard(next) {
      let shown = next;
      if (next.link !== undefined && !isShowableLink(next.link.url)) {
        appendLog(LINK_REFUSED);
        shown = withoutLink(next);
      }
      const replaced = cards.find((existing) => existing.id === shown.id);
      // The run's link came from the card being replaced (Slack's create button, GitHub's install
      // page): once the new card no longer offers it, it is stale, and the page drops it too.
      if (replaced?.link !== undefined && link?.url === replaced.link.url && shown.link?.url !== replaced.link.url) link = undefined;
      cards = replaced !== undefined
        ? cards.map((existing) => (existing.id === shown.id ? shown : existing))
        : [...cards, shown];
      publish();
    },
    showLink(next) {
      if (!isShowableLink(next.url)) {
        appendLog(LINK_REFUSED);
        return;
      }
      link = next;
      publish();
    },
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
