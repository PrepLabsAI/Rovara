import { createHash, createSign } from "node:crypto";
import { commitFilesOn, deleteBranchOn, type CommitFilesRequest } from "./commit-files.js";
import { GitBranchNameSchema, HostRateLimitError, LESSON_FILE_BRANCH_PATTERN, OrgIdSchema, PULL_REQUEST_BODY_MAX_CHARS, agentXError, createCandidateManifest, githubNotConnectedMessage, isSafeE2ESourcePath, redactText, type AgentXError, type E2ESourceSnapshot, type OrgId } from "@agentx/contracts";
import type { RepositoryAccess, RepositoryCredential } from "../../../repository-access.js";
import type { ReadBudget as GithubMergeReadBudget } from "@agentx/contracts"; // L7a: the port's read allowance, not an aws/ module (same shape)
import { isAllowedLogAddress, logTail, readLogEnd } from "../../../github-job-log.js";
import { checkAgentTokenPermissions, type GitHubAgentTokenPermissions } from "../../../agents/github-agent-tools.js";
import {
  mergeRequiredChecks, parseMergeableState, parseRepositoryPermission, parseReview, parseRollupContext, requestedReviewerCount, requestedReviewerIds, requiredChecksFromProtection, requiredChecksFromRules, statusRecord,
  type RequiredCheck,
  type PullRequestCheck, type PullRequestReview, type PullRequestStatus,
} from "../../../github-pull-status.js";

export type { PullRequestCheck, PullRequestReview, PullRequestStatus } from "../../../github-pull-status.js";

const GITHUB_APP_ID = /^[1-9][0-9]*$/;
/** A GitHub user or organization login: letters, digits and single hyphens inside, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const FILE_AT_COMMIT_MAX_BYTES = 20_971_520;
/** The most characters of a CODEOWNERS file read (GitHub's own cap is 3 MB; a file this large is not read at all). */
const CODEOWNERS_MAX_CHARS = 262_144;
/** The pages of changed files (100 each) the code-owner check reads. */
const CHANGED_PATH_PAGES = 10;
const FILE_AT_COMMIT_TIMEOUT_MS = 8_000;
/** The most of a contents answer read to tell a file from a directory (a listing holds at most 1,000 entries). */
const PATH_KIND_MAX_BYTES = 2 * 1024 * 1024;
/** GitHub lists at most this many entries of a directory; a full listing may have more. */
const PATH_LISTING_MAX_ENTRIES = 1000;
const READ_TOKEN_REUSE_MS = 5 * 60_000;
/** GitHub makes an App's slug from its name: letters, digits and hyphens. It goes into the install address. */
const GITHUB_REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_APP_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;

/** One installation of the App, as GitHub reports it (GET /app/installations/{id}): only what the install flow decides on. */
export interface GitHubInstallation {
  id: number;
  /** `Enterprise` is an account GitHub can install an App on that no Rovara organization may connect (Plan 2, Task 13). */
  account: { login: string; id: number; type: "User" | "Organization" | "Enterprise" };
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
}

/**
 * Whose work a token is minted for (Plan 2, Task 15). An org's own work names the org: on a cloud install the installation must be bound to
 * that org, active, at the moment of every mint. `webhook` (a signed delivery GitHub sent) and `install` (the install's own work, for an install that runs as one company and has
 * no bindings) name no org and are never checked.
 */
export type SystemTokenScope = { system: "webhook" | "install" };
export type GitHubTokenScope = { orgId: OrgId } | SystemTokenScope;

export interface GitHubAppCredentialProviderOptions {
  credentialRef: string;
  /** The App's id, or a function that reads it when first needed: an install's control plane
   * deploys before its GitHub App exists, and then reads the id from the App's secret. */
  appId: string | (() => Promise<string>);
  getPrivateKey: () => Promise<string>;
  /**
   * The App secret's JSON text, for the fields `agentx init` stores beside the key (slug, OAuth client id and secret). `refresh: true`
   * reads it again, for a field set after the first read. Absent: the App's slug is asked of GitHub, and it has no OAuth client.
   */
  getAppSecret?: (options?: { refresh?: boolean }) => Promise<string>;
  /**
   * Cloud installs only: refuses (GITHUB_NOT_CONNECTED) unless the installation is bound to `orgId` and active. Called before every mint for
   * an `orgId` scope. Absent on a single-company install.
   */
  requireInstallationBound?: (orgId: OrgId, installationId: number, repository?: { owner: string; name: string }) => Promise<void>;
  /**
   * Told after each repository-scoped installation token is issued, with what was asked and what GitHub says it granted (permission names, repository names, selection,
   * expiry). Never the token. It lets an operator tell a token GitHub issued with less than was asked, or for another repository, from a refused clone.
   */
  onTokenIssued?: (issued: GitHubTokenIssued) => void;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  /**
   * Staging v0.4.9: `git clone` with a repository token GitHub had just issued sometimes got "Repository not found" (and succeeded a minute later with
   * the same code and settings). With this set, `resolve` checks the new token against GitHub's git endpoint, the request `git clone` makes first, and waits
   * while GitHub answers 404 for it. Absent: the token is handed over unchecked.
   */
  tokenReadiness?: GitHubTokenReadinessOptions;
  /**
   * Port lane L11 (a laptop signed in with the owner's own token, `token-client.ts`): the hooks of a client that has no App identity. Absent for an App client, and then nothing here applies.
   *  - `ownComment`: how Rovara's own replies are told from other comments. An App's replies carry its `<slug>[bot]` login; the owner's token writes as the owner, so every reply carries `marker`
   *    (an HTML comment, hidden on the page) and a comment counts as Rovara's own only when its author is `login()` AND it has Rovara's exact reply shape (a line, a blank line, the marker). Anyone else's comment with the marker stays feedback.
   *    If `login()` cannot say who the owner is, the feedback read FAILS (no comments are returned): Rovara's own replies could not be told from the owner's feedback.
   *  - `notReachable`: the sentence for a repository the credential cannot reach (the App wording is wrong for a token).
   */
  personalToken?: {
    ownComment: { login(): Promise<string | undefined>; marker: string };
    notReachable(repository: { owner: string; name: string }): string;
  };
}

/** What `onTokenIssued` is told: names and words only. */
export interface GitHubTokenIssued {
  installationId: number;
  repository: string;
  requested: Record<string, "read" | "write">;
  granted?: Record<string, string>;
  repositorySelection?: string;
  repositories?: string[];
  expiresAt?: string;
}

export interface GitHubTokenReadinessOptions {
  /** Waits between probes; one more probe than there are delays is made at most. Default 150, 300, 600, 1200, 2400 ms. */
  delaysMs?: readonly number[];
  /** Reports each probe (never the token), for the broker log. */
  onProbe?: (event: GitHubTokenProbeEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface GitHubTokenProbeEvent {
  repository: string;
  access: RepositoryAccess;
  attempt: number;
  /** HTTP status of the probe; absent when the probe itself failed. */
  status?: number;
  /** `ready`: GitHub accepted the token; `not_found`: 404, the answer a clone turns into "Repository not found"; `other`: any other status; `error`: the probe failed. */
  outcome: "ready" | "not_found" | "other" | "error";
  /** Milliseconds from the token being issued to this probe's answer. */
  sinceIssuedMs: number;
}

const DEFAULT_TOKEN_READINESS_DELAYS_MS: readonly number[] = [150, 300, 600, 1_200, 2_400];

export interface GitHubPullRequestInput {
  repositoryUrl: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
  /** Spec 025 FR-023: opens the pull request as a draft; GitHub's default applies when absent. */
  draft?: boolean;
}

export interface GitHubPullRequestResult {
  number: number;
  url: string;
  reconciled: boolean;
  /** Set when the pull request was asked to be a draft, GitHub refused drafts for this repository, and it was opened once as a normal pull request instead (INTG1). */
  draftRefused?: true;
}

/** The line a pull request opened in place of a refused draft starts with, so a reviewer is told it is not a draft and must not be merged unreviewed (INTG1). */
export const DRAFT_REFUSED_PULL_REQUEST_NOTE = "Draft pull requests are not available for this repository, so this one is open for review. Do not merge it until it has been reviewed.";

/** A pull request's description with the draft-refused note first, cut at its end so the whole stays within GitHub's limit. */
export function pullRequestBodyWithDraftNote(body: string | undefined): string {
  if (body === undefined || body === "") return DRAFT_REFUSED_PULL_REQUEST_NOTE;
  const separator = "\n\n";
  let room = Math.max(0, PULL_REQUEST_BODY_MAX_CHARS - DRAFT_REFUSED_PULL_REQUEST_NOTE.length - separator.length);
  // Cut between characters: a surrogate pair is never split at the end.
  if (room < body.length && room > 0 && /[\uD800-\uDBFF]/u.test(body.charAt(room - 1))) room -= 1;
  return `${DRAFT_REFUSED_PULL_REQUEST_NOTE}${separator}${body.slice(0, room)}`;
}

/**
 * Why GitHub answered 422 to a pull request creation, from a fixed list. GitHub's own text is only matched against, never kept: it is user content and goes nowhere (not into the
 * error, a log or a record). `draft-unsupported` is the answer to a draft request on a private repository whose plan has no drafts.
 */
type PullRequestRefusal = "draft-unsupported" | "no-commits" | "head-not-found" | "base-not-found" | "already-exists" | "unknown";
const PULL_REQUEST_REFUSAL_SENTENCES: Record<PullRequestRefusal, string> = {
  "draft-unsupported": "this repository does not allow draft pull requests",
  "no-commits": "the head branch has no commits that the base branch lacks",
  "head-not-found": "GitHub cannot find the head branch",
  "base-not-found": "GitHub cannot find the base branch",
  "already-exists": "a pull request for this branch already exists",
  unknown: "GitHub rejected the pull request and gave a reason AgentX does not recognise",
};
const MAX_REFUSAL_BODY_CHARS = 16_384;

/** The body's first 16 KiB, read through the stream so that a larger body is never read in full; a body that goes on past that is not read as JSON (it cannot be one of the short answers listed). */
async function boundedRefusalText(response: Response): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read() as { done: boolean; value?: Uint8Array };
      if (next.done || next.value === undefined) break;
      chunks.push(next.value);
      total += next.value.byteLength;
      if (total > MAX_REFUSAL_BODY_CHARS) { await reader.cancel().catch(() => undefined); return undefined; }
    }
  } catch { return undefined; }
  return Buffer.concat(chunks).toString("utf8");
}

async function pullRequestRefusalOf(response: Response): Promise<PullRequestRefusal> {
  let parsed: unknown;
  try {
    const text = await boundedRefusalText(response);
    if (text === undefined) return "unknown";
    parsed = JSON.parse(text);
  } catch { return "unknown"; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
  const errors = (parsed as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return "unknown";
  const found = new Set<PullRequestRefusal>();
  for (const item of errors.slice(0, 20)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { message, field, code } = item as { message?: unknown; field?: unknown; code?: unknown };
    const text = typeof message === "string" ? message.toLowerCase() : "";
    if (/draft pull requests are not supported/.test(text)) found.add("draft-unsupported");
    else if (/^no commits between /.test(text)) found.add("no-commits");
    else if (/^a pull request already exists/.test(text)) found.add("already-exists");
    else if (code === "invalid" && field === "head") found.add("head-not-found");
    else if (code === "invalid" && field === "base") found.add("base-not-found");
  }
  // A draft refusal is read only when it is the whole answer: another reason beside it is that reason's to tell.
  if (found.size === 1) return [...found][0]!;
  return found.size === 0 ? "unknown" : [...found].find((reason) => reason !== "draft-unsupported") ?? "unknown";
}

export interface GitHubPullRequestDetails {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  headCommit: string;
  mergeCommit?: string;
  /** When GitHub says it merged (a merged pull request only). */
  mergedAt?: string;
  /** The login of the account that merged it, when GitHub says (a merged pull request only). */
  mergedBy?: string;
  title: string;
  body: string;
  /** The login of the account that created it, and the id of the repository it is against, when GitHub says. */
  authorLogin?: string;
  baseRepositoryId?: string;
  /** Whether that account is this App's own bot (set by `getPullRequest` only; absent when the App's login cannot be read). */
  authoredByApp?: boolean;
}

/** What a merge came to (Plan 6 Task 19): merged (by the method asked, or the other one when the repository does not allow it), merged already, or refused for a fixed reason. */
export type MergePullRequestResult =
  | { outcome: "merged"; method: "squash" | "merge"; fellBack: boolean; mergeCommitSha?: string }
  | { outcome: "already_merged" }
  | { outcome: "refused"; reason: "head_changed" | "not_mergeable" | "closed" | "forbidden"; githubMessage?: string };

/** The most characters of GitHub's own reason that are kept. */
const GITHUB_REASON_MAX = 200;

/**
 * GitHub's words for a refusal, made safe to show a person (owner decision 2026-10-27: when GitHub refuses a merge, the person sees why): redacted, markup and mentions gone, one line, cut to 200 characters.
 * Undefined when GitHub gave none.
 */
export function githubReasonOf(body: Record<string, unknown>): string | undefined {
  if (typeof body.message !== "string") return undefined;
  const plain = redactText(body.message).replace(/<[^>]*>/gu, "").replace(/[<>@]/gu, "").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const cut = [...plain].slice(0, GITHUB_REASON_MAX).join("").trim();
  return cut === "" ? undefined : cut;
}

/** GitHub's rate-limit answer. P6: it is one kind of the neutral `HostRateLimitError`, so a caller that bounds its reads handles every host's limit the same way. */
export class GithubMergeRateLimitError extends HostRateLimitError {
  constructor(retryAt: number) {
    super(retryAt, "GitHub merge observation is rate limited");
    this.name = "GithubMergeRateLimitError";
  }
}

/** GitHub's rate-limit answer to a compare read (lessons capture): the neutral `HostRateLimitError`, so the queue worker waits for the time GitHub gave. */
export class GithubCompareRateLimitError extends HostRateLimitError {
  constructor(retryAt: number) {
    super(retryAt, "GitHub is limiting requests; the compare will be tried again");
    this.name = "GithubCompareRateLimitError";
  }
}

export interface GitHubPullRequestUpdate {
  title?: string;
  body?: string;
  state?: "open" | "closed";
}

export interface GitHubPullRequestChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GitHubWebhookRepositoryScope {
  installationId: number;
  repositoryId: number;
  fullName: string;
}

export interface GitHubRepositoryIdentity { repositoryId: number; fullName: string; defaultBranch?: string; private?: boolean }

const INSTALLATION_REPOSITORY_PAGES = 10;
/** The longest one call to the App's webhook delivery API may take, and the caller's own deadline too when it gives one. */
const webhookCallSignal = (deadline?: AbortSignal): AbortSignal => deadline === undefined ? AbortSignal.timeout(8_000) : AbortSignal.any([AbortSignal.timeout(8_000), deadline]);

/** One repository an installation can reach, as GitHub lists it. */
export interface GitHubInstallationRepository { fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string }

/** The scope an agent's GitHub reads and tokens take: always an org's own work, never a system scope (Plan 3, PF10). */
export type AgentGitHubScope = { orgId: OrgId };

/**
 * What an agent's mint may be held to: the installation the project pinned for this repository (`installationId` on the project's repository). A repository
 * that GitHub now reaches through another installation gets no token (GITHUB_NOT_CONNECTED), whatever the org's bindings say.
 */
export interface AgentTokenOptions { installationId?: number | undefined }

/** One entry of a repository directory, as GitHub lists it. */
export interface AgentRepositoryEntry { name: string; path: string; type: "file" | "dir" | "symlink" | "submodule" | "other"; sha: string; size: number }
/** A file's blob sha and size, and its text unless it is over the cap that was asked for (`tooLarge`). */
export type AgentRepositoryFile = { sha: string; size: number } & ({ tooLarge: true } | { tooLarge?: false; text: string });

/**
 * A read-only view of one repository's default branch at one commit, made with a `contents: read` token for an org's run. Every read names the
 * same commit, so a scan sees one consistent tree. A path that is not there reads as undefined; anything else that goes wrong throws.
 */
export interface AgentRepositoryReader {
  defaultBranch: string;
  /** The commit of the default branch's head that every read names. */
  commit: string;
  /** The entries of a directory (undefined when the path is not a directory). `truncated` when GitHub may have listed only part of it. */
  list(path: string): Promise<{ entries: AgentRepositoryEntry[]; truncated: boolean } | undefined>;
  /** A file's blob sha and size, and its text when it is at most `maxBytes` (undefined when the path is not a file). */
  read(path: string, maxBytes: number): Promise<AgentRepositoryFile | undefined>;
}

/** A label of a repository as GitHub lists it: its numeric id, its node id and its name. */
export interface AgentRepositoryLabel { id: number; nodeId: string; name: string }

const AGENT_READ_TIMEOUT_MS = 8_000;
/** GitHub lists at most this many entries of a directory in one answer, so a listing this long may be cut short. */
const DIRECTORY_LISTING_LIMIT = 1_000;
const AGENT_LABEL_PAGES = 10;

/** The scope of a read made for a signed webhook delivery (or a bare installation lookup): it names no org. */
const WEBHOOK_SCOPE: GitHubTokenScope = { system: "webhook" };

/** What a tracking pass's reads ask for: the pull request, its reviews, the head's checks and statuses, the base branch and the workflow files, all at read. */
const STATUS_TOKEN_PERMISSIONS = { contents: "read", pull_requests: "read", checks: "read", statuses: "read" } as const;
/** The same without the checks and statuses access, for an installation that has not accepted it yet. */
/** How many pages of 100 reviews a tracking read takes. */
const REVIEW_PAGES_MAX = 5;
const BASIC_TOKEN_PERMISSIONS = { contents: "read", pull_requests: "read" } as const;

/** A repository the App can reach: its installation, and the owner as GitHub spells it. */
interface InstalledRepository {
  owner: string;
  name: string;
  installationId: number;
}

/**
 * Credentials from one GitHub App for repositories in every account it is installed on (#123).
 * Each repository's installation is looked up by its owner and cached for the process's
 * lifetime. There is no account allowlist: only administrators register repositories, and an
 * installation's token reaches only that installation's repositories.
 */
/** One attempt in the App's webhook delivery history (SRL-5a). `statusCode` is what the broker answered; 0 for a timeout or a refused connection. */
export interface GitHubWebhookDelivery {
  id: number;
  guid: string;
  deliveredAt: string;
  redelivery: boolean;
  event: string;
  action: string | null;
  statusCode: number;
}

export class GitHubAppCredentialProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly installations = new Map<string, Promise<{ id: number; login: string }>>();
  private readonly fileReadLimits = new WeakMap<object, number>();

  /** File-details reads opt into the neutral error without changing existing client callers or cached promises. */
  fileDetailsError(error: unknown): unknown {
    const retryAt = typeof error === "object" && error !== null ? this.fileReadLimits.get(error) : undefined;
    return retryAt === undefined ? error : new GithubCompareRateLimitError(retryAt);
  }

  private async unavailableFileRead(response: Response, message: string): Promise<never> {
    const error = agentXError("RUNTIME_UNAVAILABLE", message);
    const body: unknown = await response.json().catch(() => undefined);
    const retryAt = compareRateLimitRetryAt(response, body, this.now());
    if (retryAt !== undefined) this.fileReadLimits.set(error, retryAt);
    throw error;
  }

  private readonly readTokens = new Map<string, { token: Promise<string>; expiresAt: number }>();
  private slug: string | undefined;
  /** The bounded provider of each tracking pass's budget, so one pass's reads share one installation lookup. */
  private readonly passProviders = new WeakMap<GithubMergeReadBudget, GitHubAppCredentialProvider>();
  /** A tracking pass's provider keeps the installation tokens it minted, per repository and permission set, for the pass: a pass mints each kind once, not once per call. */
  private tokenCache: Map<string, Promise<string>> | undefined;

  constructor(private readonly options: GitHubAppCredentialProviderOptions) {
    if (typeof options.appId === "string" && !GITHUB_APP_ID.test(options.appId)) throw new Error("GitHub App ID must be numeric");
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async resolve(
    credentialRef: string,
    repositoryUrl: string,
    access: RepositoryAccess,
    scope: GitHubTokenScope,
  ): Promise<RepositoryCredential> {
    if (credentialRef !== this.options.credentialRef) return {};
    const repository = parseGitHubRepository(repositoryUrl);
    const token = await this.createInstallationToken(repository, {
      contents: access === "push" ? "write" : "read",
    }, scope);
    await this.waitUntilGitAccepts(repository, token, access);
    return { username: "x-access-token", password: token };
  }

  /**
   * `resolve`, and the expiry GitHub stated for the token it minted (`expires_at`), so the credential handed to a worker carries the real expiry and not one made up for it.
   * `expiresAt` is absent when GitHub's answer named none.
   */
  async resolveWithExpiry(credentialRef: string, repositoryUrl: string, access: RepositoryAccess, scope: GitHubTokenScope): Promise<RepositoryCredential & { expiresAt?: string }> {
    if (credentialRef !== this.options.credentialRef) return {};
    const repository = parseGitHubRepository(repositoryUrl);
    const expiry: { expiresAt?: string } = {};
    const token = await this.createInstallationToken(repository, { contents: access === "push" ? "write" : "read" }, scope, false, {}, false, expiry);
    await this.waitUntilGitAccepts(repository, token, access);
    return { username: "x-access-token", password: token, ...(expiry.expiresAt === undefined ? {} : { expiresAt: expiry.expiresAt }) };
  }

  /**
   * Asks GitHub's git endpoint for the repository's refs with the new token, as `git clone` does, until it stops answering 404 (a few seconds at most).
   * It never refuses: a token that stays unaccepted is handed over all the same, so the worker reports GitHub's own error, and a failed probe changes nothing.
   */
  private async waitUntilGitAccepts(repository: { owner: string; name: string }, token: string, access: RepositoryAccess): Promise<void> {
    const readiness = this.options.tokenReadiness;
    if (readiness === undefined) return;
    const delays = readiness.delaysMs ?? DEFAULT_TOKEN_READINESS_DELAYS_MS;
    const sleep = readiness.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
    const service = access === "push" ? "git-receive-pack" : "git-upload-pack";
    const url = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}.git/info/refs?service=${service}`;
    const headers = { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`, "user-agent": "git/2.45.0", accept: "*/*" };
    const issuedAt = this.now();
    for (let attempt = 0; ; attempt += 1) {
      const event = { repository: `${repository.owner}/${repository.name}`, access, attempt };
      let status: number;
      try {
        const response = await this.fetchImplementation(url, { headers, signal: AbortSignal.timeout(3_000), redirect: "error" });
        status = response.status;
        await response.body?.cancel().catch(() => undefined);
      } catch {
        readiness.onProbe?.({ ...event, outcome: "error", sinceIssuedMs: this.now() - issuedAt });
        return;
      }
      const outcome = status === 404 ? "not_found" : status >= 200 && status < 300 ? "ready" : "other";
      readiness.onProbe?.({ ...event, status, outcome, sinceIssuedMs: this.now() - issuedAt });
      const delay = delays[attempt];
      if (outcome !== "not_found" || delay === undefined) return;
      await sleep(delay);
    }
  }

  /**
   * Refuses, with CONFIG_INVALID, a repository of this App's credential that the App cannot reach. For an org on a cloud install GitHub is
   * asked afresh (as the gates do), so a repository the installation no longer covers is not accepted from the per-owner cache.
   */
  async checkRepository(repository: { credentialRef: string; url: string }, scope: GitHubTokenScope): Promise<void> {
    if (repository.credentialRef !== this.options.credentialRef) return;
    const parsed = parseGitHubRepository(repository.url);
    if ("orgId" in scope && this.options.requireInstallationBound !== undefined) await this.lookedUp(parsed, true);
    await this.installed(parsed, scope);
  }

  /** Confirms a signed webhook's repository identity against the App's current installation and GitHub API. */
  async verifyWebhookRepository(repositoryUrl: string, scope: GitHubWebhookRepositoryScope): Promise<boolean> {
    const parsed = parseGitHubRepository(repositoryUrl);
    const expectedFullName = `${parsed.owner}/${parsed.name}`.toLowerCase();
    if (scope.fullName.toLowerCase() !== expectedFullName) return false;
    // A signed delivery names no org: the repository is read to confirm what GitHub sent, never for an org's work.
    const installed = await this.installed(parsed, WEBHOOK_SCOPE);
    if (installed.installationId !== scope.installationId) return false;
    const token = await this.createInstallationToken(installed, { contents: "read" }, WEBHOOK_SCOPE);
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(installed.owner)}/${encodeURIComponent(installed.name)}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(5_000), redirect: "error" },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub repository lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid repository response");
    }
    const record = body as Record<string, unknown>;
    return Number.isSafeInteger(record.id) && record.id === scope.repositoryId
      && typeof record.full_name === "string" && record.full_name.toLowerCase() === expectedFullName;
  }

  /** Reads the immutable GitHub numeric identity for a server-registered repository URL. */
  async getRepositoryIdentity(repositoryUrl: string, scope: GitHubTokenScope): Promise<GitHubRepositoryIdentity | undefined> {
    const parsed = parseGitHubRepository(repositoryUrl);
    const expectedFullName = `${parsed.owner}/${parsed.name}`;
    const installed = await this.installed(parsed, scope);
    const token = await this.createInstallationToken(installed, { contents: "read" }, scope);
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(installed.owner)}/${encodeURIComponent(installed.name)}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(5_000), redirect: "error" },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub repository lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid repository response");
    const record = body as Record<string, unknown>;
    if (!Number.isSafeInteger(record.id) || typeof record.full_name !== "string" || record.full_name.toLowerCase() !== expectedFullName.toLowerCase()) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid repository identity");
    }
    // `private` is reported only when GitHub's answer is unambiguous (lessons visibility follow-up, G4): the answer must carry BOTH `private` and a `visibility` word, and they must agree. This code talks to api.github.com only
    // (`parseGitHubRepository` refuses every other host), and that API always sends `visibility`. An answer without it (an older GitHub Enterprise Server, which reports private: true for an internal repository that
    // every member of the enterprise can read, or any proxy or stand-in) cannot be told apart from one, so it reads as "unknown". An `internal` repository, and a visibility word this code does not know (may be wider
    // still), also leave `private` unset. Callers read an unset `private` as "unknown" (fail closed): the pull request description then carries a count and a link, never a lesson title.
    const visibility = typeof record.visibility === "string" ? record.visibility : undefined;
    const privateFlag = typeof record.private !== "boolean" || visibility === undefined ? undefined
      : visibility === "private" && record.private ? true
      : visibility === "public" && !record.private ? false
      : undefined;
    return { repositoryId: record.id as number, fullName: record.full_name, ...(typeof record.default_branch === "string" ? { defaultBranch: record.default_branch } : {}), ...(privateFlag === undefined ? {} : { private: privateFlag }) };
  }

  async issueCredentials(
    repository: { credentialRef: string; url: string },
    access: "read" | "write",
    scope: GitHubTokenScope,
  ): Promise<{ owner: string; repo: string; token: string }> {
    if (repository.credentialRef !== this.options.credentialRef) {
      throw agentXError("FORBIDDEN", "repository does not use the configured GitHub App");
    }
    const parsed = parseGitHubRepository(repository.url);
    const installed = await this.installed(parsed, scope);
    const token = await this.createInstallationToken(installed, { issues: access }, scope);
    return { owner: installed.owner, repo: parsed.name, token };
  }

  async reconcilePullRequest(input: GitHubPullRequestInput, scope: GitHubTokenScope): Promise<GitHubPullRequestResult> {
    const repository = await this.installed(parseGitHubRepository(input.repositoryUrl), scope);
    // GitHub's pull-request endpoint needs to resolve the private repository's
    // base and head refs. Keep the token repository-scoped, but allow it to
    // read those refs in addition to creating the pull request.
    const token = await this.createInstallationToken(repository, {
      contents: "read",
      pull_requests: "write",
    }, scope);
    // The draft state is GitHub's, read from the pull request object on every path (created, or found again after a lost response or a broker retry), so the record and the
    // owner's message are always truthful (I2): a draft was refused when one was asked for and the pull request is not a draft.
    const finish = (found: FoundPullRequest, reconciled: boolean, refusedForSure = false): GitHubPullRequestResult => {
      const { isDraft, ...result } = found;
      return { ...result, reconciled, ...(refusedForSure || (input.draft === true && isDraft === false) ? { draftRefused: true as const } : {}) };
    };
    const existing = await this.findOpenPullRequest(repository, input, token);
    if (existing) return finish(existing, true);

    try {
      const create = (draft: boolean | undefined, body: string | undefined) => this.fetchImplementation(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls`,
        {
          method: "POST",
          headers: githubHeaders(token),
          body: JSON.stringify({
            title: input.title,
            head: input.headBranch,
            base: input.baseBranch,
            ...(body === undefined ? {} : { body }),
            ...(draft === undefined ? {} : { draft }),
          }),
          redirect: "error", signal: AbortSignal.timeout(15_000), // L7a: the conformance suite found no redirect refusal or timeout here in Cloud v0.5.11
        },
      );
      let response = await create(input.draft, input.body);
      if (response.ok) return finish(parsePullRequestWithDraft(await response.json(), repository), false);
      // INTG1: GitHub answers 422 to a draft on a private repository whose plan has no drafts. That answer, and only that, is retried once as a normal pull request with the
      // do-not-merge note; the result says so. Any other answer, and a second refusal, fails below.
      let refusal = response.status === 422 ? await pullRequestRefusalOf(response) : undefined;
      if (refusal === "draft-unsupported" && input.draft === true) {
        response = await create(undefined, pullRequestBodyWithDraftNote(input.body));
        if (response.ok) return finish(parsePullRequestWithDraft(await response.json(), repository), false, true);
        refusal = response.status === 422 ? await pullRequestRefusalOf(response) : undefined;
      }
      const afterFailure = await this.findOpenPullRequest(repository, input, token);
      if (afterFailure) return finish(afterFailure, true);
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request creation failed with HTTP ${response.status}${refusal === undefined ? "" : `: ${PULL_REQUEST_REFUSAL_SENTENCES[refusal]}`}`);
    } catch (error) {
      if (isAgentXError(error)) throw error;
      const afterFailure = await this.findOpenPullRequest(repository, input, token);
      if (afterFailure) return finish(afterFailure, true);
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request creation outcome is unknown");
    }
  }

  async getPullRequest(repositoryUrl: string, number: number, scope: GitHubTokenScope): Promise<GitHubPullRequestDetails> {
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, {
      contents: "read",
      pull_requests: "read",
    }, scope);
    const details = await this.getPullRequestWithToken(repository, number, token);
    // Whose pull request it is: only asked when GitHub named an author (the App's own login is a lookup of its own).
    if (details.authorLogin === undefined) return details;
    const own = await this.ownBotLogin();
    return own === undefined ? details : { ...details, authoredByApp: details.authorLogin.toLowerCase() === own };
  }

  /**
   * A token for one repository that an agent's tool (or the broker, reading for an agent's run) uses. It carries exactly `permissions` plus
   * `metadata: read`, and nothing else. The allowed keys are issues, pull_requests, contents and metadata, plus `actions` and `deployments` at
   * `read` only (the GitHub Actions connector's, once `checkAgentTokenPermissions` lists them, as it does with Plan 4). Everything else is
   * refused (FORBIDDEN) before GitHub is asked: `contents: write`, `workflows`, `administration`, `actions: write`, `deployments: write` and every
   * other key. For an org on a cloud install the installation must be bound to the org, active, at this moment (`requireInstallationBound`),
   * like every other mint (PF10).
   */
  async createAgentInstallationToken(repository: string | { owner: string; name: string }, permissions: GitHubAgentTokenPermissions, scope: AgentGitHubScope, options: AgentTokenOptions = {}): Promise<string> {
    requireAgentScope(scope);
    const checked = checkAgentTokenPermissions(permissions);
    const installed = await this.installed(typeof repository === "string" ? parseGitHubRepository(repository) : repository, scope);
    requirePinnedInstallation(installed, options);
    return this.createInstallationToken(installed, { ...checked, metadata: "read" }, scope, false, options);
  }

  /** The repository as the installation spells it, checked for the org (once), with an agent token for it. */
  private async installedWithAgentToken(repositoryUrl: string, permissions: GitHubAgentTokenPermissions, scope: AgentGitHubScope, options: AgentTokenOptions): Promise<{ repository: InstalledRepository; token: string }> {
    requireAgentScope(scope);
    const checked = checkAgentTokenPermissions(permissions);
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    requirePinnedInstallation(repository, options);
    return { repository, token: await this.createInstallationToken(repository, { ...checked, metadata: "read" }, scope, false, options) };
  }

  /**
   * The head commit of a pull request, read with an agent token (`pull_requests: read`, `contents: read`) for the org, so a run that reviews it
   * checks out exactly that commit. A pull request that is not there is a clear refusal; anything else GitHub says is "unavailable".
   */
  async getAgentPullRequestHead(repositoryUrl: string, number: number, scope: AgentGitHubScope, options: AgentTokenOptions = {}): Promise<{ headSha: string; state: "open" | "closed" | "merged" }> {
    if (!Number.isSafeInteger(number) || number < 1) throw agentXError("CONFIG_INVALID", "pull request number is invalid");
    const { repository, token } = await this.installedWithAgentToken(repositoryUrl, { pull_requests: "read", contents: "read" }, scope, options);
    const response = await this.fetchImplementation(pullRequestUrl(repository, number), { headers: githubHeaders(token), signal: AbortSignal.timeout(AGENT_READ_TIMEOUT_MS), redirect: "error" });
    if (response.status === 404) {
      await response.body?.cancel();
      throw agentXError("CONFIG_INVALID", `pull request ${String(number)} of ${repository.owner}/${repository.name} doesn't exist`);
    }
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    const record = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const head = record.head !== null && typeof record.head === "object" ? record.head as Record<string, unknown> : {};
    if (record.number !== number || typeof head.sha !== "string" || !/^[a-f0-9]{40}$/u.test(head.sha) || (record.state !== "open" && record.state !== "closed") || typeof record.merged !== "boolean") {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
    }
    return { headSha: head.sha, state: record.merged ? "merged" : record.state };
  }

  /**
   * A read-only view of the repository's default branch for an org's run: one `contents: read` agent token, the default branch's head commit
   * read once, and every file and directory read at that commit. Nothing is cached beyond the reader's own life.
   */
  async agentRepositoryReader(repositoryUrl: string, scope: AgentGitHubScope, options: AgentTokenOptions = {}): Promise<AgentRepositoryReader> {
    const { repository, token } = await this.installedWithAgentToken(repositoryUrl, { contents: "read" }, scope, options);
    const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    const get = (path: string, accept?: string): Promise<Response> =>
      this.fetchImplementation(`${base}${path}`, { headers: { ...githubHeaders(token), ...(accept === undefined ? {} : { accept }) }, signal: AbortSignal.timeout(AGENT_READ_TIMEOUT_MS), redirect: "error" });
    const json = async (response: Response, what: string): Promise<unknown> => {
      if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub ${what} lookup failed with HTTP ${response.status}`);
      return response.json();
    };
    const info = await json(await get(""), "repository");
    const defaultBranch = info !== null && typeof info === "object" && "default_branch" in info && typeof info.default_branch === "string" ? info.default_branch : undefined;
    if (defaultBranch === undefined || defaultBranch === "") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid repository response");
    const ref = await json(await get(`/git/ref/heads/${defaultBranch.split("/").map(encodeURIComponent).join("/")}`), "branch");
    const refObject = ref !== null && typeof ref === "object" && "object" in ref && ref.object !== null && typeof ref.object === "object" ? ref.object as Record<string, unknown> : {};
    const commit = refObject.sha;
    if (typeof commit !== "string" || !/^[a-f0-9]{40}$/u.test(commit)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid branch response");
    const contents = (path: string): string => {
      const segments = path.split("/");
      if (path === "" || path.length > 512 || path.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw agentXError("CONFIG_INVALID", "file path is invalid");
      return `/contents/${segments.map(encodeURIComponent).join("/")}?ref=${commit}`;
    };
    return {
      defaultBranch,
      commit,
      async list(path) {
        const response = await get(contents(path));
        if (response.status === 404) { await response.body?.cancel(); return undefined; }
        const body = await json(response, "directory");
        // Only a 404 is "not there": a 200 that is not a listing (a file, a link, a submodule) is something this reader can't read.
        if (!Array.isArray(body)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub did not answer with a directory listing");
        const entries = body.map((entry): AgentRepositoryEntry => {
          const record = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {};
          if (typeof record.name !== "string" || typeof record.path !== "string" || typeof record.sha !== "string" || typeof record.size !== "number") {
            throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid directory listing");
          }
          const type = record.type === "file" || record.type === "dir" || record.type === "symlink" || record.type === "submodule" ? record.type : "other";
          return { name: record.name, path: record.path, type, sha: record.sha, size: record.size };
        });
        return { entries, truncated: entries.length >= DIRECTORY_LISTING_LIMIT };
      },
      async read(path, maxBytes) {
        const response = await get(contents(path));
        if (response.status === 404) { await response.body?.cancel(); return undefined; }
        const body = await json(response, "file");
        // A directory where a file was asked for is not a file there; anything else that is not a file (a link, a submodule, an odd answer) can't be read.
        if (Array.isArray(body)) return undefined;
        const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : undefined;
        if (record === undefined || record.type !== "file" || typeof record.sha !== "string" || typeof record.size !== "number") {
          throw agentXError("RUNTIME_UNAVAILABLE", "GitHub did not answer with a file");
        }
        if (record.size > maxBytes) return { sha: record.sha, size: record.size, tooLarge: true };
        if (record.encoding !== "base64" || typeof record.content !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid file response");
        const bytes = Buffer.from(record.content, "base64");
        if (bytes.byteLength !== record.size) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an incomplete file");
        return { sha: record.sha, size: record.size, text: bytes.toString("utf8") };
      },
    };
  }

  /**
   * The repository's labels, read with an agent token (`issues: read`) for the org: the numeric id and the node id of each with its name, so a
   * label id in an agent's call can be turned into the name a trigger-label rule checks. More than 1,000 labels throws: an id that can't be
   * looked up is treated as consequential by the caller.
   */
  async listAgentRepositoryLabels(repositoryUrl: string, scope: AgentGitHubScope, options: AgentTokenOptions = {}): Promise<AgentRepositoryLabel[]> {
    const { repository, token } = await this.installedWithAgentToken(repositoryUrl, { issues: "read" }, scope, options);
    const labels: AgentRepositoryLabel[] = [];
    for (let page = 1; page <= AGENT_LABEL_PAGES; page += 1) {
      const response = await this.fetchImplementation(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/labels?per_page=100&page=${String(page)}`,
        { headers: githubHeaders(token), signal: AbortSignal.timeout(AGENT_READ_TIMEOUT_MS), redirect: "error" },
      );
      if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub label lookup failed with HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid label listing");
      for (const entry of body) {
        const record = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {};
        if (!Number.isSafeInteger(record.id) || typeof record.node_id !== "string" || typeof record.name !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid label listing");
        labels.push({ id: record.id as number, nodeId: record.node_id, name: record.name });
      }
      if (body.length < 100) return labels;
    }
    throw agentXError("RUNTIME_UNAVAILABLE", "this repository has too many labels to look up");
  }

  /**
   * A provider whose every request counts against `budget` (and stops with it) and whose rate-limit answers become `GithubMergeRateLimitError`. It is a new instance,
   * so it cannot reuse or populate the singleton provider's caches.
   */
  private boundedProvider(budget: GithubMergeReadBudget): GitHubAppCredentialProvider {
    const boundedFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (budget.signal.aborted) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub merge observation was cancelled");
      budget.beforeRequest();
      if (budget.signal.aborted) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub merge observation was cancelled");
      const signals = [budget.signal, init?.signal, AbortSignal.timeout(5_000)]
        .filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
      const response = await this.fetchImplementation(input, { ...init, signal: AbortSignal.any(signals) });
      const retryAt = mergeRateLimitRetryAt(response, this.now());
      if (retryAt !== undefined) throw new GithubMergeRateLimitError(retryAt);
      return response;
    }) as typeof fetch;
    return new GitHubAppCredentialProvider({ ...this.options, fetchImplementation: boundedFetch, now: this.now });
  }

  /** A bounded, stable merge-state read that cannot reuse or populate the singleton provider's caches. */
  async getPullRequestMergeObservation(
    repositoryUrl: string,
    number: number,
    budget: GithubMergeReadBudget,
    tokenScope: GitHubTokenScope,
  ): Promise<GitHubPullRequestDetails & { headTreeSha: string }> {
    const scoped = this.boundedProvider(budget);
    const repository = parseGitHubRepository(repositoryUrl);
    let installed: InstalledRepository;
    try {
      installed = await scoped.installed(repository, tokenScope);
    } catch (error) {
      if (error instanceof GithubMergeRateLimitError) throw error;
      if (isAgentXError(error) && error.code === "CONFIG_INVALID") {
        throw agentXError("RUNTIME_UNAVAILABLE", "GitHub merge observation installation is unavailable");
      }
      throw error;
    }
    const token = await scoped.createInstallationToken(installed, { contents: "read", pull_requests: "read" }, tokenScope);
    const before = await scoped.getPullRequestWithToken(installed, number, token);
    assertMergePullRequestIdentity(before, number);
    const headTreeSha = await scoped.getCommitTreeWithToken(installed, before.headCommit, token);
    const after = await scoped.getPullRequestWithToken(installed, number, token);
    assertMergePullRequestIdentity(after, number);
    if (before.number !== after.number || before.url !== after.url || before.headCommit !== after.headCommit
      || before.state !== after.state || before.mergeCommit !== after.mergeCommit) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub merge observation changed during the read");
    }
    return { ...after, headTreeSha };
  }

  /** The two immutable revisions used for file types. The compare answer supplies the merge base. */
  async getPullRequestFileRevisions(repositoryUrl: string, number: number, scope: GitHubTokenScope): Promise<{ head: string; base: string }> {
    if (!Number.isSafeInteger(number) || number < 1) throw agentXError("CONFIG_INVALID", "Invalid change request.");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.diffTokenFor(repository, scope);
    const root = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    const read = await this.trackingJson(`${root}/pulls/${number}`, token, { rateLimit: true });
    const pr = statusRecord(read.body);
    const head = statusRecord(pr.head).sha, tip = statusRecord(pr.base).ref;
    if (read.status !== 200 || typeof head !== "string" || typeof tip !== "string" || !/^[a-f0-9]{40}$/u.test(head) || !GitBranchNameSchema.safeParse(tip).success) throw agentXError("RUNTIME_UNAVAILABLE", "The change request revisions are unavailable.");
    const compare = await this.trackingJson(`${root}/compare/${encodeURIComponent(tip)}...${head}?per_page=1`, token, { rateLimit: true });
    const base = statusRecord(statusRecord(compare.body).merge_base_commit).sha;
    if (compare.status !== 200 || typeof base !== "string" || !/^[a-f0-9]{40}$/u.test(base)) throw agentXError("RUNTIME_UNAVAILABLE", "The merge base is unavailable.");
    return { head, base };
  }

  /** A read-only page, keeping full patches for the session boundary's redaction and byte cap. */
  async listPullRequestFiles(repositoryUrl: string, number: number, options: { page: number }, scope: GitHubTokenScope): Promise<{ files: Array<GitHubPullRequestChangedFile & { previous_filename?: string }>; nextPage?: number }> {
    if (!Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(options.page) || options.page < 1 || options.page > 10_000) throw agentXError("CONFIG_INVALID", "Invalid diff page.");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.diffTokenFor(repository, scope);
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}/files?per_page=100&page=${options.page}`,
      { headers: { ...githubHeaders(token), accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(8_000), redirect: "error" },
    );
    if (!response.ok) {
      return this.unavailableFileRead(response, "The pull request diff is unavailable.");
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body) || body.length > 100) throw agentXError("RUNTIME_UNAVAILABLE", "Invalid pull request diff.");
    const files = body.map((entry: unknown): GitHubPullRequestChangedFile & { previous_filename?: string } => {
      if (entry === null || typeof entry !== "object") throw agentXError("RUNTIME_UNAVAILABLE", "Invalid pull request file.");
      const file = entry as Record<string, unknown>;
      if (typeof file.filename !== "string" || typeof file.status !== "string" || !Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions)) throw agentXError("RUNTIME_UNAVAILABLE", "Invalid pull request file.");
      return { filename: file.filename, status: file.status, additions: file.additions as number, deletions: file.deletions as number,
        ...(typeof file.patch === "string" ? { patch: file.patch } : {}), ...(typeof file.previous_filename === "string" ? { previous_filename: file.previous_filename } : {}) };
    });
    const hasNext = (response.headers.get("link") ?? "").split(",").some(link => /;\s*rel="next"/.test(link));
    return { files, ...(hasNext && options.page < 10_000 ? { nextPage: options.page + 1 } : {}) };
  }

  /**
   * Lessons capture: a read-only GET of one COMPARE of an installed repository (`/repos/<owner>/<name>/compare/<base>...<head>`), with a token that asks for `contents: read` only. The caller learns what the
   * people changed after Rovara's last push. Any other path is refused before GitHub is asked, so this cannot read anything but a compare of the repository it names.
   */
  async getRepositoryCompareJson(repositoryUrl: string, apiPath: string, scope: GitHubTokenScope): Promise<{ status: number; body: unknown }> {
    const repository = parseGitHubRepository(repositoryUrl);
    const prefix = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/compare/`;
    if (!apiPath.startsWith(prefix) || !/^[0-9a-f]{40}\.\.\.[0-9a-f]{40}(\?per_page=\d{1,3})?$/u.test(apiPath.slice(prefix.length))) throw agentXError("CONFIG_INVALID", "not a compare path of this repository");
    let token: string;
    try {
      const installed = await this.installed(repository, scope);
      token = await this.createInstallationToken(installed, { contents: "read" }, scope);
    } catch (error) {
      // A repository the App no longer covers (removed from the installation, or the installation no longer bound to this company) has nothing to read, now or on any retry: answered as "not found", never thrown.
      if (isAgentXError(error) && (error.code === "CONFIG_INVALID" || error.code === "GITHUB_NOT_CONNECTED")) return { status: 404, body: undefined };
      throw error;
    }
    return this.trackingJson(`https://api.github.com${apiPath}`, token, { rateLimit: true });
  }

  /** The provider a tracking pass reads through: itself with no budget, else one bounded provider per budget (a pass's reads share its installation lookup). */
  private trackingProvider(budget: GithubMergeReadBudget | undefined): GitHubAppCredentialProvider {
    if (budget === undefined) return this;
    let provider = this.passProviders.get(budget);
    if (provider === undefined) {
      provider = this.boundedProvider(budget);
      provider.tokenCache = new Map();
      this.passProviders.set(budget, provider);
    }
    return provider;
  }

  private async trackingJson(url: string, token: string, init: { method?: string; body?: unknown; rateLimit?: boolean } = {}): Promise<{ status: number; body: unknown }> {
    const response = await this.fetchImplementation(url, {
      method: init.method ?? "GET", headers: githubHeaders(token), redirect: "error", signal: AbortSignal.timeout(8_000),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    let body: unknown;
    try {
      body = response.status === 204 ? undefined : await response.json();
    } catch {
      body = undefined;
    }
    // A caller that asked for it (`rateLimit`) never gets a rate limit as an ordinary answer: GitHub's limits are mostly a 403 (the primary limit with `x-ratelimit-remaining: 0`, the secondary with `retry-after`, or only
    // the words in the message), and "no access" is a 403 too. It throws the neutral rate-limit error with the time to ask again; a 403 without any such signal is returned as it is.
    if (init.rateLimit === true) {
      const retryAt = compareRateLimitRetryAt(response, body, this.now());
      if (retryAt !== undefined) throw new GithubCompareRateLimitError(retryAt);
    }
    return { status: response.status, body };
  }

  /**
   * What GitHub says about one pull request for merge tracking (Plan 6 Task 14): the pull request, its reviews (paged), the head's checks with whether the base requires
   * each (GraphQL `statusCheckRollup`, `isRequired`), whether the base requires any check and whether the head holds workflow files. Read-only: the token asks for
   * `contents`, `pull_requests`, `checks` and `statuses` at read. With a `budget` every request counts against it. An answer that does not fit throws.
   */
  async getPullRequestStatus(repositoryUrl: string, number: number, scope: GitHubTokenScope, budget?: GithubMergeReadBudget): Promise<PullRequestStatus> {
    const provider = this.trackingProvider(budget);
    const repository = await provider.installed(parseGitHubRepository(repositoryUrl), scope);
    // The checks and statuses permissions are new to the App: an installation that has not accepted them refuses the token. Then everything else is still read, with a token
    // that asks for less, and the checks are said to be unavailable (never passing).
    let token: string;
    let checksUnavailable = false;
    try {
      token = await provider.createInstallationToken(repository, STATUS_TOKEN_PERMISSIONS, scope);
    } catch (error) {
      if (!isAgentXError(error) || (error.code !== "GITHUB_NOT_CONNECTED" && error.code !== "RUNTIME_UNAVAILABLE")) throw error;
      token = await provider.createInstallationToken(repository, BASIC_TOKEN_PERMISSIONS, scope);
      checksUnavailable = true;
    }
    const root = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    const pulled = await provider.trackingJson(pullRequestUrl(repository, number), token);
    if (pulled.status !== 200) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${pulled.status}`);
    const raw = statusRecord(pulled.body);
    const details = parsePullRequestDetails(raw, repository);
    if (details.number !== number || typeof raw.draft !== "boolean" || !/^[a-f0-9]{40}$/.test(details.headCommit)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request status identity");
    }
    const reviews: PullRequestReview[] = [];
    let reviewsIncomplete = false;
    // At most five pages of reviews: past that, what is on the pull request is not known, and no approval is read from the list.
    for (const value of await provider.feedbackPages(`${pullRequestUrl(repository, number)}/reviews`, token, { maxPages: REVIEW_PAGES_MAX, onTruncated: () => { reviewsIncomplete = true; } })) {
      const review = parseReview(value);
      if (review !== undefined) reviews.push(review);
    }
    let checks: PullRequestCheck[] = [];
    if (!checksUnavailable) {
      try {
        checks = await provider.rollupChecks(token, repository, number, details.headCommit);
      } catch (error) {
        // GitHub refused or failed the list (the field, the access): the checks are unknown. A rate limit or a spent allowance is not this and goes on up.
        if (!isAgentXError(error) || error.code !== "RUNTIME_UNAVAILABLE") throw error;
        checksUnavailable = true;
      }
    }
    const mergeableState = parseMergeableState(raw.mergeable_state);
    const baseRef = details.baseBranch.split("/").map(encodeURIComponent).join("/");
    let behindBy: number | undefined;
    if (mergeableState !== "dirty" && mergeableState !== "behind" && mergeableState !== "unknown" && details.state === "open") {
      const compared = await provider.trackingJson(`${root}/compare/${baseRef}...${details.headCommit}`, token);
      if (compared.status !== 403) {
        const count = compared.status === 200 ? statusRecord(compared.body).behind_by : undefined;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid comparison");
        behindBy = count;
      }
    }
    // Workflow files: a refusal reads as "there may be some", which only delays reading "no CI".
    const files = await provider.trackingJson(`${root}/contents/.github/workflows?ref=${details.headCommit}`, token);
    let headHasWorkflowFiles = files.status === 403;
    if (files.status === 200) {
      headHasWorkflowFiles = Array.isArray(files.body) && files.body.some((entry) => typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string" && /\.ya?ml$/iu.test((entry as { name: string }).name));
    } else if (files.status !== 404 && files.status !== 403) {
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub workflow files lookup failed with HTTP ${files.status}`);
    }
    // Which checks the base requires, from classic protection and from the rulesets, taken together. A read that fails, is refused, finds no branch or does not parse leaves
    // the required checks unknown, and unknown checks are never a pass.
    const requiredChecks: RequiredCheck[] = [];
    const branch = await provider.trackingJson(`${root}/branches/${baseRef}`, token);
    if (branch.status === 200) {
      try {
        mergeRequiredChecks(requiredChecks, requiredChecksFromProtection(branch.body));
      } catch {
        checksUnavailable = true;
      }
    } else {
      checksUnavailable = true;
    }
    const rules = await provider.trackingJson(`${root}/rules/branches/${baseRef}`, token);
    if (rules.status === 200) {
      try {
        mergeRequiredChecks(requiredChecks, requiredChecksFromRules(rules.body));
      } catch {
        checksUnavailable = true;
      }
    } else {
      checksUnavailable = true;
    }
    return {
      number: details.number, state: details.state, draft: raw.draft, headSha: details.headCommit, baseBranch: details.baseBranch, mergeableState,
      ...(typeof raw.mergeable === "boolean" ? { mergeable: raw.mergeable } : {}),
      ...(behindBy === undefined ? {} : { behindBy }), checks, ...(checksUnavailable ? { checksUnavailable: true as const } : {}), requiredChecks,
      baseHasRequiredChecks: requiredChecks.length > 0 || checks.some((check) => check.required),
      headHasWorkflowFiles, requestedReviewers: requestedReviewerCount(raw), ...(requestedReviewerIds(raw).length === 0 ? {} : { requestedReviewerIds: requestedReviewerIds(raw) }), reviews, ...(reviewsIncomplete ? { reviewsIncomplete: true as const } : {}),
    };
  }

  /** The head commit's checks and commit statuses, five pages of 100 at most (more throws: the list would be incomplete). */
  private async rollupChecks(token: string, repository: InstalledRepository, number: number, head: string): Promise<PullRequestCheck[]> {
    const checks: PullRequestCheck[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 5; page += 1) {
      const data = await this.feedbackGraphql(token, `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$name) { nameWithOwner pullRequest(number:$number) { number headRefOid
          commits(last:1) { nodes { commit { oid statusCheckRollup { state contexts(first:100,after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { __typename
              ... on CheckRun { name status conclusion detailsUrl databaseId checkSuite { app { databaseId } } isRequired(pullRequestNumber:$number) }
              ... on StatusContext { context state targetUrl isRequired(pullRequestNumber:$number) } } } } } } }
        } }
      }`, { owner: repository.owner, name: repository.name, number, cursor });
      const repo = statusRecord(data.repository);
      const pull = statusRecord(repo.pullRequest);
      if (repo.nameWithOwner !== `${repository.owner}/${repository.name}` || pull.number !== number || pull.headRefOid !== head) {
        throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request status read refused: scope or head changed");
      }
      const nodes = Array.isArray(statusRecord(pull.commits).nodes) ? statusRecord(pull.commits).nodes as unknown[] : [];
      const commit = nodes.length === 0 ? undefined : statusRecord(statusRecord(nodes[0]).commit);
      if (commit === undefined || commit.oid !== head) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request status read refused: head commit missing");
      const rollup = commit.statusCheckRollup === null || commit.statusCheckRollup === undefined ? undefined : statusRecord(commit.statusCheckRollup);
      // No rollup: nothing has reported on this commit yet.
      if (rollup === undefined) return checks;
      const connection = feedbackConnection(rollup.contexts);
      for (const node of connection.nodes) checks.push(parseRollupContext(node));
      cursor = nextFeedbackCursor(connection, seen);
      if (cursor === null) return checks;
    }
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request status read refused: too many checks to read");
  }

  /**
   * The person's permission on the repository (`GET collaborators/{login}/permission`): `admin`, `write` (`maintain` reads as `write`), `read` or `none` (a 404). The App
   * permission this needs is checked at staging.
   */
  async getRepositoryPermission(repositoryUrl: string, login: string, scope: GitHubTokenScope, budget?: GithubMergeReadBudget): Promise<"admin" | "write" | "read" | "none"> {
    return (await this.getRepositoryStanding(repositoryUrl, login, scope, budget)).permission;
  }

  /**
   * The person's permission (as `getRepositoryPermission`) and the kind of account GitHub says they are: the permission answer names its `user` and that user's `type` (`User`, `Bot`, `Organization`)
   * (Plan 6 Task 16). The kind is absent when GitHub does not say; the rule for an automatic fix then relies on the login (a bot's ends in `[bot]`). Verify at staging that the answer carries it.
   */
  async getRepositoryStanding(repositoryUrl: string, login: string, scope: GitHubTokenScope, budget?: GithubMergeReadBudget): Promise<{ permission: "admin" | "write" | "read" | "none"; userType?: string }> {
    if (!GITHUB_LOGIN.test(login)) throw agentXError("CONFIG_INVALID", "GitHub login is invalid");
    const provider = this.trackingProvider(budget);
    const repository = await provider.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await provider.createInstallationToken(repository, BASIC_TOKEN_PERMISSIONS, scope);
    const answered = await provider.trackingJson(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/collaborators/${encodeURIComponent(login)}/permission`, token,
    );
    // 404: not a collaborator. 403: the App may not ask about this person; a person it cannot vouch for has no permission here (and does not count).
    if (answered.status === 404 || answered.status === 403) return { permission: "none" };
    if (answered.status !== 200) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub permission lookup failed with HTTP ${answered.status}`);
    const permission = parseRepositoryPermission(answered.body);
    const user = (answered.body as { user?: unknown } | null)?.user;
    const kind = user !== null && typeof user === "object" ? (user as { type?: unknown }).type : undefined;
    return { permission, ...(typeof kind === "string" && kind.length > 0 ? { userType: kind.slice(0, 20) } : {}) };
  }

  /**
   * Replies once in a review thread, to a comment of it (`POST pulls/{n}/comments/{id}/replies`): the one place Rovara writes into a thread of comments (Plan 6 Task 16). The text is Rovara's own and fixed.
   * A comment or thread that is gone (404, 422) is "gone": nothing to reply to, not an error.
   */
  async replyToReviewThread(repositoryUrl: string, number: number, commentId: string, body: string, scope: GitHubTokenScope, budget?: GithubMergeReadBudget): Promise<"replied" | "gone"> {
    if (!/^[1-9][0-9]{0,18}$/.test(commentId)) throw agentXError("CONFIG_INVALID", "review comment id is invalid");
    if (body.length === 0 || body.length > 200 || /[\p{Cc}@]/u.test(body)) throw agentXError("CONFIG_INVALID", "the reply is not Rovara's fixed text");
    const provider = this.trackingProvider(budget);
    const repository = await provider.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await provider.createInstallationToken(repository, { contents: "read", pull_requests: "write" }, scope);
    const marker = this.options.personalToken?.ownComment.marker;
    const answered = await provider.trackingJson(`${pullRequestUrl(repository, number)}/comments/${commentId}/replies`, token, { method: "POST", body: { body: marker === undefined ? body : `${body}\n\n${marker}` } });
    if (answered.status === 404 || answered.status === 422) return "gone";
    if (answered.status !== 201 && answered.status !== 200) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub reply failed with HTTP ${answered.status}`);
    return "replied";
  }

  /**
   * Lane L12 (decision 66): the comments on a pull request's conversation (`GET issues/{n}/comments`: the comments of the pull request itself, not of its review threads), oldest first, created or edited since `since`,
   * one page of 100. FETCH ONLY: each comment is what GitHub says (text, author, times, the issue it is on); whether it is a command, fresh, edited or from someone who may approve is the core's to decide. A comment
   * that says it is on another issue than the one asked is left out. A pull request that is gone reads as no comments.
   */
  async listPullRequestComments(repositoryUrl: string, number: number, options: { since?: string; page?: number }, scope: GitHubTokenScope, budget?: GithubMergeReadBudget): Promise<{ comments: GitHubIssueComment[]; nextPage?: number }> {
    const page = options.page ?? 1;
    if (!Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(page) || page < 1 || page > 50) throw agentXError("CONFIG_INVALID", "the pull request or the page is invalid");
    if (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) throw agentXError("CONFIG_INVALID", "the time to read comments from is invalid");
    const provider = this.trackingProvider(budget);
    const repository = await provider.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await provider.createInstallationToken(repository, { pull_requests: "read", issues: "read", metadata: "read" }, scope);
    const root = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${String(number)}/comments`;
    const answered = await provider.trackingJson(`${root}?per_page=100&page=${String(page)}${options.since === undefined ? "" : `&since=${encodeURIComponent(new Date(Date.parse(options.since)).toISOString())}`}`, token);
    if (answered.status === 404 || answered.status === 410) return { comments: [] };
    if (answered.status !== 200 || !Array.isArray(answered.body)) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub comment read failed with HTTP ${answered.status}`);
    const comments = answered.body.flatMap((value): GitHubIssueComment[] => {
      const record = statusRecord(value);
      const user = statusRecord(record.user);
      // WHERE GitHub says the comment is: parsed from its own `issue_url`, not from what was asked. A comment that says nothing about its place is left out (the core cannot judge it).
      const place = typeof record.issue_url === "string" ? parseIssueUrl(record.issue_url, new URL(root).origin) : undefined;
      if (!(typeof record.id === "number" || typeof record.id === "string") || typeof record.body !== "string" || typeof user.login !== "string" || user.login === ""
        || typeof record.created_at !== "string" || typeof record.updated_at !== "string" || place === undefined) return [];
      const type = typeof user.type === "string" ? user.type : "User";
      return [{
        id: String(record.id), onRepositoryUrl: place.repositoryUrl, number: place.number, body: record.body.slice(0, 65_536), authorLogin: user.login, ...(typeof user.id === "number" ? { authorId: String(user.id) } : {}),
        // GitHub's words for an automation account (`Bot`, a `[bot]` login) end here; the contract carries a plain flag.
        isBot: type === "Bot" || user.login.endsWith("[bot]"), createdAt: record.created_at, updatedAt: record.updated_at,
        url: typeof record.html_url === "string" && record.html_url.startsWith("https://") ? record.html_url : "",
      }];
    });
    return { comments, ...(answered.body.length >= 100 ? { nextPage: page + 1 } : {}) };
  }

  /**
   * Lane L12: posts one comment of Rovara's own fixed text on a pull request's conversation (`POST issues/{n}/comments`). The text is one short sentence with no mention or control character; with the owner's
   * own token (L11) it carries the hidden marker, so the core reads it as Rovara's and never as a command. A pull request that is gone is `gone`.
   */
  async postPullRequestComment(repositoryUrl: string, number: number, text: string, scope: GitHubTokenScope, budget?: GithubMergeReadBudget): Promise<"posted" | "gone"> {
    if (!Number.isSafeInteger(number) || number < 1 || text.length === 0 || text.length > 200 || /[\p{Cc}@]/u.test(text)) throw agentXError("CONFIG_INVALID", "the comment is not Rovara's fixed text");
    const provider = this.trackingProvider(budget);
    const repository = await provider.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await provider.createInstallationToken(repository, { issues: "write", pull_requests: "write", metadata: "read" }, scope);
    const marker = this.options.personalToken?.ownComment.marker;
    const answered = await provider.trackingJson(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${String(number)}/comments`, token, { method: "POST", body: { body: marker === undefined ? text : `${text}\n\n${marker}` } });
    if (answered.status === 404 || answered.status === 410) return "gone";
    if (answered.status !== 201 && answered.status !== 200) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub comment failed with HTTP ${answered.status}`);
    return "posted";
  }

  /**
   * Slice 5 (ticket updates): posts one comment on an issue (`POST issues/{n}/comments`), with a token that asks for `issues: write` on this one repository only. `requirePrivate`: the
   * repository must say it is private, or nothing is posted and the answer is `public` (a task only its owner sees never writes to a public issue). An issue that is gone (404, 410) is
   * `not_found`; an App that may not write issues there is GitHub's refusal of the token (`GITHUB_NOT_CONNECTED`), thrown for the caller to report. Other faults throw `RUNTIME_UNAVAILABLE`.
   */
  async commentOnIssue(repositoryUrl: string, number: number, body: string, scope: GitHubTokenScope, options: { requirePrivate: boolean }): Promise<"posted" | "public" | "not_found"> {
    if (!Number.isInteger(number) || number < 1 || body.length === 0 || body.length > 2_000 || /[\p{Cc}@]/u.test(body.replace(/\n/gu, ""))) throw agentXError("CONFIG_INVALID", "the comment is not Rovara's fixed text");
    const provider = this.trackingProvider(undefined);
    const repository = await provider.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await provider.createInstallationToken(repository, { issues: "write", metadata: "read" }, scope);
    if (options.requirePrivate) {
      const repo = await provider.trackingJson(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`, token);
      if (repo.status !== 200) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub repository lookup failed with HTTP ${repo.status}`);
      if (statusRecord(repo.body).private !== true) return "public";
    }
    const answered = await provider.trackingJson(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${String(number)}/comments`, token, { method: "POST", body: { body } });
    if (answered.status === 404 || answered.status === 410) return "not_found";
    if (answered.status === 403) throw agentXError("GITHUB_NOT_CONNECTED", "GitHub refused the comment");
    if (answered.status !== 201 && answered.status !== 200) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub comment failed with HTTP ${answered.status}`);
    return "posted";
  }

  /** Takes a draft pull request out of draft (GraphQL `markPullRequestReadyForReview`); one that is ready already is left alone. */
  async markPullRequestReady(repositoryUrl: string, number: number, scope: GitHubTokenScope, budget?: GithubMergeReadBudget): Promise<"ready" | "already_ready"> {
    const provider = this.trackingProvider(budget);
    const repository = await provider.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await provider.createInstallationToken(repository, { contents: "read", pull_requests: "write" }, scope);
    const pulled = await provider.trackingJson(pullRequestUrl(repository, number), token);
    if (pulled.status !== 200) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${pulled.status}`);
    const raw = statusRecord(pulled.body);
    parsePullRequestDetails(raw, repository);
    if (raw.number !== number || typeof raw.draft !== "boolean" || typeof raw.node_id !== "string" || raw.node_id.length === 0 || raw.node_id.length > 200) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request identity");
    }
    if (raw.draft === false) return "already_ready";
    const data = await provider.feedbackGraphql(token, `mutation($id:ID!) { markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { isDraft } } }`, { id: raw.node_id });
    const marked = statusRecord(statusRecord(data.markPullRequestReadyForReview).pullRequest);
    if (marked.isDraft !== false) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub did not take the pull request out of draft");
    return "ready";
  }

  /**
   * Asks for reviews: a name with a `/` (`org/team`) is a team, any other a person. One call; `refused` when GitHub refuses it (a name it cannot request, such as the
   * author), which is not an error: the pull request is simply left as it is.
   */
  async requestReviewers(repositoryUrl: string, number: number, reviewers: readonly string[], scope: GitHubTokenScope, budget?: GithubMergeReadBudget): Promise<"requested" | "refused"> {
    if (reviewers.length === 0 || reviewers.length > 10) throw agentXError("CONFIG_INVALID", "reviewers must be one to ten names");
    const users: string[] = [];
    const teams: string[] = [];
    for (const name of reviewers) {
      const parts = name.split("/");
      if (parts.length === 1 && GITHUB_LOGIN.test(name)) users.push(name);
      else if (parts.length === 2 && GITHUB_LOGIN.test(parts[0]!) && /^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]!)) {
        // A team belongs to an organization: only the repository's own is asked for, so `other-org/admins` never reaches this repository's `admins`.
        if (parts[0]!.toLowerCase() !== parseGitHubRepository(repositoryUrl).owner.toLowerCase()) throw agentXError("CONFIG_INVALID", "reviewer team is not in the repository's organization");
        teams.push(parts[1]!);
      }
      else throw agentXError("CONFIG_INVALID", "reviewer name is invalid");
    }
    const provider = this.trackingProvider(budget);
    const repository = await provider.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await provider.createInstallationToken(repository, { contents: "read", pull_requests: "write" }, scope);
    const answered = await provider.trackingJson(`${pullRequestUrl(repository, number)}/requested_reviewers`, token, { method: "POST", body: { reviewers: users, team_reviewers: teams } });
    if (answered.status === 422) return "refused";
    if (answered.status !== 201 && answered.status !== 200) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub reviewer request failed with HTTP ${answered.status}`);
    return "requested";
  }

  /**
   * Merges a pull request (Plan 6 Task 19): `PUT pulls/{n}/merge` with `sha`, the head the caller checked, so GitHub refuses when the head moved. The token asks for `contents` and
   * `pull_requests` at write on this one repository. A method the repository does not allow is tried once more with the other of `squash` and `merge` (never `rebase`). A refusal
   * (405, 409, 422, or a 200 that does not say merged) reads the pull request again and says what it finds: already merged, closed, head changed, or not mergeable. GitHub's own reason
   * (branch protection, a required check, a ruleset) rides along as `githubMessage`, cleaned and cut (`githubReasonOf`), so the person sees why. A rate limit, a server fault and an unreadable pull request throw `RUNTIME_UNAVAILABLE`, to be tried again (the caller's claim keeps that from merging twice).
   */
  async mergePullRequest(repositoryUrl: string, number: number, input: { sha: string; method: "squash" | "merge" }, scope: GitHubTokenScope): Promise<MergePullRequestResult> {
    if (!/^[a-f0-9]{40}$/u.test(input.sha)) throw agentXError("CONFIG_INVALID", "the commit to merge is invalid");
    if (input.method !== "squash" && input.method !== "merge") throw agentXError("CONFIG_INVALID", "the merge method is invalid");
    if (!Number.isInteger(number) || number < 1) throw agentXError("CONFIG_INVALID", "pull request number is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, { contents: "write", pull_requests: "write" }, scope);
    let method = input.method;
    let fellBack = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(`${pullRequestUrl(repository, number)}/merge`, {
          method: "PUT", headers: githubHeaders(token), body: JSON.stringify({ sha: input.sha, merge_method: method }), redirect: "error", signal: AbortSignal.timeout(15_000),
        });
      } catch {
        // The request may or may not have reached GitHub: the caller's next run reads the pull request and finds out.
        throw agentXError("RUNTIME_UNAVAILABLE", "GitHub merge outcome is unknown");
      }
      const parsedBody: unknown = await response.json().catch(() => undefined);
      const body: Record<string, unknown> = parsedBody !== null && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? parsedBody as Record<string, unknown> : {};
      if (response.status === 200 && body.merged === true) {
        const commit = typeof body.sha === "string" && /^[a-f0-9]{40}$/u.test(body.sha) ? body.sha : undefined;
        return { outcome: "merged", method, fellBack, ...(commit === undefined ? {} : { mergeCommitSha: commit }) };
      }
      if (mergeRateLimitRetryAt(response, this.now()) !== undefined || response.status === 429) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub is limiting requests; the merge will be tried again");
      const githubMessage = githubReasonOf(body);
      const said = githubMessage === undefined ? {} : { githubMessage };
      if (response.status === 403) return { outcome: "refused", reason: "forbidden", ...said };
      const message = typeof body.message === "string" ? body.message : "";
      // GitHub words a method the repository does not allow as "Squash merges are not allowed on this repository." (verify at staging, Task 27).
      if (response.status === 405 && /\b(?:squash|merge commits?|merge)\b[^.]*\bnot allowed\b/iu.test(message)) {
        if (attempt === 0) {
          method = method === "squash" ? "merge" : "squash";
          fellBack = true;
          continue;
        }
        return { outcome: "refused", reason: "not_mergeable", ...said };
      }
      if (response.status !== 405 && response.status !== 409 && response.status !== 422 && response.status !== 200) {
        throw agentXError("RUNTIME_UNAVAILABLE", `GitHub merge failed with HTTP ${response.status}`);
      }
      const now = await this.getPullRequestWithToken(repository, number, token);
      if (now.state === "merged") return { outcome: "already_merged" };
      if (now.state === "closed") return { outcome: "refused", reason: "closed" };
      return now.headCommit !== input.sha ? { outcome: "refused", reason: "head_changed" } : { outcome: "refused", reason: "not_mergeable", ...said };
    }
    return { outcome: "refused", reason: "not_mergeable" };
  }

  /**
   * The CODEOWNERS file of a branch (owner decision 2026-10-27): the first of `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` that exists, as GitHub looks for it. Undefined when the repository has none; a
   * failing GitHub, a file over the cap or an unreadable one throws, so the caller fails closed. Read only: the token asks for `contents: read`.
   */
  async readCodeOwners(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<string | undefined> {
    if (branch.length === 0 || branch.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) throw agentXError("CONFIG_INVALID", "the branch name is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, { contents: "read" }, scope);
    for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
      const response = await this.fetchImplementation(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${path}?ref=${encodeURIComponent(branch)}`,
        { headers: { ...githubHeaders(token), accept: "application/vnd.github.raw+json" }, signal: AbortSignal.timeout(8_000), redirect: "error" },
      );
      if (response.status === 404) { await response.body?.cancel(); continue; }
      if (!response.ok) { await response.body?.cancel(); throw agentXError("RUNTIME_UNAVAILABLE", `GitHub code owners lookup failed with HTTP ${response.status}`); }
      const text = await response.text();
      if (text.length > CODEOWNERS_MAX_CHARS) throw agentXError("RUNTIME_UNAVAILABLE", "the code owners file is too large to read");
      return text;
    }
    return undefined;
  }

  /**
   * Every path a pull request changes, a renamed file under both names, for the code-owner check. Reads up to `CHANGED_PATH_PAGES` pages of 100; `complete` is false when there are more.
   * Read only (`contents` and `pull_requests` at read).
   */
  async listChangedPaths(repositoryUrl: string, number: number, scope: GitHubTokenScope): Promise<{ paths: string[]; complete: boolean }> {
    const paths: string[] = [];
    for (let page = 1; page <= CHANGED_PATH_PAGES; page += 1) {
      const read = await this.listPullRequestFiles(repositoryUrl, number, { page }, scope);
      for (const file of read.files) paths.push(file.filename, ...(file.previous_filename === undefined ? [] : [file.previous_filename]));
      if (read.nextPage === undefined) return { paths, complete: true };
    }
    return { paths, complete: false };
  }

  /**
   * Whether a person is an active member of a team of the repository's own organization (`team` is `org/slug`). `unknown` for anything Rovara cannot tell: another organization's team, a name
   * that is not one, an installation that has not accepted the members permission, a GitHub failure. Never `member` on a guess.
   */
  async isTeamMember(repositoryUrl: string, team: string, login: string, scope: GitHubTokenScope): Promise<"member" | "not_member" | "unknown"> {
    const parts = team.split("/");
    const parsed = parseGitHubRepository(repositoryUrl);
    if (parts.length !== 2 || parts[0]!.toLowerCase() !== parsed.owner.toLowerCase() || !/^[A-Za-z0-9_.-]{1,100}$/u.test(parts[1]!) || !GITHUB_LOGIN.test(login)) return "unknown";
    try {
      const repository = await this.installed(parsed, scope);
      const token = await this.createInstallationToken(repository, { members: "read" }, scope);
      const response = await this.fetchImplementation(
        `https://api.github.com/orgs/${encodeURIComponent(parts[0]!)}/teams/${encodeURIComponent(parts[1]!)}/memberships/${encodeURIComponent(login)}`,
        { headers: githubHeaders(token), signal: AbortSignal.timeout(8_000), redirect: "error" },
      );
      if (response.status === 404) { await response.body?.cancel(); return "not_member"; }
      if (response.status !== 200) { await response.body?.cancel(); return "unknown"; }
      const body: unknown = await response.json().catch(() => undefined);
      return body !== null && typeof body === "object" && (body as Record<string, unknown>).state === "active" ? "member" : "not_member";
    } catch {
      return "unknown";
    }
  }

  /**
   * The end of a GitHub Actions job's log (Plan 6 Task 15): `GET actions/jobs/{id}/logs` answers with a redirect to a short-lived address, which is followed only when it is on a host GitHub serves
   * logs from, with no credentials, and read as a stream that keeps its last lines (`logTail`). The token asks for `actions: read` alone, scoped to this one repository. Absent when GitHub has no
   * log for the job (not an Actions job, expired, or the App has not been given the permission yet); an address Rovara won't read, or GitHub failing, throws. The text is untrusted: the caller
   * redacts and labels it.
   */
  async getJobLogTail(repositoryUrl: string, jobId: string, scope: GitHubTokenScope, budget?: GithubMergeReadBudget): Promise<string | undefined> {
    if (!/^[0-9]{1,20}$/u.test(jobId)) throw agentXError("CONFIG_INVALID", "GitHub job id is invalid");
    const provider = this.trackingProvider(budget);
    const repository = await provider.installed(parseGitHubRepository(repositoryUrl), scope);
    let token: string;
    try {
      token = await provider.createInstallationToken(repository, { actions: "read" }, scope);
    } catch (error) {
      // An installation that has not accepted the Actions permission refuses the token: no log, and the checks are still named.
      if (isAgentXError(error) && (error.code === "GITHUB_NOT_CONNECTED" || error.code === "RUNTIME_UNAVAILABLE")) return undefined;
      throw error;
    }
    const located = await provider.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/jobs/${jobId}/logs`,
      { method: "GET", headers: githubHeaders(token), redirect: "manual", signal: AbortSignal.timeout(8_000) },
    );
    // GitHub's rate limits answer 403 (secondary) or 429: they are the sweep's to back off from, never a log that is not there.
    const limitedAt = mergeRateLimitRetryAt(located, this.now());
    if (limitedAt !== undefined) throw new GithubMergeRateLimitError(limitedAt);
    if (located.status === 404 || located.status === 403 || located.status === 410) return undefined;
    const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(budget === undefined ? [] : [budget.signal])]);
    // The log is read with this provider's own fetch, not the pass's (its address is not GitHub's API, so it is not one of the pass's requests), and with no credentials.
    if (located.status >= 300 && located.status < 400) {
      const address = located.headers.get("location") ?? "";
      if (!isAllowedLogAddress(address)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub sent the log somewhere Rovara will not read it");
      const log = await this.fetchImplementation(address, { method: "GET", headers: { accept: "text/plain" }, redirect: "error", signal });
      const logLimitedAt = mergeRateLimitRetryAt(log, this.now());
      if (logLimitedAt !== undefined) throw new GithubMergeRateLimitError(logLimitedAt);
      if (log.status === 404 || log.status === 403 || log.status === 410) return undefined;
      if (log.status !== 200) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub log download failed with HTTP ${log.status}`);
      return logTail(await readLogEnd(log, signal));
    }
    if (located.status === 200) return logTail(await readLogEnd(located, signal));
    throw agentXError("RUNTIME_UNAVAILABLE", `GitHub log lookup failed with HTTP ${located.status}`);
  }

  /** Reads a bounded PR diff summary for a code-aware, owner-approved feedback proposal. */
  async getPullRequestChangedFiles(repositoryUrl: string, number: number, scope: GitHubTokenScope): Promise<GitHubPullRequestChangedFile[]> {
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, { contents: "read", pull_requests: "read" }, scope);
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}/files?per_page=100`,
      { headers: { ...githubHeaders(token), accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(8_000), redirect: "error" },
    );
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request diff lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request diff");
    return body.slice(0, 100).flatMap((entry): GitHubPullRequestChangedFile[] => {
      if (!entry || typeof entry !== "object") return [];
      const file = entry as Record<string, unknown>;
      if (typeof file.filename !== "string" || file.filename.length > 500 || typeof file.status !== "string"
        || !Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions)) return [];
      return [{ filename: file.filename, status: file.status, additions: file.additions as number, deletions: file.deletions as number,
        ...(typeof file.patch === "string" ? { patch: file.patch.slice(0, 3_000) } : {}) }];
    });
  }

  /** Current authoritative feedback, including thread resolution, read with a repository-scoped token. */
  async getPullRequestFeedback(repositoryUrl: string, number: number, scope: GitHubTokenScope): Promise<GitHubPullRequestFeedback> {
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, { contents: "read", pull_requests: "read", issues: "read" }, scope);
    const prUrl = pullRequestUrl(repository, number);
    const before = await this.getPullRequestWithToken(repository, number, token);
    if (before.number !== number) throw feedbackReadError("PR scope mismatch");
    const root = prUrl.replace(/\/pulls\/\d+$/, "");
    const comments: GitHubFeedbackComment[] = [];
    for (const [path, kind] of [[`${prUrl}/reviews`, "REVIEW"], [`${prUrl}/comments`, "REVIEW_COMMENT"], [`${root}/issues/${number}/comments`, "DISCUSSION"]] as const) {
      for (const value of await this.feedbackPages(path, token)) {
        const record = feedbackRecord(value);
        if (kind === "REVIEW" && record.state === "PENDING") continue;
        const parsed = parseFeedbackComment(record, repository, number, kind);
        if (kind !== "REVIEW" || parsed.body.trim()) comments.push(parsed);
      }
    }
    // REST reviews expose submitted_at rather than the current edit time. Bind their bytes to GraphQL updatedAt.
    let reviewCursor: string | null = null;
    const reviewCursors = new Set<string>();
    const currentReviewIds = new Set<string>();
    // Whether the host records an edit of a comment (GraphQL `lastEditedAt`: null = never edited). A comment the host does not say anything about is left out, which is unknown, never "unedited".
    const edits: Record<string, boolean> = {};
    const noteEdit = (id: string, lastEditedAt: unknown): void => {
      if (lastEditedAt === null) edits[id] = false;
      else if (typeof lastEditedAt === "string") edits[id] = true;
    };
    do {
      const data = await this.feedbackGraphql(token, `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$name) { nameWithOwner pullRequest(number:$number) { number headRefOid
          reviews(first:100,after:$cursor) { nodes { fullDatabaseId updatedAt lastEditedAt url body } pageInfo { hasNextPage endCursor } }
        } }
      }`, { owner: repository.owner, name: repository.name, number, cursor: reviewCursor });
      const repo = feedbackRecord(data.repository); const pr = feedbackRecord(repo.pullRequest);
      if (repo.nameWithOwner !== `${repository.owner}/${repository.name}` || pr.number !== number || pr.headRefOid !== before.headCommit) throw feedbackReadError("review scope or head changed");
      const connection = feedbackConnection(pr.reviews);
      for (const value of connection.nodes) {
        const review = feedbackRecord(value);
        const databaseId = feedbackDatabaseId(review.fullDatabaseId);
        // GraphQL sends fullDatabaseId as a string. A review with no usable ID cannot match a REST review, and the
        // "review set changed" check below refuses if a collected review is never matched.
        const id = databaseId === null ? null : `review:${databaseId}`;
        const comment = id === null ? undefined : comments.find(c => c.id === id && c.kind === "REVIEW");
        if (!id || !comment) continue; // Blank bodies and unpublished draft reviews were excluded by REST.
        if (currentReviewIds.has(id) || comment.url !== review.url || comment.body !== review.body
          || typeof review.updatedAt !== "string" || !Number.isFinite(Date.parse(review.updatedAt))) throw feedbackReadError("review changed during collection");
        currentReviewIds.add(id); comment.updatedAt = new Date(review.updatedAt).toISOString();
        noteEdit(id, review.lastEditedAt);
      }
      reviewCursor = nextFeedbackCursor(connection, reviewCursors);
    } while (reviewCursor !== null);
    if (comments.some(c => c.kind === "REVIEW" && !currentReviewIds.has(c.id))) throw feedbackReadError("review set changed during collection");
    const threads: GitHubFeedbackThread[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const data = await this.feedbackGraphql(token, `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$name) { nameWithOwner pullRequest(number:$number) { number headRefOid
          reviewThreads(first:100,after:$cursor) { nodes { ${FEEDBACK_THREAD_FIELDS} } pageInfo { hasNextPage endCursor } }
        } }
      }`, { owner: repository.owner, name: repository.name, number, cursor });
      const repo = feedbackRecord(data.repository);
      const pr = feedbackRecord(repo.pullRequest);
      if (repo.nameWithOwner !== `${repository.owner}/${repository.name}` || pr.number !== number || pr.headRefOid !== before.headCommit) throw feedbackReadError("PR scope or head changed");
      const connection = feedbackConnection(pr.reviewThreads);
      for (const value of connection.nodes) {
        const thread = feedbackRecord(value);
        validateFeedbackThread(thread, repository, number);
        const ids: string[] = [];
        let threadComments = feedbackConnection(thread.comments);
        const commentCursors = new Set<string>();
        for (;;) {
          for (const comment of threadComments.nodes) {
            const id = feedbackDatabaseId(feedbackRecord(comment).fullDatabaseId);
            if (id === null) throw feedbackReadError("invalid thread comment ID");
            ids.push(`review_comment:${id}`);
            noteEdit(`review_comment:${id}`, feedbackRecord(comment).lastEditedAt);
          }
          const next = nextFeedbackCursor(threadComments, commentCursors);
          if (next === null) break;
          const more = await this.feedbackGraphql(token, `query($threadId:ID!,$cursor:String) { node(id:$threadId) { ... on PullRequestReviewThread {
            id isResolved repository { nameWithOwner } pullRequest { number }
            comments(first:100,after:$cursor) { nodes { fullDatabaseId lastEditedAt } pageInfo { hasNextPage endCursor } }
          } } }`, { threadId: thread.id, cursor: next });
          const node = feedbackRecord(more.node);
          validateFeedbackThread(node, repository, number);
          if (node.id !== thread.id || node.isResolved !== thread.isResolved) throw feedbackReadError("thread state changed during pagination");
          threadComments = feedbackConnection(node.comments);
        }
        threads.push({ id: thread.id as string, resolved: thread.isResolved as boolean, commentIds: ids });
      }
      cursor = nextFeedbackCursor(connection, seenCursors);
    } while (cursor !== null);
    const assignments = new Map<string, string>();
    const threadIds = new Set<string>();
    for (const thread of threads) {
      if (threadIds.has(thread.id)) throw feedbackReadError("duplicate thread in current state");
      threadIds.add(thread.id);
      for (const id of thread.commentIds) {
        if (assignments.has(id)) throw feedbackReadError("duplicate thread comment in current state");
        assignments.set(id, thread.id);
      }
    }
    const commentIds = new Set<string>();
    for (const comment of comments) {
      if (commentIds.has(comment.id)) throw feedbackReadError("duplicate comment in current state");
      commentIds.add(comment.id);
      if (comment.kind === "REVIEW_COMMENT") {
        const threadId = assignments.get(comment.id);
        if (!threadId) throw feedbackReadError("inline comment thread state is incomplete");
        comment.threadId = threadId;
      }
    }
    if ([...assignments.keys()].some(id => !commentIds.has(id))) throw feedbackReadError("thread and REST comment sets changed during collection");
    const after = await this.getPullRequestWithToken(repository, number, token);
    if (after.number !== number || after.headCommit !== before.headCommit || after.state !== before.state) throw feedbackReadError("PR head or state changed during collection");
    const headTreeSha = await this.getCommitTreeSha(repository, after.headCommit, token);
    const final = await this.getPullRequestWithToken(repository, number, token);
    if (final.number !== number || final.headCommit !== after.headCommit || final.state !== after.state) throw feedbackReadError("PR head or state changed during collection");
    // The App's own comments (Rovara's "Fixed in ..." replies, Plan 6 Task 16) are not feedback: they are left out of the comments and of their threads, after every consistency check above,
    // so a reply Rovara left never starts a round of its own and is never part of a round's comment set. A slug that cannot be read leaves the comments as they are.
    const ownIds = await this.ownCommentIds(comments);
    if (ownIds.size > 0) {
      return {
        pullRequest: { ...final, headTreeSha }, comments: comments.filter((comment) => !ownIds.has(comment.id)),
        threads: threads.map((thread) => ({ ...thread, commentIds: thread.commentIds.filter((id) => !ownIds.has(id)) })), edits,
      };
    }
    return { pullRequest: { ...final, headTreeSha }, comments, threads, edits };
  }

  /** The ids of Rovara's own comments among `comments`: the App's (its `<slug>[bot]` login), or with the owner's token (L11) the owner's login plus the exact reply shape. An App slug that cannot be read leaves every comment as it is; an owner login that cannot be read fails the read. */
  private async ownCommentIds(comments: readonly GitHubFeedbackComment[]): Promise<Set<string>> {
    const personal = this.options.personalToken?.ownComment;
    if (personal !== undefined) {
      let login: string | undefined;
      try { login = (await personal.login())?.toLowerCase(); } catch { login = undefined; }
      // Fail closed: with the owner's login unknown, Rovara's own replies cannot be told from the owner's feedback, and reading them as feedback would start a round that posts another reply.
      if (login === undefined) throw feedbackReadError("the token owner's login could not be read");
      // Rovara's exact reply shape: one line of at most 200 characters without a mention or control character, a blank line, then the marker and nothing else.
      const reply = new RegExp(`^[^\\p{Cc}@]{1,200}\\r?\\n\\r?\\n${personal.marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
      return new Set(comments.filter((comment) => comment.author.toLowerCase() === login && reply.test(comment.body.trimEnd())).map((comment) => comment.id));
    }
    const own = await this.ownBotLogin();
    return new Set(own === undefined ? [] : comments.filter((comment) => comment.author.toLowerCase() === own).map((comment) => comment.id));
  }

  /** The login the App's own comments carry (`<slug>[bot]`, lower-case), or undefined when the slug cannot be read. */
  private async ownBotLogin(): Promise<string | undefined> {
    try {
      return `${(await this.appSlug()).toLowerCase()}[bot]`;
    } catch {
      return undefined;
    }
  }

  /** The tree of a commit GitHub holds in the installed repository; throws when GitHub does not have that commit. */
  async getCommitTree(repositoryUrl: string, commitSha: string, scope: GitHubTokenScope): Promise<string> {
    if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw agentXError("CONFIG_INVALID", "commit identity is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, { contents: "read" }, scope);
    return this.getCommitTreeSha(repository, commitSha, token);
  }

  /** Server-owned, complete-tree source capture for normal project setup discovery. */
  async captureE2ESourceSnapshot(repositoryUrl: string, ref: string, scope: GitHubTokenScope): Promise<E2ESourceSnapshot> {
    if (!ref || ref.length > 255 || ref.startsWith("-") || /[\0\\~^:?*[\s]/.test(ref) || ref.split("/").some(part => part === "" || part === "." || part === "..")) {
      throw agentXError("CONFIG_INVALID", "repository ref is invalid");
    }
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.readTokenFor(repository, scope);
    const api = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    const headers = githubHeaders(token);
    const deadlineAt = this.now() + 60_000;
    const readJson = async (url: string, limit: number): Promise<Record<string, unknown>> => {
      const remaining = deadlineAt - this.now();
      if (remaining <= 0) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub immutable source capture exceeded its shared deadline");
      const response = await this.fetchImplementation(url, { headers, signal: AbortSignal.timeout(Math.min(8_000, remaining)), redirect: "error" });
      if (!response.ok) { await response.body?.cancel(); throw agentXError("RUNTIME_UNAVAILABLE", `GitHub immutable source read failed with HTTP ${response.status}`); }
      const responseBody = response.body as unknown as ReadableStream<Uint8Array> | null;
      const reader = responseBody?.getReader();
      if (!reader) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub immutable source response body is unavailable");
      const chunks: Uint8Array[] = []; let total = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > limit) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub immutable source metadata exceeded the response size limit");
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const value: unknown = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned invalid immutable source metadata");
      return value as Record<string, unknown>;
    };
    const commit = await readJson(`${api}/commits/${encodeURIComponent(ref)}`, 256 * 1024);
    const commitSha = commit.sha;
    const commitInfo = commit.commit && typeof commit.commit === "object" && !Array.isArray(commit.commit) ? commit.commit as Record<string, unknown> : undefined;
    const commitTree = commitInfo?.tree && typeof commitInfo.tree === "object" && !Array.isArray(commitInfo.tree) ? commitInfo.tree as Record<string, unknown> : undefined;
    const treeSha = commitTree?.sha;
    if (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/u.test(commitSha) || typeof treeSha !== "string" || !/^[a-f0-9]{40}$/u.test(treeSha)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid immutable commit or tree identity");
    const treeBody = await readJson(`${api}/git/trees/${treeSha}?recursive=1`, 16 * 1024 * 1024);
    const entries = treeBody.tree;
    if (treeBody.sha !== treeSha || treeBody.truncated !== false || !Array.isArray(entries) || entries.length > 100_000) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned a mismatched, incomplete or oversized immutable source tree");
    const paths: string[] = [];
    const selected: Array<{ path: string; sha: string; size: number }> = [];
    const seen = new Set<string>();
    for (const raw of entries) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid immutable tree entry");
      const entry = raw as Record<string, unknown>;
      const path = entry.path;
      if (typeof path !== "string" || path.length === 0 || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some(part => part === "" || part === "." || part === "..") || seen.has(path)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid or duplicate immutable tree path");
      seen.add(path); paths.push(path);
      const useful = isSafeE2ESourcePath(path) && /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|requirements\.txt|AndroidManifest\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|project\.pbxproj|Info\.plist|[^/\n\r\u2028\u2029]*\.(?:js|mjs|cjs|ts|tsx|jsx|json|swift|kt|kts|plist|gradle|md|toml|ya?ml))$/i.test(path);
      if (!useful || entry.type !== "blob") continue;
      if (entry.mode !== "100644" && entry.mode !== "100755") throw agentXError("RUNTIME_UNAVAILABLE", "selected immutable source path has an unsupported Git mode");
      if (typeof entry.sha !== "string" || !/^[a-f0-9]{40}$/u.test(entry.sha) || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 512 * 1024) throw agentXError("RUNTIME_UNAVAILABLE", "selected immutable source blob exceeds supported bounds");
      selected.push({ path, sha: entry.sha, size: entry.size });
    }
    if (selected.length > 512) throw agentXError("RUNTIME_UNAVAILABLE", "selected immutable source set exceeds 512 files");
    const sources: E2ESourceSnapshot["sources"][number][] = [];
    let total = 0;
    for (const entry of selected) {
      const blob = await readJson(`${api}/git/blobs/${entry.sha}`, 768 * 1024);
      if (blob.sha !== entry.sha || blob.encoding !== "base64" || blob.size !== entry.size || typeof blob.content !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned mismatched immutable source blob data");
      const encoded = blob.content.replace(/[\r\n\t ]/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned malformed immutable source bytes");
      const bytes = Buffer.from(encoded, "base64");
      const actualGitSha = createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex");
      if (bytes.byteLength !== entry.size || actualGitSha !== entry.sha) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub source bytes do not match immutable Git blob identity");
      total += bytes.byteLength;
      if (total > 4 * 1024 * 1024) throw agentXError("RUNTIME_UNAVAILABLE", "selected immutable source set exceeds 4 MiB");
      sources.push({ path: entry.path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes, kind: "blob" });
    }
    const fullName = `${repository.owner}/${repository.name}`;
    const candidate = createCandidateManifest([{ repositoryId: fullName, commitSha, treeSha }]);
    return { candidate, commitSha, treeSha, treeComplete: true, treePaths: paths, sources };
  }

  /**
   * The whole tree of a commit, one listing (`git/trees?recursive=1`), as the entries GitHub gives: path, mode, type and the git object id. Saved project images work the environment key out from it, so a file's
   * content is never read: its blob id names it. `truncated` is GitHub's own flag (the listing is cut at 100,000 entries or 7 MB); a caller that needs the whole tree must treat it as no answer.
   * Throws for a commit that is not a full sha or a listing GitHub cannot give.
   */
  async listTreeAtCommit(repositoryUrl: string, commitSha: string, scope: GitHubTokenScope, options?: { timeoutMs?: number }): Promise<{ truncated: boolean; entries: Array<{ path: string; mode: string; type: string; sha: string }> }> {
    if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw agentXError("CONFIG_INVALID", "commit identity is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.readTokenFor(repository, scope);
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${commitSha}?recursive=1`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(options?.timeoutMs ?? 30_000), redirect: "error" },
    );
    if (!response.ok) {
      return this.unavailableFileRead(response, `GitHub tree listing failed with HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !Array.isArray((body as { tree?: unknown }).tree) || typeof (body as { truncated?: unknown }).truncated !== "boolean") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid tree listing");
    const entries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    for (const raw of (body as { tree: unknown[] }).tree) {
      if (typeof raw !== "object" || raw === null) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid tree entry");
      const entry = raw as { path?: unknown; mode?: unknown; type?: unknown; sha?: unknown };
      if (typeof entry.path !== "string" || typeof entry.mode !== "string" || typeof entry.type !== "string" || typeof entry.sha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(entry.sha)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid tree entry");
      entries.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha });
    }
    return { truncated: (body as { truncated: boolean }).truncated, entries };
  }

  /**
   * A file's text as GitHub holds it at a commit; undefined when the file is not there.
   * With `untilLine` the body is read as a stream and the read stops after that many newline-ended lines (the text through that line is returned);
   * a file that ends sooner comes back whole. Throws when GitHub cannot answer or 20 MB arrive before the wanted line (or without one).
   * `timeoutMs` (default 8,000) is how long the request may take, for a caller that has more time to give.
   */
  async getFileAtCommit(repositoryUrl: string, path: string, commitSha: string, scope: GitHubTokenScope, options?: { untilLine?: number; timeoutMs?: number; maxBytes?: number }): Promise<string | undefined> {
    if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw agentXError("CONFIG_INVALID", "commit identity is invalid");
    const segments = path.split("/");
    if (path.length === 0 || path.length > 512 || path.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw agentXError("CONFIG_INVALID", "file path is invalid");
    }
    const untilLine = options?.untilLine;
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.readTokenFor(repository, scope);
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${segments.map(encodeURIComponent).join("/")}?ref=${commitSha}`,
      { headers: { ...githubHeaders(token), accept: "application/vnd.github.raw+json" }, signal: AbortSignal.timeout(options?.timeoutMs ?? FILE_AT_COMMIT_TIMEOUT_MS), redirect: "error" },
    );
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) {
      await response.body?.cancel();
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub file lookup failed with HTTP ${response.status}`);
    }
    // A directory answers with a JSON listing even for the raw media type; it is not a file, so it is not there.
    if (response.headers.get("content-type")?.toLowerCase().startsWith("application/json") === true) { await response.body?.cancel(); return undefined; }
    // A caller that gives its own `maxBytes` (a config file) gets a CONFIG_INVALID refusal, which it can record once, instead of a RUNTIME_UNAVAILABLE that would be retried for ever.
    const cap = Math.min(options?.maxBytes ?? FILE_AT_COMMIT_MAX_BYTES, FILE_AT_COMMIT_MAX_BYTES);
    const tooLarge = () => options?.maxBytes !== undefined
      ? agentXError("CONFIG_INVALID", "file too large")
      : agentXError("RUNTIME_UNAVAILABLE", untilLine === undefined ? "file too large" : "file too large to read up to the cited line");
    // Without a last line the whole file is wanted, so a declared size over the cap is refused before any byte is read.
    if (untilLine === undefined && Number(response.headers.get("content-length")) > cap) {
      await response.body?.cancel();
      throw tooLarge();
    }
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let lines = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      let value = result.value as Uint8Array;
      let reached = false;
      if (untilLine !== undefined) {
        // Find the newline that ends the wanted line; the rest of this chunk is not needed.
        let from = 0;
        for (let end = value.indexOf(10, from); end !== -1; end = value.indexOf(10, from)) {
          lines += 1;
          from = end + 1;
          if (lines >= untilLine) { value = value.subarray(0, from); reached = true; break; }
        }
      }
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
      if (reached) { await reader.cancel().catch(() => undefined); break; }
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  /** Lessons in the repo: puts text files on a `rovara/lessons-` working branch with the same `contents: write` scope a worker's push uses (`github-commit-files.ts`). */
  async commitFilesToBranch(repositoryUrl: string, request: CommitFilesRequest, scope: GitHubTokenScope): Promise<{ revision: string; changed: boolean }> {
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, { contents: "write" }, scope);
    return commitFilesOn({ fetch: this.fetchImplementation, owner: repository.owner, name: repository.name, token }, request);
  }

  /** Lessons in the repo: the pull request (any state) made from one of Rovara's own `rovara/lessons-` branches, or undefined. No other branch name is looked up. */
  async findLessonsPullRequest(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<{ number: number; url: string } | undefined> {
    if (!LESSON_FILE_BRANCH_PATTERN.test(branch)) throw agentXError("CONFIG_INVALID", "branch name is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, { pull_requests: "read" }, scope);
    const query = new URLSearchParams({ state: "all", head: `${repository.owner}:${branch}`, per_page: "1" });
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query.toString()}`,
      { headers: githubHeaders(token), redirect: "error", signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) { await response.body?.cancel(); throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${response.status}`); }
    const value: unknown = await response.json();
    const first = Array.isArray(value) ? (value[0] as { number?: unknown; html_url?: unknown } | undefined) : undefined;
    if (first === undefined) return undefined;
    if (typeof first.number !== "number" || !Number.isSafeInteger(first.number)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
    return { number: first.number, url: typeof first.html_url === "string" && first.html_url.startsWith("https://") ? first.html_url : "" };
  }

  /** Lessons in the repo: deletes one of Rovara's own `rovara/lessons-` branches (no other name is accepted). */
  async deleteLessonsBranch(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<"deleted" | "gone"> {
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, { contents: "write" }, scope);
    return deleteBranchOn({ fetch: this.fetchImplementation, owner: repository.owner, name: repository.name, token }, branch);
  }

  /**
   * What a path is at a commit: "file", "dir" (a directory or a submodule), "symlink" (a symbolic link at the path itself; what it points to is not known here, so it is not claimed to be a file or a directory) or "none"
   * (GitHub's 404, a name its parent directory does not list, or a parent that is a plain file). Throws when GitHub cannot answer (never "none" for an error), when a symbolic link or a submodule is the path's PARENT
   * (the link may point at a directory that holds the name) and for a type it does not know. Same commit and path rules as `getFileAtCommit`.
   * L7: it lists the path's PARENT directory and reads the entry's type, so no file's bytes are fetched just to learn what it is (a listing is at most 1,000 entries; a listing that is full and does not name the
   * path cannot say "none").
   */
  async getPathKindAtCommit(repositoryUrl: string, path: string, commitSha: string, scope: GitHubTokenScope, options?: { timeoutMs?: number }): Promise<"file" | "dir" | "symlink" | "none"> {
    if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw agentXError("CONFIG_INVALID", "commit identity is invalid");
    const segments = path.split("/");
    if (path.length === 0 || path.length > 512 || path.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw agentXError("CONFIG_INVALID", "file path is invalid");
    }
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.readTokenFor(repository, scope);
    const name = segments[segments.length - 1]!;
    const parent = segments.slice(0, -1).map(encodeURIComponent).join("/");
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents${parent === "" ? "" : `/${parent}`}?ref=${commitSha}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(options?.timeoutMs ?? FILE_AT_COMMIT_TIMEOUT_MS), redirect: "error" },
    );
    if (response.status === 404) { await response.body?.cancel(); return "none"; }
    if (!response.ok) {
      await response.body?.cancel();
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub path lookup failed with HTTP ${response.status}`);
    }
    // A directory is a JSON list. An answer over the cap is not read (it cannot be told cheaply): the caller treats a throw as "not verified".
    if (Number(response.headers.get("content-length")) > PATH_KIND_MAX_BYTES) { await response.body?.cancel(); throw agentXError("RUNTIME_UNAVAILABLE", "GitHub's path answer is too large to read"); }
    const body: unknown = await response.json();
    // The parent is not a directory. A real file has nothing below it ("none"). A symbolic link may point at a directory that has the name, and a submodule's contents are not in this repository: those are "cannot tell"
    // (a throw), because "none" is a final answer for a citation.
    if (!Array.isArray(body)) {
      if ((body as { type?: unknown } | null)?.type === "file") return "none";
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub reports a link or a submodule where a directory was expected");
    }
    const entry = (body as Array<{ name?: unknown; type?: unknown }>).find((candidate) => candidate.name === name);
    if (entry === undefined) {
      if (body.length >= PATH_LISTING_MAX_ENTRIES) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub's directory listing was cut before this name");
      return "none";
    }
    if (entry.type === "dir" || entry.type === "submodule") return "dir";
    if (entry.type === "file") return "file";
    // A symbolic link may point at a file, a directory or nothing; it is not claimed to be any of them. The reader says what it is, and each caller decides (a lesson reader cannot tell; the lessons pass never writes to it).
    if (entry.type === "symlink") return "symlink";
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an unexpected path answer");
  }

  /**
   * A contents-read token for reading files: reused for 5 minutes per repository, so a run of file reads mints one. The caller has just run
   * `installed(repository, scope)`, so the org check happens on every read, a reused token included.
   */
  private readTokenFor(repository: InstalledRepository, scope: GitHubTokenScope): Promise<string> {
    const key = `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}:contents=read`;
    const cached = this.readTokens.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.token;
    const token = this.createInstallationToken(repository, { contents: "read" }, scope);
    this.readTokens.set(key, { token, expiresAt: this.now() + READ_TOKEN_REUSE_MS });
    token.catch(() => { if (this.readTokens.get(key)?.token === token) this.readTokens.delete(key); });
    return token;
  }

  /** Reuse only the two diff read permissions; installed() checks the live org binding before every call. */
  private diffTokenFor(repository: InstalledRepository, scope: GitHubTokenScope): Promise<string> {
    const key = `${repository.installationId}:${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}:contents=read,pull_requests=read`;
    const cached = this.readTokens.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.token;
    const token = this.createInstallationToken(repository, { contents: "read", pull_requests: "read" }, scope);
    this.readTokens.set(key, { token, expiresAt: this.now() + READ_TOKEN_REUSE_MS });
    void token.catch(() => { if (this.readTokens.get(key)?.token === token) this.readTokens.delete(key); });
    return token;
  }

  /** The parents of a commit GitHub holds in the installed repository; throws when GitHub does not have that commit. */
  async getCommitParents(repositoryUrl: string, commitSha: string, scope: GitHubTokenScope): Promise<string[]> {
    if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw agentXError("CONFIG_INVALID", "commit identity is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, { contents: "read" }, scope);
    const value = await this.getCommitObject(repository, commitSha, token);
    if (!Array.isArray(value.parents)) throw feedbackReadError("invalid commit parents");
    return value.parents.map((parent) => {
      const sha = feedbackRecord(parent).sha;
      if (typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha)) throw feedbackReadError("invalid commit parent identity");
      return sha;
    });
  }

  /** The commit a branch points at now, as GitHub says; throws when the branch does not exist. */
  async getBranchHead(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<string> {
    if (!/^agentx\/[0-9a-f-]{36}$/iu.test(branch)) throw agentXError("CONFIG_INVALID", "branch name is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, { contents: "read" }, scope);
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/ref/heads/${branch}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(8_000), redirect: "error" },
    );
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub branch lookup failed with HTTP ${response.status}`);
    const value = feedbackRecord(await response.json());
    const target = feedbackRecord(value.object);
    if (value.ref !== `refs/heads/${branch}` || target.type !== "commit" || typeof target.sha !== "string" || !/^[a-f0-9]{40}$/u.test(target.sha)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid branch reference");
    }
    return target.sha;
  }

  /**
   * The commit a repository's branch points at now, for any ordinary branch name (a project's default branch), as GitHub says; throws when the branch does not exist.
   * `getBranchHead` is for Rovara's own `agentx/*` branches only.
   */
  async getDefaultBranchHead(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<string> {
    if (!GitBranchNameSchema.safeParse(branch).success) throw agentXError("CONFIG_INVALID", "branch name is invalid");
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.readTokenFor(repository, scope);
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(8_000), redirect: "error" },
    );
    if (!response.ok) {
      await response.body?.cancel();
      // A branch the host does not have is not an outage: the caller may try the host's own default branch.
      if (response.status === 404) throw agentXError("NOT_FOUND", "the repository has no such branch");
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub branch lookup failed with HTTP ${response.status}`);
    }
    const value = feedbackRecord(await response.json());
    const target = feedbackRecord(value.object);
    if (value.ref !== `refs/heads/${branch}` || target.type !== "commit" || typeof target.sha !== "string" || !/^[a-f0-9]{40}$/u.test(target.sha)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid branch reference");
    }
    return target.sha;
  }

  /** GitHub's immutable tree object identifies code content independently of publication commit metadata. */
  private async getCommitTreeSha(repository: InstalledRepository, commitSha: string, token: string): Promise<string> {
    const value = await this.getCommitObject(repository, commitSha, token);
    const tree = feedbackRecord(value.tree);
    if (typeof tree.sha !== "string" || !/^[a-f0-9]{40}$/u.test(tree.sha)) throw feedbackReadError("invalid PR head tree identity");
    return tree.sha;
  }

  /** GitHub's Git commit object (its tree and parents). */
  private async getCommitObject(repository: InstalledRepository, commitSha: string, token: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/commits/${commitSha}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(8_000), redirect: "error" },
    );
    if (!response.ok) throw feedbackReadError(`head commit lookup HTTP ${response.status}`);
    return feedbackRecord(await response.json());
  }

  private async feedbackPages(path: string, token: string, limit?: { maxPages: number; onTruncated(): void }): Promise<unknown[]> {
    const values: unknown[] = [];
    let next: string | undefined = `${path}?per_page=100&page=1`;
    const seen = new Set<string>();
    let pages = 0;
    while (next) {
      if (seen.has(next)) throw feedbackReadError("pagination did not advance");
      seen.add(next);
      const response = await this.fetchImplementation(next, { headers: githubHeaders(token), redirect: "error", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw feedbackReadError(`comment lookup HTTP ${response.status}`);
      const page: unknown = await response.json();
      if (!Array.isArray(page)) throw feedbackReadError("invalid comment page");
      for (const value of page as unknown[]) values.push(value);
      const link = response.headers.get("link");
      const linked = link?.split(",").map(part => /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(part)).find(match => match)?.[1];
      if (linked) {
        const url = new URL(linked);
        if (`${url.origin}${url.pathname}` !== path || url.username || url.password || url.hash
          || [...url.searchParams.keys()].some(key => key !== "per_page" && key !== "page")
          || url.searchParams.get("per_page") !== "100" || !/^[1-9][0-9]*$/.test(url.searchParams.get("page") ?? "")) throw feedbackReadError("pagination scope mismatch");
        next = url.href;
      } else if (!link && page.length === 100) {
        const url: URL = new URL(next); url.searchParams.set("page", String(Number(url.searchParams.get("page")) + 1)); next = url.href;
      } else next = undefined;
      pages += 1;
      if (next !== undefined && limit !== undefined && pages >= limit.maxPages) {
        limit.onTruncated();
        next = undefined;
      }
    }
    return values;
  }

  private async feedbackGraphql(token: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.fetchImplementation("https://api.github.com/graphql", {
      method: "POST", headers: githubHeaders(token), body: JSON.stringify({ query, variables }), redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw feedbackReadError(`thread lookup HTTP ${response.status}`);
    const body = feedbackRecord(await response.json());
    if (body.errors !== undefined) throw feedbackReadError("thread lookup incomplete");
    return feedbackRecord(body.data);
  }

  async updatePullRequest(
    repositoryUrl: string,
    number: number,
    update: GitHubPullRequestUpdate,
    scope: GitHubTokenScope,
  ): Promise<GitHubPullRequestDetails> {
    if (update.title === undefined && update.body === undefined && update.state === undefined) {
      throw agentXError("CONFIG_INVALID", "pull request update is empty");
    }
    const repository = await this.installed(parseGitHubRepository(repositoryUrl), scope);
    const token = await this.createInstallationToken(repository, {
      contents: "read",
      pull_requests: "write",
    }, scope);
    try {
      const response = await this.fetchImplementation(
        pullRequestUrl(repository, number),
        {
          method: "PATCH",
          headers: githubHeaders(token),
          body: JSON.stringify(update),
          redirect: "error", signal: AbortSignal.timeout(15_000), // L7a
        },
      );
      if (response.ok) {
        return parsePullRequestDetails(await response.json(), repository);
      }
      const reconciled = await this.getPullRequestWithToken(repository, number, token);
      if (matchesUpdate(reconciled, update)) return reconciled;
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request update failed with HTTP ${response.status}`);
    } catch (error) {
      if (isAgentXError(error)) throw error;
      const reconciled = await this.getPullRequestWithToken(repository, number, token).catch(() => undefined);
      if (reconciled && matchesUpdate(reconciled, update)) return reconciled;
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub pull request update outcome is unknown");
    }
  }

  private async getPullRequestWithToken(
    repository: InstalledRepository,
    number: number,
    token: string,
  ): Promise<GitHubPullRequestDetails> {
    const response = await this.fetchImplementation(
      pullRequestUrl(repository, number),
      { headers: githubHeaders(token), redirect: "error", signal: AbortSignal.timeout(8_000) }, // L7a
    );
    if (!response.ok) {
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${response.status}`);
    }
    return parsePullRequestDetails(await response.json(), repository);
  }

  private async getCommitTreeWithToken(
    repository: InstalledRepository,
    commit: string,
    token: string,
  ): Promise<string> {
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/commits/${commit}`,
      { headers: githubHeaders(token), redirect: "error", signal: AbortSignal.timeout(8_000) }, // L7a
    );
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub commit tree lookup failed with HTTP ${response.status}`);
    const value: unknown = await response.json();
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const tree = record?.tree;
    const treeSha = tree && typeof tree === "object" && !Array.isArray(tree) ? (tree as Record<string, unknown>).sha : undefined;
    if (record?.sha !== commit || typeof treeSha !== "string" || !/^[a-f0-9]{40}$/.test(treeSha)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid commit tree response");
    }
    return treeSha;
  }

  /** One page of chooser suggestions, never authority for a save/start or a complete snapshot. */
  async listWorkingBranches(repositoryUrl: string, expected: { installationId: number; repositoryId: number }, scope: GitHubTokenScope, page = 1): Promise<WorkingBranchPage> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000) throw workingBranchInvalid();
    const input = workingBranchInput(repositoryUrl, expected, scope);
    return this.workingBranchList(input, page);
  }

  private async workingBranchList(input: WorkingBranchInput, page: number, lookup?: () => Promise<{ id: number; login: string }>): Promise<WorkingBranchPage> {
    try {
      const check = this.options.requireInstallationBound;
      if (check === undefined) throw agentXError("GITHUB_NOT_CONNECTED", "Repository connection unavailable.");
      const connected = async () => {
        const current = await (lookup === undefined ? this.lookedUp(input, true) : lookup());
        if (current.id !== input.installationId) throw agentXError("GITHUB_NOT_CONNECTED", "Repository connection changed.");
        await check(input.orgId, current.id, { owner: input.owner, name: input.name });
      };
      await connected();
      const token = await this.createInstallationToken(input, { contents: "read" }, { orgId: input.orgId }, lookup !== undefined, { installationId: input.installationId });
      const read = (path: string) => this.fetchImplementation(`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}${path}`, { headers: githubHeaders(token), signal: AbortSignal.timeout(5_000), redirect: "error" });
      const repository = await read("");
      if (repository.status !== 200) throw workingBranchUnavailable();
      const identity = feedbackRecord(await workingBranchPageJson(repository));
      if (identity.id !== input.repositoryId || typeof identity.full_name !== "string" || identity.full_name.toLowerCase() !== `${input.owner}/${input.name}`.toLowerCase()) throw workingBranchUnavailable();
      // Never follow Link URLs or paginate automatically. Only this local integer selects the page.
      const response = await read(`/branches?per_page=100&page=${String(page)}`);
      if (response.status !== 200) throw workingBranchUnavailable();
      const rows = await workingBranchPageJson(response);
      if (!Array.isArray(rows) || rows.length > 100) throw workingBranchUnavailable();
      const branches: string[] = [], seen = new Set<string>();
      let omittedUnsupported = false;
      for (const raw of rows) {
        const row = feedbackRecord(raw), commit = feedbackRecord(row.commit);
        if (typeof row.name !== "string" || row.name.length === 0 || seen.has(row.name) || typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/.test(commit.sha)) throw workingBranchUnavailable();
        seen.add(row.name);
        if (!GitBranchNameSchema.safeParse(row.name).success || row.name === "HEAD" || row.name.startsWith("refs/")) { omittedUnsupported = true; continue; }
        branches.push(row.name);
      }
      // Empty and filtered pages must also survive a fresh connection/binding check.
      await connected();
      return { branches, page, mayHaveMore: rows.length === 100, omittedUnsupported };
    } catch (error) {
      if (isAgentXError(error) && error.code === "GITHUB_NOT_CONNECTED") throw agentXError("GITHUB_NOT_CONNECTED", "Reconnect this project's repository before listing its working branches.");
      throw workingBranchUnavailable();
    }
  }

  /** Unexposed working-branch reader: org-only, immutable pins required, no default fallback. */
  async readWorkingBranchRepository(repositoryUrl: string, expected: { installationId: number; repositoryId: number }, scope: GitHubTokenScope): Promise<{ installationId: number; repositoryId: number }> {
    const input = workingBranchInput(repositoryUrl, expected, scope);
    return this.workingBranchRead(input);
  }

  async readWorkingBranch(repositoryUrl: string, branch: string, expected: { installationId: number; repositoryId: number }, scope: GitHubTokenScope): Promise<{ installationId: number; repositoryId: number; fullName: string; branch: string; commit: string } | undefined> {
    const parsed = GitBranchNameSchema.safeParse(branch);
    if (!parsed.success || branch === "HEAD" || branch.startsWith("refs/")) throw workingBranchInvalid();
    const input = workingBranchInput(repositoryUrl, expected, scope);
    const result = await this.workingBranchRead(input, branch);
    if (result.commit === undefined) return undefined;
    return { installationId: input.installationId, repositoryId: input.repositoryId, fullName: `${input.owner}/${input.name}`, branch, commit: result.commit };
  }

  /** Isolated exact-preview/list read session: no cross-request/org cache; finish rechecks fresh installation identity. */
  createWorkingBranchPreviewSession() {
    const scoped = new GitHubAppCredentialProvider(this.options);
    scoped.tokenCache = new Map();
    let locked: WorkingBranchInput | undefined, initial: Promise<{ id: number; login: string }> | undefined, closed = false;
    const prepare = (url: string, expected: { installationId: number; repositoryId: number }, scope: GitHubTokenScope) => {
      if (closed) throw workingBranchUnavailable();
      const input = workingBranchInput(url, expected, scope);
      if (locked !== undefined && JSON.stringify(locked) !== JSON.stringify(input)) throw workingBranchInvalid();
      locked ??= input;
      return input;
    };
    const lookup = () => {
      if (closed || locked === undefined) throw workingBranchUnavailable();
      return initial ??= scoped.lookedUp(locked, true);
    };
    return {
      readWorkingBranchRepository: async (url: string, expected: { installationId: number; repositoryId: number }, scope: GitHubTokenScope) => {
        const input = prepare(url, expected, scope);
        const result = await scoped.workingBranchRead(input, undefined, lookup);
        return { installationId: result.installationId, repositoryId: result.repositoryId };
      },
      readWorkingBranch: async (url: string, branch: string, expected: { installationId: number; repositoryId: number }, scope: GitHubTokenScope) => {
        if (!GitBranchNameSchema.safeParse(branch).success || branch === "HEAD" || branch.startsWith("refs/")) throw workingBranchInvalid();
        const input = prepare(url, expected, scope), result = await scoped.workingBranchRead(input, branch, lookup);
        return result.commit === undefined ? undefined : { installationId: input.installationId, repositoryId: input.repositoryId, fullName: `${input.owner}/${input.name}`, branch, commit: result.commit };
      },
      listWorkingBranches: async (url: string, expected: { installationId: number; repositoryId: number }, scope: GitHubTokenScope, page = 1) => {
        if (!Number.isSafeInteger(page) || page < 1 || page > 1_000) throw workingBranchInvalid();
        const input = prepare(url, expected, scope);
        return scoped.workingBranchList(input, page, lookup);
      },
      finish: async (operation: "list" | "preview" = "preview") => {
        if (closed) throw workingBranchUnavailable();
        closed = true;
        try {
          if (locked === undefined) return;
          const current = await scoped.lookedUp(locked, true), check = scoped.options.requireInstallationBound;
          if (current.id !== locked.installationId) throw agentXError("GITHUB_NOT_CONNECTED", operation === "list" ? "Reconnect this project's repository before listing working branches." : "Reconnect this project's repository before reviewing its working branch.");
          if (check === undefined) throw workingBranchUnavailable();
          await check(locked.orgId, current.id, { owner: locked.owner, name: locked.name });
        } catch (error) {
          if (isAgentXError(error) && error.code === "GITHUB_NOT_CONNECTED") throw agentXError("GITHUB_NOT_CONNECTED", operation === "list" ? "Reconnect this project's repository before listing working branches." : "Reconnect this project's repository before reviewing its working branch.");
          throw workingBranchUnavailable();
        }
        finally { scoped.tokenCache?.clear(); scoped.installations.clear(); locked = undefined; initial = undefined; }
      },
    };
  }

  private async workingBranchRead(input: WorkingBranchInput, branch?: string, lookup?: () => Promise<{ id: number; login: string }>): Promise<{ installationId: number; repositoryId: number; commit?: string }> {
    try {
      // Unlike the older system-scope APIs, this optional reader requires an explicit org policy.
      const check = this.options.requireInstallationBound;
      if (check === undefined) throw agentXError("GITHUB_NOT_CONNECTED", "Repository connection unavailable.");
      const connected = async () => {
        const current = await (lookup === undefined ? this.lookedUp(input, true) : lookup());
        if (current.id !== input.installationId) throw agentXError("GITHUB_NOT_CONNECTED", "Repository connection changed.");
        await check(input.orgId, current.id, { owner: input.owner, name: input.name });
      };
      await connected();
      const token = await this.createInstallationToken(input, { contents: "read" }, { orgId: input.orgId }, lookup !== undefined, { installationId: input.installationId });
      const read = (path: string) => this.fetchImplementation(`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}${path}`, { headers: githubHeaders(token), signal: AbortSignal.timeout(5_000), redirect: "error" });
      const repository = await read("");
      if (repository.status !== 200) throw workingBranchUnavailable();
      const identity = feedbackRecord(await repository.json());
      if (identity.id !== input.repositoryId || typeof identity.full_name !== "string" || identity.full_name.toLowerCase() !== `${input.owner}/${input.name}`.toLowerCase()) throw workingBranchUnavailable();
      let commit: string | undefined;
      if (branch !== undefined) {
        const response = await read(`/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
        if (response.status !== 404) {
          if (response.status !== 200) throw workingBranchUnavailable();
          const ref = feedbackRecord(await response.json()), object = feedbackRecord(ref.object);
          if (ref.ref !== `refs/heads/${branch}` || object.type !== "commit" || typeof object.sha !== "string" || !/^[a-f0-9]{40}$/.test(object.sha)) throw workingBranchUnavailable();
          commit = object.sha;
        }
      }
      // Point-in-time checks, not an atomic external revocation or admission fence.
      await connected();
      return { installationId: input.installationId, repositoryId: input.repositoryId, ...(commit === undefined ? {} : { commit }) };
    } catch (error) {
      if (isAgentXError(error) && error.code === "GITHUB_NOT_CONNECTED") throw agentXError("GITHUB_NOT_CONNECTED", "Reconnect this project's repository before reviewing its working branch.");
      throw workingBranchUnavailable();
    }
  }

  /**
   * The installation that covers a repository, as GitHub says (cached by owner as `installed` caches it; a failed lookup is not cached;
   * `fresh` asks GitHub again); undefined when the App is not installed there. Reads no org's binding: callers hand the result to `requireInstallationBound`.
   */
  async installationForRepository(owner: string, name: string, options: { fresh?: boolean } = {}): Promise<{ installationId: number } | undefined> {
    try {
      return { installationId: (await this.lookedUp({ owner, name }, options.fresh === true)).id };
    } catch (error) {
      if (isAgentXError(error) && error.code === "CONFIG_INVALID") return undefined;
      throw error;
    }
  }

  /** The repository's installation by owner, from the cache or (when `fresh`, or not cached) from GitHub. A failed lookup is not cached. */
  private async lookedUp(repository: { owner: string; name: string }, fresh: boolean): Promise<{ id: number; login: string }> {
    const key = repository.owner.toLowerCase();
    if (fresh) this.installations.delete(key);
    let installation = this.installations.get(key);
    if (installation === undefined) {
      installation = this.lookUpInstallation(repository);
      this.installations.set(key, installation);
      const pending = installation;
      pending.catch(() => {
        if (this.installations.get(key) === pending) this.installations.delete(key);
      });
    }
    return installation;
  }

  /**
   * The repository's installation. For an org's scope on a cloud install it must be bound to that org and active, read fresh each time (the
   * binding is never cached), so a removed binding stops every later mint and read. A cached installation that fails that check may be one
   * the App has since been reinstalled over (a new id): GitHub is asked once more before the refusal stands.
   */
  private async installed(repository: { owner: string; name: string }, scope: GitHubTokenScope): Promise<InstalledRepository> {
    let { id, login } = await this.lookedUp(repository, false);
    const check = this.options.requireInstallationBound;
    if ("orgId" in scope && check !== undefined) {
      try {
        await check(scope.orgId, id, { owner: login, name: repository.name });
      } catch (error) {
        if (!isAgentXError(error) || error.code !== "GITHUB_NOT_CONNECTED") throw error;
        const current = await this.lookedUp(repository, true);
        if (current.id === id) throw error;
        ({ id, login } = current);
        await check(scope.orgId, id, { owner: login, name: repository.name });
      }
    }
    return { owner: login, name: repository.name, installationId: id };
  }

  private async lookUpInstallation(repository: { owner: string; name: string }): Promise<{ id: number; login: string }> {
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/installation`,
      { headers: await this.appHeaders(), signal: AbortSignal.timeout(5_000), redirect: "error" },
    );
    if (response.status === 404) {
      throw agentXError(
        "CONFIG_INVALID",
        this.options.personalToken?.notReachable(repository) ?? `the GitHub App cannot access ${repository.owner}/${repository.name}; install it on ${repository.owner} with access to that repository`,
      );
    }
    if (!response.ok) {
      return this.unavailableFileRead(response, `GitHub App installation lookup failed with HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    const id = body && typeof body === "object" && "id" in body ? body.id : undefined;
    const account = body && typeof body === "object" && "account" in body ? body.account : undefined;
    const login = account && typeof account === "object" && "login" in account ? account.login : undefined;
    if (!Number.isSafeInteger(id) || (id as number) < 1 || typeof login !== "string" || login.toLowerCase() !== repository.owner.toLowerCase()) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installation response");
    }
    return { id: id as number, login };
  }

  /**
   * The App's slug, which makes its install address (https://github.com/apps/<slug>/installations/new): from the App's secret,
   * or from GitHub when the secret has none. Refused when it is not letters, digits and hyphens.
   */
  async appSlug(): Promise<string> {
    if (this.slug !== undefined) return this.slug;
    const fromSecret = this.options.getAppSecret === undefined ? undefined : secretField(await this.options.getAppSecret(), "slug");
    let slug = fromSecret;
    if (slug === undefined) {
      const response = await this.fetchImplementation("https://api.github.com/app", { headers: await this.appHeaders(), signal: AbortSignal.timeout(5_000), redirect: "error" });
      if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub App lookup failed with HTTP ${response.status}`);
      const body: unknown = await response.json();
      slug = body && typeof body === "object" && "slug" in body && typeof body.slug === "string" ? body.slug : undefined;
    }
    if (slug === undefined || !GITHUB_APP_SLUG.test(slug)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App slug is missing or not valid");
    this.slug = slug;
    return slug;
  }

  /**
   * The App's OAuth client id and secret, for the install flow's user authorization; undefined when the App secret has neither (an App
   * made before the install flow: `agentx github oauth set` stores them). A client set while this process runs is found by one fresh read.
   */
  async oauthClient(): Promise<{ clientId: string; clientSecret: string } | undefined> {
    const { getAppSecret } = this.options;
    if (getAppSecret === undefined) return undefined;
    const read = (secret: string) => {
      const clientId = secretField(secret, "clientId");
      const clientSecret = secretField(secret, "clientSecret");
      return clientId === undefined || clientSecret === undefined ? undefined : { clientId, clientSecret };
    };
    return read(await getAppSecret()) ?? read(await getAppSecret({ refresh: true }));
  }

  /** One installation of the App, by id (the App's JWT; GitHub tells it nothing of an installation of another App). */
  async installation(id: number): Promise<GitHubInstallation> {
    if (!Number.isSafeInteger(id) || id < 1) throw agentXError("CONFIG_INVALID", "GitHub installation id must be a positive integer");
    const response = await this.fetchImplementation(`https://api.github.com/app/installations/${id}`, {
      headers: await this.appHeaders(), signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (response.status === 404) throw agentXError("NOT_FOUND", "GitHub has no such installation of this App");
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub App installation lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const account = record.account && typeof record.account === "object" ? record.account as Record<string, unknown> : {};
    const selection = record.repository_selection;
    const suspendedAt = record.suspended_at;
    if (
      record.id !== id
      || typeof account.login !== "string" || account.login === ""
      || !Number.isSafeInteger(account.id) || (account.id as number) < 1
      || (account.type !== "User" && account.type !== "Organization" && account.type !== "Enterprise")
      || (selection !== "all" && selection !== "selected")
      || (suspendedAt !== null && suspendedAt !== undefined && typeof suspendedAt !== "string")
    ) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installation response");
    }
    return {
      id, account: { login: account.login, id: account.id as number, type: account.type },
      repositorySelection: selection, suspendedAt: suspendedAt ?? null,
    };
  }

  /**
   * Plan 2, Task 14: whether `login` is a member of the GitHub organization `org`, read with a token of the installation `installationId`
   * (the App's own `members: read`). GitHub answers 404 for a user who is not a member (or not visible to the token), which is `undefined`;
   * any other failure is thrown, so the caller never mistakes an outage for "not a member". The installation is not bound to any org yet
   * (this runs while a signed `installation.created` is being judged), so the scope can only be a system one.
   */
  async organizationMembership(installationId: number, org: string, login: string, scope: SystemTokenScope): Promise<{ state: string; role: string } | undefined> {
    if (!("system" in scope)) throw agentXError("CONFIG_INVALID", "a membership is read for an installation no org holds yet; the scope must be a system one");
    if (!Number.isSafeInteger(installationId) || installationId < 1) throw agentXError("CONFIG_INVALID", "GitHub installation id must be a positive integer");
    if (!GITHUB_LOGIN.test(org) || !GITHUB_LOGIN.test(login)) return undefined;
    const token = await this.mintInstallationToken(installationId, { members: "read" });
    const response = await this.fetchImplementation(`https://api.github.com/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "agentx-control-plane", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's membership lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    if (typeof record.state !== "string" || typeof record.role !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid membership response");
    return { state: record.state, role: record.role };
  }

  /**
   * Whether the author of a pull request or an issue belongs to the repository, asked of GitHub now with a token of the installation `installationId` (the payload's association shows a
   * private org member as CONTRIBUTOR or NONE, so it is not enough). For an organization's repository: an active membership of the org (`members: read`) is `member`; otherwise, and for a
   * user's repository, write, maintain or admin access to the repository (the collaborator permission endpoint, `metadata: read`) is `collaborator`. GitHub's 404 is "no"; any other failure is
   * thrown, so the caller never mistakes an outage for a membership. A name that could not be an account or repository answers `none` before anything is asked.
   */
  async authorStanding(installationId: number, query: { owner: string; ownerType?: string; repo: string; login: string }): Promise<"member" | "collaborator" | "none"> {
    if (!Number.isSafeInteger(installationId) || installationId < 1) throw agentXError("CONFIG_INVALID", "GitHub installation id must be a positive integer");
    const { owner, repo, login } = query;
    if (!GITHUB_LOGIN.test(owner) || !GITHUB_LOGIN.test(login) || !GITHUB_REPOSITORY_NAME.test(repo) || repo === "." || repo === "..") return "none";
    const organization = query.ownerType === "Organization";
    const token = await this.mintInstallationToken(installationId, organization ? { metadata: "read", members: "read" } : { metadata: "read" });
    const read = (path: string) => this.fetchImplementation(`https://api.github.com${path}`, {
      headers: githubHeaders(token), signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (organization) {
      const response = await read(`/orgs/${encodeURIComponent(owner)}/memberships/${encodeURIComponent(login)}`);
      if (response.ok) {
        const body: unknown = await response.json();
        const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
        if (typeof record.state !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid membership response");
        if (record.state === "active") return "member";
      } else if (response.status !== 404) {
        throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's membership lookup failed with HTTP ${response.status}`);
      }
    }
    const response = await read(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(login)}/permission`);
    if (response.status === 404) return "none";
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's repository permission lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    if (typeof record.permission !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid permission response");
    // `permission` is the legacy role (maintain reads as write, triage as read); `role_name` is the exact one.
    return record.permission === "admin" || record.permission === "write" || record.role_name === "maintain" || record.role_name === "write" || record.role_name === "admin" ? "collaborator" : "none";
  }

  /**
   * Every repository one installation can reach (`GET /installation/repositories`, 100 to a page, at most 10 pages), read with a token minted
   * for the installation. For an org's scope on a cloud install the installation must be bound to that org and active, checked before the mint.
   */
  async listInstallationRepositories(installationId: number, scope: GitHubTokenScope): Promise<GitHubInstallationRepository[]> {
    if (!Number.isSafeInteger(installationId) || installationId < 1) throw agentXError("CONFIG_INVALID", "GitHub installation id must be a positive integer");
    if ("orgId" in scope && this.options.requireInstallationBound !== undefined) await this.options.requireInstallationBound(scope.orgId, installationId);
    const token = await this.mintInstallationToken(installationId, { metadata: "read" });
    return this.readInstallationRepositories(token);
  }

  private async readInstallationRepositories(token: string, signal?: AbortSignal): Promise<GitHubInstallationRepository[]> {
    const repositories: GitHubInstallationRepository[] = [];
    for (let page = 1; page <= INSTALLATION_REPOSITORY_PAGES; page += 1) {
      const response = await this.fetchImplementation(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
        headers: githubHeaders(token), signal: webhookCallSignal(signal), redirect: "error",
      });
      if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's repository listing failed with HTTP ${response.status}`);
      const body: unknown = await response.json();
      const entries = body !== null && typeof body === "object" && "repositories" in body && Array.isArray(body.repositories) ? body.repositories as unknown[] : undefined;
      if (entries === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid repository listing");
      for (const entry of entries) {
        const record = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {};
        if (typeof record.full_name !== "string" || !Number.isSafeInteger(record.id) || (record.id as number) < 1 || typeof record.private !== "boolean" || typeof record.default_branch !== "string") {
          throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid repository listing");
        }
        repositories.push({ fullName: record.full_name, githubRepositoryId: record.id as number, private: record.private, defaultBranch: record.default_branch });
      }
      if (entries.length < 100) break;
    }
    return repositories;
  }

  /** Spec 025 A13: how many accounts the App is installed on (the first 100), for the health route. */
  async installationCount(): Promise<number> {
    const response = await this.fetchImplementation("https://api.github.com/app/installations?per_page=100", {
      headers: await this.appHeaders(), signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub App installations lookup failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installations response");
    return body.length;
  }

  /**
   * SRL-5a: one page of the App's webhook deliveries, newest first (`GET /app/hook/deliveries`, App JWT only). `cursor` is the opaque value of the previous page's `Link: rel="next"`.
   * An entry GitHub states badly is left out (the sweep never acts on what it cannot read). Throws when GitHub did not answer the list.
   */
  async listWebhookDeliveries(input: { cursor?: string; perPage: number; signal?: AbortSignal }): Promise<{ entries: GitHubWebhookDelivery[]; next?: string }> {
    const query = new URLSearchParams({ per_page: String(Math.min(Math.max(1, Math.trunc(input.perPage)), 100)) });
    if (input.cursor !== undefined) query.set("cursor", input.cursor);
    const response = await this.fetchImplementation(`https://api.github.com/app/hook/deliveries?${query.toString()}`, {
      headers: await this.appHeaders(), signal: webhookCallSignal(input.signal), redirect: "error",
    });
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's webhook delivery list failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid webhook delivery list");
    const entries: GitHubWebhookDelivery[] = [];
    for (const item of body) {
      const record = item !== null && typeof item === "object" ? item as Record<string, unknown> : {};
      if (!Number.isSafeInteger(record.id) || typeof record.guid !== "string" || typeof record.delivered_at !== "string" || Number.isNaN(Date.parse(record.delivered_at))
        || typeof record.event !== "string" || !Number.isSafeInteger(record.status_code)) continue;
      entries.push({
        id: record.id as number, guid: record.guid, deliveredAt: new Date(record.delivered_at).toISOString(), redelivery: record.redelivery === true,
        event: record.event, action: typeof record.action === "string" ? record.action : null, statusCode: record.status_code as number,
      });
    }
    const next = /<[^>]*[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/u.exec(response.headers.get("link") ?? "")?.[1];
    return { entries, ...(next === undefined ? {} : { next: decodeURIComponent(next) }) };
  }

  /**
   * SRL-5a: asks GitHub to deliver one delivery again (`POST /app/hook/deliveries/{id}/attempts`): `requested` on 202, `gone` only on 404 (GitHub no longer has it). Everything else THROWS, 422 included:
   * GitHub documents 422 as "validation failed, or the endpoint has been spammed", so it can mean "slow down", never "this delivery is gone".
   */
  async redeliverWebhookDelivery(deliveryId: number, signal?: AbortSignal): Promise<"requested" | "gone"> {
    if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) throw agentXError("CONFIG_INVALID", "GitHub webhook delivery id must be a positive integer");
    const response = await this.fetchImplementation(`https://api.github.com/app/hook/deliveries/${deliveryId}/attempts`, {
      method: "POST", headers: await this.appHeaders(), signal: webhookCallSignal(signal), redirect: "error",
    });
    if (response.status === 202) return "requested";
    if (response.status === 404) return "gone";
    throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's webhook redelivery failed with HTTP ${response.status}`);
  }

  /**
   * SRL-5a: one installation as the repository check needs it: the ids of every repository it reaches and whether that list is certainly complete (a list that filled all its pages may have more),
   * and a lookup of one repository by id (`GET /repositories/{id}`): `exists` on 200, `missing` on 404, a throw on anything else (a refusal, a rate limit, a server error, a redirect). 404 does not say
   * deleted, transferred or no longer shared with the installation: the caller treats all three as "not held". ONE installation token is minted for the list and every lookup, and `signal` ends every call
   * (with the provider's own timeout) at the caller's deadline. The cloud binding check runs once, before the mint.
   */
  async installationRepositoryView(installationId: number, scope: GitHubTokenScope, signal?: AbortSignal): Promise<{ ids: number[]; complete: boolean; status(repositoryId: number, signal?: AbortSignal): Promise<"exists" | "missing"> }> {
    if (!Number.isSafeInteger(installationId) || installationId < 1) throw agentXError("CONFIG_INVALID", "GitHub installation id must be a positive integer");
    if ("orgId" in scope && this.options.requireInstallationBound !== undefined) await this.options.requireInstallationBound(scope.orgId, installationId);
    const token = await this.mintInstallationToken(installationId, { metadata: "read" }, signal);
    const repositories = await this.readInstallationRepositories(token, signal);
    return {
      ids: repositories.map((repository) => repository.githubRepositoryId),
      complete: repositories.length < INSTALLATION_REPOSITORY_PAGES * 100,
      status: async (repositoryId, lookupSignal) => {
        if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) throw agentXError("CONFIG_INVALID", "GitHub repository id must be a positive integer");
        const response = await this.fetchImplementation(`https://api.github.com/repositories/${repositoryId}`, { headers: githubHeaders(token), signal: webhookCallSignal(lookupSignal ?? signal), redirect: "error" });
        if (response.status === 200) return "exists";
        if (response.status === 404) return "missing";
        throw agentXError("RUNTIME_UNAVAILABLE", `GitHub's repository lookup failed with HTTP ${response.status}`);
      },
    };
  }

  private async appHeaders(): Promise<Record<string, string>> {
    const appId = typeof this.options.appId === "string" ? this.options.appId : await this.options.appId();
    if (!GITHUB_APP_ID.test(appId)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App ID must be numeric");
    const privateKey = await this.options.getPrivateKey();
    const jwt = createGitHubAppJwt(appId, privateKey, this.now());
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "user-agent": "agentx-control-plane",
      "x-github-api-version": "2022-11-28",
    };
  }

  /**
   * A token for one repository. An `InstalledRepository` has just been through `installed()` (so the org check is done, once); a bare
   * repository goes through it here. When the cached installation is gone (the App was uninstalled and installed again, which gives it a
   * new ID), the installation is looked up once more, and checked again. GitHub's 422 for a repository an installation does not (or no
   * longer) reach means, for an org, that its connection does not cover the repository. An agent's token carries the project's pinned
   * installation (`options`), and the retry checks it again exactly as the first attempt did: a lookup that crosses to another installation is
   * refused before any token is asked of it.
   */
  private async createInstallationToken(
    repository: { owner: string; name: string } | InstalledRepository,
    permissions: Record<string, "read" | "write">,
    scope: GitHubTokenScope,
    retried = false,
    options: AgentTokenOptions = {},
    minting = false,
    /** Receives the expiry GitHub states for the minted token (Plug-in foundations M-7), when the caller wants it. */
    expiry?: { expiresAt?: string },
  ): Promise<string> {
    const installed = "installationId" in repository ? repository : await this.installed(repository, scope);
    requirePinnedInstallation(installed, options);
    const cache = this.tokenCache;
    if (cache !== undefined && !minting) {
      const key = `${String(installed.installationId)}/${installed.name}/${JSON.stringify(Object.entries(permissions).sort())}`;
      let minted = cache.get(key);
      if (minted === undefined) {
        minted = this.createInstallationToken(installed, permissions, scope, retried, options, true);
        cache.set(key, minted);
        // A refused mint is not kept: the next call asks again.
        minted.catch(() => { if (cache.get(key) === minted) cache.delete(key); });
      }
      return minted;
    }
    const response = await this.postInstallationToken(installed.installationId, { repositories: [installed.name], permissions });
    if (response.status === 404 && !retried) {
      this.installations.delete(installed.owner.toLowerCase());
      return this.createInstallationToken({ owner: installed.owner, name: installed.name }, permissions, scope, true, options, false, expiry);
    }
    if (response.status === 422 && "orgId" in scope) throw agentXError("GITHUB_NOT_CONNECTED", githubNotConnectedMessage(`${installed.owner}/${installed.name}`));
    return this.tokenOf(response, { installationId: installed.installationId, repository: `${installed.owner}/${installed.name}`, requested: permissions }, expiry);
  }

  /** `POST /app/installations/{id}/access_tokens` with the App's JWT; the caller reads the status. */
  private async postInstallationToken(installationId: number, body: { permissions: Record<string, "read" | "write">; repositories?: string[] }, signal?: AbortSignal): Promise<Response> {
    return this.fetchImplementation(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST", headers: await this.appHeaders(), body: JSON.stringify(body), signal: signal === undefined ? AbortSignal.timeout(5_000) : AbortSignal.any([AbortSignal.timeout(5_000), signal]), redirect: "error",
    });
  }

  /** The token of a successful token response; anything else is GitHub being unavailable. */
  private async tokenOf(response: Response, issued?: Pick<GitHubTokenIssued, "installationId" | "repository" | "requested">, expiry?: { expiresAt?: string }): Promise<string> {
    if (!response.ok) {
      return this.unavailableFileRead(response, `GitHub App installation token request failed with HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string") {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid installation token response");
    }
    if (issued !== undefined && this.options.onTokenIssued !== undefined) {
      try { this.options.onTokenIssued({ ...issued, ...grantOf(body) }); } catch { /* a report that cannot be made never fails the mint */ }
    }
    if (expiry !== undefined) {
      const stated = grantOf(body).expiresAt;
      if (stated !== undefined) expiry.expiresAt = stated;
    }
    return body.token;
  }

  /** A token for a whole installation (no repository list), for the reads that name no one repository. */
  private async mintInstallationToken(installationId: number, permissions: Record<string, "read" | "write">, signal?: AbortSignal): Promise<string> {
    return this.tokenOf(await this.postInstallationToken(installationId, { permissions }, signal));
  }

  private async findOpenPullRequest(
    repository: InstalledRepository,
    input: GitHubPullRequestInput,
    token: string,
  ): Promise<FoundPullRequest | undefined> {
    const query = new URLSearchParams({
      state: "open",
      head: `${repository.owner}:${input.headBranch}`,
      base: input.baseBranch,
      per_page: "2",
    });
    const response = await this.fetchImplementation(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query.toString()}`,
      { headers: githubHeaders(token), redirect: "error", signal: AbortSignal.timeout(8_000) }, // L7a
    );
    if (!response.ok) {
      throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request lookup failed with HTTP ${response.status}`);
    }
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
    }
    if (value.length === 0) return undefined;
    return parsePullRequestWithDraft(value[0], repository);
  }
}

/**
 * WHERE a comment says it is: its `issue_url`, accepted only at the API origin the request went to (exact origin, so a comment cannot name another host), with the path `/repos/<owner>/<name>/issues/<n>` (a GitHub Enterprise
 * server's API sits under `/api/v3`). The repository address is the web address of the same host. Undefined for anything else.
 */
export function parseIssueUrl(issueUrl: string, apiOrigin: string): { repositoryUrl: string; number: number } | undefined {
  try {
    const url = new URL(issueUrl);
    if (url.origin !== apiOrigin || url.search !== "" || url.hash !== "") return undefined;
    const match = /^(?:\/api\/v3)?\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)$/u.exec(url.pathname);
    if (match === null) return undefined;
    const web = apiOrigin === "https://api.github.com" ? "https://github.com" : apiOrigin;
    return { repositoryUrl: `${web}/${match[1]!}/${match[2]!}`, number: Number(match[3]) };
  } catch {
    return undefined;
  }
}

/** A comment on a pull request's conversation as GitHub reports it (lane L12): the facts only. */
export interface GitHubIssueComment {
  id: string;
  /** The repository and the pull request (issue) number GitHub says it is on. */
  onRepositoryUrl: string;
  number: number;
  body: string;
  authorLogin: string;
  authorId?: string;
  isBot: boolean;
  createdAt: string;
  updatedAt: string;
  url: string;
}
export interface GitHubFeedbackComment {
  id: string; threadId?: string; kind: "REVIEW" | "REVIEW_COMMENT" | "DISCUSSION";
  /** In-memory identity only; never part of feedback bundles or refs. */
  authorId?: string; authorType?: string;
  url: string; author: string; updatedAt: string; body: string; path?: string; line?: number;
}
export interface GitHubFeedbackThread { id: string; resolved: boolean; commentIds: string[] }
export interface GitHubPullRequestFeedback {
  pullRequest: GitHubPullRequestDetails & { headTreeSha: string }; comments: GitHubFeedbackComment[]; threads: GitHubFeedbackThread[];
  /**
   * Comment id to whether the host records an edit of it (GraphQL `lastEditedAt`): false = never edited, true = edited. A comment not listed is unknown. Kept beside the comments, never in them:
   * the comments are digested into the bundles. Lessons capture reads it to prove a review body or comment is its author's own words.
   */
  edits?: Readonly<Record<string, boolean>>;
}
const FEEDBACK_THREAD_FIELDS = `id isResolved repository { nameWithOwner } pullRequest { number }
  comments(first:100) { nodes { fullDatabaseId lastEditedAt } pageInfo { hasNextPage endCursor } }`;
/** A GitHub database ID: a positive-integer string (GraphQL BigInt) or a safe-integer number. Null when neither. */
function feedbackDatabaseId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  const text = String(value);
  return /^[1-9][0-9]*$/.test(text) ? text : null;
}
function feedbackReadError(reason: string): AgentXError { return agentXError("RUNTIME_UNAVAILABLE", `GitHub feedback read refused: ${reason}`); }
function feedbackRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw feedbackReadError("invalid record");
  return value as Record<string, unknown>;
}
function feedbackConnection(value: unknown): { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const record = feedbackRecord(value); const info = feedbackRecord(record.pageInfo);
  if (!Array.isArray(record.nodes) || typeof info.hasNextPage !== "boolean" || (info.endCursor !== null && typeof info.endCursor !== "string")) throw feedbackReadError("invalid pagination state");
  return { nodes: record.nodes, pageInfo: { hasNextPage: info.hasNextPage, endCursor: info.endCursor } };
}
function nextFeedbackCursor(connection: ReturnType<typeof feedbackConnection>, seen: Set<string>): string | null {
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (!cursor || seen.has(cursor)) throw feedbackReadError("pagination did not advance");
  seen.add(cursor); return cursor;
}
function validateFeedbackThread(thread: Record<string, unknown>, repo: InstalledRepository, number: number): void {
  if (typeof thread.id !== "string" || !thread.id || typeof thread.isResolved !== "boolean"
    || feedbackRecord(thread.repository).nameWithOwner !== `${repo.owner}/${repo.name}`
    || feedbackRecord(thread.pullRequest).number !== number) throw feedbackReadError("thread scope mismatch");
}
function parseFeedbackComment(record: Record<string, unknown>, repository: InstalledRepository, number: number, kind: GitHubFeedbackComment["kind"]): GitHubFeedbackComment {
  const prefix = kind === "REVIEW" ? "review" : kind === "REVIEW_COMMENT" ? "review_comment" : "discussion";
  const anchor = kind === "REVIEW" ? "pullrequestreview-" : kind === "REVIEW_COMMENT" ? "discussion_r" : "issuecomment-";
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id < 1) throw feedbackReadError("invalid comment ID");
  const commentId = record.id;
  const expected = `https://github.com/${repository.owner}/${repository.name}/pull/${number}#${anchor}${commentId}`;
  const api = `https://api.github.com/repos/${repository.owner}/${repository.name}`;
  const user = feedbackRecord(record.user);
  const timestamp = record.updated_at ?? record.submitted_at;
  if (record.html_url !== expected || (kind === "REVIEW_COMMENT" && record.pull_request_url !== `${api}/pulls/${number}`)
    || (kind === "DISCUSSION" && record.issue_url !== `${api}/issues/${number}`)) throw feedbackReadError("comment scope mismatch: non-canonical URL");
  if ((record.body !== null && typeof record.body !== "string") || typeof user.login !== "string" || !user.login || user.login.length > 100
    || typeof timestamp !== "string" || !/^\d{4}-\d\d-\d\dT/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw feedbackReadError("invalid comment content");
  if (record.path !== undefined && (typeof record.path !== "string" || record.path.length > 1024)) throw feedbackReadError("invalid comment path");
  if (record.line !== undefined && record.line !== null && (!Number.isSafeInteger(record.line) || (record.line as number) < 1)) throw feedbackReadError("invalid comment line");
  return { id: `${prefix}:${commentId}`, kind, url: expected, author: user.login,
    ...(typeof user.id === "number" && Number.isSafeInteger(user.id) && user.id > 0 ? { authorId: String(user.id) } : {}),
    ...(typeof user.type === "string" && user.type.length <= 40 ? { authorType: user.type } : {}), updatedAt: new Date(timestamp).toISOString(), body: (record.body) ?? "",
    ...(kind === "REVIEW_COMMENT" && typeof record.path === "string" ? { path: record.path } : {}),
    ...(kind === "REVIEW_COMMENT" && typeof record.line === "number" ? { line: record.line } : {}) };
}

function pullRequestUrl(repository: InstalledRepository, number: number): string {
  if (!Number.isInteger(number) || number < 1) throw agentXError("CONFIG_INVALID", "pull request number is invalid");
  return `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}`;
}

function matchesUpdate(details: GitHubPullRequestDetails, update: GitHubPullRequestUpdate): boolean {
  return (update.title === undefined || details.title === update.title) &&
    (update.body === undefined || details.body === update.body) &&
    (update.state === undefined || details.state === update.state);
}

function requirePinnedInstallation(installed: { owner: string; name: string; installationId: number }, options: AgentTokenOptions): void {
  if (options.installationId !== undefined && options.installationId !== installed.installationId) {
    throw agentXError("GITHUB_NOT_CONNECTED", githubNotConnectedMessage(`${installed.owner}/${installed.name}`));
  }
}

/** Refuses (FORBIDDEN) any scope but an org's own: an agent's token is never minted for a system scope or for no one. */
function requireAgentScope(scope: unknown): asserts scope is AgentGitHubScope {
  if (scope === null || typeof scope !== "object" || !("orgId" in scope) || typeof scope.orgId !== "string" || "system" in scope) {
    throw agentXError("FORBIDDEN", "An agent's GitHub token is minted only for an organization's own work.");
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "agentx-control-plane",
    "x-github-api-version": "2022-11-28",
  };
}

function safeFutureMilliseconds(value: number, now: number): number | undefined {
  return Number.isSafeInteger(value) && value > now && Number.isFinite(new Date(value).getTime()) ? value : undefined;
}

export function mergeRateLimitRetryAt(response: Response, now: number): number | undefined {
  if (response.status !== 429 && response.status !== 403) return undefined;
  const candidates: number[] = [];
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = /^[0-9]+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : Number.NaN;
    const relative = safeFutureMilliseconds(now + seconds * 1_000, now);
    const absolute = safeFutureMilliseconds(Date.parse(retryAfter), now);
    if (relative !== undefined) candidates.push(relative);
    else if (absolute !== undefined) candidates.push(absolute);
  }
  const exhausted = response.headers.get("x-ratelimit-remaining")?.trim() === "0";
  if (exhausted) {
    const resetSeconds = response.headers.get("x-ratelimit-reset");
    const reset = resetSeconds !== null && /^[0-9]+$/.test(resetSeconds.trim())
      ? safeFutureMilliseconds(Number(resetSeconds.trim()) * 1_000, now) : undefined;
    if (reset !== undefined) candidates.push(reset);
  }
  if (response.status === 403 && candidates.length === 0 && !exhausted) return undefined;
  return candidates.length > 0 ? Math.max(...candidates) : safeFutureMilliseconds(now + 5 * 60_000, now);
}

/** When to ask GitHub again after a compare read, when the answer was a rate limit; undefined for every other answer (a 403 for lack of access included). */
export function compareRateLimitRetryAt(response: Response, body: unknown, now: number): number | undefined {
  const byHeaders = mergeRateLimitRetryAt(response, now);
  if (byHeaders !== undefined) return byHeaders;
  if (response.status !== 403) return undefined;
  const message = (body as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && /rate limit|abuse detection/iu.test(message) ? now + 60_000 : undefined;
}

function assertMergePullRequestIdentity(details: GitHubPullRequestDetails, expectedNumber: number): void {
  if (details.number !== expectedNumber || !/^[a-f0-9]{40}$/.test(details.headCommit)
    || (details.mergeCommit !== undefined && !/^[a-f0-9]{40}$/.test(details.mergeCommit))) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid merge observation identity");
  }
}

function parsePullRequest(
  value: unknown,
  repository: InstalledRepository,
): Omit<GitHubPullRequestResult, "reconciled"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.number) || (candidate.number as number) < 1 || typeof candidate.html_url !== "string") {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  const expected = `https://github.com/${repository.owner}/${repository.name}/pull/${String(candidate.number)}`;
  if (candidate.html_url !== expected) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned a non-canonical pull request URL");
  }
  return { number: candidate.number as number, url: candidate.html_url };
}

/** A pull request as the reconcile paths read it: the result without `reconciled`, and GitHub's own `draft` flag when it gives one. */
type FoundPullRequest = Omit<GitHubPullRequestResult, "reconciled" | "draftRefused"> & { isDraft?: boolean };
function parsePullRequestWithDraft(value: unknown, repository: InstalledRepository): FoundPullRequest {
  const basic = parsePullRequest(value, repository);
  const draft = (value as Record<string, unknown>).draft;
  return typeof draft === "boolean" ? { ...basic, isDraft: draft } : basic;
}

/** The login in a pull request's `merged_by`, when it is one GitHub could have issued (letters, digits and single hyphens, a bot's `[bot]` suffix allowed). */
function mergedByLogin(value: unknown): string | undefined {
  const login = value !== null && typeof value === "object" ? (value as Record<string, unknown>).login : undefined;
  return typeof login === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/u.test(login) ? login : undefined;
}

/** The login of the account in a pull request's `user`, when GitHub gives one. */
function userLoginOf(user: unknown): string | undefined {
  const login = user !== null && typeof user === "object" ? (user as Record<string, unknown>).login : undefined;
  return typeof login === "string" && login.length > 0 && login.length <= 100 ? login : undefined;
}
/** The id of a repository object (`base.repo`), as text, when GitHub gives a whole number. */
function repositoryIdOf(repo: unknown): string | undefined {
  const id = repo !== null && typeof repo === "object" ? (repo as Record<string, unknown>).id : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
}

function parsePullRequestDetails(
  value: unknown,
  repository: InstalledRepository,
): GitHubPullRequestDetails {
  const basic = parsePullRequest(value, repository);
  const candidate = value as Record<string, unknown>;
  const head = candidate.head;
  const base = candidate.base;
  if (
    (candidate.state !== "open" && candidate.state !== "closed") ||
    typeof candidate.merged !== "boolean" ||
    !head || typeof head !== "object" || Array.isArray(head) ||
    !base || typeof base !== "object" || Array.isArray(base) ||
    typeof (head as Record<string, unknown>).ref !== "string" ||
    typeof (head as Record<string, unknown>).sha !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test((head as Record<string, unknown>).sha as string) ||
    typeof (base as Record<string, unknown>).ref !== "string" ||
    typeof candidate.title !== "string" ||
    (candidate.body !== null && typeof candidate.body !== "string") ||
    (candidate.merge_commit_sha !== null && typeof candidate.merge_commit_sha !== "string")
  ) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  }
  // AgentX opens its pull requests from a branch of the base repository: a head in another repository (a fork, or a
  // deleted fork, which leaves no head repository) is never one of them.
  const headRepository = (head as Record<string, unknown>).repo;
  const headFullName = headRepository && typeof headRepository === "object" ? (headRepository as Record<string, unknown>).full_name : undefined;
  if (typeof headFullName !== "string" || headFullName.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase()) {
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned a pull request from another repository");
  }
  return {
    ...basic,
    state: candidate.merged ? "merged" : candidate.state,
    headBranch: (head as Record<string, unknown>).ref as string,
    baseBranch: (base as Record<string, unknown>).ref as string,
    headCommit: (head as Record<string, unknown>).sha as string,
    ...(typeof candidate.merge_commit_sha === "string" ? { mergeCommit: candidate.merge_commit_sha } : {}),
    ...(candidate.merged === true && typeof candidate.merged_at === "string" && Number.isFinite(Date.parse(candidate.merged_at)) ? { mergedAt: candidate.merged_at } : {}),
    ...(candidate.merged === true && typeof mergedByLogin(candidate.merged_by) === "string" ? { mergedBy: mergedByLogin(candidate.merged_by)! } : {}),
    title: candidate.title,
    body: candidate.body ?? "",
    ...(userLoginOf(candidate.user) === undefined ? {} : { authorLogin: userLoginOf(candidate.user)! }),
    ...(repositoryIdOf((base as Record<string, unknown>).repo) === undefined ? {} : { baseRepositoryId: repositoryIdOf((base as Record<string, unknown>).repo)! }),
  };
}

export function createGitHubAppJwt(appId: string, privateKey: string, nowMilliseconds: number): string {
  const issuedAt = Math.floor(nowMilliseconds / 1_000) - 60;
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({ iat: issuedAt, exp: issuedAt + 600, iss: appId });
  const signingInput = `${header}.${payload}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(privateKey).toString("base64url")}`;
  } catch (error) {
    if (isAgentXError(error)) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private key could not sign a token");
  }
}

export function privateKeyFromSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (
      value &&
      typeof value === "object" &&
      "privateKey" in value &&
      typeof value.privateKey === "string" &&
      value.privateKey.trim().startsWith("-----BEGIN")
    ) {
      return value.privateKey.trim();
    }
  } catch {
    // Report one stable error below without reflecting secret contents.
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is not a PEM key");
}

/** The App's id from the secret `agentx init` stores (`{"appId", "privateKey", ...}`). A secret
 * holding only a PEM key has none: its control plane passes GITHUB_APP_ID instead. */
export function appIdFromSecret(secret: string): string {
  try {
    const value = JSON.parse(secret.trim()) as unknown;
    if (value && typeof value === "object" && "appId" in value && typeof value.appId === "string" && GITHUB_APP_ID.test(value.appId)) {
      return value.appId;
    }
  } catch {
    // Report one stable error below without reflecting secret contents.
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App secret holds no appId; set the control plane's GitHubAppId parameter");
}

/** A non-empty string field of the App secret's JSON; undefined when the secret is not JSON or the field is not a string. Never throws, never echoes. */
function secretField(secret: string, name: string): string | undefined {
  try {
    const value = JSON.parse(secret.trim()) as unknown;
    if (value && typeof value === "object" && name in value) {
      const field = (value as Record<string, unknown>)[name];
      if (typeof field === "string" && field.trim() !== "") return field.trim();
    }
  } catch {
    // Do not include secret material in errors.
  }
  return undefined;
}

const GITHUB_WEBHOOK_SECRET_MISSING = "GitHub App secret does not contain a valid webhook secret";

/** True for the refusal webhookSecretFromSecret raises when the App secret has no usable webhook secret. */
export function isWebhookSecretMissing(error: unknown): boolean {
  return isAgentXError(error) && error.code === "RUNTIME_UNAVAILABLE" && error.message.endsWith(GITHUB_WEBHOOK_SECRET_MISSING);
}

/** Reads the optional webhook HMAC secret from the same protected App secret JSON object. */
export function webhookSecretFromSecret(secret: string): string {
  try {
    const value = JSON.parse(secret.trim()) as unknown;
    if (value && typeof value === "object" && "webhookSecret" in value && typeof value.webhookSecret === "string") {
      const webhookSecret = value.webhookSecret.trim();
      if (webhookSecret.length >= 32 && Buffer.byteLength(webhookSecret, "utf8") <= 4_096) return webhookSecret;
    }
  } catch {
    // Do not include secret material in errors.
  }
  throw agentXError("RUNTIME_UNAVAILABLE", GITHUB_WEBHOOK_SECRET_MISSING);
}

/** The well-formed part of what GitHub says an installation token grants: permission names with read, write or admin, the repositories' names, the selection and the expiry. */
function grantOf(body: Record<string, unknown>): Partial<Pick<GitHubTokenIssued, "granted" | "repositorySelection" | "repositories" | "expiresAt">> {
  const out: Partial<Pick<GitHubTokenIssued, "granted" | "repositorySelection" | "repositories" | "expiresAt">> = {};
  const permissions = body["permissions"];
  if (permissions !== null && typeof permissions === "object" && !Array.isArray(permissions)) {
    const granted = Object.fromEntries(Object.entries(permissions).filter(([name, level]) => /^[a-z_]{1,64}$/.test(name) && (level === "read" || level === "write" || level === "admin")));
    out.granted = granted;
  }
  if (typeof body["repository_selection"] === "string" && /^[a-z]{1,16}$/.test(body["repository_selection"])) out.repositorySelection = body["repository_selection"];
  if (Array.isArray(body["repositories"])) {
    out.repositories = body["repositories"].flatMap((entry: unknown) => {
      const name = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)["name"] : undefined;
      return typeof name === "string" && GITHUB_REPOSITORY_NAME.test(name) ? [name] : [];
    }).slice(0, 20);
  }
  if (typeof body["expires_at"] === "string" && /^[0-9TZ:.+-]{10,40}$/.test(body["expires_at"])) out.expiresAt = body["expires_at"];
  return out;
}

export function parseGitHubRepository(repositoryUrl: string): { owner: string; name: string } {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    // An address that is not a URL at all (for example `git@gitlab.com:org/repo`): say "github.com only" when it names another host.
    const named = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@\s/]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)[:/]/.exec(repositoryUrl.trim())?.[1];
    throw agentXError("CONFIG_INVALID", named !== undefined && named.toLowerCase() !== "github.com"
      ? "GitHub repository URL is invalid: only github.com repositories are supported"
      : "GitHub repository URL is invalid");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    segments.length !== 2 ||
    segments.some((segment) => segment.includes("%"))
  ) {
    // An empty host (`github.com:org/repo` parses as a scheme) is not another host: no blame.
    throw agentXError("CONFIG_INVALID", url.hostname === "" || url.hostname.toLowerCase() === "github.com"
      ? "credentialed repository must be a canonical GitHub HTTPS URL"
      : "credentialed repository must be a canonical GitHub HTTPS URL: only github.com repositories are supported");
  }
  const [owner, rawName] = segments;
  const name = rawName?.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (
    !owner ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    !name ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(name)
  ) {
    throw agentXError("CONFIG_INVALID", "credentialed repository must be a canonical GitHub HTTPS URL");
  }
  return { owner, name };
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isAgentXError(error: unknown): error is AgentXError {
  return error instanceof Error && error.name === "AgentXError";
}

interface WorkingBranchInput extends InstalledRepository { orgId: OrgId; repositoryId: number }
const workingBranchInvalid = () => agentXError("CONFIG_INVALID", "Review a valid pinned repository branch before continuing.");
const workingBranchUnavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The working branch could not be checked. Try again.");
function workingBranchInput(repositoryUrl: string, expected: { installationId: number; repositoryId: number }, scope: GitHubTokenScope): WorkingBranchInput {
  if (!scope || typeof scope !== "object" || !("orgId" in scope) || "system" in scope || !OrgIdSchema.safeParse(scope.orgId).success || !expected || !Number.isSafeInteger(expected.installationId) || expected.installationId < 1 || !Number.isSafeInteger(expected.repositoryId) || expected.repositoryId < 1) throw workingBranchInvalid();
  let repository: { owner: string; name: string };
  try { repository = parseGitHubRepository(repositoryUrl); } catch { throw workingBranchInvalid(); }
  return { ...repository, orgId: scope.orgId, installationId: expected.installationId, repositoryId: expected.repositoryId };
}

export interface WorkingBranchPage { branches: string[]; page: number; mayHaveMore: boolean; omittedUnsupported: boolean }
/** Bound both metadata and list bodies independently of content-length or unknown provider fields. */
async function workingBranchPageJson(response: Response): Promise<unknown> {
  if (response.body === null) throw workingBranchUnavailable();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw workingBranchUnavailable();
      bytes += chunk.byteLength;
      if (bytes > 524_288) { await reader.cancel(); throw workingBranchUnavailable(); }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { reader.releaseLock(); }
}
