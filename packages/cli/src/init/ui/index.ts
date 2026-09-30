// `agentx init --ui`: the local install wizard, assembled. The hub holds the state, the server
// serves it on 127.0.0.1, and `browserPrompter` turns every question `agentx init` already asks
// into a field on the page.
//
// Nothing about what init does changes here. This module is injected through the seams init already
// has -- `Prompter`, `onEvent`, `write(line)` and `openBrowser(url)` -- so the terminal path and
// `--yes` are untouched.
import type { InstallSurface, OpenManifestHost } from "../context.js";
import type { Prompter } from "../prompts.js";
import type { InitEvent } from "../steps.js";
import type { InitStepId } from "../install-state.js";
import { linkLabel } from "./cards.js";
import { browserPrompter } from "./prompter.js";
import type { WizardPhase, WizardResume } from "./protocol.js";
import { startWizardServer, type WizardServer } from "./server.js";
import { createWizardHub, type WizardHub } from "./state.js";

export interface InstallWizard {
  /** The loopback address the wizard was opened at, session token and all. */
  url: string;
  prompter: Prompter;
  /** The page's cards, for the init context (context.surface). */
  surface: InstallSurface;
  /** Q5: the init context's openBrowser with --ui. The address becomes a button on the page, and
   * the operator opens it; nothing is opened on its own. Always true: the page shows it. */
  openLink: (url: string) => Promise<boolean>;
  /** FR-030: the GitHub App's manifest form and GitHub's redirect, on the wizard's own address. */
  manifestHost: OpenManifestHost;
  hub: WizardHub;
  /** One line for the log pane: the same line init writes to stderr. */
  log(line: string): void;
  event(event: InitEvent): void;
  /** The checklist, before any step has run. */
  setSteps(steps: ReadonlyArray<{ id: InitStepId; title: string }>): void;
  /** `confirmInstallPlan`'s priced plan, for the review screen (FR-005). */
  plan(text: string): void;
  /** What `readInstallProgress` already recorded, for the resume screen (FR-006). */
  resume(resume: WizardResume): void;
  finish(outcome: string, phase?: Exclude<WizardPhase, "running">): void;
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
}): Promise<InstallWizard> {
  const hub = createWizardHub(input.env);
  const server: WizardServer = await startWizardServer({
    hub,
    ...(input.port === undefined ? {} : { port: input.port }),
    ...(input.token === undefined ? {} : { token: input.token }),
  });
  input.write(`The AgentX installer is at ${server.url}`);
  const opened = input.openBrowser === undefined ? false : await input.openBrowser(server.url);
  if (!opened) {
    input.write(`Open that address in a browser on this machine to continue. From another machine, first run: ssh -L ${server.port}:127.0.0.1:${server.port} <this host>`);
  }
  input.write("Every question agentx init asks is on that page; nothing else needs typing here.");

  let closed = false;
  return {
    url: server.url,
    hub,
    prompter: browserPrompter(hub),
    surface: { card: (card) => hub.showCard(card) },
    openLink: async (url) => {
      hub.showLink({ url, label: linkLabel(url) });
      return true;
    },
    manifestHost: async (input) => server.mountManifest(input),
    log: (line) => hub.log(line),
    event: (event) => hub.applyEvent(event),
    setSteps: (steps) => hub.setSteps(steps),
    plan: (text) => hub.showPlan(text),
    resume: (resume) => hub.showResume(resume),
    finish: (outcome, phase) => hub.finish(outcome, phase),
    async close() {
      if (closed) return;
      closed = true;
      // The hub first: it sends the page its "closed" event over the streams the server then ends.
      hub.close();
      await server.close();
    },
  };
}

export { browserPrompter } from "./prompter.js";
export { createWizardHub } from "./state.js";
export { startWizardServer } from "./server.js";
