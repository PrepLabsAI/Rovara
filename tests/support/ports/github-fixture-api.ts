// GitHub's REST and GraphQL API as the real GitHubAppCredentialProvider reads and writes it, served from the shared in-memory model. Response shapes follow GitHub's
// documented ones (the same fields tests/support/workflow-e2e-github.ts and the existing github-app tests use, extended to checks, status and merge). The
// provider's own parsing runs on every answer, so a mapping that drifts from what the provider accepts fails here.
//
// One model feeds both this server and the FakeCodeHost, so the same contract suite can be run through the GitHub adapter and through the fake.
import { createHash, generateKeyPairSync } from "node:crypto";
import { GitHubAppCredentialProvider } from "../../../packages/broker/src/plugins/code-host/github/client.js";
import type { FakeChangeRequest, FakeHostModel } from "@agentx/broker/fakes";

/** The fake model speaks Rovara's words; this fixture speaks GitHub's. */
export const githubMergeableState = (state: string): string => (state === "conflicted" ? "dirty" : state);
export const githubAccountType = (kind: string): string => (kind === "person" ? "User" : kind === "bot" ? "Bot" : "Organization");

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
const gitSha = (seed: string): string => createHash("sha1").update(seed).digest("hex");

/** Port lane L11: the fake GitHub in the mode of a laptop signed in with one personal token. The App's endpoints do not exist (401), and the one token is accepted everywhere else. */
export interface GitHubFixtureOptions {
  personalToken?: string;
  /** The `github-authentication-token-expiration` header a personal token's answers carry. */
  personalTokenExpiration?: string;
  /** The login `GET /user` answers for the personal token. */
  personalLogin?: string;
}

export class GitHubFixtureApi {
  /** Every request made to an App-only endpoint (the App's own pages, the installation lookups, the token mints), in personal-token mode. A personal-token client makes none. */
  readonly appRequests: Array<{ method: string; path: string }> = [];
  /** Every installation token minted, with what it asked for. */
  readonly tokens: Array<{ token: string; permissions: Record<string, string>; repositories?: string[] }> = [];
  /** Every request served, in order: method and path. */
  readonly requests: Array<{ method: string; path: string }> = [];

  constructor(private readonly model: FakeHostModel, private readonly options: GitHubFixtureOptions = {}) {}

  private crJson(cr: FakeChangeRequest): Record<string, unknown> {
    const head = this.model.headRevisionOf(cr);
    return {
      number: Number(cr.id), node_id: `PR_node_${cr.id}`, html_url: this.model.crUrl(cr.id), state: cr.state === "open" ? "open" : "closed", merged: cr.state === "merged",
      ...(cr.mergedBy === undefined ? {} : { merged_by: { login: cr.mergedBy } }), ...(cr.mergedAt === undefined ? {} : { merged_at: cr.mergedAt }),
      draft: cr.draft, title: cr.title, body: cr.body === "" ? null : cr.body, merge_commit_sha: cr.mergeRevision ?? null,
      user: { login: cr.author, id: 1, type: cr.author.endsWith("[bot]") ? "Bot" : "User" },
      head: { ref: cr.sourceBranch, sha: head, repo: { full_name: FULL } }, base: { ref: cr.targetBranch, sha: this.model.headOf(cr.targetBranch), repo: { full_name: FULL, id: Number(this.model.id) } },
      mergeable_state: githubMergeableState(this.model.mergeableState(cr)), mergeable: !cr.conflicts,
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

  private readonly blobs = new Map<string, string>();
  private readonly trees = new Map<string, { files: Map<string, string>; symlinks: ReadonlySet<string> }>();

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

    const personal = this.options.personalToken;
    if (personal !== undefined) {
      if (path === "/app" || path.startsWith("/app/") || /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) {
        this.appRequests.push({ method, path });
        return json(401, { message: "A JSON web token could not be decoded" });
      }
      if (authorization !== `Bearer ${personal}`) return json(401, { message: "Bad credentials" });
      const expiration = this.options.personalTokenExpiration === undefined ? {} : { "github-authentication-token-expiration": this.options.personalTokenExpiration };
      if (method === "GET" && path === "/user") return json(200, { login: this.options.personalLogin ?? "octo-dev" }, { "x-oauth-scopes": "repo, read:org", ...expiration });
      if (method === "GET" && path === ROOT) return json(200, this.repositoryJson(), expiration);
    }
    if (method === "GET" && path === "/app") return json(200, { slug: APP_SLUG });
    if (method === "GET" && path === `${ROOT}/installation`) return json(200, { id: INSTALLATION_ID, account: { login: GITHUB_OWNER } });
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) return NOT_FOUND();
    if (method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      const token = `ghs_fixture_${this.tokens.length + 1}`;
      this.tokens.push({ token, permissions: (body.permissions ?? {}) as Record<string, string>, ...(Array.isArray(body.repositories) ? { repositories: body.repositories as string[] } : {}) });
      return json(201, { token, ...(this.tokenExpiry === null ? {} : { expires_at: this.tokenExpiry ?? new Date(Date.parse(this.model.now()) + 3_600_000).toISOString() }), permissions: body.permissions ?? {}, repository_selection: "selected" });
    }
    const token = authorization.slice("Bearer ".length);
    if (personal === undefined && !this.tokens.some((entry) => entry.token === token)) return json(401, { message: "Bad credentials" });

    if (method === "POST" && path === "/graphql") return json(200, this.graphql(body as { query: string; variables: Record<string, unknown> }));
    if (method === "GET" && path === ROOT) return json(200, this.repositoryJson());
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
    if (method === "GET" && match) {
      const target = this.model.branches.get(match[1]!) ?? match[1]!;
      return json(200, { behind_by: 0, ahead_by: 1, merge_base_commit: { sha: this.model.mergeBase(match[2]!, target) } });
    }
    match = new RegExp(`^${ROOT}/git/trees/([0-9a-f]{40})$`).exec(path);
    if (method === "GET" && match) {
      const revision = this.model.revisions.get(match[1]!);
      if (revision === undefined) return NOT_FOUND();
      const modes = { file: "100644", executable: "100755", symlink: "120000", submodule: "160000" } as const;
      return json(200, { truncated: this.model.incompleteTrees.has(revision.sha), tree: [...revision.entries].map(([path, type]) => ({ path, mode: modes[type], type: type === "submodule" ? "commit" : "blob", sha: gitSha(path) })) });
    }
    if (method === "GET" && path === `${ROOT}/contents/.github/workflows`) {
      const files = this.revisionFor(url.searchParams.get("ref") ?? "");
      const names = files === undefined ? [] : [...this.model.revision(files).files.keys()].filter((name) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name));
      return names.length === 0 ? NOT_FOUND() : json(200, names.map((name) => ({ name: name.split("/").pop() })));
    }
    match = new RegExp(`^${ROOT}/contents(?:/(.+))?$`).exec(path);
    if (method === "GET" && match) {
      const revision = this.revisionFor(url.searchParams.get("ref") ?? "");
      if (revision === undefined) return NOT_FOUND();
      const found = this.model.revision(revision);
      const wanted = match[1] ?? "";
      const accept = new Headers(init?.headers).get("accept") ?? "";
      for (const [name, type] of found.entries) {
        if (type === "submodule" && (wanted === name || wanted.startsWith(`${name}/`))) return json(200, { type, name: name.split("/").pop(), path: name, sha: gitSha(`module ${name}`) });
      }
      // The raw media type is a file's text; any other is GitHub's JSON: a file's record, a symbolic link's, or a directory's listing.
      if (accept.includes("raw")) {
        const content = found.files.get(wanted);
        return content === undefined ? NOT_FOUND() : text(200, content);
      }
      // A path below a symbolic link is the link's record, whatever the name (a client cannot tell what the link points at).
      for (const link of found.symlinks) if (wanted.startsWith(`${link}/`)) return json(200, { type: "symlink", name: link.split("/").pop(), path: link, sha: gitSha(`link ${link}`) });
      if (found.symlinks.has(wanted)) return json(200, { type: "symlink", name: wanted.split("/").pop(), path: wanted, sha: gitSha(`link ${wanted}`) });
      const file = found.files.get(wanted);
      if (file !== undefined) return json(200, { type: "file", name: wanted.split("/").pop(), path: wanted, sha: gitSha(`blob ${file}`), encoding: "base64", content: Buffer.from(file, "utf8").toString("base64") });
      const prefix = wanted === "" ? "" : `${wanted}/`;
      const children = new Map<string, string>();
      for (const name of found.entries.keys()) {
        if (!name.startsWith(prefix)) continue;
        const rest = name.slice(prefix.length);
        const first = rest.split("/")[0]!;
        children.set(first, rest.includes("/") ? "dir" : found.entries.get(name) === "executable" ? "file" : found.entries.get(name)!);
      }
      return children.size === 0 ? NOT_FOUND() : json(200, [...children.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, type]) => ({ name, path: `${prefix}${name}`, type, sha: gitSha(`entry ${prefix}${name}`) })));
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
    // The git data API (item C1): references, blobs, trees and commits, enough for a client that writes files on a branch.
    if (method === "POST" && path === `${ROOT}/git/refs`) {
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      if (this.model.branches.has(branch)) return json(422, { message: "Reference already exists" });
      if (!this.model.revisions.has(String(body.sha))) return json(422, { message: "Object does not exist" });
      this.model.branches.set(branch, String(body.sha));
      return json(201, { ref: `refs/heads/${branch}`, object: { type: "commit", sha: body.sha } });
    }
    if (method === "POST" && path === `${ROOT}/git/blobs`) {
      const content = Buffer.from(String(body.content), "base64").toString("utf8");
      const sha = gitSha(`blob ${content}`);
      this.blobs.set(sha, content);
      return json(201, { sha });
    }
    if (method === "POST" && path === `${ROOT}/git/trees`) {
      const base = [...this.model.revisions.values()].find((revision) => revision.tree === String(body.base_tree));
      if (base === undefined) return json(422, { message: "The tree does not exist" });
      const files = new Map(base.files);
      for (const item of body.tree as Array<{ path: string; sha: string }>) {
        const content = this.blobs.get(item.sha);
        if (content === undefined) return json(422, { message: "The blob does not exist" });
        files.set(item.path, content);
      }
      const sha = gitSha(`tree ${JSON.stringify([...files.entries()])}${String(body.base_tree)}`);
      this.trees.set(sha, { files, symlinks: base.symlinks });
      return json(201, { sha });
    }
    if (method === "POST" && path === `${ROOT}/git/commits`) {
      const tree = this.trees.get(String(body.tree));
      const parents = (body.parents ?? []) as string[];
      if (tree === undefined || parents.some((parent) => !this.model.revisions.has(parent))) return json(422, { message: "The tree or a parent does not exist" });
      return json(201, { sha: this.model.makeRevision(parents, tree.files, tree.symlinks).sha });
    }
    match = new RegExp(`^${ROOT}/git/refs/heads/(.+)$`).exec(path);
    if (method === "PATCH" && match) {
      const current = this.model.branches.get(match[1]!);
      if (current === undefined) return NOT_FOUND();
      // `force: false`: only a fast-forward of the branch's current head.
      const target = this.model.revisions.get(String(body.sha));
      if (target === undefined || body.force !== false || target.parents[0] !== current) return json(422, { message: "Update is not a fast forward" });
      this.model.branches.set(match[1]!, target.sha);
      return json(200, { ref: `refs/heads/${match[1]}`, object: { type: "commit", sha: target.sha } });
    }
    if (method === "DELETE" && match) return this.model.removeBranch(match[1]!) ? new Response(null, { status: 204 }) : json(422, { message: "Reference does not exist" });
    match = new RegExp(`^${ROOT}/collaborators/([^/]+)/permission$`).exec(path);
    if (method === "GET" && match) {
      const account = this.model.accounts.get(match[1]!);
      return account === undefined ? NOT_FOUND() : json(200, { permission: account.permission, user: { login: account.login, type: githubAccountType(account.accountType) } });
    }
    match = new RegExp(`^${ROOT}/actions/jobs/([0-9]+)/logs$`).exec(path);
    if (method === "GET" && match) {
      const log = this.model.logOf(match[1]!);
      return log === undefined ? NOT_FOUND() : text(200, log);
    }

    // pull requests
    if (method === "GET" && path === `${ROOT}/pulls`) {
      const head = (url.searchParams.get("head") ?? "").split(":")[1];
      // `state=all` with no base branch: any change request made from the branch, the newest first (the lookup of a lessons branch).
      const found = url.searchParams.get("state") === "all"
        ? [...this.model.changeRequests].reverse().find((cr) => cr.sourceBranch === head)
        : this.model.changeRequests.find((cr) => cr.state === "open" && cr.sourceBranch === head && cr.targetBranch === url.searchParams.get("base"));
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
        const files = all.slice((page - 1) * 100, page * 100).map((file) => ({ filename: file.path, status: file.status, additions: file.additions, deletions: file.deletions, ...(file.previousPath === undefined ? {} : { previous_filename: file.previousPath }) }));
        return json(200, files, all.length > page * 100 ? { link: `<${API}${ROOT}/pulls/${cr.id}/files?per_page=100&page=${page + 1}>; rel="next"` } : {});
      }
      if (method === "GET" && rest === "/reviews") return json(200, cr.reviews.map((review, index) => this.reviewJson(cr, index, review)));
      if (method === "GET" && rest === "/comments") return json(200, cr.comments.filter((comment) => comment.kind === "review_comment").map((comment) => this.commentJson(cr, comment, "REVIEW_COMMENT")));
      match = /^\/comments\/(\d+)\/replies$/.exec(rest);
      if (method === "POST" && match) {
        const found = cr.comments.find((comment) => comment.id === match![1] && comment.kind === "review_comment");
        if (found === undefined) return json(404, { message: "Not Found" });
        // The model holds Rovara's fixed one-line text; GitHub itself takes any text, so the hidden marker a personal-token client appends is kept on the stored comment.
        const posted = String(body.body);
        const marked = /^(.*)\n\n(<!-- [a-z-]+ -->)$/su.exec(posted);
        this.model.reply(cr.id, found.id, marked?.[1] ?? posted, personal === undefined ? `${APP_SLUG}[bot]` : this.options.personalLogin ?? "octo-dev");
        if (marked !== null) cr.comments.at(-1)!.body = posted;
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
      if (cr === undefined) return NOT_FOUND();
      const since = url.searchParams.get("since");
      return json(200, cr.comments.filter((comment) => comment.kind === "discussion" && (since === null || Date.parse(comment.updatedAt) >= Date.parse(since))).map((comment) => this.commentJson(cr, comment, "DISCUSSION")));
    }
    if (method === "POST" && match) {
      const cr = this.findCr(match[1]!);
      if (cr === undefined) return NOT_FOUND();
      return json(201, this.commentJson(cr, this.model.addDiscussionComment(cr.id, "rovara-owner", String(body.body)), "DISCUSSION"));
    }
    return NOT_FOUND();
  };

  private logBody(path: string): Response {
    void path;
    return NOT_FOUND();
  }

  private repositoryJson(): Record<string, unknown> {
    return {
      id: Number(this.model.id), full_name: FULL, default_branch: this.model.defaultBranch, owner: { login: GITHUB_OWNER, id: 9, type: "Organization" }, permissions: { push: true, pull: true },
    };
  }

  private userJson(login: string): Record<string, unknown> {
    const account = this.model.accounts.get(login);
    return { login, id: Number(account?.hostUserId ?? "1"), type: githubAccountType(account?.accountType ?? "person") };
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
    if (kind === "DISCUSSION") return { ...common, user: this.userJson(comment.author), created_at: comment.createdAt ?? comment.updatedAt, html_url: `${this.prUrl(cr.id)}#issuecomment-${comment.id}`, issue_url: `${API}${ROOT}/issues/${cr.id}` };
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
