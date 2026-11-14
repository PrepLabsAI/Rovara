// Enterprise foundations, task P2: the in-memory host the fakes (and the GitHub fixture server in the tests) stand on. One model holds one repository: its
// revisions and branches, change requests with their reviews, comments and threads, the checks that reported on each revision, and the accounts that may
// act. It is deterministic (no clock, no randomness unless given) so a test and a fixture agree on every id.
//
// A bare git repository on disk is not modelled here: the worker-side fake git server belongs to P10 (the end-to-end task), which needs a real clone.
import { createHash } from "node:crypto";
import {
  agentXError, type ChangeRequestFile, type Check, type HostPermission, type MergeMethod, type MergeResult, type ReviewState, type Review,
} from "@agentx/contracts";

export interface FakeAccount { login: string; permission: HostPermission; accountType: string; hostUserId: string }
export interface FakeComment {
  id: string; kind: "review" | "review_comment" | "discussion"; author: string; body: string; updatedAt: string;
  path?: string; line?: number; threadId?: string; reviewState?: ReviewState;
}
export interface FakeThread { id: string; resolved: boolean; commentIds: string[] }
export interface FakeRevision { sha: string; tree: string; parents: string[]; files: ReadonlyMap<string, string> }
export interface FakeChangeRequest {
  id: string; sourceBranch: string; targetBranch: string; title: string; body: string; draft: boolean; draftRefused: boolean;
  state: "open" | "closed" | "merged"; author: string; frozenHead?: string; mergeRevision?: string; mergedAt?: string; mergedBy?: string;
  reviews: Review[];
  /** What each review also holds (parallel to `reviews`): the host's id for it and its summary text. */
  reviewMeta: Array<{ id: string; body: string }>;
  comments: FakeComment[]; threads: FakeThread[]; requestedReviewers: string[]; conflicts: boolean;
}
export interface FakeModelOptions {
  url: string; id: string; fullName: string; defaultBranch?: string; initialFiles?: Record<string, string>;
  /** Whether the host can open drafts. Default true. */
  drafts?: boolean;
  /** The host's web address, for the links it gives. Default `https://host.example.test`. */
  webBase?: string;
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const lines = (text: string) => (text === "" ? 0 : text.split("\n").length);
/** Rovara's replies in a thread are its own fixed text: short, one line, no mentions. */
export const REPLY_MAX_CHARS = 200;
export const REPLY_REFUSED_MESSAGE = "the reply is not Rovara's fixed text";

export class FakeHostModel {
  readonly url: string;
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly drafts: boolean;
  readonly webBase: string;
  readonly revisions = new Map<string, FakeRevision>();
  readonly branches = new Map<string, string>();
  readonly accounts = new Map<string, FakeAccount>();
  readonly changeRequests: FakeChangeRequest[] = [];
  /** Names the target branch requires before a merge. */
  requiredChecks: string[] = [];
  /** P6: when set, the host answers every budgeted read as rate limited until this time (milliseconds). A test sets it; nothing in the model reads the real clock. */
  rateLimitedUntil: number | undefined;
  private readonly checksByRevision = new Map<string, Check[]>();
  private readonly logs = new Map<string, string>();
  private serial = 0;
  private clock = Date.parse("2026-10-30T09:00:00.000Z");

  constructor(options: FakeModelOptions) {
    this.url = options.url;
    this.id = options.id;
    this.fullName = options.fullName;
    this.defaultBranch = options.defaultBranch ?? "main";
    this.drafts = options.drafts ?? true;
    this.webBase = options.webBase ?? "https://host.example.test";
    const root = this.addRevision([], new Map(Object.entries(options.initialFiles ?? { "README.md": "# demo\n" })));
    this.branches.set(this.defaultBranch, root.sha);
  }

  /** An ISO time that moves forward by one second each call, so ordering is visible and nothing reads the real clock. */
  now(): string {
    this.clock += 1_000;
    return new Date(this.clock).toISOString();
  }

  private addRevision(parents: string[], files: Map<string, string>): FakeRevision {
    const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const tree = sha1(`tree\n${JSON.stringify(sorted)}`);
    this.serial += 1;
    const sha = sha1(`commit\n${parents.join(",")}\n${tree}\n${this.serial}`);
    const revision: FakeRevision = { sha, tree, parents, files };
    this.revisions.set(sha, revision);
    return revision;
  }

  headOf(branch: string): string {
    const head = this.branches.get(branch);
    if (head === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `the host has no branch ${branch}`);
    return head;
  }

  revision(sha: string): FakeRevision {
    const found = this.revisions.get(sha);
    if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the host has no such revision");
    return found;
  }

  /** A new revision on `branch` (made from the default branch's head when the branch is new). A `null` value deletes a path. */
  commit(branch: string, changes: Record<string, string | null>): string {
    const parentSha = this.branches.get(branch) ?? this.headOf(this.defaultBranch);
    const files = new Map(this.revision(parentSha).files);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    const made = this.addRevision([parentSha], files);
    this.branches.set(branch, made.sha);
    return made.sha;
  }

  setAccount(login: string, permission: HostPermission, accountType = "User"): FakeAccount {
    const account: FakeAccount = { login, permission, accountType, hostUserId: String(1_000 + this.accounts.size + 1) };
    this.accounts.set(login, account);
    return account;
  }

  // ---- change requests

  private cr(id: string): FakeChangeRequest {
    const found = this.changeRequests.find((entry) => entry.id === id);
    if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the host has no such change request");
    return found;
  }

  getChangeRequest(id: string): FakeChangeRequest {
    return this.cr(id);
  }

  crUrl(id: string): string {
    return `${this.webBase}/${this.fullName}/pull/${id}`;
  }

  headRevisionOf(cr: FakeChangeRequest): string {
    return cr.frozenHead ?? this.headOf(cr.sourceBranch);
  }

  /** The one open change request of a source and target branch, if any. */
  findOpen(sourceBranch: string, targetBranch: string): FakeChangeRequest | undefined {
    return this.changeRequests.find((entry) => entry.state === "open" && entry.sourceBranch === sourceBranch && entry.targetBranch === targetBranch);
  }

  /** Idempotent: the same open source and target make no second change request. A draft is refused (once) by a host that has none. */
  reconcile(input: { sourceBranch: string; targetBranch: string; title: string; body?: string; draft?: boolean }, author = "rovara-app[bot]"): { cr: FakeChangeRequest; reconciled: boolean } {
    const existing = this.findOpen(input.sourceBranch, input.targetBranch);
    if (existing !== undefined) return { cr: existing, reconciled: true };
    this.headOf(input.sourceBranch);
    this.headOf(input.targetBranch);
    const draftRefused = input.draft === true && !this.drafts;
    const cr: FakeChangeRequest = {
      id: String(this.changeRequests.length + 1), sourceBranch: input.sourceBranch, targetBranch: input.targetBranch, title: input.title,
      body: draftRefused ? `Draft change requests are not available here, so this one is open for review. Do not merge it until it has been reviewed.\n\n${input.body ?? ""}`.trimEnd() : input.body ?? "",
      draft: input.draft === true && this.drafts, draftRefused, state: "open", author, reviews: [], reviewMeta: [], comments: [], threads: [], requestedReviewers: [], conflicts: false,
    };
    this.changeRequests.push(cr);
    return { cr, reconciled: false };
  }

  update(id: string, update: { title?: string; body?: string; state?: "open" | "closed" }): FakeChangeRequest {
    const cr = this.cr(id);
    if (cr.state === "merged") throw agentXError("RUNTIME_UNAVAILABLE", "a merged change request cannot be updated");
    if (update.title !== undefined) cr.title = update.title;
    if (update.body !== undefined) cr.body = update.body;
    if (update.state !== undefined) {
      if (update.state === "closed" && cr.state === "open") cr.frozenHead = this.headOf(cr.sourceBranch);
      if (update.state === "open") delete cr.frozenHead;
      cr.state = update.state;
    }
    return cr;
  }

  markReady(id: string): "ready" | "already_ready" {
    const cr = this.cr(id);
    if (!cr.draft) return "already_ready";
    cr.draft = false;
    return "ready";
  }

  requestReviewers(id: string, reviewers: readonly string[]): "requested" | "refused" {
    const cr = this.cr(id);
    // A host refuses to ask the author, an unknown account, or a closed change request.
    if (cr.state !== "open" || reviewers.some((name) => name === cr.author || (!name.includes("/") && !this.accounts.has(name)))) return "refused";
    for (const name of reviewers) if (!cr.requestedReviewers.includes(name)) cr.requestedReviewers.push(name);
    return "requested";
  }

  // ---- reviews and comments

  addReview(id: string, input: { login: string; state: ReviewState; body?: string; revision?: string }): Review {
    const cr = this.cr(id);
    const account = this.accounts.get(input.login) ?? this.setAccount(input.login, "write");
    const review: Review = { reviewer: { login: account.login, hostUserId: account.hostUserId }, accountType: account.accountType, state: input.state, revision: input.revision ?? this.headRevisionOf(cr), submittedAt: this.now() };
    const reviewId = this.nextCommentId();
    cr.reviews.push(review);
    cr.reviewMeta.push({ id: reviewId, body: input.body ?? "" });
    cr.requestedReviewers = cr.requestedReviewers.filter((name) => name !== input.login);
    // A review with a summary is feedback; one with none, or one still pending, is not.
    if (input.body !== undefined && input.body.trim() !== "" && input.state !== "PENDING") {
      cr.comments.push({ id: reviewId, kind: "review", author: input.login, body: input.body, updatedAt: review.submittedAt, reviewState: input.state });
    }
    return review;
  }

  private nextCommentId(): string {
    this.serial += 1;
    return String(9_000_000 + this.serial);
  }

  addDiscussionComment(id: string, author: string, body: string): FakeComment {
    const cr = this.cr(id);
    const comment: FakeComment = { id: this.nextCommentId(), kind: "discussion", author, body, updatedAt: this.now() };
    cr.comments.push(comment);
    return comment;
  }

  /** A comment on a line of the diff, which opens a thread. */
  addReviewComment(id: string, author: string, body: string, path: string, line: number): FakeComment {
    const cr = this.cr(id);
    const comment: FakeComment = { id: this.nextCommentId(), kind: "review_comment", author, body, updatedAt: this.now(), path, line };
    comment.threadId = `thread-${comment.id}`;
    cr.comments.push(comment);
    cr.threads.push({ id: comment.threadId, resolved: false, commentIds: [comment.id] });
    return comment;
  }

  resolveThread(id: string, threadId: string, resolved = true): void {
    const thread = this.cr(id).threads.find((entry) => entry.id === threadId);
    if (thread === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the host has no such thread");
    thread.resolved = resolved;
  }

  /** Rovara's reply in a thread: only fixed, short, one-line text with no mention goes out; a comment that is not in a thread (or is gone) is "gone". */
  reply(id: string, commentId: string, body: string, author = "rovara-app[bot]"): "replied" | "gone" {
    if (body.length === 0 || body.length > REPLY_MAX_CHARS || /[\p{Cc}@]/u.test(body)) throw agentXError("CONFIG_INVALID", REPLY_REFUSED_MESSAGE);
    const cr = this.cr(id);
    const target = cr.comments.find((entry) => entry.id === commentId && entry.kind === "review_comment");
    if (target?.threadId === undefined) return "gone";
    const reply: FakeComment = { id: this.nextCommentId(), kind: "review_comment", author, body, updatedAt: this.now(), threadId: target.threadId, ...(target.path === undefined ? {} : { path: target.path }), ...(target.line === undefined ? {} : { line: target.line }) };
    cr.comments.push(reply);
    cr.threads.find((entry) => entry.id === target.threadId)!.commentIds.push(reply.id);
    return "replied";
  }

  // ---- checks

  setChecks(revision: string, checks: Check[]): void {
    this.revision(revision);
    this.checksByRevision.set(revision, checks.map((check) => ({ ...check })));
  }

  checksOf(revision: string): Check[] {
    return (this.checksByRevision.get(revision) ?? []).map((check) => ({ ...check }));
  }

  /** A run (a build, a job) by its id, wherever it reported. */
  findRun(runId: string): { revision: string; check: Check } | undefined {
    for (const [revision, checks] of this.checksByRevision) {
      const check = checks.find((entry) => entry.runId === runId);
      if (check !== undefined) return { revision, check: { ...check } };
    }
    return undefined;
  }

  /** Adds a check to a revision, or replaces the one with the same run id. */
  upsertCheck(revision: string, check: Check): void {
    this.revision(revision);
    const list = this.checksByRevision.get(revision) ?? [];
    const index = check.runId === undefined ? -1 : list.findIndex((entry) => entry.runId === check.runId);
    if (index >= 0) list[index] = { ...check };
    else list.push({ ...check });
    this.checksByRevision.set(revision, list);
  }

  setLog(runId: string, text: string): void {
    this.logs.set(runId, text);
  }

  logOf(runId: string): string | undefined {
    return this.logs.get(runId);
  }

  // ---- reads

  changedFiles(id: string): ChangeRequestFile[] {
    const cr = this.cr(id);
    const source = this.revision(this.headRevisionOf(cr)).files;
    const target = this.revision(cr.state === "merged" && cr.mergeRevision !== undefined ? this.revision(cr.mergeRevision).parents[0]! : this.headOf(cr.targetBranch)).files;
    const out: ChangeRequestFile[] = [];
    for (const [path, content] of [...source.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const before = target.get(path);
      if (before === content) continue;
      out.push({ path, status: before === undefined ? "added" : "modified", additions: lines(content), deletions: before === undefined ? 0 : lines(before) });
    }
    for (const [path, content] of [...target.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!source.has(path)) out.push({ path, status: "removed", additions: 0, deletions: lines(content) });
    }
    return out;
  }

  /** The host's word on whether the change request can merge: draft, conflicts, a required check failing or pending, else clean. */
  mergeableState(cr: FakeChangeRequest): "clean" | "dirty" | "blocked" | "draft" {
    if (cr.draft) return "draft";
    if (cr.conflicts) return "dirty";
    const checks = this.checksOf(this.headRevisionOf(cr));
    for (const name of this.requiredChecks) {
      const found = checks.find((check) => check.name === name);
      if (found === undefined || found.state !== "completed" || found.conclusion !== "success") return "blocked";
    }
    return "clean";
  }

  // ---- merge

  merge(id: string, input: { revision: string; method: MergeMethod }, mergedBy = "rovara-user"): MergeResult {
    const cr = this.cr(id);
    if (cr.state === "merged") return { outcome: "already_merged" };
    if (cr.state === "closed") return { outcome: "refused", reason: "closed" };
    if (this.headRevisionOf(cr) !== input.revision) return { outcome: "refused", reason: "head_changed" };
    if (this.mergeableState(cr) !== "clean") return { outcome: "refused", reason: "not_mergeable", hostMessage: "Required checks have not passed." };
    const files = new Map(this.revision(input.revision).files);
    const merged = this.addRevision([this.headOf(cr.targetBranch)], files);
    this.branches.set(cr.targetBranch, merged.sha);
    cr.state = "merged";
    cr.frozenHead = input.revision;
    cr.mergeRevision = merged.sha;
    cr.mergedAt = this.now();
    cr.mergedBy = mergedBy;
    return { outcome: "merged", method: input.method, fellBack: false, mergeRevision: merged.sha };
  }
}
