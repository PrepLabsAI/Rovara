// Rovara Code (Plan 6 Task 14): what GitHub says about one pull request for merge tracking, and the parsing of it. Pure functions over GitHub's JSON, so each answer is
// checked field by field before anything decides on it; an answer that does not fit throws (the tracking pass then tries again), it is never read as "fine".
import { agentXError } from "@agentx/contracts";

/** A check or status on the head: `pending` until it has finished. */
export type PullRequestCheckStatus = "pending" | "completed";
export type PullRequestCheckConclusion =
  | "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "stale" | "startup_failure" | "error";

export interface PullRequestCheck {
  name: string;
  status: PullRequestCheckStatus;
  conclusion?: PullRequestCheckConclusion;
  /** Whether the base branch requires this check (GitHub's `isRequired` for this pull request). */
  required: boolean;
  url: string;
  /** The check run's database id, which is the job id of a GitHub Actions job. */
  jobId?: string;
  /** The GitHub App that made the check run (a commit status has none). */
  appId?: number;
}

/** A check the base branch requires by name (branch protection or a ruleset), and the app it must come from when one is named. */
export interface RequiredCheck {
  name: string;
  appId?: number;
}

export interface PullRequestReview {
  githubUserId: string;
  login: string;
  userType: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  commitId: string;
  submittedAt: string;
}

export type PullRequestMergeableState = "clean" | "dirty" | "behind" | "blocked" | "unstable" | "has_hooks" | "draft" | "unknown";

export interface PullRequestStatus {
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  baseBranch: string;
  mergeableState: PullRequestMergeableState;
  /** GitHub's `mergeable` when it has worked it out: false means the branch conflicts with its base. Absent while GitHub is still working it out. */
  mergeable?: boolean;
  /** How many commits of the base the branch lacks, when it was worked out (it is not asked of a branch GitHub already calls dirty, behind or unknown). */
  behindBy?: number;
  checks: PullRequestCheck[];
  /** The checks could not be read (GitHub refused the checks/statuses access, or the list failed): they are not known, so no reading of them may say "passing". */
  checksUnavailable?: true;
  /** The checks the base branch requires, from classic branch protection and from the rulesets that apply to it (the union), whether or not they have reported. */
  requiredChecks: RequiredCheck[];
  /** The list of reviews was cut at the page limit: what is past it is not known, so no approval may be read from this list. */
  reviewsIncomplete?: true;
  baseHasRequiredChecks: boolean;
  headHasWorkflowFiles: boolean;
  /** How many reviewers (people and teams) are asked for a review now. */
  requestedReviewers: number;
  /** The GitHub user ids of the people (not teams or bots) asked for a review now, at most `REQUESTED_REVIEWER_IDS_MAX`. Absent when none is listed. */
  requestedReviewerIds?: string[];
  reviews: PullRequestReview[];
}

const SHA = /^[a-f0-9]{40}$/;
const MAX_NAME = 200;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const HAS_CONTROL = /[\p{Cc}\p{Cf}]/u;

function fail(reason: string): never {
  throw agentXError("RUNTIME_UNAVAILABLE", `GitHub pull request status read refused: ${reason}`);
}

export function statusRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("invalid record");
  return value as Record<string, unknown>;
}

/** A name from GitHub as one short line: control and format characters taken out, cut at 200 characters. */
export function cleanName(value: unknown): string {
  if (typeof value !== "string") return fail("invalid name");
  const text = value.replace(CONTROL, " ").trim();
  return text.length === 0 ? fail("empty name") : [...text].slice(0, MAX_NAME).join("");
}

const MERGEABLE_STATES: ReadonlySet<string> = new Set(["clean", "dirty", "behind", "blocked", "unstable", "has_hooks", "draft", "unknown"]);

export function parseMergeableState(value: unknown): PullRequestMergeableState {
  // GitHub works the state out on first request and answers null until it has: that is "unknown", not an error.
  if (value === null || value === undefined) return "unknown";
  return typeof value === "string" && MERGEABLE_STATES.has(value) ? value as PullRequestMergeableState : "unknown";
}

const CONCLUSIONS: Readonly<Record<string, PullRequestCheckConclusion>> = {
  SUCCESS: "success", FAILURE: "failure", NEUTRAL: "neutral", CANCELLED: "cancelled", SKIPPED: "skipped", TIMED_OUT: "timed_out",
  ACTION_REQUIRED: "action_required", STALE: "stale", STARTUP_FAILURE: "startup_failure",
};

/** One node of the head commit's `statusCheckRollup.contexts`: a check run or a commit status. */
export function parseRollupContext(value: unknown): PullRequestCheck {
  const node = statusRecord(value);
  const required = node.isRequired === true;
  if (node.__typename === "CheckRun") {
    const completed = node.status === "COMPLETED";
    const conclusion = typeof node.conclusion === "string" ? CONCLUSIONS[node.conclusion] : undefined;
    // A finished run with a conclusion this reader does not know is not a pass.
    if (completed && conclusion === undefined) return fail("unknown check conclusion");
    const id = typeof node.databaseId === "number" && Number.isSafeInteger(node.databaseId) && node.databaseId > 0 ? String(node.databaseId) : undefined;
    const suite = node.checkSuite === null || typeof node.checkSuite !== "object" ? undefined : node.checkSuite as Record<string, unknown>;
    const app = suite?.app === null || typeof suite?.app !== "object" ? undefined : suite.app as Record<string, unknown>;
    const appId = typeof app?.databaseId === "number" && Number.isSafeInteger(app.databaseId) && app.databaseId > 0 ? app.databaseId : undefined;
    return {
      name: cleanName(node.name), status: completed ? "completed" : "pending", ...(completed && conclusion !== undefined ? { conclusion } : {}),
      required, url: safeUrl(node.detailsUrl), ...(id === undefined ? {} : { jobId: id }), ...(appId === undefined ? {} : { appId }),
    };
  }
  if (node.__typename === "StatusContext") {
    const state = node.state;
    if (state !== "EXPECTED" && state !== "ERROR" && state !== "FAILURE" && state !== "PENDING" && state !== "SUCCESS") return fail("unknown status state");
    const finished = state === "ERROR" || state === "FAILURE" || state === "SUCCESS";
    return {
      name: cleanName(node.context), status: finished ? "completed" : "pending",
      ...(finished ? { conclusion: state === "SUCCESS" ? "success" as const : state === "ERROR" ? "error" as const : "failure" as const } : {}),
      required, url: safeUrl(node.targetUrl),
    };
  }
  return fail("unknown check kind");
}

/** A link GitHub gave for a check: https only, at most 2,048 characters, or an empty string. */
function safeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : "";
  } catch {
    return "";
  }
}

const REVIEW_STATES: ReadonlySet<string> = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);

/** One review of `pulls/{n}/reviews`. A review that is not yet submitted (PENDING, no `submitted_at`) is not returned: it is the reviewer's draft. */
export function parseReview(value: unknown): PullRequestReview | undefined {
  const review = statusRecord(value);
  const user = review.user === null || review.user === undefined ? undefined : statusRecord(review.user);
  // A deleted account ("ghost") leaves a review with no user: it can be counted for nothing.
  if (user === undefined) return undefined;
  if (typeof review.state !== "string" || !REVIEW_STATES.has(review.state)) return fail("unknown review state");
  if (review.state === "PENDING" || typeof review.submitted_at !== "string") return undefined;
  const id = user.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return fail("invalid reviewer id");
  const login = user.login;
  if (typeof login !== "string" || login.length === 0 || login.length > 100 || HAS_CONTROL.test(login)) return fail("invalid reviewer login");
  const commit = review.commit_id;
  if (typeof commit !== "string" || !SHA.test(commit)) return fail("invalid review commit");
  const submittedAt = Date.parse(review.submitted_at);
  if (!Number.isFinite(submittedAt)) return fail("invalid review time");
  return {
    githubUserId: String(id), login, userType: typeof user.type === "string" ? user.type.slice(0, 20) : "", state: review.state as PullRequestReview["state"],
    commitId: commit, submittedAt: new Date(submittedAt).toISOString(),
  };
}

/** What the permission endpoint answers, as the four words tracking uses. `maintain` reads as `write`. */
export function parseRepositoryPermission(value: unknown): "admin" | "write" | "read" | "none" {
  const body = statusRecord(value);
  if (body.role_name === "maintain") return "write";
  const permission = body.permission;
  if (permission === "admin" || permission === "write" || permission === "read" || permission === "none") return permission;
  // `triage` and anything else a repository role can be: below write.
  return typeof permission === "string" ? "read" : fail("invalid permission answer");
}

export function requestedReviewerCount(pull: Record<string, unknown>): number {
  const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;
  return count(pull.requested_reviewers) + count(pull.requested_teams);
}

/** How many requested reviewers are kept: more than this are not reminded. */
export const REQUESTED_REVIEWER_IDS_MAX = 25;

/** The GitHub user ids of the people `requested_reviewers` lists (a bot or an entry that does not read is left out; teams are another list). */
export function requestedReviewerIds(pull: Record<string, unknown>): string[] {
  const listed = pull.requested_reviewers;
  if (!Array.isArray(listed)) return [];
  const ids: string[] = [];
  for (const entry of listed) {
    if (entry === null || typeof entry !== "object") continue;
    const { id, type } = entry as Record<string, unknown>;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || (type !== undefined && type !== "User")) continue;
    if (!ids.includes(String(id))) ids.push(String(id));
    if (ids.length >= REQUESTED_REVIEWER_IDS_MAX) break;
  }
  return ids;
}

function requiredEntry(context: unknown, app: unknown): RequiredCheck | undefined {
  if (typeof context !== "string" || context.length === 0) return undefined;
  const name = context.slice(0, MAX_NAME);
  // -1 and null mean "any app" in GitHub's settings.
  return typeof app === "number" && Number.isSafeInteger(app) && app > 0 ? { name, appId: app } : { name };
}

/** Adds the entries not already there (same name, same app). */
export function mergeRequiredChecks(into: RequiredCheck[], more: readonly RequiredCheck[]): RequiredCheck[] {
  for (const entry of more) if (!into.some((have) => have.name === entry.name && have.appId === entry.appId)) into.push(entry);
  return into;
}

/** The checks classic branch protection requires: `required_status_checks.contexts` and `.checks[]` (a name and the app it must come from). Throws when the body does not fit. */
export function requiredChecksFromProtection(branch: unknown): RequiredCheck[] {
  const protection = statusRecord(branch).protection;
  if (protection === undefined || protection === null) return [];
  const required = statusRecord(protection).required_status_checks;
  if (required === undefined || required === null) return [];
  const record = statusRecord(required);
  const found: RequiredCheck[] = [];
  if (record.contexts !== undefined && !Array.isArray(record.contexts)) return fail("invalid required contexts");
  if (record.checks !== undefined && !Array.isArray(record.checks)) return fail("invalid required checks");
  for (const context of (record.contexts ?? []) as unknown[]) mergeRequiredChecks(found, [requiredEntry(context, undefined)].filter((entry) => entry !== undefined));
  for (const entry of (record.checks ?? []) as unknown[]) {
    const item = statusRecord(entry);
    mergeRequiredChecks(found, [requiredEntry(item.context, item.app_id)].filter((value) => value !== undefined));
  }
  return found;
}

/** The checks the rulesets that apply to the base branch require (`GET rules/branches/{branch}`, the `required_status_checks` rules). Throws when the body does not fit. */
export function requiredChecksFromRules(rules: unknown): RequiredCheck[] {
  if (!Array.isArray(rules)) return fail("invalid rules list");
  const found: RequiredCheck[] = [];
  for (const rule of rules as unknown[]) {
    const record = statusRecord(rule);
    if (record.type !== "required_status_checks") continue;
    const list = statusRecord(record.parameters).required_status_checks;
    if (!Array.isArray(list)) return fail("invalid required checks rule");
    for (const entry of list as unknown[]) {
      const item = statusRecord(entry);
      mergeRequiredChecks(found, [requiredEntry(item.context, item.integration_id)].filter((value) => value !== undefined));
    }
  }
  return found;
}
