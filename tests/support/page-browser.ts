// A browser tab on the task page, for the end-to-end tests: the page the broker's real route renders for a signed-in
// reader, parsed into the small fake DOM, with both of the page's scripts running in a vm sandbox. The scripts' fetch
// calls go to the same broker handler, as the browser would send them: the review session cookie, the CSRF cookie the
// broker last set, the page's own Origin, and whatever headers the script adds. Timers run only when the test advances
// the tab's clock, so a poll happens exactly when the test says.
import { createHash, randomUUID } from "node:crypto";
import vm from "node:vm";
import { DEV_ISSUER, type Developer } from "./developer-task-broker.js";
import { fakeStorage, parseHtml, type FakeDocument, type FakeElement } from "./fake-dom.js";
import type { Handler } from "./slack-broker.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";

/** The page's origin: the API answers a POST only from here. */
export const PAGE_ORIGIN = new URL(DEV_ISSUER).origin;

export interface PageReader { developerId: string; name: string; slackUserId?: string; provider?: "slack" | "oidc" }

export interface BrowserRequest { path: string; method: string; headers: Record<string, string>; body?: unknown; status: number; answer: unknown }

/** What the e2e harness gives the tab: the broker, its table and the task's ID. */
export interface PageHost { db: FakeDynamoDb; handler: Handler; taskId(): string }

/** A review session for `reader` (and their developer record, when the table has none yet); answers the session ID. */
export function signInToReview(host: PageHost, reader: PageReader): string {
  const sessionId = uuidFrom(`review-session\0${reader.developerId}`);
  const now = Math.floor(Date.now() / 1000);
  host.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: reader.developerId, amr: reader.provider ?? "slack",
    startedAt: new Date().toISOString(), endsAt: now + 604_800, reviewExpiresAt: now + 604_800 });
  if (host.db.get(`DEVELOPER#${reader.developerId}`, "META") === undefined) {
    host.db.set({ pk: `DEVELOPER#${reader.developerId}`, sk: "META", developerId: reader.developerId, provider: reader.provider ?? "slack", displayName: reader.name,
      ...(reader.slackUserId === undefined ? {} : { slackUserId: reader.slackUserId }), firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  }
  return sessionId;
}

const uuidFrom = (seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** A cookie jar for one reader: the session, and the CSRF cookie as the broker last set it. */
class Jar {
  csrf: string | undefined;
  constructor(readonly sessionId: string) {}
  header(): string { return `__Host-agentx_review_session=${this.sessionId}${this.csrf === undefined ? "" : `; __Host-agentx_review_csrf=${this.csrf}`}`; }
  take(headers: Record<string, string | undefined> | undefined): void {
    const set = headers?.["set-cookie"] ?? headers?.["Set-Cookie"];
    const match = set === undefined ? null : /__Host-agentx_review_csrf=([^;]*)/.exec(set);
    if (match !== null) this.csrf = match[1];
  }
}

/** The page's HTML as the broker serves it to `reader` at `search` ("?doc=coding-plan", say). Sets the jar's CSRF cookie. */
async function fetchPage(host: PageHost, jar: Jar, search: string): Promise<{ status: number; body: string; headers: Record<string, string | undefined> }> {
  const response = await host.handler({
    version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${host.taskId()}/task`, rawQueryString: search.replace(/^\?/, ""),
    headers: { cookie: jar.header() }, requestContext: { requestId: randomUUID(), http: { method: "GET" } },
  }) as { statusCode: number; body: string; headers?: Record<string, string | undefined> };
  jar.take(response.headers);
  return { status: response.statusCode, body: response.body, headers: response.headers ?? {} };
}

/** The nonce in the response's content-security-policy script-src, if it names one. */
function cspNonce(headers: Record<string, string | undefined>): string | undefined {
  const policy = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-security-policy")?.[1];
  return policy === undefined ? undefined : /script-src[^;]*'nonce-([^']+)'/.exec(policy)?.[1];
}

/**
 * Opens the task page in a new tab as `reader`. With `scripts: false` the tab is the page with JavaScript off: the HTML
 * only. `storage` is the tab's sessionStorage.
 */
export async function openTaskPage(host: PageHost, reader: PageReader | Developer, options: { search?: string; scripts?: boolean; storage?: ReturnType<typeof fakeStorage> } = {}) {
  const who: PageReader = "provider" in reader && (reader.provider === "slack" || reader.provider === "oidc")
    ? { developerId: reader.developerId, name: reader.name, provider: reader.provider, ...(reader.slackUserId === undefined ? {} : { slackUserId: reader.slackUserId }) }
    : reader;
  const jar = new Jar(signInToReview(host, who));
  const page = await fetchPage(host, jar, options.search ?? "");
  const document: FakeDocument = parseHtml(page.body);
  // As a browser does: only what carries the nonce the response's content-security-policy names runs or applies.
  const nonce = cspNonce(page.headers);
  const storage = options.storage ?? fakeStorage();
  const requests: BrowserRequest[] = [];
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  const clock = { now: Date.now() };
  const reloads: number[] = [];
  let timerId = 0;
  const inFlight = new Set<Promise<unknown>>();

  const send = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const target = new URL(url, `${PAGE_ORIGIN}/review/${host.taskId()}/task`);
    const method = (init.method ?? "GET").toUpperCase();
    // The browser adds the cookies, and an Origin on every POST; the script adds the rest.
    const headers: Record<string, string> = { ...(init.headers ?? {}), cookie: jar.header(), ...(method === "GET" ? {} : { origin: PAGE_ORIGIN }) };
    const response = await host.handler({
      version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: target.pathname, rawQueryString: target.search.replace(/^\?/, ""), headers,
      ...(init.body === undefined ? {} : { body: init.body }), isBase64Encoded: false,
      requestContext: { requestId: randomUUID(), http: { method } },
    }) as { statusCode: number; body: string; headers?: Record<string, string | undefined> };
    jar.take(response.headers);
    let answer: unknown = {};
    try { answer = JSON.parse(response.body); } catch { answer = {}; }
    requests.push({ path: target.pathname, method, headers, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }), status: response.statusCode, answer });
    return { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, json: async () => answer };
  };

  if (options.scripts !== false) {
    const sandbox: Record<string, unknown> = {
      document,
      location: { hash: "", search: options.search ?? "", pathname: `/review/${host.taskId()}/task`, reload: () => { reloads.push(clock.now); } },
      setTimeout: (fn: unknown, ms: number) => {
        if (typeof fn !== "function") throw new Error("string timers are not allowed");
        timerId += 1;
        timers.push({ fn: fn as () => void, at: clock.now + ms, id: timerId });
        return timerId;
      },
      clearTimeout: (handle: number) => { const index = timers.findIndex((timer) => timer.id === handle); if (index >= 0) timers.splice(index, 1); },
      setInterval: () => 0, clearInterval: () => undefined,
      // `new Date()` is the tab's own clock; given arguments it is an ordinary Date.
      Date: Object.assign(function PageDate(...args: unknown[]) { return args.length === 0 ? new Date(clock.now) : new Date(...(args as [string])); }, { now: () => clock.now }),
      crypto: { randomUUID },
      fetch: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        const answer = send(url, init);
        inFlight.add(answer);
        void answer.finally(() => inFlight.delete(answer));
        return answer;
      },
      decodeURIComponent, encodeURIComponent,
    };
    sandbox.window = { addEventListener: () => undefined, sessionStorage: storage };
    sandbox.sessionStorage = storage;
    for (const script of document.querySelectorAll("script")) {
      if (nonce !== undefined && script.getAttribute("nonce") === nonce) vm.runInNewContext(script.textContent, sandbox);
    }
  }

  /** The page's style elements that carry the response's nonce (the only ones a browser applies). */
  const styles = () => document.querySelectorAll("style").filter((style) => nonce !== undefined && style.getAttribute("nonce") === nonce);

  /** Lets every request the scripts started reach the broker and its answer reach the page. */
  const settle = async () => {
    for (let round = 0; round < 50; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      else if (round > 4) break;
    }
  };
  /** Moves the tab's clock on by `ms`, running each timer that falls due (the poll, say). */
  const advance = async (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      timers.sort((left, right) => left.at - right.at);
      const next = timers[0];
      if (next === undefined || next.at > until) break;
      timers.shift();
      clock.now = next.at;
      next.fn();
      await settle();
    }
    clock.now = until;
  };
  const byId = (name: string): FakeElement => {
    const found = document.getElementById(name);
    if (found === null) throw new Error(`the page has no #${name}`);
    return found;
  };
  const button = (within: FakeElement, text: string): FakeElement => {
    const found = within.querySelectorAll("button").find((entry) => entry.textContent === text && !entry.hidden);
    if (found === undefined) throw new Error(`no visible "${text}" button here`);
    return found;
  };
  /** Opens the Comment form on `target` ("claim:2.1", "document"), types `text`, ticks Ask AgentX when asked, and posts it. */
  const comment = async (target: string, text: string, commentOptions: { ask?: boolean } = {}) => {
    const open = document.querySelector(`.comment-open[data-target="${target}"]`);
    if (open === null || open.hidden) throw new Error(`no Comment control on ${target}`);
    open.click();
    const form = document.querySelector(`[data-comments="${target}"] .comment-form`);
    if (form === null) throw new Error(`no comment form opened on ${target}`);
    form.querySelector("textarea")!.type_(text);
    const ask = form.querySelector("input[type=checkbox]");
    if (ask !== null && ask.checked !== (commentOptions.ask === true)) ask.click();
    button(form, "Post").click();
    await settle();
    return form;
  };
  return {
    /** A request made from this tab outside the page's scripts (the browser's cookies and Origin, nothing else). */
    fetch: send,
    status: page.status, html: page.body, nonce, styles, document, storage, requests, clock, reloads, jar, settle, advance, byId, button, comment,
    /** The page as it is now, as a person reads it. */
    text: () => readable(document.body),
  };
}
/** What a reader sees of `element`: its visible text, leaving out scripts, styles, the page's data and a closed dialog. */
export function readable(element: FakeElement): string {
  if (element.hidden || ["script", "style", "template"].includes(element.localName) || (element.localName === "dialog" && !element.open)) return "";
  return element.childNodes.map((node) => "localName" in node ? ` ${readable(node)} ` : node.textContent).join("").replace(/\s+/g, " ").trim();
}
export type TaskPageTab = Awaited<ReturnType<typeof openTaskPage>>;
