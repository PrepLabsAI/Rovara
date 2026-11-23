// W1: what every GitHub request of a tracking sweep carries. The sweep runs each phase of a row (verify, feedback, reconcile) inside a context; the GitHub clients' fetch (`instrumentGithubFetch`) then
//   - ends a request when the phase ends (the phase's signal is joined into EVERY request, so a hung fetch cannot outlive its phase),
//   - gives a request that has no deadline of its own one (`GITHUB_REQUEST_TIMEOUT_MS`),
//   - logs one fixed-word line per request: method, a path TEMPLATE (no owner, repository, id, sha or token), status, milliseconds, GitHub's rate-limit headers,
//   - turns GitHub's rate-limit answer into the neutral rate-limit error (so no read swallows it as "unavailable"), and
//   - tells the sweep how much of the rate limit is left, so a background sweep can stop before it uses the quota the people's own actions need.
// Outside a context (a Merge press, a publish, a worker) nothing is logged and no rate-limit error is raised: those callers keep their own behaviour.
import { AsyncLocalStorage } from "node:async_hooks";

/** A request with no deadline of its own may take this long. */
export const GITHUB_REQUEST_TIMEOUT_MS = 8_000;

export interface GithubRateLimitState {
  /** Requests left in GitHub's window for the resource this answer counted against. */
  remaining: number;
  limit: number;
  /** When the window resets (milliseconds since the epoch). */
  resetAt: number;
}

export interface GithubRequestContext {
  /** Ends every request made inside the context. */
  signal?: AbortSignal;
  /** Receives one fixed-word entry per request. */
  log?: (entry: Record<string, unknown>) => void;
  /** Told after each answer that carries GitHub's rate-limit headers (the REST core resource only). */
  onRateLimit?: (state: GithubRateLimitState) => void;
}

const contexts = new AsyncLocalStorage<GithubRequestContext>();

/** Runs `work` so every GitHub request made inside it (at any depth of awaiting) carries `context`. */
export function withGithubRequestContext<T>(context: GithubRequestContext, work: () => Promise<T>): Promise<T> {
  return contexts.run(context, work);
}

export const githubRequestContext = (): GithubRequestContext | undefined => contexts.getStore();

// ---- the path template: fixed words only

const FIXED_WORDS: ReadonlySet<string> = new Set([
  "repos", "pulls", "issues", "comments", "reviews", "files", "commits", "compare", "git", "trees", "contents", "check-runs", "check-suites", "statuses", "status", "commit", "installation", "app", "installations",
  "access_tokens", "user", "graphql", "branches", "ref", "refs", "heads", "actions", "runs", "artifacts", "zip", "logs", "jobs", "deployments", "labels", "collaborators", "permission", "repositories",
  "requested_reviewers", "merge", "topics", "hooks", "deliveries", "attempts", "events", "rate_limit", "threads", "timeline", "reactions", "tags", "blobs", "rulesets", "protection", "teams", "members", "orgs", "users", "search",
]);

/** `/repos/acme/app/pulls/12/files?page=2` becomes `/repos/:owner/:repo/pulls/:id/files`; a host that is not GitHub's API is `other:/:redacted`. Never throws. */
export function pathTemplate(input: string | URL | Request): string {
  let url: URL;
  try { url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); } catch { return "invalid:/:redacted"; }
  if (url.hostname !== "api.github.com") return "other:/:redacted";
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const masked = parts.map((part, index) => {
    if (parts[index - 2] === "repos" && index >= 2) return ":repo";
    if (parts[index - 1] === "repos") return ":owner";
    return FIXED_WORDS.has(part) ? part : ":id";
  });
  return `/${masked.join("/")}`;
}

const pageOf = (input: string | URL | Request): number | undefined => {
  try {
    const page = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).searchParams.get("page");
    return page !== null && /^[0-9]{1,4}$/u.test(page) ? Number(page) : undefined;
  } catch { return undefined; }
};

const numberHeader = (response: Response, name: string): number | undefined => {
  const value = response.headers.get(name)?.trim();
  return value !== undefined && /^[0-9]{1,12}$/u.test(value) ? Number(value) : undefined;
};

/** GitHub's rate-limit headers on an answer, for the REST core resource only (another resource has its own window). */
export function rateLimitStateOf(response: Response): GithubRateLimitState | undefined {
  const resource = response.headers.get("x-ratelimit-resource");
  if (resource !== null && resource !== "core") return undefined;
  const remaining = numberHeader(response, "x-ratelimit-remaining"), limit = numberHeader(response, "x-ratelimit-limit"), reset = numberHeader(response, "x-ratelimit-reset");
  return remaining === undefined || limit === undefined || reset === undefined || limit === 0 ? undefined : { remaining, limit, resetAt: reset * 1_000 };
}

// ---- the fetch wrapper

const INSTRUMENTED = Symbol.for("agentx.github-fetch-instrumented");

/** Marks a fetch that already does this (a bounded provider's own), so a provider built over it does not count, log or time its requests twice. */
export function markGithubFetchInstrumented<F extends typeof fetch>(fetchImplementation: F): F {
  (fetchImplementation as unknown as Record<symbol, unknown>)[INSTRUMENTED] = true;
  return fetchImplementation;
}

export interface InstrumentOptions {
  /** The neutral rate-limit error for an answer that is GitHub's rate limit (undefined for every other answer). Raised only inside a context. */
  rateLimitError?: (response: Response, now: number) => Error | undefined;
  now?: () => number;
  /** Tests: the deadline of a request that has none. */
  timeoutMs?: number;
}

const errorClass = (error: unknown): string => error instanceof Error ? error.name : "unknown";

/** The signal of one request: its own deadline (or the default one) and the phase's signal, whichever ends first. */
function requestSignal(init: RequestInit | undefined, context: GithubRequestContext | undefined, options: InstrumentOptions): AbortSignal {
  const own = init?.signal ?? undefined;
  const signals = [own ?? AbortSignal.timeout(options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS), ...(context?.signal === undefined ? [] : [context.signal])];
  return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
}

/** Why a request ended without an answer, in fixed words. */
function failureOutcome(error: unknown, context: GithubRequestContext | undefined): string {
  if (context?.signal?.aborted === true) return "phase_ended";
  return errorClass(error) === "TimeoutError" ? "timeout" : "error";
}

/** Writes the request's timing line, when the context has a log. */
function logRequest(context: GithubRequestContext | undefined, input: string | URL | Request, method: string, ms: number, fields: Record<string, unknown>): void {
  if (context?.log === undefined) return;
  const page = pageOf(input);
  context.log({ component: "merge_tracking", event: "github.request", method, pathTemplate: pathTemplate(input), ms, ...(page === undefined ? {} : { page }), ...fields });
}

/** What a context does with an answer: it hears the rate limit, and a rate-limit answer becomes the neutral error. */
async function inspectAnswer(response: Response, state: GithubRateLimitState | undefined, context: GithubRequestContext, options: InstrumentOptions, at: number): Promise<void> {
  if (state !== undefined) context.onRateLimit?.(state);
  const limited = options.rateLimitError?.(response, at);
  if (limited !== undefined) { await response.body?.cancel().catch(() => undefined); throw limited; }
}

export function instrumentGithubFetch(inner: typeof fetch, options: InstrumentOptions = {}): typeof fetch {
  if ((inner as unknown as Record<symbol, unknown>)[INSTRUMENTED] === true) return inner;
  const now = options.now ?? Date.now;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const context = contexts.getStore();
    const signal = requestSignal(init, context, options);
    const startedAt = now();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const entry = (fields: Record<string, unknown>): void => logRequest(context, input, method, Math.max(0, now() - startedAt), fields);
    let response: Response;
    try {
      response = await inner(input, { ...init, signal });
    } catch (error) {
      entry({ status: 0, outcome: failureOutcome(error, context), error: errorClass(error) });
      throw error;
    }
    const state = rateLimitStateOf(response);
    entry({ status: response.status, outcome: "ok", ...(state === undefined ? {} : { remaining: state.remaining, limit: state.limit, resetAt: state.resetAt }) });
    if (context !== undefined) await inspectAnswer(response, state, context, options, now());
    return response;
  }) as typeof fetch;
  return markGithubFetchInstrumented(wrapped);
}
