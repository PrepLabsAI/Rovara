// GitHub's REST and GraphQL API as the real GitHubAppCredentialProvider reads and writes it, served from the shared in-memory model. Response shapes follow GitHub's
// documented ones (the same fields tests/support/workflow-e2e-github.ts and the existing github-app tests use, extended to checks, status and merge). The
// provider's own parsing runs on every answer, so a mapping that drifts from what the provider accepts fails here.
//
// One model feeds both this server and the FakeCodeHost, so the same contract suite can be run through the GitHub adapter and through the fake.
import { generateKeyPairSync } from "node:crypto";
import { GitHubAppCredentialProvider } from "../../../packages/broker/src/plugins/code-host/github/client.js";
import type { FakeChangeRequest, FakeHostModel } from "../../../packages/broker/src/plugins/fake/model.js";

export const GITHUB_OWNER = "acme";
export const GITHUB_NAME = "app";
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_NAME}`;
export const GITHUB_OTHER_URL = `https://github.com/${GITHUB_OWNER}/other`;
export const GITHUB_ORG_SCOPE = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" } as const;
export const INSTALLATION_ID = 77;
export const APP_SLUG = "rovara-app";
const API = "https://api.github.com";
const FULL = `${GITHUB_OWNER}/${GITHUB_NAME}`;
const ROOT = `/repos/${FULL}`;
const CONCLUSIONS: Record<string, string> = {
  success: "SUCCESS", failure: "FAILURE", neutral: "NEUTRAL", cancelled: "CANCELLED", skipped: "SKIPPED", timed_out: "TIMED_OUT", action_required: "ACTION_REQUIRED", stale: "STALE", startup_failure: "STARTUP_FAILURE",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain" } });
const NOT_FOUND = () => json(404, { message: "Not Found" });

export class GitHubFixtureApi {
  /** Every installation token minted, with what it asked for. */
  readonly tokens: Array<{ token: string; permissions: Record<string, string>; repositories?: string[] }> = [];
  /** Every request served, in order: method and path. */
  readonly requests: Array<{ method: string; path: string }> = [];

  constructor(private readonly model: FakeHostModel) {}

  private crJson(cr: FakeChangeRequest): Record<string, unknown> {
    const head = this.model.headRevisionOf(cr);
    return {
      number: Number(cr.id), node_id: `PR_node_${cr.id}`, html_url: this.model.crUrl(cr.id), state: cr.state === "open" ? "open" : "closed", merged: cr.state === "merged",
      ...(cr.mergedBy === undefined ? {} : { merged_by: { login: cr.mergedBy } }), ...(cr.mergedAt === undefined ? {} : { merged_at: cr.mergedAt }),
      draft: cr.draft, title: cr.title, body: cr.body === "" ? null : cr.body, merge_commit_sha: cr.mergeRevision ?? null,
      head: { ref: cr.sourceBranch, sha: head, repo: { full_name: FULL } }, base: { ref: cr.targetBranch, repo: { full_name: FULL } },
      mergeable_state: this.model.mergeableState(cr), mergeable: !cr.conflicts,
      requested_reviewers: cr.requestedReviewers.filter((name) => !name.includes("/")).map((login) => ({ login, id: Number(this.model.accounts.get(login)?.hostUserId ?? "1"), type: "User" })),
      requested_teams: cr.requestedReviewers.filter((name) => name.includes("/")).map((name) => ({ slug: name.split("/")[1] })),
    };
  }

  private prUrl(id: string): string {
    return `https://github.com/${FULL}/pull/${id}`;
  }

  private findCr(id: string): FakeChangeRequest | undefined {
    return this.model.changeRequests.find((cr) => cr.id === id);
  }

  private revisionFor(ref: string): string | undefined {
    if (this.model.revisions.has(ref)) return ref;
    return this.model.branches.get(ref);
  }

  /** P6: when set, every request is answered 429 with this many seconds to wait, as GitHub does when a caller is limited. */
  private limitedForSeconds: number | undefined;
  limitReadsFor(seconds: number): void { this.limitedForSeconds = seconds; }

  /** The `expires_at` the next tokens carry: an hour from now by default, a given time, or none (null). */
  tokenExpiry: string | null | undefined;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname);
    this.requests.push({ method, path });
    if (this.limitedForSeconds !== undefined) return json(429, { message: "API rate limit exceeded" }, { "retry-after": String(this.limitedForSeconds) });
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (!/^Bearer \S+$/.test(authorization)) return json(401, { message: "Requires authentication" });
    if (url.origin === "https://actions-logs.example.test") return this.logBody(path);
    if (url.origin !== API) return NOT_FOUND();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};

    if (method === "GET" && path === "/app") return json(200, { slug: APP_SLUG });
    if (method === "GET" && path === `${ROOT}/installation`) return json(200, { id: INSTALLATION_ID, account: { login: GITHUB_OWNER } });
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) return NOT_FOUND();
    if (method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      const token = `ghs_fixture_${this.tokens.length + 1}`;
      this.tokens.push({ token, permissions: (body.permissions ?? {}) as Record<string, string>, ...(Array.isArray(body.repositories) ? { repositories: body.repositories as string[] } : {}) });
      return json(201, { token, ...(this.tokenExpiry === null ? {} : { expires_at: this.tokenExpiry ?? new Date(Date.parse(this.model.now()) + 3_600_000).toISOString() }), permissions: body.permissions ?? {}, repository_selection: "selected" });
    }
    const token = authorization.slice("Bearer ".length);
    if (!this.tokens.some((entry) => entry.token === token)) return json(401, { message: "Bad credentials" });

    if (method === "POST" && path === "/graphql") return json(200, this.graphql(body as { query: string; variables: Record<string, unknown> }));
    if (method === "GET" && path === ROOT) return json(200, { id: Number(this.model.id), full_name: FULL, default_branch: this.model.defaultBranch });
    if (method === "GET" && path === `${ROOT}/branches`) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const rows = [...this.model.branches.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).slice((page - 1) * 100, page * 100).map(([name, sha]) => ({ name, commit: { sha } }));
      return json(200, rows);
    }
    let match = new RegExp(`^${ROOT}/branches/(.+)$`).exec(path);
    if (method === "GET" && match) {
      return this.model.branches.has(match[1]!)
        ? json(200, { name: match[1], protection: this.model.requiredChecks.length === 0 ? null : { required_status_checks: { contexts: this.model.requiredChecks } } })
        : NOT_FOUND();
    }
    if (method === "GET" && new RegExp(`^${ROOT}/rules/branches/`).test(path)) return json(200, []);
    match = new RegExp(`^${ROOT}/compare/(.+)\\.\\.\\.([0-9a-f]{40})$`).exec(path);
    if (method === "GET" && match) return json(200, { behind_by: 0, ahead_by: 1 });
    if (method === "GET" && path === `${ROOT}/contents/.github/workflows`) {
      const files = this.revisionFor(url.searchParams.get("ref") ?? "");
      const names = files === undefined ? [] : [...this.model.revision(files).files.keys()].filter((name) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name));
      return names.length === 0 ? NOT_FOUND() : json(200, names.map((name) => ({ name: name.split("/").pop() })));
    }
    match = new RegExp(`^${ROOT}/contents/(.+)$`).exec(path);
    if (method === "GET" && match) {
      const revision = this.revisionFor(url.searchParams.get("ref") ?? "");
      const content = revision === undefined ? undefined : this.model.revision(revision).files.get(match[1]!);
      return content === undefined ? NOT_FOUND() : text(200, content);
    }
    match = new RegExp(`^${ROOT}/git/ref/heads/(.+)$`).exec(path);
    if (method === "GET" && match) {
      const head = this.model.branches.get(match[1]!);
      return head === undefined ? NOT_FOUND() : json(200, { ref: `refs/heads/${match[1]}`, object: { type: "commit", sha: head } });
    }
    match = new RegExp(`^${ROOT}/git/commits/([0-9a-f]{40})$`).exec(path);
    if (method === "GET" && match) {
      const revision = this.model.revisions.get(match[1]!);
      return revision === undefined ? NOT_FOUND() : json(200, { sha: revision.sha, tree: { sha: revision.tree }, parents: revision.parents.map((sha) => ({ sha })) });
    }
    match = new RegExp(`^${ROOT}/collaborators/([^/]+)/permission$`).exec(path);
    if (method === "GET" && match) {
      const account = this.model.accounts.get(match[1]!);
      return account === undefined ? NOT_FOUND() : json(200, { permission: account.permission, user: { login: account.login, type: account.accountType } });
    }
    match = new RegExp(`^${ROOT}/actions/jobs/([0-9]+)/logs$`).exec(path);
    if (method === "GET" && match) {
      const log = this.model.logOf(match[1]!);
      return log === undefined ? NOT_FOUND() : text(200, log);
    }

    // pull requests
    if (method === "GET" && path === `${ROOT}/pulls`) {
      const head = (url.searchParams.get("head") ?? "").split(":")[1];
      const found = this.model.changeRequests.find((cr) => cr.state === "open" && cr.sourceBranch === head && cr.targetBranch === url.searchParams.get("base"));
      return json(200, found === undefined ? [] : [this.crJson(found)]);
    }
    if (method === "POST" && path === `${ROOT}/pulls`) {
      if (body.draft === true && !this.model.drafts) return json(422, { message: "Validation Failed", errors: [{ message: "Draft pull requests are not supported in this repository." }] });
      if (!this.model.branches.has(String(body.head)) || !this.model.branches.has(String(body.base))) return json(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "invalid", field: "head" }] });
      const { cr } = this.model.reconcile({ sourceBranch: String(body.head), targetBranch: String(body.base), title: String(body.title), ...(typeof body.body === "string" ? { body: body.body } : {}), ...(body.draft === true ? { draft: true } : {}) });
      return json(201, this.crJson(cr));
    }
    match = new RegExp(`^${ROOT}/pulls/(\\d+)(/.*)?$`).exec(path);
    if (match) {
      const cr = this.findCr(match[1]!);
      if (cr === undefined) return NOT_FOUND();
      const rest = match[2] ?? "";
      if (method === "GET" && rest === "") return json(200, this.crJson(cr));
      if (method === "PATCH" && rest === "") {
        this.model.update(cr.id, { ...(typeof body.title === "string" ? { title: body.title } : {}), ...(typeof body.body === "string" ? { body: body.body } : {}), ...(body.state === "open" || body.state === "closed" ? { state: body.state } : {}) });
        return json(200, this.crJson(cr));
      }
      if (method === "GET" && rest === "/files") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const all = this.model.changedFiles(cr.id);
        const files = all.slice((page - 1) * 100, page * 100).map((file) => ({ filename: file.path, status: file.status, additions: file.additions, deletions: file.deletions }));
        return json(200, files, all.length > page * 100 ? { link: `<${API}${ROOT}/pulls/${cr.id}/files?per_page=100&page=${page + 1}>; rel="next"` } : {});
      }
      if (method === "GET" && rest === "/reviews") return json(200, cr.reviews.map((review, index) => this.reviewJson(cr, index, review)));
      if (method === "GET" && rest === "/comments") return json(200, cr.comments.filter((comment) => comment.kind === "review_comment").map((comment) => this.commentJson(cr, comment, "REVIEW_COMMENT")));
      match = /^\/comments\/(\d+)\/replies$/.exec(rest);
      if (method === "POST" && match) {
        const found = cr.comments.find((comment) => comment.id === match![1] && comment.kind === "review_comment");
        if (found === undefined) return json(404, { message: "Not Found" });
        this.model.reply(cr.id, found.id, String(body.body), `${APP_SLUG}[bot]`);
        return json(201, {});
      }
      if (method === "POST" && rest === "/requested_reviewers") {
        const names = [...((body.reviewers ?? []) as string[]), ...((body.team_reviewers ?? []) as string[]).map((team) => `${GITHUB_OWNER}/${team}`)];
        return this.model.requestReviewers(cr.id, names) === "requested" ? json(201, this.crJson(cr)) : json(422, { message: "Review cannot be requested" });
      }
      if (method === "PUT" && rest === "/merge") {
        const result = this.model.merge(cr.id, { revision: String(body.sha), method: body.merge_method === "merge" ? "merge" : "squash" });
        return result.outcome === "merged" ? json(200, { merged: true, sha: result.mergeRevision, message: "Pull Request successfully merged" }) : json(405, { message: "Pull Request is not mergeable" });
      }
      return NOT_FOUND();
    }
    match = new RegExp(`^${ROOT}/issues/(\\d+)/comments$`).exec(path);
    if (method === "GET" && match) {
      const cr = this.findCr(match[1]!);
      return cr === undefined ? NOT_FOUND() : json(200, cr.comments.filter((comment) => comment.kind === "discussion").map((comment) => this.commentJson(cr, comment, "DISCUSSION")));
    }
    return NOT_FOUND();
  };

  private logBody(path: string): Response {
    void path;
    return NOT_FOUND();
  }

  private userJson(login: string): Record<string, unknown> {
    const account = this.model.accounts.get(login);
    return { login, id: Number(account?.hostUserId ?? "1"), type: account?.accountType ?? "User" };
  }

  private reviewJson(cr: FakeChangeRequest, index: number, review: FakeChangeRequest["reviews"][number]): Record<string, unknown> {
    const meta = cr.reviewMeta[index]!;
    return {
      id: Number(meta.id), html_url: `${this.prUrl(cr.id)}#pullrequestreview-${meta.id}`, user: this.userJson(review.reviewer.login), body: meta.body, state: review.state,
      submitted_at: review.submittedAt, commit_id: review.revision,
    };
  }

  private commentJson(cr: FakeChangeRequest, comment: FakeChangeRequest["comments"][number], kind: "REVIEW_COMMENT" | "DISCUSSION"): Record<string, unknown> {
    const common = { id: Number(comment.id), user: { login: comment.author }, body: comment.body, updated_at: comment.updatedAt };
    if (kind === "DISCUSSION") return { ...common, html_url: `${this.prUrl(cr.id)}#issuecomment-${comment.id}`, issue_url: `${API}${ROOT}/issues/${cr.id}` };
    return { ...common, html_url: `${this.prUrl(cr.id)}#discussion_r${comment.id}`, pull_request_url: `${API}${ROOT}/pulls/${cr.id}`, path: comment.path, line: comment.line ?? null };
  }

  private graphql(request: { query: string; variables: Record<string, unknown> }): Record<string, unknown> {
    const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    if (/markPullRequestReadyForReview/.test(request.query)) {
      const cr = this.model.changeRequests.find((entry) => `PR_node_${entry.id}` === request.variables.id);
      if (cr === undefined) return { errors: [{ message: "Could not resolve to a node" }] };
      this.model.markReady(cr.id);
      return { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } };
    }
    const cr = this.findCr(String(request.variables.number));
    if (cr === undefined || request.variables.owner !== GITHUB_OWNER || request.variables.name !== GITHUB_NAME) return { data: { repository: null }, errors: [{ message: "Could not resolve to a PullRequest" }] };
    const head = this.model.headRevisionOf(cr);
    const pr: Record<string, unknown> = { number: Number(cr.id), headRefOid: head };
    if (/statusCheckRollup/.test(request.query)) {
      const checks = this.model.checksOf(head);
      const required = (name: string) => this.model.requiredChecks.includes(name);
      const nodes = checks.map((check) => {
        if (check.conclusion === "error") return { __typename: "StatusContext", context: check.name, state: "ERROR", targetUrl: check.url === "" ? null : check.url, isRequired: required(check.name) };
        return {
          __typename: "CheckRun", name: check.name, status: check.state === "completed" ? "COMPLETED" : "IN_PROGRESS", conclusion: check.conclusion === undefined ? null : CONCLUSIONS[check.conclusion],
          detailsUrl: check.url === "" ? null : check.url, databaseId: check.runId === undefined ? null : Number(check.runId), checkSuite: { app: null }, isRequired: required(check.name),
        };
      });
      pr.commits = { nodes: [{ commit: { oid: head, statusCheckRollup: checks.length === 0 ? null : { state: "PENDING", contexts: page(nodes) } } }] };
    } else if (/\breviews\(first:100/.test(request.query)) {
      pr.reviews = page(cr.reviews.map((review, index) => ({ fullDatabaseId: cr.reviewMeta[index]!.id, updatedAt: review.submittedAt, url: `${this.prUrl(cr.id)}#pullrequestreview-${cr.reviewMeta[index]!.id}`, body: cr.reviewMeta[index]!.body })));
    } else if (/\breviewThreads\(first:100/.test(request.query)) {
      pr.reviewThreads = page(cr.threads.map((thread) => ({
        id: thread.id, isResolved: thread.resolved, repository: { nameWithOwner: FULL }, pullRequest: { number: Number(cr.id) },
        comments: page(thread.commentIds.map((id) => ({ fullDatabaseId: id }))),
      })));
    } else {
      return { errors: [{ message: "the fixture API does not serve this query" }] };
    }
    return { data: { repository: { nameWithOwner: FULL, pullRequest: pr } } };
  }
}

/** A provider that talks to the fixture API: a real GitHubAppCredentialProvider, so its parsing and request choreography run for real. */
export function providerOver(api: GitHubFixtureApi): GitHubAppCredentialProvider {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fetchImplementation: api.fetch, now: () => Date.parse("2026-10-30T10:00:00.000Z"),
    // Cloud-style binding: always bound in these tests.
    requireInstallationBound: async () => undefined,
  });
}
