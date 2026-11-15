// TE-E0 option A, slice A2: the GitHub reads behind the customer's pipeline evidence. One check run's times and run attempt (never guessed), the latest run of a named check on the base commit or the
// main branch (check runs, then commit statuses; bound to the commit asked), and the check names seen on recent pull requests for the setup screen. Read-only, with the permissions the App already asks,
// bounded, and an answer that does not fit is "not known", never "passed".
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GITHUB_ACTIONS_APP_ID, IMPLICIT_COMPANY_ID, type Check } from "@agentx/contracts";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { githubActionsCheckRunner } from "../../packages/broker/src/plugins/check-runner/github-actions/index.js";
import {
  RUN_ATTEMPT_MAX, SEEN_CHECKS_MAX, addSeenCheckNames, latestCheckRunOf, latestStatusOf, parseCheckRunFacts, recentPullRequestHeads, type SeenCheckName,
} from "../../packages/broker/src/github-check-facts.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ORG = { orgId: IMPLICIT_COMPANY_ID };
const REPO = "https://github.com/acme/svc";
const T = (minute: number) => `2026-11-15T10:${String(minute).padStart(2, "0")}:00Z`;

const run = (over: Record<string, unknown> = {}) => ({ id: 7, name: "e2e-real", status: "completed", conclusion: "success", head_sha: SHA_A, app: { id: GITHUB_ACTIONS_APP_ID }, html_url: "https://github.com/acme/svc/runs/7", started_at: T(0), completed_at: T(40), ...over });

describe("parsing one run's facts", () => {
  it("reads times and an Actions job's attempt and run", () => {
    expect(parseCheckRunFacts(run(), { id: 7, run_attempt: 2, run_id: 99 }, "7")).toEqual({ startedAt: T(0), completedAt: T(40), attempt: 2, workflowRunId: "99" });
  });
  it("refuses an answer for another run, and ignores a job answer for another job", () => {
    expect(parseCheckRunFacts(run({ id: 8 }), undefined, "7")).toBeUndefined();
    expect(parseCheckRunFacts(run(), { id: 8, run_attempt: 2 }, "7")).toEqual({ startedAt: T(0), completedAt: T(40) });
  });
  it.each([0, -1, 1.5, RUN_ATTEMPT_MAX + 1, "2", null])("never believes a run attempt of %s", (attempt) => {
    expect(parseCheckRunFacts(run(), { id: 7, run_attempt: attempt }, "7")?.attempt).toBeUndefined();
  });
  it("drops times that are not times, and a finish before the start", () => {
    expect(parseCheckRunFacts(run({ started_at: "yesterday", completed_at: 5 }), undefined, "7")).toEqual({});
    expect(parseCheckRunFacts(run({ started_at: T(40), completed_at: T(0) }), undefined, "7")).toEqual({ startedAt: T(40) });
  });
});

describe("the latest run of a named check", () => {
  it("matches the name exactly and the app when one is named", () => {
    const list = { check_runs: [run({ name: "e2e-real-2" }), run({ id: 9, app: { id: 5 } })] };
    expect(latestCheckRunOf(list, { name: "e2e-real" })?.check.jobId).toBe("9");
    expect(latestCheckRunOf(list, { name: "e2e-real", appId: GITHUB_ACTIONS_APP_ID })).toBeUndefined();
    expect(latestCheckRunOf(list, { name: "E2E-real" })).toBeUndefined();
  });
  it("binds to the commit asked: a run on another commit is not this one's", () => {
    expect(latestCheckRunOf({ check_runs: [run({ head_sha: SHA_B })] }, { name: "e2e-real", expectedSha: SHA_A })).toBeUndefined();
    expect(latestCheckRunOf({ check_runs: [run()] }, { name: "e2e-real", expectedSha: SHA_A })?.headSha).toBe(SHA_A);
  });
  it("takes the newest start, and a failure on a tie", () => {
    const older = run({ id: 1, conclusion: "failure", started_at: T(0) });
    const newer = run({ id: 2, conclusion: "success", started_at: T(30) });
    expect(latestCheckRunOf({ check_runs: [older, newer] }, { name: "e2e-real" })?.check.jobId).toBe("2");
    const tieA = run({ id: 3, conclusion: "success", started_at: T(5) });
    const tieB = run({ id: 4, conclusion: "failure", started_at: T(5) });
    expect(latestCheckRunOf({ check_runs: [tieA, tieB] }, { name: "e2e-real" })?.check).toMatchObject({ jobId: "4", conclusion: "failure" });
    expect(latestCheckRunOf({ check_runs: [run({ status: "in_progress", conclusion: null })] }, { name: "e2e-real" })?.check).toMatchObject({ status: "pending" });
  });
  it.each([
    ["no list", {}],
    ["a run that is not an object", { check_runs: [5] }],
    ["an unknown conclusion", { check_runs: [run({ conclusion: "maybe" })] }],
    ["a bad head", { check_runs: [run({ head_sha: "x" })] }],
    ["a list cut at a page (the check could be on the next)", { total_count: 140, check_runs: [run({ name: "other" })] }],
  ])("throws on %s (not known, never passed)", (_label, list) => {
    expect(() => latestCheckRunOf(list, { name: "e2e-real" })).toThrow();
  });
  it("reads commit statuses, which never match a mark that names an app", () => {
    const combined = { sha: SHA_A, statuses: [{ context: "jenkins/e2e", state: "failure", target_url: "https://ci.example/job/1" }, { context: "other", state: "success" }] };
    expect(latestStatusOf(combined, { name: "jenkins/e2e" })).toEqual({ headSha: SHA_A, check: { name: "jenkins/e2e", status: "completed", conclusion: "failure", required: false, url: "https://ci.example/job/1" } });
    expect(latestStatusOf(combined, { name: "jenkins/e2e", appId: 5 })).toBeUndefined();
    expect(latestStatusOf(combined, { name: "jenkins/e2e", expectedSha: SHA_B })).toBeUndefined();
    expect(latestStatusOf({ sha: SHA_A, statuses: [{ context: "x", state: "pending" }] }, { name: "x" })?.check.status).toBe("pending");
    expect(() => latestStatusOf({ sha: SHA_A, statuses: [{ context: "x", state: "weird" }] }, { name: "x" })).toThrow();
    expect(() => latestStatusOf({ statuses: [] }, { name: "x" })).toThrow();
  });
});

describe("check names for setup", () => {
  it("collects distinct names by app, skips what does not parse, and stops at the cap", () => {
    const seen = new Map<string, SeenCheckName>();
    expect(addSeenCheckNames(seen, { check_runs: [run(), run(), run({ app: { id: 5 } }), { name: 7 }, "x"] }, { statuses: [{ context: "jenkins/e2e" }, { context: "" }] })).toBe(false);
    expect([...seen.values()]).toEqual([{ name: "e2e-real", source: String(GITHUB_ACTIONS_APP_ID) }, { name: "e2e-real", source: "5" }, { name: "jenkins/e2e" }]);
    const many = new Map<string, SeenCheckName>();
    expect(addSeenCheckNames(many, { check_runs: Array.from({ length: 100 }, (_, index) => run({ name: `c${String(index)}` })) }, { statuses: Array.from({ length: 100 }, (_, index) => ({ context: `s${String(index)}` })) })).toBe(false);
    expect(many.size).toBe(SEEN_CHECKS_MAX);
    expect(addSeenCheckNames(new Map(), { total_count: 1, check_runs: [run()] }, { statuses: [] })).toBe(true);
    expect(addSeenCheckNames(new Map(), { total_count: 150, check_runs: [run()] }, { statuses: [] })).toBe(false);
    expect(addSeenCheckNames(new Map(), undefined, { statuses: [] })).toBe(false);
  });
  it("takes full-sha heads only, distinct, bounded", () => {
    expect(recentPullRequestHeads([{ head: { sha: SHA_A } }, { head: { sha: SHA_A } }, { head: { sha: "short" } }, { head: { sha: SHA_B } }, { head: { sha: "c".repeat(40) } }], 4)).toEqual([SHA_A, SHA_B]);
    expect(recentPullRequestHeads({ not: "a list" }, 5)).toEqual([]);
  });
});

/** A client over a fake GitHub that answers the installation and token calls, records each request and its token's permissions, and serves `routes` by path. */
function fakeClient(routes: Record<string, (url: URL) => Response>, options: { refuseActionsToken?: boolean } = {}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const requests: Array<{ path: string; search: string; redirect: string | undefined; signal: boolean }> = [];
  const mints: Array<Record<string, string>> = [];
  const client = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => pem, now: () => Date.parse(T(0)),
    fetchImplementation: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (/^\/repos\/[^/]+\/[^/]+\/installation$/u.test(url.pathname)) return new Response(JSON.stringify({ id: 1, account: { login: "acme" } }), { status: 200 });
      if (url.pathname.endsWith("/access_tokens")) {
        const permissions = (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { permissions?: Record<string, string> }).permissions ?? {};
        mints.push(permissions);
        if (options.refuseActionsToken === true && permissions["actions"] !== undefined) return new Response(JSON.stringify({ message: "denied" }), { status: 422 });
        return new Response(JSON.stringify({ token: "fake-token", expires_at: "2026-11-15T11:00:00Z" }), { status: 201 });
      }
      requests.push({ path: url.pathname, search: url.search, redirect: init?.redirect, signal: init?.signal !== undefined });
      const route = Object.entries(routes).find(([path]) => url.pathname === path);
      return route === undefined ? new Response("{}", { status: 404 }) : route[1](url);
    }),
  });
  return { client, requests, mints };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

describe("the client's reads", () => {
  it("reads a run's times and its attempt, with read-only tokens and no redirect", async () => {
    const { client, requests, mints } = fakeClient({ "/repos/acme/svc/check-runs/7": json(run()), "/repos/acme/svc/actions/jobs/7": json({ id: 7, run_attempt: 3, run_id: 42 }) });
    expect(await client.getCheckRunFacts(REPO, "7", ORG, undefined, { actionsJob: true })).toEqual({ startedAt: T(0), completedAt: T(40), attempt: 3, workflowRunId: "42" });
    expect(requests.every((request) => request.redirect === "error" && request.signal)).toBe(true);
    expect(mints.every((permissions) => Object.values(permissions).every((level) => level === "read"))).toBe(true);
  });
  it("gives no attempt when the Actions token is refused or the job is gone, and none for a non-Actions run", async () => {
    const refused = fakeClient({ "/repos/acme/svc/check-runs/7": json(run()) }, { refuseActionsToken: true });
    expect((await refused.client.getCheckRunFacts(REPO, "7", ORG, undefined, { actionsJob: true }))?.attempt).toBeUndefined();
    const gone = fakeClient({ "/repos/acme/svc/check-runs/7": json(run()) });
    expect((await gone.client.getCheckRunFacts(REPO, "7", ORG, undefined, { actionsJob: true }))?.attempt).toBeUndefined();
    const other = fakeClient({ "/repos/acme/svc/check-runs/7": json(run()), "/repos/acme/svc/actions/jobs/7": json({ id: 7, run_attempt: 3 }) });
    expect((await other.client.getCheckRunFacts(REPO, "7", ORG))?.attempt).toBeUndefined();
    expect(other.requests.some((request) => request.path.includes("/actions/jobs/"))).toBe(false);
  });
  it("refuses a bad run id before any request, and says not found for a run GitHub does not have", async () => {
    const { client, requests } = fakeClient({});
    await expect(client.getCheckRunFacts(REPO, "../7", ORG)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(requests).toEqual([]);
    expect(await client.getCheckRunFacts(REPO, "7", ORG)).toBeUndefined();
  });
  it("fails a check run read GitHub fails, and a job read GitHub fails", async () => {
    const failing = fakeClient({ "/repos/acme/svc/check-runs/7": json({}, 500) });
    await expect(failing.client.getCheckRunFacts(REPO, "7", ORG)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const jobFailing = fakeClient({ "/repos/acme/svc/check-runs/7": json(run()), "/repos/acme/svc/actions/jobs/7": json({}, 500) });
    await expect(jobFailing.client.getCheckRunFacts(REPO, "7", ORG, undefined, { actionsJob: true })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("finds the latest run on the base commit by name, then falls back to commit statuses", async () => {
    const runs = fakeClient({ [`/repos/acme/svc/commits/${SHA_A}/check-runs`]: json({ check_runs: [run({ conclusion: "failure" })] }) });
    expect(await runs.client.getLatestCheckRun(REPO, { revision: SHA_A }, { name: "e2e-real" }, ORG)).toMatchObject({ headSha: SHA_A, check: { conclusion: "failure", jobId: "7" } });
    expect(runs.requests[0]?.search).toContain("check_name=e2e-real");
    const statuses = fakeClient({
      [`/repos/acme/svc/commits/${SHA_A}/check-runs`]: json({ check_runs: [] }),
      [`/repos/acme/svc/commits/${SHA_A}/status`]: json({ sha: SHA_A, statuses: [{ context: "jenkins/e2e", state: "success" }] }),
    });
    expect(await statuses.client.getLatestCheckRun(REPO, { revision: SHA_A }, { name: "jenkins/e2e" }, ORG)).toMatchObject({ check: { name: "jenkins/e2e", conclusion: "success" } });
    // A mark that names an app never falls back to statuses (a status has no app).
    const named = fakeClient({ [`/repos/acme/svc/commits/${SHA_A}/check-runs`]: json({ check_runs: [] }) });
    expect(await named.client.getLatestCheckRun(REPO, { revision: SHA_A }, { name: "jenkins/e2e", appId: 5 }, ORG)).toBeUndefined();
    expect(named.requests.some((request) => request.path.endsWith("/status"))).toBe(false);
  });
  it("reads a branch at one commit: its head once, then that commit's runs and statuses", async () => {
    const { client, requests } = fakeClient({
      "/repos/acme/svc/branches/release/2026": json({ name: "release/2026", commit: { sha: SHA_B } }),
      [`/repos/acme/svc/commits/${SHA_B}/check-runs`]: json({ check_runs: [run({ head_sha: SHA_B })] }),
    });
    expect((await client.getLatestCheckRun(REPO, { branch: "release/2026" }, { name: "e2e-real" }, ORG))?.headSha).toBe(SHA_B);
    expect(requests.map((request) => request.path)).toEqual(["/repos/acme/svc/branches/release/2026", `/repos/acme/svc/commits/${SHA_B}/check-runs`]);
    const moved = fakeClient({
      "/repos/acme/svc/branches/main": json({ commit: { sha: SHA_B } }),
      [`/repos/acme/svc/commits/${SHA_B}/check-runs`]: json({ check_runs: [run({ head_sha: SHA_A })] }),
      [`/repos/acme/svc/commits/${SHA_B}/status`]: json({ sha: SHA_B, statuses: [] }),
    });
    expect(await moved.client.getLatestCheckRun(REPO, { branch: "main" }, { name: "e2e-real" }, ORG)).toBeUndefined();
    const gone = fakeClient({});
    expect(await gone.client.getLatestCheckRun(REPO, { branch: "main" }, { name: "e2e-real" }, ORG)).toBeUndefined();
    const odd = fakeClient({ "/repos/acme/svc/branches/main": json({ commit: { sha: "nope" } }) });
    await expect(odd.client.getLatestCheckRun(REPO, { branch: "main" }, { name: "e2e-real" }, ORG)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
  it("reads each answer to a byte cap: a larger one is not known, never cut", async () => {
    const huge = () => new Response(JSON.stringify({ check_runs: [run({ output: { text: "x".repeat(3 * 1024 * 1024) } })] }), { status: 200 });
    const { client } = fakeClient({ [`/repos/acme/svc/commits/${SHA_A}/check-runs`]: huge, "/repos/acme/svc/check-runs/7": huge });
    await expect(client.getLatestCheckRun(REPO, { revision: SHA_A }, { name: "e2e-real" }, ORG)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(client.getCheckRunFacts(REPO, "7", ORG)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
  it("refuses bad inputs before any request, and an unreadable answer as not known", async () => {
    const { client, requests } = fakeClient({ [`/repos/acme/svc/commits/${SHA_A}/check-runs`]: json({ check_runs: [run({ conclusion: "maybe" })] }) });
    await expect(client.getLatestCheckRun(REPO, { revision: "abc" }, { name: "e2e-real" }, ORG)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(client.getLatestCheckRun(REPO, { branch: "../x" }, { name: "e2e-real" }, ORG)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(client.getLatestCheckRun(REPO, { revision: SHA_A }, { name: "e2e\nreal" }, ORG)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(requests).toEqual([]);
    await expect(client.getLatestCheckRun(REPO, { revision: SHA_A }, { name: "e2e-real" }, ORG)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const missing = fakeClient({ [`/repos/acme/svc/commits/${SHA_A}/check-runs`]: json({ message: "No commit found" }, 422) });
    expect(await missing.client.getLatestCheckRun(REPO, { revision: SHA_A }, { name: "e2e-real" }, ORG)).toBeUndefined();
  });

  it("lists check names from the five most recent pull requests' heads in at most eleven requests", async () => {
    const heads = Array.from({ length: 8 }, (_, index) => String.fromCharCode(97 + index).repeat(40));
    const routes: Record<string, (url: URL) => Response> = { "/repos/acme/svc/pulls": json(heads.map((sha) => ({ head: { sha } }))) };
    for (const sha of heads) {
      routes[`/repos/acme/svc/commits/${sha}/check-runs`] = json({ check_runs: [run({ name: `job-${sha.slice(0, 1)}` })] });
      routes[`/repos/acme/svc/commits/${sha}/status`] = json({ sha, statuses: [{ context: "jenkins/e2e", state: "success" }] });
    }
    const { client, requests } = fakeClient(routes);
    const listed = await client.listSeenCheckNames(REPO, ORG);
    expect(listed.complete).toBe(true);
    expect(listed.checks.map((entry) => entry.name)).toEqual(["jenkins/e2e", "job-a", "job-b", "job-c", "job-d", "job-e"]);
    expect(requests.length).toBeLessThanOrEqual(11);
    expect(requests[0]?.search).toContain("per_page=5");
  });
});

describe("an incomplete setup listing says so", () => {
  it("is incomplete, not empty-and-sure, when every head's checks fail to read", async () => {
    const { client } = fakeClient({ "/repos/acme/svc/pulls": json([{ head: { sha: SHA_A } }, { head: { sha: SHA_B } }]) });
    expect(await client.listSeenCheckNames(REPO, ORG)).toEqual({ checks: [], complete: false });
  });
});

describe("the GitHub Actions check runner's reads", () => {
  const check = (over: Partial<Check> = {}): Check => ({ name: "e2e-real", state: "completed", conclusion: "success", required: false, url: "", runId: "7", source: String(GITHUB_ACTIONS_APP_ID), ...over });
  const target = { kind: "revision" as const, repository: { url: REPO }, revision: SHA_A };
  const base = { getPullRequestStatus: async () => { throw new Error("unused"); }, getJobLogTail: async () => undefined };
  it("offers each read only when the client has it", () => {
    const runner = githubActionsCheckRunner(base);
    expect(Object.keys(runner).filter((key) => ["runFacts", "latestCheck", "seenChecks"].includes(key))).toEqual([]);
  });
  it("asks for the attempt only for an Actions job, and drops facts that do not fit the port", async () => {
    const asked: Array<boolean | undefined> = [];
    const runner = githubActionsCheckRunner({ ...base, getCheckRunFacts: async (_url, _id, _scope, _budget, options) => { asked.push(options?.actionsJob); return { attempt: 2 }; } });
    expect(await runner.runFacts!(target, check(), ORG)).toEqual({ attempt: 2 });
    await runner.runFacts!(target, check({ source: "5" }), ORG);
    expect(asked).toEqual([true, false]);
    expect(await runner.runFacts!(target, check({ runId: undefined }), ORG)).toBeUndefined();
    const bad = githubActionsCheckRunner({ ...base, getCheckRunFacts: async () => ({ attempt: 0 }) });
    expect(await bad.runFacts!(target, check(), ORG)).toBeUndefined();
  });
  it("matches nothing for a source that is not an app id, and maps the latest run to the port's check", async () => {
    const calls: unknown[] = [];
    const runner = githubActionsCheckRunner({ ...base, getLatestCheckRun: async (_url, at, wanted) => { calls.push({ at, wanted }); return { headSha: SHA_A, check: { name: "e2e-real", status: "completed", conclusion: "failure", required: false, url: "", jobId: "9", appId: GITHUB_ACTIONS_APP_ID } }; } });
    expect(await runner.latestCheck!({ url: REPO }, { revision: SHA_A }, { name: "e2e-real", source: "jenkins" }, ORG)).toBeUndefined();
    expect(calls).toEqual([]);
    expect(await runner.latestCheck!({ url: REPO }, { branch: "main" }, { name: "e2e-real", source: String(GITHUB_ACTIONS_APP_ID) }, ORG))
      .toEqual({ revision: SHA_A, check: { name: "e2e-real", state: "completed", conclusion: "failure", required: false, url: "", runId: "9", source: String(GITHUB_ACTIONS_APP_ID), logReadable: true } });
    expect(calls).toEqual([{ at: { branch: "main" }, wanted: { name: "e2e-real", appId: GITHUB_ACTIONS_APP_ID } }]);
    await expect(runner.latestCheck!({ url: REPO }, { revision: SHA_A, branch: "main" }, { name: "e2e-real" }, ORG)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("refuses a call with no valid scope", async () => {
    const runner = githubActionsCheckRunner({ ...base, listSeenCheckNames: async () => ({ checks: [{ name: "e2e-real" }, { name: "" }], complete: true }) });
    await expect(runner.seenChecks!({ url: REPO }, {} as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await runner.seenChecks!({ url: REPO }, ORG)).toEqual({ checks: [{ name: "e2e-real" }], complete: false });
  });
});
