// A headless operator for `agentx init --ui`: the browser the wizard opens, played by fetch. It
// reads the wizard's state, answers each question from a script in the order it is asked, and
// stops when the run does. Nothing here reaches AWS, GitHub or Slack; it also plays GitHub for the
// manifest listener, the way browserThatCreatesGitHubApp does.
import { WIZARD_TOKEN_HEADER, WIZARD_TOKEN_QUERY, type AnswerReply, type WizardSnapshot } from "../../packages/cli/src/init/ui/protocol.js";
import type { ScriptedAnswer } from "./init-fakes.js";

/** A run that asks more than this many questions is a loop, not an install: the driver gives up so
 * the test fails on its own timeout rather than answering forever. */
const MAX_QUESTIONS = 80;

export interface WizardOperator {
  /** The `openBrowser` seam `agentx init` calls; a property, so it can be passed on unbound. */
  open: (url: string) => Promise<boolean>;
  /** Every address the run asked a browser to open. */
  opened: string[];
  /** Every question the page showed, in order. */
  asked: string[];
  /** Every state the page saw, oldest first. */
  states: WizardSnapshot[];
  /** Every inline field error the page was shown. */
  fieldErrors: string[];
  /** Waits for the driver to stop, and rethrows whatever stopped it. */
  settled(): Promise<void>;
  remaining(): number;
}

export function fakeWizardOperator(script: ScriptedAnswer[], options: { githubCode?: string } = {}): WizardOperator {
  const queue = [...script];
  const opened: string[] = [];
  const asked: string[] = [];
  const states: WizardSnapshot[] = [];
  const fieldErrors: string[] = [];
  let driving: Promise<void> = Promise.resolve();
  let failure: unknown;

  /** Reads the page's own event stream, so the driver sees every state the page would, in order
   * and with no polling race against the end of the run. */
  const drive = async (wizardUrl: string): Promise<void> => {
    const { origin, searchParams } = new URL(wizardUrl);
    const token = searchParams.get(WIZARD_TOKEN_QUERY) ?? "";
    const headers = { [WIZARD_TOKEN_HEADER]: token };
    let log: string[] = [];
    let answered: string | undefined;
    let count = 0;

    const onState = async (state: Omit<WizardSnapshot, "log">): Promise<void> => {
      states.push({ ...state, log: [...log] });
      const question = state.question;
      if (question === undefined || question.id === answered) return;
      if (question.error !== undefined) fieldErrors.push(question.error);
      count += 1;
      if (count > MAX_QUESTIONS) throw new Error(`test setup: the wizard asked more than ${MAX_QUESTIONS} questions`);
      const next = queue.shift();
      if (next === undefined) throw new Error(`test setup: no scripted answer for "${question.text}"`);
      if (question.kind === "confirm" && typeof next !== "boolean") throw new Error(`test setup: "${question.text}" wants true or false`);
      if (question.kind !== "confirm" && typeof next !== "string") throw new Error(`test setup: "${question.text}" wants text`);
      asked.push(question.text);
      answered = question.id;
      const value = typeof next === "boolean" ? (next ? "yes" : "no") : next;
      const reply = (await (await fetch(`${origin}/answer`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ id: question.id, value }),
      })).json()) as AnswerReply;
      // A refusal comes back as a fresh question carrying the message; the next state answers that one.
      if (!reply.ok) fieldErrors.push(reply.error);
    };

    const response = await fetch(`${origin}/events`, { headers });
    if (!response.ok) throw new Error(`the wizard answered HTTP ${response.status} for /events`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      // The run ending closes the listener under the reader; that is how this loop is meant to stop.
      const chunk = await reader.read().then((value) => value, () => undefined);
      if (chunk === undefined || chunk.done) return;
      buffered += decoder.decode(chunk.value, { stream: true });
      let split = buffered.indexOf("\n\n");
      for (; split !== -1; split = buffered.indexOf("\n\n")) {
        const frame = buffered.slice(0, split);
        buffered = buffered.slice(split + 2);
        const name = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (name === "closed") return;
        if (name === "log" && data !== undefined) log.push(JSON.parse(data) as string);
        if ((name === "snapshot" || name === "state") && data !== undefined) {
          const parsed = JSON.parse(data) as WizardSnapshot;
          if (name === "snapshot") log = [...parsed.log];
          await onState(parsed);
        }
      }
    }
  };

  return {
    opened,
    asked,
    states,
    fieldErrors,
    remaining: () => queue.length,
    async settled() {
      await driving;
      if (failure !== undefined) throw failure instanceof Error ? failure : new Error(JSON.stringify(failure));
    },
    async open(url) {
      opened.push(url);
      if (url.includes("/github/start")) {
        // GitHub, played back: read the pre-filled form and redirect to the listener with a code.
        const page = await (await fetch(url)).text();
        const state = /[?&]state=([a-f0-9]+)/.exec(page)?.[1];
        await fetch(`${url.replace("/github/start", "/github/created")}?code=${options.githubCode ?? "0123456789abcdef0123"}&state=${state ?? "missing"}`);
        return true;
      }
      if (url.startsWith("http://127.0.0.1:") && new URL(url).searchParams.has(WIZARD_TOKEN_QUERY)) {
        driving = drive(url).catch((error: unknown) => { failure = error; });
      }
      return true;
    },
  };
}
