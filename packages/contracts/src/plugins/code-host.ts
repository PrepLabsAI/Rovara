// The CodeHost port: where the code lives and where change requests are opened, reviewed and merged. GitHub is the first adapter.
// Grouped from the methods the broker already uses of `GitHubAppCredentialProvider` (broker.ts `githubPullRequests`, about 40 of them).
import { z } from "zod";
import {
  BranchNameSchema, ExternalIdSchema, HostAccountSchema, HttpsUrlOrEmptySchema, ISO_TIME, PluginKindSchema, RepositoryRefSchema, RevisionSchema,
  type HostAccount, type HostScope, type PluginKind, type ReadBudget, type RepositoryRef, type UntrustedText,
} from "./common.js";

// ---- capabilities: what an adapter can do. Callers branch on these, never on the adapter's name.

export const GIT_CREDENTIAL_KINDS = ["token", "basic", "ssh-key", "helper"] as const;
export const GitCredentialKindSchema = z.enum(GIT_CREDENTIAL_KINDS);
export type GitCredentialKind = z.infer<typeof GitCredentialKindSchema>;

/** The kinds every worker takes: the wire shapes `{username, password}` and `{token}`. A worker that says nothing about kinds takes these and no others. */
export const LEGACY_WORKER_CREDENTIAL_KINDS: readonly GitCredentialKind[] = ["token", "basic"];
/**
 * The feature a worker lists on /ping when it takes a credential kind beyond the legacy two (today: an ssh key, `ssh-key`). Without it the broker neither dispatches a repository whose host
 * hands out such a kind nor sends one at the exchange (Enterprise foundations P8). A kind no worker takes yet (`helper`) is never sent.
 */
export const WORKER_CREDENTIAL_KINDS_FEATURE = "repository.credentialKinds.v1" as const;
/** The request header a worker sends at `/repository-credentials` to say which kinds it takes: a comma-separated list. Absent or unreadable means the legacy two. */
export const WORKER_CREDENTIAL_KINDS_HEADER = "x-agentx-credential-kinds";
/** The kinds a worker with these /ping features takes. */
export function credentialKindsOfWorkerFeatures(features: readonly string[]): GitCredentialKind[] {
  return features.includes(WORKER_CREDENTIAL_KINDS_FEATURE) ? [...LEGACY_WORKER_CREDENTIAL_KINDS, "ssh-key"] : [...LEGACY_WORKER_CREDENTIAL_KINDS];
}
/** The kinds a request header names. Unknown names are dropped, the list is bounded, and a header that is missing or empty names the legacy two (never more than was said). */
export function parseWorkerCredentialKindsHeader(value: string | undefined): GitCredentialKind[] {
  if (value === undefined || value.length > 128) return [...LEGACY_WORKER_CREDENTIAL_KINDS];
  const named = new Set<GitCredentialKind>();
  for (const part of value.split(",")) {
    const parsed = GitCredentialKindSchema.safeParse(part.trim());
    if (parsed.success) named.add(parsed.data);
  }
  return named.size === 0 ? [...LEGACY_WORKER_CREDENTIAL_KINDS] : GIT_CREDENTIAL_KINDS.filter((kind) => named.has(kind));
}
/** The kinds a worker can be sent on the wire: the legacy two and an ssh key. A `helper` has no wire shape, so it is never sent and never asked of a worker. */
export const SENDABLE_WORKER_CREDENTIAL_KINDS: readonly GitCredentialKind[] = ["token", "basic", "ssh-key"];
/** Whether a kind is one the exchange can send; the dispatcher requires the worker's feature only for these. */
export const credentialKindIsSendable = (kind: string): boolean => (SENDABLE_WORKER_CREDENTIAL_KINDS as readonly string[]).includes(kind);
/** Whether a credential kind needs the worker feature (every kind beyond the legacy two does). */
export function credentialKindNeedsWorkerFeature(kind: string): boolean {
  return !(LEGACY_WORKER_CREDENTIAL_KINDS as readonly string[]).includes(kind);
}

export const CodeHostCapabilitiesSchema = z.object({
  /** Change requests can be opened as drafts. */
  drafts: z.boolean(),
  /** Comments come in resolvable threads. */
  threadedComments: z.boolean(),
  /** The host can require approvals or checks before a merge. */
  requiredApprovals: z.boolean(),
  codeOwners: z.boolean(),
  /** Events arrive as webhooks. False: the install polls. */
  webhooks: z.boolean(),
  rerunChecks: z.boolean(),
  /** The host can act with a person's own short-lived delegated credential (the on-behalf-of mode). */
  perPersonCredentials: z.boolean(),
  /** `merge` is offered. Rovara only ever merges after a person approves and presses Merge. */
  merge: z.boolean(),
  markReady: z.boolean(),
  requestReviewers: z.boolean(),
  /** The git credential kinds `issueGitCredential` can hand out. A worker that does not advertise a kind never receives it. */
  credentialKinds: z.array(GitCredentialKindSchema).min(1).max(GIT_CREDENTIAL_KINDS.length),
}).strict();
export type CodeHostCapabilities = z.infer<typeof CodeHostCapabilitiesSchema>;

// ---- neutral data

/** `private`: whether only the company's own people can read the repository (absent: the host did not say, which callers treat as not private). */
export const RepositoryIdentitySchema = z.object({ id: ExternalIdSchema, fullName: z.string().min(1).max(300), defaultBranch: BranchNameSchema.optional(), private: z.boolean().optional() }).strict();
export type RepositoryIdentity = z.infer<typeof RepositoryIdentitySchema>;

export const HostPermissionSchema = z.enum(["admin", "write", "read", "none"]);
export type HostPermission = z.infer<typeof HostPermissionSchema>;
/** What a person may do at the repository, and what kind of account it is (a person, a bot). */
export const HostStandingSchema = z.object({ permission: HostPermissionSchema, accountType: z.string().min(1).max(40).optional() }).strict();
export type HostStanding = z.infer<typeof HostStandingSchema>;

/** The git credential helpers a worker may be told to use, by name. Never a command: git runs a helper that starts with `!` through a shell. */
export const GIT_CREDENTIAL_HELPERS = ["aws-codecommit"] as const;
export const GitCredentialHelperSchema = z.enum(GIT_CREDENTIAL_HELPERS);

/** A credential handed to a worker lives at most this long (GitHub's installation tokens last an hour). */
export const GIT_CREDENTIAL_MAX_LIFETIME_MS = 60 * 60 * 1_000;

/** An OpenSSH-format private key (never printed or logged; it goes to a file only the worker's user can read). */
export const SshPrivateKeySchema = z.string().min(1).max(16_384).regex(/^-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n: ,.-]+\r?\n-----END (?:OPENSSH|RSA|EC) PRIVATE KEY-----\r?\n?$/, "an OpenSSH private key");
/**
 * Where an ssh credential clones and pushes: `ssh://[user@]host[:port]/path`. The host starts with a letter or digit, so it can never be read as an ssh option, and the path has no
 * space, quote or `$`, so it can never be read by the remote shell as more than a path.
 */
export const SshRemoteUrlSchema = z.string().min(1).max(512).regex(/^ssh:\/\/(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?\/[A-Za-z0-9._~+/-]{1,300}$/, "an ssh:// address");
// A host pattern is a literal name or address, or `[host]:port`: no `*`, `?` or `!`, so a line can never vouch for hosts it does not name.
const KNOWN_HOSTS_LINE = /^[A-Za-z0-9.\-[\]:]+(?:,[A-Za-z0-9.\-[\]:]+)* (?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]{20,1000}={0,2}$/;
/**
 * The host keys the ssh server is trusted under, as `known_hosts` lines (plain host patterns, no marker, no hashed host). The worker pins them and never accepts an unknown host,
 * so a credential with no host key is refused rather than trusting the first server that answers.
 */
export const SshKnownHostsSchema = z.string().min(1).max(8_192).refine((value) => {
  const lines = value.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.length > 0 && lines.length <= 16 && lines.every((line) => KNOWN_HOSTS_LINE.test(line));
}, "known_hosts lines");

/** The host and port an `ssh://` address names (the user is not part of it), or undefined for an address that is not one. */
function sshHostOf(sshUrl: string): { host: string; port: number } | undefined {
  const match = /^ssh:\/\/(?:[^@/]+@)?([^:/]+)(?::([0-9]{1,5}))?\//u.exec(sshUrl);
  return match?.[1] === undefined ? undefined : { host: match[1].toLowerCase(), port: match[2] === undefined ? 22 : Number(match[2]) };
}

/**
 * Whether the host keys are for the server the address names: every `known_hosts` line must list that host (`host`, or `[host]:port` for another port than 22), so a key for some other server can
 * never stand in, and a line that names only other hosts is refused. Names compare in lower case; there are no wildcards to match (the line check refuses them).
 */
export function sshKnownHostsMatchAddress(sshUrl: string, knownHosts: string): boolean {
  const target = sshHostOf(sshUrl);
  if (target === undefined) return false;
  const wanted = target.port === 22 ? target.host : `[${target.host}]:${String(target.port)}`;
  const lines = knownHosts.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => (line.split(" ")[0] ?? "").split(",").some((pattern) => pattern.toLowerCase() === wanted));
}

/** What the worker is sent for an ssh key: the key, the address and the pinned host keys, held to the same rules on both sides of the wire. */
export const SshCredentialMaterialSchema = z.object({ privateKey: SshPrivateKeySchema, url: SshRemoteUrlSchema, knownHosts: SshKnownHostsSchema }).strict()
  .refine((value) => sshKnownHostsMatchAddress(value.url, value.knownHosts), "the host keys are not for the address's host");

const ExpiresAt = z.string().min(1).max(64).refine((value) => Number.isFinite(Date.parse(value)), "an ISO time");

/**
 * What the worker clones and pushes with: minted per operation and always with an expiry. The secret never enters a model's context or a log; this schema is only
 * for the broker-to-worker exchange (`/repository-credentials`). `expiresAt` is required on every kind (when the host stops accepting it, or when Rovara will
 * stop using it), and `workerGitCredentialUsable` holds it to one hour. An ssh key is for a service identity only, and a helper is a name from a fixed list.
 */
export const GitCredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("token"), username: z.string().min(1).max(200).optional(), token: z.string().min(1).max(4_096), expiresAt: ExpiresAt }).strict(),
  z.object({ kind: z.literal("basic"), username: z.string().min(1).max(200), password: z.string().min(1).max(4_096), expiresAt: ExpiresAt }).strict(),
  z.object({ kind: z.literal("ssh-key"), privateKey: SshPrivateKeySchema, sshUrl: SshRemoteUrlSchema, knownHosts: SshKnownHostsSchema, expiresAt: ExpiresAt }).strict()
    .refine((value) => sshKnownHostsMatchAddress(value.sshUrl, value.knownHosts), "the host keys are not for the address's host"),
  z.object({ kind: z.literal("helper"), helper: GitCredentialHelperSchema, expiresAt: ExpiresAt }).strict(),
]);
export type GitCredential = z.infer<typeof GitCredentialSchema>;

export type GitCredentialRefusal = "invalid" | "expired" | "too_long_lived" | "ssh_key_needs_service_identity";

/**
 * Whether a credential may go to a worker now. It must parse, must not be expired, must not outlive an hour from `now`, and an ssh key goes only when the host acts
 * as a service identity (a delegated, per-person credential is never a long-lived key).
 */
export function workerGitCredentialUsable(credential: unknown, context: { now: number; actingAs: "service" | "on-behalf-of" }): { ok: true; credential: GitCredential } | { ok: false; reason: GitCredentialRefusal } {
  const parsed = GitCredentialSchema.safeParse(credential);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const expires = Date.parse(parsed.data.expiresAt);
  if (!(expires > context.now)) return { ok: false, reason: "expired" };
  if (expires - context.now > GIT_CREDENTIAL_MAX_LIFETIME_MS) return { ok: false, reason: "too_long_lived" };
  if (parsed.data.kind === "ssh-key" && context.actingAs !== "service") return { ok: false, reason: "ssh_key_needs_service_identity" };
  return { ok: true, credential: parsed.data };
}
export type GitAccess = "clone" | "push";

export const ChangeRequestStateSchema = z.enum(["open", "closed", "merged"]);
export type ChangeRequestState = z.infer<typeof ChangeRequestStateSchema>;

/** A change request (a pull request or a CR). `id` is the host's own number or id as a string. */
export const ChangeRequestRefSchema = z.object({ repository: RepositoryRefSchema, id: ExternalIdSchema, url: HttpsUrlOrEmptySchema }).strict();
export type ChangeRequestRef = z.infer<typeof ChangeRequestRefSchema>;

export const ChangeRequestInputSchema = z.object({
  repository: RepositoryRefSchema,
  sourceBranch: BranchNameSchema,
  targetBranch: BranchNameSchema,
  title: z.string().min(1).max(500),
  body: z.string().max(65_536).optional(),
  /** Asked to open as a draft. A host that cannot says so in the result (`draftRefused`), and the body then carries the do-not-merge note. */
  draft: z.boolean().optional(),
}).strict();
export type ChangeRequestInput = z.infer<typeof ChangeRequestInputSchema>;

/** The result of an idempotent create-or-update: asking twice for the same source and target branches answers the same change request with `reconciled: true`. */
export const ChangeRequestReconciledSchema = z.object({ ref: ChangeRequestRefSchema, reconciled: z.boolean(), draftRefused: z.literal(true).optional() }).strict();
export type ChangeRequestReconciled = z.infer<typeof ChangeRequestReconciledSchema>;

export const ChangeRequestDetailsSchema = z.object({
  ref: ChangeRequestRefSchema,
  state: ChangeRequestStateSchema,
  sourceBranch: BranchNameSchema,
  targetBranch: BranchNameSchema,
  headRevision: RevisionSchema,
  mergeRevision: RevisionSchema.optional(),
  /** When the host says it merged (a merged change request only). Optional: a host that does not say, or a record from before P6, has none. */
  mergedAt: ISO_TIME.optional(),
  mergedBy: z.string().min(1).max(200).optional(),
  title: z.string().max(500),
  body: z.string().max(65_536),
}).strict();
export type ChangeRequestDetails = z.infer<typeof ChangeRequestDetailsSchema>;

/**
 * P6: a change request's merge state read for scoring or recovery: its details and the id of its head's tree, read so that the answer did not change while it was read.
 * `mergeRevision` and `mergedAt` are what track-record samples carry.
 */
export const MergeObservationSchema = ChangeRequestDetailsSchema.extend({ headTreeRevision: RevisionSchema }).strict();
export type MergeObservation = z.infer<typeof MergeObservationSchema>;

export const ChangeRequestUpdateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(65_536).optional(),
  state: z.enum(["open", "closed"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "an update changes at least one field");
export type ChangeRequestUpdate = z.infer<typeof ChangeRequestUpdateSchema>;

export const CHECK_CONCLUSIONS = ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure", "error"] as const;
export const CheckConclusionSchema = z.enum(CHECK_CONCLUSIONS);
export type CheckConclusion = z.infer<typeof CheckConclusionSchema>;

/** A check or build result on a revision: `pending` until it has finished. A finished check always has a conclusion; one that has none is not a pass. */
export const CheckSchema = z.object({
  name: z.string().min(1).max(200),
  state: z.enum(["pending", "completed"]),
  conclusion: CheckConclusionSchema.optional(),
  /** The target requires this check before a merge. */
  required: z.boolean(),
  url: HttpsUrlOrEmptySchema,
  /** The runner's own id for the run (a job id, a build id), used to read its log. */
  runId: ExternalIdSchema.optional(),
  /** The system that produced it, when the host tells (a GitHub App id, a pipeline name). */
  source: z.string().min(1).max(200).optional(),
}).strict().superRefine((check, ctx) => {
  if (check.state === "completed" && check.conclusion === undefined) ctx.addIssue({ code: "custom", message: "a completed check has a conclusion", path: ["conclusion"] });
  if (check.state === "pending" && check.conclusion !== undefined) ctx.addIssue({ code: "custom", message: "a pending check has no conclusion", path: ["conclusion"] });
});
export type Check = z.infer<typeof CheckSchema>;

export const RequiredCheckSchema = z.object({ name: z.string().min(1).max(200), source: z.string().min(1).max(200).optional() }).strict();
export type RequiredCheck = z.infer<typeof RequiredCheckSchema>;

export const ReviewStateSchema = z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export const ReviewSchema = z.object({
  reviewer: HostAccountSchema,
  accountType: z.string().min(1).max(40),
  state: ReviewStateSchema,
  revision: RevisionSchema,
  submittedAt: ISO_TIME,
}).strict();
export type Review = z.infer<typeof ReviewSchema>;

/** The host's own word on whether the change request can merge now. Kept in the vocabulary the broker's tracking already reads, so moving to the port changes nothing. */
export const MergeableStateSchema = z.enum(["clean", "dirty", "behind", "blocked", "unstable", "has_hooks", "draft", "unknown"]);
export type MergeableState = z.infer<typeof MergeableStateSchema>;

export const ChangeRequestStatusSchema = z.object({
  id: ExternalIdSchema,
  state: ChangeRequestStateSchema,
  draft: z.boolean(),
  headRevision: RevisionSchema,
  targetBranch: BranchNameSchema,
  mergeableState: MergeableStateSchema,
  mergeable: z.boolean().optional(),
  behindBy: z.number().int().nonnegative().optional(),
  checks: z.array(CheckSchema).max(500),
  /** The checks could not be read: they are not known, so nothing may read "passing" from this status. */
  checksUnavailable: z.literal(true).optional(),
  requiredChecks: z.array(RequiredCheckSchema).max(500),
  /** The list of reviews was cut: what is past it is not known, so no approval may be read from this list. */
  reviewsIncomplete: z.literal(true).optional(),
  targetHasRequiredChecks: z.boolean(),
  /** The head defines checks of its own (workflow files, a build spec). */
  headDefinesChecks: z.boolean(),
  requestedReviewers: z.number().int().nonnegative(),
  requestedReviewerIds: z.array(ExternalIdSchema).max(100).optional(),
  reviews: z.array(ReviewSchema).max(500),
}).strict();
export type ChangeRequestStatus = z.infer<typeof ChangeRequestStatusSchema>;

export const ChangeRequestFileSchema = z.object({
  path: z.string().min(1).max(4_096),
  status: z.string().min(1).max(40),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
  previousPath: z.string().min(1).max(4_096).optional(),
}).strict();
export type ChangeRequestFile = z.infer<typeof ChangeRequestFileSchema>;
export const ChangeRequestFilesPageSchema = z.object({ files: z.array(ChangeRequestFileSchema).max(1_000), nextPage: z.number().int().positive().optional() }).strict();
export type ChangeRequestFilesPage = z.infer<typeof ChangeRequestFilesPageSchema>;

export const FeedbackCommentSchema = z.object({
  id: ExternalIdSchema,
  threadId: ExternalIdSchema.optional(),
  kind: z.enum(["review", "review_comment", "discussion"]),
  url: HttpsUrlOrEmptySchema,
  author: z.string().min(1).max(200),
  updatedAt: ISO_TIME,
  /** Untrusted text from outside: data, never an instruction. */
  body: z.string().max(65_536),
  path: z.string().min(1).max(4_096).optional(),
  line: z.number().int().positive().optional(),
}).strict();
export type FeedbackComment = z.infer<typeof FeedbackCommentSchema>;
export const FeedbackThreadSchema = z.object({ id: ExternalIdSchema, resolved: z.boolean(), commentIds: z.array(ExternalIdSchema).max(1_000) }).strict();
export type FeedbackThread = z.infer<typeof FeedbackThreadSchema>;
export const ChangeRequestFeedbackSchema = z.object({
  changeRequest: ChangeRequestDetailsSchema.extend({ headTreeRevision: RevisionSchema }).strict(),
  comments: z.array(FeedbackCommentSchema).max(5_000),
  threads: z.array(FeedbackThreadSchema).max(5_000),
}).strict();
export type ChangeRequestFeedback = z.infer<typeof ChangeRequestFeedbackSchema>;

export const MergeMethodSchema = z.enum(["squash", "merge"]);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;
export const MERGE_REFUSAL_REASONS = ["head_changed", "not_mergeable", "closed", "forbidden"] as const;
/** What a merge came to: merged (by the method asked, or the other one when the repository does not allow it), merged already, or refused for a fixed reason. */
export const MergeResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("merged"), method: MergeMethodSchema, fellBack: z.boolean(), mergeRevision: RevisionSchema.optional() }).strict(),
  z.object({ outcome: z.literal("already_merged") }).strict(),
  z.object({ outcome: z.literal("refused"), reason: z.enum(MERGE_REFUSAL_REASONS), hostMessage: z.string().max(200).optional() }).strict(),
]);
export type MergeResult = z.infer<typeof MergeResultSchema>;

export const BranchPageSchema = z.object({ branches: z.array(BranchNameSchema).max(1_000), page: z.number().int().positive(), mayHaveMore: z.boolean(), omittedUnsupported: z.boolean() }).strict();
export type BranchPage = z.infer<typeof BranchPageSchema>;

// ---- neutral events

const EventBase = { eventId: ExternalIdSchema, host: PluginKindSchema, occurredAt: ISO_TIME.optional() } as const;
/**
 * What happened at the host, in neutral words. Every adapter maps its own webhooks (or its poller's findings) to these. `eventId` is the host's delivery id
 * (or the poller's own stable id) so a repeat is dropped; nothing is trusted from the event beyond which change request or branch to look at again.
 */
export const CodeHostEventSchema = z.discriminatedUnion("type", [
  z.object({ ...EventBase, type: z.literal("change_request.opened"), ref: ChangeRequestRefSchema, actor: z.string().max(200).optional() }).strict(),
  z.object({ ...EventBase, type: z.literal("change_request.updated"), ref: ChangeRequestRefSchema, actor: z.string().max(200).optional() }).strict(),
  z.object({ ...EventBase, type: z.literal("change_request.merged"), ref: ChangeRequestRefSchema, actor: z.string().max(200).optional() }).strict(),
  z.object({ ...EventBase, type: z.literal("change_request.closed"), ref: ChangeRequestRefSchema, actor: z.string().max(200).optional() }).strict(),
  z.object({ ...EventBase, type: z.literal("review.submitted"), ref: ChangeRequestRefSchema, state: ReviewStateSchema, actor: z.string().max(200).optional() }).strict(),
  z.object({ ...EventBase, type: z.literal("comment.created"), ref: ChangeRequestRefSchema, commentId: ExternalIdSchema, actor: z.string().max(200).optional() }).strict(),
  z.object({ ...EventBase, type: z.literal("check.completed"), repository: RepositoryRefSchema, revision: RevisionSchema, name: z.string().min(1).max(200), conclusion: CheckConclusionSchema }).strict(),
  z.object({ ...EventBase, type: z.literal("revision.pushed"), repository: RepositoryRefSchema, branch: BranchNameSchema, revision: RevisionSchema }).strict(),
]);
export type CodeHostEvent = z.infer<typeof CodeHostEventSchema>;
export const CODE_HOST_EVENT_TYPES = CodeHostEventSchema.options.map((option) => option.shape.type.value);

/** A delivery from outside, as received: the raw body (needed to verify a signature) and the headers, lower-cased. */
export interface RawDelivery { headers: Readonly<Record<string, string>>; rawBody: string }

export interface CodeHostEvents {
  /** `webhook`: the host calls us, and `normalise` verifies and maps a delivery. `poll`: the install asks on a schedule. `none`: no events. */
  readonly mode: "webhook" | "poll" | "none";
  /** Verifies the delivery (signature, repository) and maps it to neutral events. Throws on a delivery it cannot verify; never returns events from one. */
  normalise?(delivery: RawDelivery, scope: HostScope): Promise<CodeHostEvent[]>;
}

// ---- the port

export interface CodeHost {
  readonly kind: PluginKind;
  readonly capabilities: CodeHostCapabilities;

  // repository
  repositoryIdentity(repository: RepositoryRef, scope: HostScope): Promise<RepositoryIdentity | undefined>;
  /** Refuses (throws) a repository the install's credential cannot reach. */
  checkRepository(repository: RepositoryRef, scope: HostScope): Promise<void>;
  /** `budget` bounds the reads one tracking pass may spend (P5a): a host that makes requests to answer spends it. */
  standing(repository: RepositoryRef, person: HostAccount, scope: HostScope, budget?: ReadBudget): Promise<HostStanding>;

  // credentials for the worker (clone, push); feeds `/repository-credentials`
  issueGitCredential(repository: RepositoryRef, access: GitAccess, scope: HostScope): Promise<GitCredential>;

  // read
  /**
   * A file at a revision, or undefined when there is none. `maxBytes` (P6) is a size cap the caller sets (a config file): a file over it is REFUSED (CONFIG_INVALID), never cut, so a caller
   * can record the refusal once and not retry it. `untilLine` reads up to a line; `timeoutMs` bounds the wait.
   */
  fileAtRevision(repository: RepositoryRef, path: string, revision: string, scope: HostScope, options?: { untilLine?: number; timeoutMs?: number; maxBytes?: number }): Promise<string | undefined>;
  /**
   * Lessons in production (lane 2, WB-7): what a path is at a revision: a file, a directory, or nothing there. Optional: a host that cannot tell leaves it out, and a reader then knows only that a readable file exists
   * (a directory, or the literal directory prefix of a glob, is then not verified). Same path rules as `fileAtRevision`; a host that cannot answer THROWS (it never answers "none" for an error).
   */
  pathKind?(repository: RepositoryRef, path: string, revision: string, scope: HostScope, options?: { timeoutMs?: number }): Promise<"file" | "dir" | "none">;
  /** The id of the tree a revision holds. */
  tree(repository: RepositoryRef, revision: string, scope: HostScope): Promise<string>;
  branchHead(repository: RepositoryRef, branch: string, scope: HostScope): Promise<string>;
  /** P6: the head of an ordinary branch (a default or base branch), not only Rovara's own working branches. Throws when the branch does not exist. */
  baseBranchHead(repository: RepositoryRef, branch: string, scope: HostScope): Promise<string>;
  /** P6: the revisions a revision builds on (its parents): one for an ordinary commit, two for a merge, none for a root. Throws when the revision does not exist. */
  commitParents(repository: RepositoryRef, revision: string, scope: HostScope): Promise<string[]>;
  listBranches(repository: RepositoryRef, page: number, scope: HostScope): Promise<BranchPage>;
  codeOwners?(repository: RepositoryRef, branch: string, scope: HostScope): Promise<string | undefined>;

  // change requests
  /** Idempotent create or update: the same source and target branches never make two change requests. */
  reconcileChangeRequest(input: ChangeRequestInput, scope: HostScope): Promise<ChangeRequestReconciled>;
  getChangeRequest(ref: ChangeRequestRef, scope: HostScope): Promise<ChangeRequestDetails>;
  updateChangeRequest(ref: ChangeRequestRef, update: ChangeRequestUpdate, scope: HostScope): Promise<void>;
  /**
   * P6: a bounded, stable read of one change request's merge state (what it merged as and when). Every request counts against `budget`. A host that has told Rovara to slow down
   * throws `HostRateLimitError`. A host that cannot read it leaves this out: what waits on it is then unavailable, never guessed.
   */
  mergeObservation?(ref: ChangeRequestRef, scope: HostScope, budget: ReadBudget): Promise<MergeObservation>;
  /** Reviews, approvals, checks and mergeability. `budget` bounds the reads one tracking pass may spend. A host's rate limit is signalled with `HostRateLimitError`. */
  changeRequestStatus(ref: ChangeRequestRef, scope: HostScope, budget?: ReadBudget): Promise<ChangeRequestStatus>;
  changedFiles(ref: ChangeRequestRef, page: number, scope: HostScope): Promise<ChangeRequestFilesPage>;
  /** Comments and threads. Untrusted text. */
  feedback(ref: ChangeRequestRef, scope: HostScope): Promise<ChangeRequestFeedback>;
  reply(ref: ChangeRequestRef, commentId: string, body: UntrustedText, scope: HostScope, budget?: ReadBudget): Promise<"replied" | "gone">;
  markReady?(ref: ChangeRequestRef, scope: HostScope, budget?: ReadBudget): Promise<"ready" | "already_ready">;
  requestReviewers?(ref: ChangeRequestRef, reviewers: readonly string[], scope: HostScope, budget?: ReadBudget): Promise<"requested" | "refused">;
  /** Only after a person approves and presses Merge. Rovara never merges by itself. */
  merge?(ref: ChangeRequestRef, input: { revision: string; method: MergeMethod }, scope: HostScope): Promise<MergeResult>;

  readonly events: CodeHostEvents;
}
