// A headless operator for the install page in the cloud: what a person's browser does on the setup
// page, played against the page's handler with no HTTP in between. It polls GET /state as the page
// does, answers each new question from a script in the order it is asked, and stops when the
// state says the installer has closed. The job on the other side runs `agentx init --setup-table`
// with the same store.
import { WIZARD_TOKEN_HEADER, WIZARD_TOKEN_QUERY, type AnswerReply, type WizardSnapshot } from "../../packages/cli/src/init/ui/protocol.js";
import type { SetupRequest, SetupResponse, SetupStateReply } from "../../packages/cli/src/init/ui/setup-handler.js";
import type { ScriptedAnswer } from "./init-fakes.js";

const MAX_QUESTIONS = 80;
const POLL_MS = 5;

export const SETUP_ORIGIN = "https://setup.example.com";

export interface SetupPageOperator {
  asked: string[];
  states: WizardSnapshot[];
  fieldErrors: string[];
  /** Polls until the installer closes, answering as it goes; rethrows what stopped it. */
  run(): Promise<void>;
  remaining(): number;
}

export function setupPageOperator(input: {
  script: ScriptedAnswer[];
  handle: (request: SetupRequest) => Promise<SetupResponse>;
  token: string;
}): SetupPageOperator {
  const queue = [...input.script];
  const asked: string[] = [];
  const states: WizardSnapshot[] = [];
  const fieldErrors: string[] = [];
  const headers = { host: new URL(SETUP_ORIGIN).host, origin: SETUP_ORIGIN };
  const get = (path: string) => input.handle({ method: "GET", path, query: { [WIZARD_TOKEN_QUERY]: input.token }, headers });
  const post = (path: string, body: unknown) => input.handle({
    method: "POST", path, query: {}, headers: { ...headers, [WIZARD_TOKEN_HEADER]: input.token, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return {
    asked, states, fieldErrors,
    remaining: () => queue.length,
    async run() {
      let answered: string | undefined;
      let count = 0;
      for (;;) {
        const response = await get("/state");
        if (response.status !== 200) throw new Error(`the setup page answered HTTP ${response.status} for /state`);
        const state = JSON.parse(response.body) as SetupStateReply;
        states.push(state);
        if (state.installerClosed) return;
        const question = state.question;
        if (question !== undefined && question.id !== answered) {
          if (question.error !== undefined) fieldErrors.push(question.error);
          count += 1;
          if (count > MAX_QUESTIONS) throw new Error(`test setup: the setup page asked more than ${MAX_QUESTIONS} questions`);
          const next = queue.shift();
          if (next === undefined) throw new Error(`test setup: no scripted answer for "${question.text}"`);
          asked.push(question.text);
          answered = question.id;
          const value = typeof next === "boolean" ? (next ? "yes" : "no") : next;
          const reply = JSON.parse((await post("/answer", { id: question.id, value })).body) as AnswerReply;
          if (!reply.ok) fieldErrors.push(reply.error);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
  };
}
