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
  /** Every link the page offered, in the order the operator opened it. */
  clicked: string[];
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
  githubCode?: string;
  slackCode?: string;
}): SetupPageOperator {
  const queue = [...input.script];
  const asked: string[] = [];
  const clicked: string[] = [];
  const states: WizardSnapshot[] = [];
  const fieldErrors: string[] = [];
  const headers = { host: new URL(SETUP_ORIGIN).host, origin: SETUP_ORIGIN };
  const get = (path: string) => input.handle({ method: "GET", path, query: { [WIZARD_TOKEN_QUERY]: input.token }, headers });
  const post = (path: string, body: unknown) => input.handle({
    method: "POST", path, query: {}, headers: { ...headers, [WIZARD_TOKEN_HEADER]: input.token, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  /** What a person's browser does with a link the page offers: the GitHub App form is played back
   * as GitHub (a redirect to the page's callback with a code and the form's state); anything else
   * is only recorded. */
  const visit = async (url: string): Promise<void> => {
    // Add to Slack: Slack's page, played back as Slack (the install allowed, back to the callback).
    if (url.startsWith("https://slack.com/oauth/v2/authorize")) {
      const authorize = new URL(url);
      if (!(authorize.searchParams.get("redirect_uri") ?? "").startsWith(`${SETUP_ORIGIN}/slack/callback`)) throw new Error(`test setup: Add to Slack sends Slack back to ${authorize.searchParams.get("redirect_uri")}`);
      await input.handle({
        method: "GET", path: "/slack/callback", query: { code: input.slackCode ?? "slack-code-0123", state: authorize.searchParams.get("state") ?? "missing" },
        headers: { host: new URL(SETUP_ORIGIN).host, "sec-fetch-site": "cross-site", referer: "https://slack.com/" },
      });
      return;
    }
    if (!url.startsWith(`${SETUP_ORIGIN}/github/start`)) return;
    const form = await get("/github/start");
    if (form.status !== 200) throw new Error(`the setup page answered HTTP ${form.status} for /github/start`);
    const state = /[?&]amp;state=([a-f0-9]+)|[?&]state=([a-f0-9]+)/.exec(form.body);
    // GitHub's redirect is a cross-site visit with no token or session.
    await input.handle({
      method: "GET", path: "/github/created", query: { code: input.githubCode ?? "0123456789abcdef0123", state: state?.[1] ?? state?.[2] ?? "missing" },
      headers: { host: new URL(SETUP_ORIGIN).host, "sec-fetch-site": "cross-site", referer: "https://github.com/" },
    });
  };
  return {
    asked, clicked, states, fieldErrors,
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
        for (const link of [state.link, ...(state.cards ?? []).map((card) => card.link)]) {
          if (link === undefined || clicked.includes(link.url)) continue;
          clicked.push(link.url);
          await visit(link.url);
        }
        const question = state.question;
        if (question !== undefined && question.id !== answered) {
          if (question.error !== undefined) fieldErrors.push(question.error);
          count += 1;
          if (count > MAX_QUESTIONS) throw new Error(`test setup: the setup page asked more than ${MAX_QUESTIONS} questions`);
          const next = queue.shift();
          if (next === undefined) {
            const failure = state.failure === undefined ? "" : ` (the page shows a failure: ${state.failure.what} ${state.failure.details.join(" ")})`;
            throw new Error(`test setup: no scripted answer for "${question.text}"${failure}`);
          }
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
