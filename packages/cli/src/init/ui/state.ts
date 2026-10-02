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
import { journeyOf, STEP_PLAN, usualText, welcomeLines, type JourneyPhaseId } from "./journey.js";
import type {
  WizardCard, WizardCommand, WizardFailure, WizardHeader, WizardLink, WizardPhase, WizardQuestion, WizardResume, WizardSnapshot, WizardState, WizardStep,
} from "./protocol.js";

/** FR-037: every link the page shows says it opens in a new tab and to come back. */
export const NEW_TAB_NOTE = "Opens in a new tab. Come back to this tab when you are done.";
/** FR-005: the tab title whenever the run waits on the operator. */
export const ACTION_NEEDED_TITLE = "(Action needed) Install AgentX";

const withNote = (link: WizardLink): WizardLink => ({ ...link, note: NEW_TAB_NOTE });

/** How many log lines the page is given on connect; the terminal keeps all of them either way. */
export const LOG_BACKLOG = 1000;

/** Checks and normalizes one posted answer. `error` is shown on the field and the question is asked
 * again; `value` is what the `Prompter` caller receives. `retry` republishes a different question
 * than the one asked (a form redisplays its fields with the valid ones kept and errors marked). */
export type AnswerCheck = (raw: string) => { value: string } | { error: string; retry?: NewQuestion };

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
  /** Drops the run's link: the address it offered no longer leads anywhere useful (a sign-in
   * that failed). */
  clearLink(): void;
  /** Publishes a question and resolves with the answer the page posts, once `check` accepts it. */
  ask(question: NewQuestion, check: AnswerCheck): Promise<string>;
  /** The page's answer. Returns the message to show on the field, or undefined when accepted. */
  answer(id: string, value: string): string | undefined;
  /** FR-001: the phase before any step has run (Get started, Your choices). */
  setStage(stage: JourneyPhaseId): void;
  /** FR-001: the account and region, once the install knows them. */
  setPlace(place: { account: string; region: string }): void;
  /** FR-060: a failure in three parts, shown instead of the run going on. */
  showFailure(failure: WizardFailure): void;
  /** Drops the failure: the operator is trying again. */
  clearFailure(): void;
  finish(outcome: string, phase?: Exclude<WizardPhase, "running">, commands?: WizardCommand[]): void;
  /** The page asked to close (FR-002). */
  requestClose(): void;
  /** Resolves once the page has asked to close. */
  closeRequested(): Promise<void>;
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

/** The card without its link. Destructures out only `link`, so every other field (including one a
 * later spec adds) survives a refused link. */
function withoutLink(card: WizardCard): WizardCard {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
  const { link: _link, ...rest } = card;
  return rest;
}

export function createWizardHub(env: string, options: { now?: () => number; logPath?: string } = {}): WizardHub {
  const now = options.now ?? Date.now;
  let phase: WizardPhase = "running";
  let stage: JourneyPhaseId = "get-started";
  let steps: WizardStep[] = [];
  let header: WizardHeader = { installName: env };
  let question: WizardQuestion | undefined;
  let plan: string | undefined;
  let resume: WizardResume | undefined;
  let outcome: string | undefined;
  let cards: WizardCard[] = [];
  let link: WizardLink | undefined;
  let failure: WizardFailure | undefined;
  let commands: WizardCommand[] | undefined;
  const log: string[] = [];
  const listeners = new Set<WizardListener>();
  let pending: Pending | undefined;
  let closed = false;
  let closeWanted: () => void = () => undefined;
  const closeRequest = new Promise<void>((resolvePromise) => { closeWanted = resolvePromise; });

  // A question, a link, a waiting card or a failure: the operator has something to do before the
  // run goes on (FR-005). Once the run has ended there is nothing left to answer on the page.
  const waitingOnYou = (): boolean => phase === "running" && !closed
    && (question !== undefined || link !== undefined || failure !== undefined || cards.some((card) => card.status === "waiting"));

  const state = (): WizardState => {
    const waiting = waitingOnYou();
    const journey = journeyOf({
      stage,
      steps: steps.map((step) => ({ id: step.id, status: step.status, ...(step.startedAt === undefined ? {} : { startedAtMs: Date.parse(step.startedAt) }) })),
      // A paused run ended on a step that waits on someone: its phase says so, not Done.
      waitingOnYou: waiting || phase === "paused",
      stopped: failure !== undefined || phase === "failed",
      finished: phase === "finished",
      nowMs: now(),
    });
    return {
      env,
      phase,
      steps,
      header,
      journey,
      waitingOnYou: waiting,
      pageTitle: waiting ? ACTION_NEEDED_TITLE : `Install AgentX (step ${journey.stepNumber} of ${journey.stepCount})`,
      ...(stage === "get-started" && steps.every((step) => step.status === "pending") ? { welcome: welcomeLines() } : {}),
      ...(question === undefined ? {} : { question }),
      ...(plan === undefined ? {} : { plan }),
      ...(resume === undefined ? {} : { resume }),
      ...(cards.length === 0 ? {} : { cards }),
      ...(link === undefined ? {} : { link }),
      ...(failure === undefined ? {} : { failure }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(commands === undefined ? {} : { commands }),
      ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
    };
  };
  const publish = () => { const current = state(); for (const listener of listeners) listener.state(current); };
  const planFields = (id: InitStepId) => ({ phase: STEP_PLAN[id].phase, usualSeconds: STEP_PLAN[id].usualSeconds, usualText: usualText(STEP_PLAN[id].usualSeconds) });
  const changeStep = (id: InitStepId, title: string, change: Partial<Omit<WizardStep, "id">>) => {
    const known = steps.some((step) => step.id === id) ? steps : [...steps, { id, title, status: "pending" as const, ...planFields(id) }];
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
      steps = next.map((step) => ({ id: step.id, title: step.title, status: "pending", ...planFields(step.id) }));
      publish();
    },
    applyEvent(event) {
      // The link belonged to the step that just started or ended.
      link = undefined;
      const at = new Date(now()).toISOString();
      switch (event.kind) {
        case "step-skipped": return changeStep(event.id, event.title, { status: "skipped" });
        case "step-started": return changeStep(event.id, event.title, { status: "running", startedAt: at });
        case "step-done": {
          const started = steps.find((step) => step.id === event.id)?.startedAt;
          return changeStep(event.id, event.title, { status: "done", ...(started === undefined ? {} : { tookSeconds: Math.round((now() - Date.parse(started)) / 1000) }) });
        }
        case "step-waiting": return changeStep(event.id, event.title, { status: "waiting", message: event.message });
        case "step-failed": return changeStep(event.id, event.title, { status: "failed" });
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
      shown = shown.link === undefined ? shown : { ...shown, link: withNote(shown.link) };
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
      link = withNote(next);
      publish();
    },
    clearLink() {
      link = undefined;
      publish();
    },
    setStage(next) { stage = next; publish(); },
    setPlace(place) { header = { installName: env, account: place.account, region: place.region }; publish(); },
    showFailure(next) {
      if (next.link === undefined || isShowableLink(next.link.url)) {
        failure = next;
      } else {
        appendLog(LINK_REFUSED);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
        const { link: _link, ...rest } = next;
        failure = rest;
      }
      publish();
    },
    clearFailure() { failure = undefined; publish(); },
    requestClose() { closeWanted(); },
    closeRequested: () => closeRequest,
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
        pending = { ...waiting, question: publishQuestion(checked.retry ?? waiting.asked, checked.error) };
        return checked.error;
      }
      pending = undefined;
      question = undefined;
      publish();
      waiting.resolve(checked.value);
      return undefined;
    },
    finish(next, ended = "finished", continueWith) {
      phase = ended;
      outcome = next;
      question = undefined;
      commands = continueWith;
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
