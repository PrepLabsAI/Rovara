// A CodeHost over the in-memory model. It is a test double for everything that takes the port, and the reference the contract suite is written against:
// a real adapter must answer what this one answers for the same state.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isAiInstructionPath, type FileEntryType, agentXError, CodeHostEventSchema, ROVARA_REPLY_MARKER, CommitFilesInputSchema, HostRateLimitError, HostScopeSchema, ChangeRequestUpdateSchema, ChangeRequestInputSchema,
  type BranchPage, type ChangeRequestDetails, type ChangeRequestFeedback, type ChangeRequestFilesPage, type ChangeRequestInput, type ChangeRequestReconciled,
  type ChangeRequestRef, type CodeOwnersRead, type CommitFilesInput, type CommitFilesResult, type PathKind, type ChangeRequestStatus, type ChangeRequestUpdate, type CodeHost, type CodeHostCapabilities, type CodeHostEvent, type CodeHostEvents, type GitAccess,
  type GitCredential, type HostAccount, type HostCommentsPage, type HostScope, type HostStanding, type MergeMethod, type MergeObservation, type MergeResult, type RawDelivery, type ReadBudget, type RepositoryIdentity,
  type RepositoryRef,
} from "@agentx/contracts";
import { readCodeOwnersFile } from "../code-host/code-owners-file.js";
import type { FakeChangeRequest, FakeHostModel } from "./model.js";

export const FAKE_HOST_KIND = "fake";
export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret-not-a-real-secret";

export const FAKE_CODE_HOST_CAPABILITIES: CodeHostCapabilities = {
  drafts: true, threadedComments: true, requiredApprovals: true, codeOwners: true, webhooks: true, rerunChecks: true, perPersonCredentials: false,
  merge: true, markReady: true, requestReviewers: true, credentialKinds: ["token", "basic"],
};

/** What the fake's "webhook" carries: which change request or branch to look at again, and a stable delivery id. */
export type FakeRawEvent =
  | { delivery: string; event: "cr.opened" | "cr.updated" | "cr.merged" | "cr.closed"; cr: string; actor?: string }
  | { delivery: string; event: "review"; cr: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"; actor?: string }
  | { delivery: string; event: "comment"; cr: string; commentId: string }
  | { delivery: string; event: "check"; revision: string; name: string; conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "stale" | "startup_failure" | "error" }
  | { delivery: string; event: "push"; branch: string; revision: string };

/** A delivery the fake host accepts: the body, and its HMAC signature in the header the host would send. */
export function fakeSignedDelivery(event: FakeRawEvent, secret = FAKE_WEBHOOK_SECRET): RawDelivery {
  const rawBody = JSON.stringify(event);
  return { rawBody, headers: { "x-fake-signature": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`, "x-fake-delivery": event.delivery } };
}

export class FakeCodeHost implements CodeHost {
  readonly kind = FAKE_HOST_KIND;
  readonly capabilities: CodeHostCapabilities = FAKE_CODE_HOST_CAPABILITIES;
  readonly events: CodeHostEvents;

  constructor(readonly model: FakeHostModel, private readonly webhookSecret = FAKE_WEBHOOK_SECRET) {
    this.events = { mode: "webhook", normalise: (delivery, scope) => this.normalise(delivery, scope) };
  }

  protected checkScope(scope: HostScope): void {
    if (!HostScopeSchema.safeParse(scope).success) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
  }

  /** The model of a registered repository, or a refusal; a repository nobody registered is never read. */
  protected registered(repository: RepositoryRef): FakeHostModel {
    if (repository.url !== this.model.url) throw agentXError("CONFIG_INVALID", "the repository is not registered with this host");
    return this.model;
  }

  protected ref(id: string): ChangeRequestRef {
    return { repository: { url: this.model.url }, id, url: this.model.crUrl(id) };
  }

  protected cr(ref: ChangeRequestRef): FakeChangeRequest {
    this.registered(ref.repository);
    const found = this.model.changeRequests.find((entry) => entry.id === ref.id);
    if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the host has no such change request");
    return found;
  }

  async repositoryIdentity(repository: RepositoryRef, scope: HostScope): Promise<RepositoryIdentity | undefined> {
    this.checkScope(scope);
    if (repository.url !== this.model.url) return (undefined);
    return ({ id: this.model.id, fullName: this.model.fullName, defaultBranch: this.model.defaultBranch });
  }

  async checkRepository(repository: RepositoryRef, scope: HostScope): Promise<void> {
    this.checkScope(scope);
    this.registered(repository);
    return;
  }

  async standing(repository: RepositoryRef, person: HostAccount, scope: HostScope, budget?: ReadBudget): Promise<HostStanding> {
    this.checkScope(scope);
    this.spend(budget);
    const model = this.registered(repository);
    const account = model.accounts.get(person.login);
    return (account === undefined ? { permission: "none" } : { permission: account.permission, accountType: account.accountType });
  }

  async issueGitCredential(repository: RepositoryRef, access: GitAccess, scope: HostScope): Promise<GitCredential> {
    this.checkScope(scope);
    this.registered(repository);
    // Fixed, obviously fake, and different for the two kinds of access so a test can tell them apart.
    return ({ kind: "token", username: "x-access-token", token: `fake-${access}-token-not-a-real-secret`, expiresAt: new Date(Date.parse(this.model.now()) + 50 * 60_000).toISOString() });
  }

  async fileAtRevision(repository: RepositoryRef, path: string, revision: string, scope: HostScope, options?: { untilLine?: number; maxBytes?: number }): Promise<string | undefined> {
    this.checkScope(scope);
    const model = this.registered(repository);
    const content = model.revision(revision).files.get(path);
    if (content === undefined) return (undefined);
    if (options?.maxBytes !== undefined && Buffer.byteLength(content, "utf8") > options.maxBytes) throw agentXError("CONFIG_INVALID", "file too large");
    return (options?.untilLine === undefined ? content : content.split("\n").slice(0, options.untilLine).join("\n"));
  }

  async pathKind(repository: RepositoryRef, path: string, revision: string, scope: HostScope): Promise<PathKind> {
    this.checkScope(scope);
    const found = this.registered(repository).revision(revision);
    const files = found.files;
    if (found.symlinks.has(path)) return "symlink";
    // Like a real host: a path below a symbolic link cannot be told (what the link points at is not known), so it is an error, never "none".
    for (const link of found.symlinks) if (path.startsWith(`${link}/`)) throw agentXError("RUNTIME_UNAVAILABLE", "a symbolic link is the parent of this path");
    for (const [name, type] of found.entries) {
      if (type !== "submodule") continue;
      if (name === path) return "dir";
      if (path.startsWith(`${name}/`)) throw agentXError("RUNTIME_UNAVAILABLE", "a submodule is the parent of this path");
    }
    if (files.has(path)) return "file";
    // A directory is a path some file lives under.
    for (const name of found.entries.keys()) if (name.startsWith(`${path}/`)) return "dir";
    return "none";
  }

  async instructionFiles(repository: RepositoryRef, revision: string, scope: HostScope, options?: { max?: number; timeoutMs?: number }): Promise<{ files: Array<{ path: string; type: FileEntryType }>; complete: boolean }> {
    this.checkScope(scope);
    const model = this.registered(repository);
    this.spend(undefined);
    const max = options?.max ?? 500;
    if (!Number.isSafeInteger(max) || max < 0) throw agentXError("CONFIG_INVALID", "instruction file limit is invalid");
    const at = model.revision(revision);
    const matches = [...at.entries].filter(([path]) => isAiInstructionPath(path)).sort(([a], [b]) => a.localeCompare(b));
    return { files: matches.slice(0, max).map(([path, type]) => ({ path, type })), complete: !model.incompleteTrees.has(revision) && matches.length <= max };
  }

  async tree(repository: RepositoryRef, revision: string, scope: HostScope): Promise<string> {
    this.checkScope(scope);
    return (this.registered(repository).revision(revision).tree);
  }

  async branchHead(repository: RepositoryRef, branch: string, scope: HostScope): Promise<string> {
    this.checkScope(scope);
    return (this.registered(repository).headOf(branch));
  }

  async baseBranchHead(repository: RepositoryRef, branch: string, scope: HostScope): Promise<string> {
    this.checkScope(scope);
    return (this.registered(repository).headOf(branch));
  }

  async commitParents(repository: RepositoryRef, revision: string, scope: HostScope): Promise<string[]> {
    this.checkScope(scope);
    return ([...this.registered(repository).revision(revision).parents]);
  }

  /** A budgeted read: it counts against the pass's allowance, and a host that has told Rovara to slow down says so with the neutral signal. */
  protected spend(budget: ReadBudget | undefined): void {
    budget?.beforeRequest();
    const until = this.model.rateLimitedUntil;
    if (until !== undefined) throw new HostRateLimitError(until);
  }

  async listBranches(repository: RepositoryRef, page: number, scope: HostScope): Promise<BranchPage> {
    this.checkScope(scope);
    const model = this.registered(repository);
    if (!Number.isSafeInteger(page) || page < 1) throw agentXError("CONFIG_INVALID", "the page is invalid");
    const all = [...model.branches.keys()].sort();
    const size = 100;
    return ({ branches: all.slice((page - 1) * size, page * size), page, mayHaveMore: all.length > page * size, omittedUnsupported: false });
  }

  async codeOwners(repository: RepositoryRef, branch: string, scope: HostScope): Promise<CodeOwnersRead | undefined> {
    this.checkScope(scope);
    const model = this.registered(repository);
    const files = model.revision(model.headOf(branch)).files;
    const text = files.get(".github/CODEOWNERS") ?? files.get("CODEOWNERS") ?? files.get("docs/CODEOWNERS");
    return text === undefined ? undefined : readCodeOwnersFile(text);
  }

  /** Item C1: the same rules a real host's adapter holds (see `FakeHostModel.commitLessonFiles`). */
  async commitFiles(input: CommitFilesInput, scope: HostScope): Promise<CommitFilesResult> {
    this.checkScope(scope);
    const parsed = CommitFilesInputSchema.parse(input);
    return this.registered(parsed.repository).commitLessonFiles(parsed);
  }

  async changeRequestForBranch(repository: RepositoryRef, branch: string, scope: HostScope): Promise<ChangeRequestRef | undefined> {
    this.checkScope(scope);
    const found = this.registered(repository).changeRequestForLessonBranch(branch);
    return found === undefined ? undefined : this.ref(found.id);
  }

  /** Deleting the source branch of an open change request closes it, as a real host does. */
  async deleteBranch(repository: RepositoryRef, branch: string, scope: HostScope): Promise<"deleted" | "gone"> {
    this.checkScope(scope);
    return this.registered(repository).deleteLessonBranch(branch);
  }

  async reconcileChangeRequest(input: ChangeRequestInput, scope: HostScope): Promise<ChangeRequestReconciled> {
    this.checkScope(scope);
    const parsed = ChangeRequestInputSchema.parse(input);
    const model = this.registered(parsed.repository);
    const { cr, reconciled } = model.reconcile({
      sourceBranch: parsed.sourceBranch, targetBranch: parsed.targetBranch, title: parsed.title, ...(parsed.body === undefined ? {} : { body: parsed.body }), ...(parsed.draft === undefined ? {} : { draft: parsed.draft }),
    });
    return ({ ref: this.ref(cr.id), reconciled, ...(cr.draftRefused && !reconciled ? { draftRefused: true as const } : {}) });
  }

  async getChangeRequest(ref: ChangeRequestRef, scope: HostScope): Promise<ChangeRequestDetails> {
    this.checkScope(scope);
    return (this.details(this.cr(ref)));
  }

  protected details(cr: FakeChangeRequest): ChangeRequestDetails {
    return {
      ref: this.ref(cr.id), state: cr.state, sourceBranch: cr.sourceBranch, targetBranch: cr.targetBranch, headRevision: this.model.headRevisionOf(cr),
      ...(cr.mergeRevision === undefined ? {} : { mergeRevision: cr.mergeRevision }), ...(cr.mergedAt === undefined ? {} : { mergedAt: cr.mergedAt }), ...(cr.mergedBy === undefined ? {} : { mergedBy: cr.mergedBy }), title: cr.title, body: cr.body,
      authoredByRovara: cr.author === "rovara-app[bot]", baseRepositoryId: this.model.id,
    };
  }

  async updateChangeRequest(ref: ChangeRequestRef, update: ChangeRequestUpdate, scope: HostScope): Promise<void> {
    this.checkScope(scope);
    const cr = this.cr(ref);
    const parsed = ChangeRequestUpdateSchema.parse(update);
    this.model.update(cr.id, { ...(parsed.title === undefined ? {} : { title: parsed.title }), ...(parsed.body === undefined ? {} : { body: parsed.body }), ...(parsed.state === undefined ? {} : { state: parsed.state }) });
    return;
  }

  async mergeObservation(ref: ChangeRequestRef, scope: HostScope, budget: ReadBudget): Promise<MergeObservation> {
    this.checkScope(scope);
    this.spend(budget);
    const cr = this.cr(ref);
    // One read for the change request, one for its head's tree (the host's real reads are three; the count is the adapter's business, the budget is spent per request).
    this.spend(budget);
    return ({ ...this.details(cr), headTreeRevision: this.model.revision(this.model.headRevisionOf(cr)).tree });
  }

  async changeRequestStatus(ref: ChangeRequestRef, scope: HostScope, budget?: ReadBudget): Promise<ChangeRequestStatus> {
    this.checkScope(scope);
    this.spend(budget);
    const cr = this.cr(ref);
    const head = this.model.headRevisionOf(cr);
    return ({
      id: cr.id, state: cr.state, draft: cr.draft, headRevision: head, targetBranch: cr.targetBranch, mergeableState: this.model.mergeableState(cr),
      mergeable: !cr.conflicts, checks: this.model.checksOf(head), requiredChecks: this.model.requiredChecks.map((name) => ({ name })),
      targetHasRequiredChecks: this.model.requiredChecks.length > 0, headDefinesChecks: this.model.revision(head).files.has(".ci/checks.yml"),
      requestedReviewers: cr.requestedReviewers.length, ...(cr.requestedReviewers.length === 0 ? {} : { requestedReviewerIds: [...cr.requestedReviewers] }),
      reviews: cr.reviews.map((review) => ({ ...review })),
    });
  }

  async changedFiles(ref: ChangeRequestRef, page: number, scope: HostScope, options?: { expectedHead?: string }): Promise<ChangeRequestFilesPage> {
    this.checkScope(scope);
    if (!Number.isSafeInteger(page) || page < 1) throw agentXError("CONFIG_INVALID", "the page is invalid");
    const cr = this.cr(ref);
    const all = this.model.changedFiles(cr.id);
    const size = 100;
    const files = all.slice((page - 1) * size, page * size);
    if (options?.expectedHead !== undefined && options.expectedHead !== this.model.headRevisionOf(cr)) for (const file of files) delete file.entry;
    return ({ files, ...(all.length > page * size ? { nextPage: page + 1 } : {}) });
  }

  async feedback(ref: ChangeRequestRef, scope: HostScope): Promise<ChangeRequestFeedback> {
    this.checkScope(scope);
    const cr = this.cr(ref);
    const head = this.model.headRevisionOf(cr);
    // Rovara's own comments are not feedback; a review with no text, or one still pending, is not either.
    const own = new Set(cr.comments.filter((comment) => comment.author === "rovara-app[bot]").map((comment) => comment.id));
    const comments = cr.comments.filter((comment) => !own.has(comment.id)).map((comment) => ({
      id: comment.id, ...(comment.threadId === undefined ? {} : { threadId: comment.threadId }), kind: comment.kind,
      url: `${this.model.crUrl(cr.id)}#c${comment.id}`, author: comment.author, updatedAt: comment.updatedAt, body: comment.body,
      ...(comment.path === undefined ? {} : { path: comment.path }), ...(comment.line === undefined ? {} : { line: comment.line }),
    }));
    return ({
      changeRequest: { ...this.details(cr), headTreeRevision: this.model.revision(head).tree }, comments,
      threads: cr.threads.map((thread) => ({ id: thread.id, resolved: thread.resolved, commentIds: thread.commentIds.filter((id) => !own.has(id)) })),
    });
  }

  async comments(ref: ChangeRequestRef, options: { since?: string; page?: number }, scope: HostScope, budget?: ReadBudget): Promise<HostCommentsPage> {
    this.checkScope(scope);
    this.spend(budget);
    const cr = this.cr(ref);
    const since = options.since === undefined ? undefined : Date.parse(options.since);
    const page = options.page ?? 1;
    const all = cr.comments.filter((comment) => comment.kind === "discussion" && (since === undefined || Date.parse(comment.updatedAt) >= since));
    const listed = all.slice((page - 1) * 100, page * 100).map((comment) => ({
      id: comment.id, ref: this.ref(cr.id), author: { login: comment.author, ...(this.model.accounts.get(comment.author) === undefined ? {} : { hostUserId: this.model.accounts.get(comment.author)!.hostUserId }), isBot: (this.model.accounts.get(comment.author)?.accountType ?? "person") === "bot" || comment.author.endsWith("[bot]") },
      body: comment.body, createdAt: comment.createdAt ?? comment.updatedAt, updatedAt: comment.updatedAt,
    }));
    return { comments: listed, ...(all.length > page * 100 ? { nextPage: page + 1 } : {}) };
  }

  /** Rovara's own comment: a person's account (the owner's token), so the text carries the marker the core reads it by. */
  async postComment(ref: ChangeRequestRef, text: string, scope: HostScope, budget?: ReadBudget): Promise<"posted" | "gone"> {
    this.checkScope(scope);
    this.spend(budget);
    if (text.length === 0 || text.length > 200 || /[\p{Cc}@]/u.test(text)) throw agentXError("CONFIG_INVALID", "the comment is not Rovara's fixed text");
    const found = this.model.changeRequests.find((entry) => entry.id === ref.id);
    if (found === undefined) return "gone";
    this.model.addDiscussionComment(found.id, "rovara-owner", `${text}\n\n${ROVARA_REPLY_MARKER}`);
    return "posted";
  }

  async reply(ref: ChangeRequestRef, commentId: string, body: string, scope: HostScope, budget?: ReadBudget): Promise<"replied" | "gone"> {
    this.checkScope(scope);
    this.spend(budget);
    return (this.model.reply(this.cr(ref).id, commentId, body));
  }

  async markReady(ref: ChangeRequestRef, scope: HostScope, budget?: ReadBudget): Promise<"ready" | "already_ready"> {
    this.checkScope(scope);
    this.spend(budget);
    return (this.model.markReady(this.cr(ref).id));
  }

  async requestReviewers(ref: ChangeRequestRef, reviewers: readonly string[], scope: HostScope, budget?: ReadBudget): Promise<"requested" | "refused"> {
    this.checkScope(scope);
    this.spend(budget);
    if (reviewers.length === 0 || reviewers.length > 10) throw agentXError("CONFIG_INVALID", "reviewers must be one to ten names");
    return (this.model.requestReviewers(this.cr(ref).id, reviewers));
  }

  async merge(ref: ChangeRequestRef, input: { revision: string; method: MergeMethod }, scope: HostScope): Promise<MergeResult> {
    this.checkScope(scope);
    return (this.model.merge(this.cr(ref).id, input));
  }

  // ---- events: verify the signature first, then map; nothing is returned from a delivery that does not verify.

  private async normalise(delivery: RawDelivery, scope: HostScope): Promise<CodeHostEvent[]> {
    this.checkScope(scope);
    const given = /^sha256=([0-9a-f]{64})$/.exec(delivery.headers["x-fake-signature"] ?? "")?.[1];
    const expected = createHmac("sha256", this.webhookSecret).update(delivery.rawBody).digest();
    if (given === undefined || !timingSafeEqual(Buffer.from(given, "hex"), expected)) throw agentXError("CALLBACK_FORBIDDEN", "the delivery's signature does not verify");
    let raw: FakeRawEvent;
    try {
      raw = JSON.parse(delivery.rawBody) as FakeRawEvent;
    } catch {
      throw agentXError("CONFIG_INVALID", "the delivery is not JSON");
    }
    const base = { eventId: raw.delivery, host: FAKE_HOST_KIND } as const;
    const parsed = (event: unknown) => [CodeHostEventSchema.parse(event)];
    switch (raw.event) {
      case "cr.opened": case "cr.updated": case "cr.merged": case "cr.closed":
        return (parsed({ ...base, type: `change_request.${raw.event.slice(3)}`, ref: this.ref(raw.cr), ...(raw.actor === undefined ? {} : { actor: raw.actor }) }));
      case "review": return (parsed({ ...base, type: "review.submitted", ref: this.ref(raw.cr), state: raw.state, ...(raw.actor === undefined ? {} : { actor: raw.actor }) }));
      case "comment": return (parsed({ ...base, type: "comment.created", ref: this.ref(raw.cr), commentId: raw.commentId }));
      case "check": return (parsed({ ...base, type: "check.completed", repository: { url: this.model.url }, revision: raw.revision, name: raw.name, conclusion: raw.conclusion }));
      case "push": return (parsed({ ...base, type: "revision.pushed", repository: { url: this.model.url }, branch: raw.branch, revision: raw.revision }));
      default: throw agentXError("CONFIG_INVALID", "the delivery names an event this host does not send");
    }
  }
}
