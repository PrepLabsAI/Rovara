// `agentx init --ui`: the local install wizard, assembled. The hub holds the state, the server
// serves it on 127.0.0.1, and `browserPrompter` turns every question `agentx init` already asks
// into a field on the page.
//
// Nothing about what init does changes here. This module is injected through the seams init already
// has -- `Prompter`, `onEvent`, `write(line)` and `openBrowser(url)` -- so the terminal path and
// `--yes` are untouched.
import { agentXError } from "@agentx/contracts";
import type { InstallSurface, OpenManifestHost, OpenSlackInstallHost } from "../context.js";
import type { Prompter } from "../prompts.js";
import type { InitEvent } from "../steps.js";
import type { InitStepId } from "../install-state.js";
import { linkLabel } from "./cards.js";
import { minutesText, totalMinutes, type JourneyPhaseId } from "./journey.js";
import { browserPrompter } from "./prompter.js";
import type { WizardCommand, WizardFailure, WizardPhase, WizardPlan, WizardResume } from "./protocol.js";
import { startHubRelay } from "./relay.js";
import { GITHUB_CALLBACK_PATH, GITHUB_START_PATH, startWizardServer, type WizardServer } from "./server.js";
import { GITHUB_NONCE_PLACEHOLDER, type SetupStore } from "./setup-store.js";
import { createWizardHub, isShowableLink, type WizardHub } from "./state.js";

/** Q3: how long a question, or a page button, may wait with no page connected before the terminal
 * says where it is. */
export const PAGE_CLOSED_MS = 60_000;
const REMINDER_CHECK_MS = 5_000;
const PAGE_OPEN_GRACE_MS = 1_000;

export function pageClosedLine(url: string): string {
  return `The install page is closed. Open ${url} to continue, or press Ctrl-C to stop; agentx init continues from here next time.`;
}

/** Says once per wait, in the terminal, where to reopen a page that has been closed for a minute.
 * A wait is a question, or a run link with no question (the run waits on a page button: the GitHub
 * App's create button, the admin sign-in). `check` is called on a timer; tests call it directly. */
export function pageClosedReminder(input: { hub: WizardHub; url: string; write: (line: string) => void; now: () => number }): { check(): void } {
  let lastConnected = input.now();
  let reminded: string | undefined;
  return {
    check() {
      if (input.hub.connected() > 0) {
        lastConnected = input.now();
        return;
      }
      const state = input.hub.state();
      const waiting = state.question?.id ?? (state.link === undefined ? undefined : `link:${state.link.url}`);
      if (waiting === undefined || waiting === reminded) return;
      if (input.now() - lastConnected < PAGE_CLOSED_MS) return;
      reminded = waiting;
      input.write(pageClosedLine(input.url));
    },
  };
}

export interface InstallWizard {
  /** The loopback address the wizard was opened at, session token and all. */
  url: string;
  /** The session token alone (url already carries it in its query string). The page in the cloud
   * has none of its own here: its function holds it. */
  token?: string;
  /** Where the full log is, when the run was given one (FR-059, FR-070). */
  logPath?: string;
  prompter: Prompter;
  /** The page's cards, for the init context (context.surface). */
  surface: InstallSurface;
  /** Q5: the init context's openBrowser with --ui. The address becomes a button on the page, and
   * the operator opens it; nothing is opened on its own. True when the page shows it; false when
   * isShowableLink refuses it, so the step falls back to its terminal instructions. */
  openLink: (url: string) => Promise<boolean>;
  /** FR-030: the GitHub App's manifest form and GitHub's redirect, on the wizard's own address. */
  manifestHost: OpenManifestHost;
  /** Add to Slack: on the setup page only (Slack takes only https redirects). */
  slackInstallHost?: OpenSlackInstallHost;
  hub: WizardHub;
  /** One line for the log pane: the same line init writes to stderr. */
  log(line: string): void;
  event(event: InitEvent): void;
  /** The checklist, before any step has run. */
  setSteps(steps: ReadonlyArray<{ id: InitStepId; title: string }>): void;
  /** `confirmInstallPlan`'s priced plan, for the review screen (FR-005). */
  plan(plan: WizardPlan): void;
  /** What `readInstallProgress` already recorded, for the resume screen (FR-006). */
  resume(resume: WizardResume): void;
  /** FR-001: the phase before any step has run (Get started, Your choices). */
  setStage(stage: JourneyPhaseId): void;
  /** FR-001: the account and region, once the install knows them. */
  setPlace(place: { account: string; region: string }): void;
  /** Spec 048 FR-020: a Change answers (or a first settings submission) can rename the install;
   * the header follows it from then on. */
  setInstallName(name: string): void;
  /** FR-060: a failure in three parts, shown instead of the run going on. */
  showFailure(failure: WizardFailure): void;
  /** Drops the failure: the operator is trying again. */
  clearFailure(): void;
  finish(outcome: string, phase?: Exclude<WizardPhase, "running">, commands?: WizardCommand[]): void;
  /** Resolves once the page has asked to close (FR-002). */
  closeRequested(): Promise<void>;
  /** Ends the wizard with the run (FR-002). Safe to call more than once. */
  close(): Promise<void>;
}

export async function startInstallWizard(input: {
  env: string;
  /** One progress line to the terminal: where the wizard is, and whether a browser opened. */
  write: (line: string) => void;
  /** Absent with --no-browser. Never throws: false means the operator opens the address instead. */
  openBrowser?: (url: string) => Promise<boolean>;
  port?: number;
  token?: string;
  /** Where the full log is (Task 14), shown on the failure and Stop for now screens. */
  logPath?: string;
}): Promise<InstallWizard> {
  const hub = createWizardHub(input.env, { ...(input.logPath === undefined ? {} : { logPath: input.logPath }) });
  const server: WizardServer = await startWizardServer({
    hub,
    ...(input.port === undefined ? {} : { port: input.port }),
    ...(input.token === undefined ? {} : { token: input.token }),
  });
  const opened = input.openBrowser === undefined ? false : await input.openBrowser(server.url);
  if (opened) {
    // Opening a browser launches navigation; it does not mean the page has subscribed yet. Give
    // that first event stream a brief chance to connect so an immediate preflight failure is still
    // delivered to the page before the run closes its loopback server.
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolvePromise) => {
      timer = setTimeout(resolvePromise, PAGE_OPEN_GRACE_MS);
      timer.unref();
    });
    await Promise.race([hub.whenConnected(), grace]);
    if (timer !== undefined) clearTimeout(timer);
  }
  input.write(opened ? `The AgentX installer is open in your browser: ${server.url}` : `The AgentX installer is at ${server.url}`);
  if (!opened) {
    input.write(`Open that address in a browser on this machine. From another machine, first run: ssh -L ${server.port}:127.0.0.1:${server.port} <this host>`);
  }
  input.write(`Keep this terminal open and your computer awake (${minutesText(totalMinutes())}).`);
  if (input.logPath !== undefined) input.write(`Full log: ${input.logPath}`);
  const reminder = pageClosedReminder({ hub, url: server.url, write: input.write, now: Date.now });
  const timer = setInterval(() => reminder.check(), REMINDER_CHECK_MS);
  timer.unref();

  return wizardOn(hub, {
    url: server.url,
    token: server.token,
    ...(input.logPath === undefined ? {} : { logPath: input.logPath }),
    manifestHost: async (manifest) => server.mountManifest(manifest),
    async close() {
      clearInterval(timer);
      // The hub first: it sends the page its "closed" event over the streams the server then ends.
      hub.close();
      await server.close();
    },
  });
}

/** `agentx init --cloud`: the same wizard, with the page served by the setup page's function and
 * everything in between through the setup table (relay.ts). Nothing is served from this machine. */
export function startCloudInstallWizard(input: {
  env: string;
  store: SetupStore;
  /** The setup page's address, printed for the job's log. */
  url: string;
  write: (line: string) => void;
  logPath?: string;
  /** The relay's timers (tests make them short). */
  timing?: { stateWriteMs: number; pollMs: number };
}): InstallWizard {
  const hub = createWizardHub(input.env, { ...(input.logPath === undefined ? {} : { logPath: input.logPath }) });
  const relay = startHubRelay({ hub, store: input.store, warn: input.write, ...input.timing });
  input.write(`The AgentX installer is on its setup page: ${input.url}`);
  return wizardOn(hub, {
    url: input.url,
    ...(input.logPath === undefined ? {} : { logPath: input.logPath }),
    manifestHost: cloudManifestHost({ store: input.store, url: input.url, pollMs: input.timing?.pollMs ?? GITHUB_CODE_POLL_MS }),
    slackInstallHost: cloudSlackInstallHost({ store: input.store, pollMs: input.timing?.pollMs ?? GITHUB_CODE_POLL_MS }),
    async close() {
      hub.close();
      await relay.stop();
    },
  });
}

const GITHUB_CODE_POLL_MS = 2_000;

/** FR-030 in the cloud: the GitHub App's form is served by the setup page, from the table, and
 * GitHub's redirect back lands there too. The job waits for the code as long as the step lets it
 * (no 15-minute limit: the person may come back to the page much later). */
export function cloudManifestHost(input: { store: SetupStore; url: string; pollMs: number }): OpenManifestHost {
  return async ({ state, page }) => {
    const redirectUrl = `${input.url}${GITHUB_CALLBACK_PATH}`;
    await input.store.putGitHubManifest({ state, html: page(redirectUrl, GITHUB_NONCE_PLACEHOLDER) });
    let closed = false;
    const code = (async () => {
      for (;;) {
        if (closed) throw agentXError("OPERATION_INTERRUPTED", "the GitHub app step ended before GitHub sent its code");
        const sent = await input.store.takeGitHubCode(state);
        if (sent !== undefined) return sent;
        await new Promise((resolve) => setTimeout(resolve, input.pollMs));
      }
    })();
    // A step that ends another way never reads it: nothing is left unhandled.
    code.catch(() => undefined);
    return {
      port: 0, startUrl: `${input.url}${GITHUB_START_PATH}`, redirectUrl, code,
      close() {
        closed = true;
        void input.store.deleteGitHubManifest().catch(() => undefined);
      },
    };
  };
}

/** Add to Slack: Slack's redirect back lands on the setup page, which hands the code to this run
 * through the table. Waits as long as the step allows. */
export function cloudSlackInstallHost(input: { store: SetupStore; pollMs: number }): OpenSlackInstallHost {
  return async ({ state, timeoutMs }) => {
    await input.store.putSlackInstall(state);
    let closed = false;
    const started = Date.now();
    const code = (async () => {
      for (;;) {
        if (closed) throw agentXError("OPERATION_INTERRUPTED", "the Slack app step ended before Slack sent its install");
        const sent = await input.store.takeSlackCode(state);
        if (sent !== undefined) return sent;
        if (Date.now() - started > timeoutMs) {
          throw agentXError("OPERATION_INTERRUPTED", `the Slack app was not added within ${Math.round(timeoutMs / 60_000)} minutes; press Add to Slack, then try this step again`);
        }
        await new Promise((resolve) => setTimeout(resolve, input.pollMs));
      }
    })();
    code.catch(() => undefined);
    return {
      code,
      close() {
        closed = true;
        void input.store.deleteSlackInstall().catch(() => undefined);
      },
    };
  };
}

/** The wizard around a hub, whichever way its page is served. */
function wizardOn(hub: WizardHub, transport: {
  url: string; token?: string; logPath?: string; manifestHost: OpenManifestHost; slackInstallHost?: OpenSlackInstallHost; close(): Promise<void>;
}): InstallWizard {
  let closed = false;
  return {
    url: transport.url,
    ...(transport.token === undefined ? {} : { token: transport.token }),
    ...(transport.logPath === undefined ? {} : { logPath: transport.logPath }),
    hub,
    prompter: browserPrompter(hub),
    surface: { card: (card) => hub.showCard(card), clearLink: () => hub.clearLink() },
    openLink: async (url) => {
      hub.showLink({ url, label: linkLabel(url) });
      // A refused address is not on the page, so no one can open it: say so, as a browser that
      // would not open does.
      return isShowableLink(url);
    },
    manifestHost: transport.manifestHost,
    ...(transport.slackInstallHost === undefined ? {} : { slackInstallHost: transport.slackInstallHost }),
    log: (line) => hub.log(line),
    event: (event) => hub.applyEvent(event),
    setSteps: (steps) => hub.setSteps(steps),
    plan: (plan) => hub.showPlan(plan),
    resume: (resume) => hub.showResume(resume),
    setStage: (stage) => hub.setStage(stage),
    setPlace: (place) => hub.setPlace(place),
    setInstallName: (name) => hub.setInstallName(name),
    showFailure: (failure) => hub.showFailure(failure),
    clearFailure: () => hub.clearFailure(),
    closeRequested: () => hub.closeRequested(),
    finish: (outcome, phase, commands) => hub.finish(outcome, phase, commands),
    async close() {
      if (closed) return;
      closed = true;
      await transport.close();
    },
  };
}

export { browserPrompter } from "./prompter.js";
export { createWizardHub } from "./state.js";
export { startWizardServer } from "./server.js";
