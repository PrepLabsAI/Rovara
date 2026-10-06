// The page's side of the install page in the cloud: the same page the local server serves, for a
// request handler with no state of its own (the setup page's Lambda function). Everything it knows
// is in the setup table the job's relay writes. Nothing here is HTTP-library specific, so the
// Lambda function, the local dev server (scripts/setup-page-dev.ts) and the tests all call it the
// same way.
//
// It differs from the local server in three ways: the page polls GET /state instead of holding an
// event stream open (API Gateway closes those); an answer goes to the table and the reply waits a
// few seconds for the job's verdict; and the GitHub App's manifest flow is not here yet.
import { randomBytes } from "node:crypto";
import type { AnswerReply, AnswerRequest } from "./protocol.js";
import { WIZARD_TOKEN_HEADER, WIZARD_TOKEN_QUERY } from "./protocol.js";
import { WIZARD_CSS, WIZARD_JS, wizardHtml } from "./page.js";
import { CALLBACK_HEADERS, CALLBACK_PAGE, GITHUB_CALLBACK_PATH, GITHUB_START_PATH, manifestFormCsp, MAX_BODY_BYTES, refusalReason, SECURITY_HEADERS, SLACK_CALLBACK_PATH, tokensMatch } from "./server.js";
import { finishSignIn, SETUP_CALLBACK_PATH, SETUP_LOGIN_PATH, signedInSession, startSignIn, type SetupIdentity, type TokenSeal } from "./setup-auth.js";
import { GITHUB_NONCE_PLACEHOLDER, type SetupStore } from "./setup-store.js";
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
export interface SetupResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Set-Cookie values, one cookie each. */
  cookies?: string[];
}

/** GET /state's reply: the page's snapshot, and whether the run is over. */
export type SetupStateReply = ReturnType<ReturnType<typeof createWizardHub>["snapshot"]> & { installerClosed: boolean };

const reply = (status: number, type: string, body: string): SetupResponse => ({ status, headers: { ...SECURITY_HEADERS, "content-type": type }, body });
const json = (body: unknown, status = 200) => reply(status, "application/json; charset=utf-8", JSON.stringify(body));

/** How the page knows who may use it. "token": the local page's session token in its address (the
 * dev server, scripts/setup-page-dev.ts). "cognito": the identity stack's hosted sign-in, an
 * administrator only, then a session cookie (the setup page's function). */
export type SetupPageAuth =
  | { kind: "token"; token: string }
  | {
    kind: "cognito";
    /** The identity stack's sign-in, or undefined until that stack is up (the first few minutes). */
    identity: () => Promise<SetupIdentity | undefined>;
    seal: TokenSeal;
    fetch?: typeof fetch;
  };

/** What the page shows before the identity stack is up: there is no sign-in to send anyone to yet. */
export const SETTING_UP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Install AgentX</title></head>
<body><h1>Install AgentX</h1>
<p>AgentX is still setting up sign-in in your AWS account. This takes about five minutes from when the stack was created.</p>
<p>When it is ready, you get an email with your temporary password. This page reloads by itself.</p></body></html>`;

export function setupPageHandler(input: {
  store: SetupStore;
  env: string;
  /** The page's own origin, such as https://abc.execute-api.us-east-1.amazonaws.com. */
  origin: string;
  auth: SetupPageAuth;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  verdictWaitMs?: number;
}): (request: SetupRequest) => Promise<SetupResponse> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const { auth } = input;
  // The page's own token in its address; signed-in pages carry none (their cookie identifies them).
  const pageToken = auth.kind === "token" ? auth.token : "";
  const expectedHost = new URL(input.origin).host;

  /** Why the request is refused, or undefined. */
  const refused = async (request: SetupRequest): Promise<SetupResponse | undefined> => {
    if (auth.kind === "token") {
      const refusal = refusalReason({
        host: request.headers.host, origin: request.headers.origin, referer: request.headers.referer, secFetchSite: request.headers["sec-fetch-site"],
        token: request.method === "GET" ? request.query[WIZARD_TOKEN_QUERY] : request.headers[WIZARD_TOKEN_HEADER],
        expectedOrigin: input.origin, expectedToken: auth.token,
      });
      return refusal === undefined ? undefined : reply(refusal.status, "text/plain; charset=utf-8", `${refusal.reason}\n`);
    }
    if (request.headers.host !== expectedHost) return reply(403, "text/plain; charset=utf-8", "wrong Host\n");
    // A visit (GET) may come from anywhere: the invitation email's link, the hosted sign-in's
    // redirect. Anything that changes something (POST) must come from the page itself.
    if (request.method !== "GET") {
      const site = request.headers["sec-fetch-site"];
      if (request.headers.origin !== input.origin || (site !== undefined && site !== "same-origin")) {
        return reply(403, "text/plain; charset=utf-8", "cross-site request\n");
      }
    }
    return undefined;
  };

  return async (request) => {
    // GitHub's redirect back after it made the App: a cross-site visit with no token or session,
    // let through only with the state of the form the job is waiting on, once (as the local
    // server's own callback is).
    if (request.method === "GET" && request.path === GITHUB_CALLBACK_PATH) {
      if (request.headers.host !== expectedHost) return reply(403, "text/plain; charset=utf-8", "wrong Host\n");
      return githubCallback(input.store, request.query);
    }
    // Slack's redirect back after Add to Slack: the same rule, with the state of the install the
    // job is waiting on.
    if (request.method === "GET" && request.path === SLACK_CALLBACK_PATH) {
      if (request.headers.host !== expectedHost) return reply(403, "text/plain; charset=utf-8", "wrong Host\n");
      return slackCallback(input.store, request.query);
    }
    const refusal = await refused(request);
    if (refusal !== undefined) return refusal;

    if (auth.kind === "cognito") {
      const identity = await auth.identity();
      if (request.method === "GET" && request.path === SETUP_LOGIN_PATH) {
        if (identity === undefined) return reply(200, "text/html; charset=utf-8", SETTING_UP_HTML);
        const started = startSignIn({ identity, origin: input.origin });
        return redirect(started.location, [started.setCookie]);
      }
      if (request.method === "GET" && request.path === SETUP_CALLBACK_PATH) {
        if (identity === undefined) return reply(200, "text/html; charset=utf-8", SETTING_UP_HTML);
        const outcome = await finishSignIn({
          identity, origin: input.origin, query: request.query, cookieHeader: request.headers.cookie,
          store: input.store, seal: auth.seal, fetch: auth.fetch ?? fetch, now,
        });
        return outcome.ok ? redirect("/", outcome.setCookies) : reply(outcome.status, "text/plain; charset=utf-8", `${outcome.reason}\n`);
      }
      if (await signedInSession(input.store, request.headers.cookie) === undefined) {
        if (request.method === "GET" && (request.path === "/" || request.path === "/index.html")) {
          return identity === undefined ? reply(200, "text/html; charset=utf-8", SETTING_UP_HTML) : redirect(SETUP_LOGIN_PATH, []);
        }
        return reply(401, "text/plain; charset=utf-8", "sign in first\n");
      }
    }

    if (request.method === "GET" && (request.path === "/" || request.path === "/index.html")) {
      return reply(200, "text/html; charset=utf-8", wizardHtml(pageToken, { poll: true }));
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
    if (request.method === "GET" && request.path === GITHUB_START_PATH) {
      const manifest = await input.store.getGitHubManifest();
      if (manifest === undefined) return reply(404, "text/plain; charset=utf-8", "There is no GitHub app to create right now. Go back to the setup page.\n");
      const nonce = randomBytes(16).toString("base64");
      return {
        status: 200,
        headers: { ...SECURITY_HEADERS, "content-security-policy": manifestFormCsp(nonce), "content-type": "text/html; charset=utf-8" },
        body: manifest.html.replaceAll(GITHUB_NONCE_PLACEHOLDER, nonce),
      };
    }
    if (request.method === "POST" && request.path === "/close") {
      await input.store.requestClose();
      return json({ ok: true } satisfies AnswerReply);
    }
    return reply(404, "text/plain; charset=utf-8", "not found\n");
  };
}

async function githubCallback(store: SetupStore, query: Record<string, string | undefined>): Promise<SetupResponse> {
  const answer = (status: number, text: string): SetupResponse => ({
    status, headers: { ...CALLBACK_HEADERS, "content-type": "text/html; charset=utf-8" }, body: CALLBACK_PAGE(text),
  });
  const manifest = await store.getGitHubManifest();
  if (manifest === undefined || !tokensMatch(query.state, manifest.state)) {
    return answer(400, "This page is from another AgentX install, or its GitHub app was already created. Go back to the setup page.");
  }
  if (query.code === undefined || query.code === "") return answer(400, "GitHub sent no code. Go back to the setup page.");
  await store.putGitHubCode(manifest.state, query.code);
  await store.deleteGitHubManifest();
  // GitHub has not converted the code yet; the setup page says whether that worked.
  return answer(200, "GitHub sent AgentX the new app. You can close this tab and go back to the setup page.");
}

async function slackCallback(store: SetupStore, query: Record<string, string | undefined>): Promise<SetupResponse> {
  const answer = (status: number, text: string): SetupResponse => ({
    status, headers: { ...CALLBACK_HEADERS, "content-type": "text/html; charset=utf-8" }, body: CALLBACK_PAGE(text),
  });
  const state = await store.getSlackInstall();
  if (state === undefined || !tokensMatch(query.state, state)) {
    return answer(400, "This page is from another AgentX install, or its Slack app was already added. Go back to the setup page.");
  }
  // Cancel, or Request to Install in a workspace that needs an admin's approval: nothing to take
  // yet, and the setup page still offers Add to Slack. Slack's own word, never echoed raw.
  if (query.error !== undefined) {
    const reason = /^[a-z_]{1,40}$/.test(query.error) ? query.error : "an error";
    return answer(400, `Slack did not add the app (${reason}). Go back to the setup page; once you may, press Add to Slack again.`);
  }
  if (query.code === undefined || query.code === "") return answer(400, "Slack sent no code. Go back to the setup page.");
  await store.putSlackCode(state, query.code);
  await store.deleteSlackInstall();
  return answer(200, "Slack sent AgentX the app's install. You can close this tab and go back to the setup page.");
}

/** A redirect, with each cookie in its own Set-Cookie (the Lambda adapter sends them as a list). */
function redirect(location: string, setCookies: string[]): SetupResponse {
  return { status: 302, headers: { ...SECURITY_HEADERS, location }, body: "", ...(setCookies.length === 0 ? {} : { cookies: setCookies }) };
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
