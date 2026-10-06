// The page's side of the install page in the cloud: the same page the local server serves, for a
// request handler with no state of its own (the setup page's Lambda function). Everything it knows
// is in the setup table the job's relay writes. Nothing here is HTTP-library specific, so the
// Lambda function, the local dev server (scripts/setup-page-dev.ts) and the tests all call it the
// same way.
//
// It differs from the local server in three ways: the page polls GET /state instead of holding an
// event stream open (API Gateway closes those); an answer goes to the table and the reply waits a
// few seconds for the job's verdict; and the GitHub App's manifest flow is not here yet.
import type { AnswerReply, AnswerRequest } from "./protocol.js";
import { WIZARD_TOKEN_HEADER, WIZARD_TOKEN_QUERY } from "./protocol.js";
import { WIZARD_CSS, WIZARD_JS, wizardHtml } from "./page.js";
import { MAX_BODY_BYTES, refusalReason, SECURITY_HEADERS } from "./server.js";
import type { SetupStore } from "./setup-store.js";
import { createWizardHub } from "./state.js";

/** How long POST /answer waits for the job's verdict before replying that the answer was sent. */
export const VERDICT_WAIT_MS = 8_000;
const VERDICT_POLL_MS = 250;

export interface SetupRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  /** Lower-case names. */
  headers: Record<string, string | undefined>;
  body?: string;
}
export interface SetupResponse { status: number; headers: Record<string, string>; body: string }

/** GET /state's reply: the page's snapshot, and whether the run is over. */
export type SetupStateReply = ReturnType<ReturnType<typeof createWizardHub>["snapshot"]> & { installerClosed: boolean };

const reply = (status: number, type: string, body: string): SetupResponse => ({ status, headers: { ...SECURITY_HEADERS, "content-type": type }, body });
const json = (body: unknown, status = 200) => reply(status, "application/json; charset=utf-8", JSON.stringify(body));

export function setupPageHandler(input: {
  store: SetupStore;
  env: string;
  /** The page's own origin, such as https://abc.execute-api.us-east-1.amazonaws.com. */
  origin: string;
  token: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  verdictWaitMs?: number;
}): (request: SetupRequest) => Promise<SetupResponse> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  return async (request) => {
    const refusal = refusalReason({
      host: request.headers.host, origin: request.headers.origin, referer: request.headers.referer, secFetchSite: request.headers["sec-fetch-site"],
      token: request.method === "GET" ? request.query[WIZARD_TOKEN_QUERY] : request.headers[WIZARD_TOKEN_HEADER],
      expectedOrigin: input.origin, expectedToken: input.token,
    });
    if (refusal !== undefined) return reply(refusal.status, "text/plain; charset=utf-8", `${refusal.reason}\n`);

    if (request.method === "GET" && (request.path === "/" || request.path === "/index.html")) {
      return reply(200, "text/html; charset=utf-8", wizardHtml(input.token, { poll: true }));
    }
    if (request.method === "GET" && request.path === "/app.css") return reply(200, "text/css; charset=utf-8", WIZARD_CSS);
    if (request.method === "GET" && request.path === "/app.js") return reply(200, "text/javascript; charset=utf-8", WIZARD_JS);
    if (request.method === "GET" && request.path === "/state") {
      const stored = await input.store.getState();
      // Before the job has written anything, the page shows what a new install's page shows.
      const snapshot = stored?.snapshot ?? createWizardHub(input.env).snapshot();
      return json({ ...snapshot, installerClosed: stored?.closed === true } satisfies SetupStateReply);
    }
    if (request.method === "POST" && request.path === "/answer") {
      const parsed = parseAnswer(request.body);
      if (parsed === undefined) return json({ ok: false, error: "the answer could not be read" } satisfies AnswerReply, 400);
      const key = await input.store.putAnswer(parsed.id, parsed.value);
      const deadline = now() + (input.verdictWaitMs ?? VERDICT_WAIT_MS);
      while (now() < deadline) {
        const verdict = await input.store.takeVerdict(key);
        if (verdict !== undefined) return json(verdict);
        await sleep(VERDICT_POLL_MS);
      }
      // The job has not read it yet; it will. The page sees the outcome in the state it polls.
      return json({ ok: true } satisfies AnswerReply);
    }
    if (request.method === "POST" && request.path === "/close") {
      await input.store.requestClose();
      return json({ ok: true } satisfies AnswerReply);
    }
    return reply(404, "text/plain; charset=utf-8", "not found\n");
  };
}

function parseAnswer(body: string | undefined): AnswerRequest | undefined {
  if (body === undefined || Buffer.byteLength(body) > MAX_BODY_BYTES) return undefined;
  try {
    const value = JSON.parse(body) as Partial<AnswerRequest>;
    return typeof value.id === "string" && typeof value.value === "string" ? { id: value.id, value: value.value } : undefined;
  } catch {
    return undefined;
  }
}
