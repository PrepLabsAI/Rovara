import { expect, it } from "vitest";
import { HostRateLimitError, hostRateLimitRetryAt } from "@agentx/contracts";
import { GITHUB_REQUEST_TIMEOUT_MS, instrumentGithubFetch, pathTemplate, withGithubRequestContext } from "../../packages/broker/src/plugins/code-host/github/request-context.js";
import { GithubMergeRateLimitError, mergeRateLimitRetryAt } from "../../packages/broker/src/plugins/code-host/github/client.js";

const SECRET_PATH = "https://api.github.com/repos/acme-secret-org/private-app/pulls/4242/files?page=3&per_page=100";

/** A fetch that never answers until its signal ends it (what a hung GitHub request does). */
const hanging = (): typeof fetch => (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
});

const answer = (status: number, headers: Record<string, string> = {}): typeof fetch => async () => new Response("{}", { status, headers });

it("names a request by a template with no owner, repository, id, sha or token", () => {
  expect(pathTemplate(SECRET_PATH)).toBe("/repos/:owner/:repo/pulls/:id/files");
  expect(pathTemplate(`https://api.github.com/repos/acme/app/git/trees/${"a".repeat(40)}?recursive=1`)).toBe("/repos/:owner/:repo/git/trees/:id");
  expect(pathTemplate("https://api.github.com/app/installations/987654/access_tokens")).toBe("/app/installations/:id/access_tokens");
  expect(pathTemplate("https://pipelines.example.test/logs/abc?token=SECRET")).toBe("other:/:redacted");
  expect(pathTemplate("not a url")).toBe("invalid:/:redacted");
  for (const text of [SECRET_PATH, `https://api.github.com/repos/pulls/issues/pulls/9`]) {
    const template = pathTemplate(text);
    expect(template).not.toMatch(/acme-secret-org|private-app|4242|[0-9]{3}/u);
  }
});

it("ends a request that has no deadline of its own (a hung fetch cannot outlive its timeout)", async () => {
  const fetchImplementation = instrumentGithubFetch(hanging(), { timeoutMs: 30 });
  const started = Date.now();
  await expect(fetchImplementation(SECRET_PATH)).rejects.toMatchObject({ name: "TimeoutError" });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(8_000);
});

it("ends an in-flight request when the phase's signal ends, even one with a longer deadline of its own", async () => {
  const fetchImplementation = instrumentGithubFetch(hanging());
  const phase = new AbortController();
  const entries: Array<Record<string, unknown>> = [];
  const request = withGithubRequestContext({ signal: phase.signal, log: (entry) => entries.push(entry), onRateLimit: () => undefined },
    () => fetchImplementation(SECRET_PATH, { signal: AbortSignal.timeout(60_000) }));
  setTimeout(() => phase.abort(), 20);
  await expect(request).rejects.toBeDefined();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ event: "github.request", method: "GET", pathTemplate: "/repos/:owner/:repo/pulls/:id/files", status: 0, outcome: "phase_ended", page: 3 });
});

it("logs one fixed-word line per request with the method, template, status, milliseconds and rate-limit headers, and nothing else", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const fetchImplementation = instrumentGithubFetch(answer(200, { "x-ratelimit-remaining": "4800", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(reset) }));
  const entries: Array<Record<string, unknown>> = [];
  const seen: unknown[] = [];
  await withGithubRequestContext({ log: (entry) => entries.push(entry), onRateLimit: (state) => seen.push(state) }, () => fetchImplementation(SECRET_PATH, { method: "post" }));
  expect(entries).toEqual([{ component: "merge_tracking", event: "github.request", method: "POST", pathTemplate: "/repos/:owner/:repo/pulls/:id/files", ms: expect.any(Number) as number, page: 3, status: 200, outcome: "ok", remaining: 4800, limit: 5000, resetAt: reset * 1000 }]);
  expect(JSON.stringify(entries)).not.toMatch(/acme-secret-org|private-app|4242/u);
  expect(seen).toEqual([{ remaining: 4800, limit: 5000, resetAt: reset * 1000 }]);
});

it("reports only the core resource's window", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const fetchImplementation = instrumentGithubFetch(answer(200, { "x-ratelimit-remaining": "3", "x-ratelimit-limit": "30", "x-ratelimit-reset": String(reset), "x-ratelimit-resource": "search" }));
  const seen: unknown[] = [];
  await withGithubRequestContext({ onRateLimit: (state) => seen.push(state) }, () => fetchImplementation(SECRET_PATH));
  expect(seen).toEqual([]);
});

it("inside a context, GitHub's rate-limit answer becomes the neutral rate-limit error with the time of X-RateLimit-Reset; outside, the answer is returned as it was", async () => {
  const now = Date.now();
  const reset = Math.floor(now / 1000) + 900;
  const limited = answer(403, { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(reset) });
  const fetchImplementation = instrumentGithubFetch(limited, { rateLimitError: (response, at) => { const retryAt = mergeRateLimitRetryAt(response, at); return retryAt === undefined ? undefined : new GithubMergeRateLimitError(retryAt); } });
  const error = await withGithubRequestContext({ log: () => undefined }, () => fetchImplementation(SECRET_PATH)).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HostRateLimitError);
  expect(hostRateLimitRetryAt(error)).toBe(reset * 1000);
  // A 403 for lack of access is not a rate limit.
  const forbidden = instrumentGithubFetch(answer(403), { rateLimitError: (response, at) => { const retryAt = mergeRateLimitRetryAt(response, at); return retryAt === undefined ? undefined : new GithubMergeRateLimitError(retryAt); } });
  expect((await withGithubRequestContext({ log: () => undefined }, () => forbidden(SECRET_PATH))).status).toBe(403);
  expect((await fetchImplementation(SECRET_PATH)).status).toBe(403);
});

it("logs nothing outside a context and wraps a fetch once", async () => {
  const calls: string[] = [];
  const inner = (async () => { calls.push("inner"); return new Response("{}"); }) as typeof fetch;
  const once = instrumentGithubFetch(inner);
  expect(instrumentGithubFetch(once)).toBe(once);
  await once(SECRET_PATH);
  expect(calls).toEqual(["inner"]);
});
