// The GitHub CodeHost adapter (Cloud's P3, ported in lane L2). It maps a GitHub client (`GitHubCodeHostProvider`, see `provider.ts`) one method to one method to the
// neutral port (`mapping.ts`). The conformance suite (tests/support/ports/code-host-conformance.ts) runs against it with GitHub-shaped fixtures.
//
// What GitHub restricts stays restricted, and is stated rather than hidden. The adapter holds these itself, whatever client sits under it:
//  - `branchHead` reads Rovara's own working branches only (`agentx/<uuid>`); the branch goes into an API address.
//  - `listBranches` is org-scoped (a system scope is refused) and takes pages 1 to 1000.
//  - `reply` posts Rovara's own fixed text only (200 characters, one line, no mention).
//  - `events.normalise` (`events.ts`) exists only when the adapter is given the install's webhook secret; without one it verifies nothing and offers no normaliser.
// The client holds the rest (see the rules on `GitHubCodeHostProvider`): tenant binding, least-privilege tokens, no redirects.
import {
  agentXError, hostRateLimitRetryAt, ChangeRequestInputSchema, ChangeRequestUpdateSchema, CommitFilesInputSchema, HostScopeSchema,
  type BranchPage, type CodeOwnersRead, type CommitFilesInput, type CommitFilesResult, type PathKind, type ChangeRequestDetails, type ChangeRequestFeedback, type ChangeRequestFilesPage, type ChangeRequestInput, type ChangeRequestReconciled, type ChangeRequestRef,
  type ChangeRequestStatus, type ChangeRequestUpdate, type CodeHost, type CodeHostCapabilities, type GitAccess, type GitCredential, type HostAccount, type HostScope,
  type HostCommentsPage, type HostStanding, type MergeMethod, type MergeObservation, type MergeResult, type ReadBudget, type RepositoryIdentity, type RepositoryRef,
} from "@agentx/contracts";
import { parseGitHubRepository } from "../../../github-app.js";
import { githubCodeHostEvents } from "./events.js";
import { readCodeOwnersFile } from "../code-owners-file.js";
import { accountKindOf, detailsOf, feedbackOf, fileOf, mergeResultOf, pullRequestNumber, refOf, replyTargetOf, statusOf } from "./mapping.js";
import { entryAt, fileTrees, instructionList } from "./file-details.js";
import { type GitHubCodeHostProvider } from "./provider.js";

export const GITHUB_HOST_KIND = "github";

/** Rovara's working branches: `agentx/<uuid>`. */
const WORKING_BRANCH = /^agentx\/[0-9a-f-]{36}$/iu;
const MAX_BRANCH_PAGE = 1_000;

export const GITHUB_CODE_HOST_CAPABILITIES: CodeHostCapabilities = {
  drafts: true, threadedComments: true, requiredApprovals: true, codeOwners: true, webhooks: true,
  // Re-running a GitHub check is not wired to the provider yet.
  rerunChecks: false,
  // GitHub user-to-server tokens exist, but nothing here asks a person for one.
  perPersonCredentials: false,
  merge: true, markReady: true, requestReviewers: true,
  // `resolve` hands back a username and an installation token, which is a basic credential.
  credentialKinds: ["basic"],
};

/** The GitHub client the adapter is built over (see `provider.ts`): a narrow type, so a test can stand in for the rest. */
export type { GitHubCodeHostProvider } from "./provider.js";

export interface GitHubCodeHostOptions {
  /**
   * Item C2: the name of this connection (`github`, `github-company`), which is also the adapter's `kind` and the name it is registered under. Default `github`. Every connection of this adapter is of provider `github`.
   * Several connections can be registered; a repository record names one (`host.kind`), and one is the default for a repository that names none.
   */
  name?: string;
  /** Item C2: this connection is the default of its provider (used when a repository names none). At most one connection of a provider may say so. */
  isDefault?: boolean;
  /** The credential reference the provider was configured with; a repository registered under another one is refused by the provider. */
  credentialRef: string;
  /** The clock, in milliseconds. Default `Date.now`. */
  now?: () => number;
  /** P6: the install's webhook secret (read for each delivery; `refresh` rereads it after a rotation). Absent: the adapter has no `events.normalise`, so no delivery is accepted through the port. */
  webhookSecret?: (options?: { refresh?: boolean }) => Promise<string>;
}

function checkedScope(scope: HostScope): HostScope {
  const parsed = HostScopeSchema.safeParse(scope);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the plug-in call has no valid scope");
  return parsed.data;
}

export function githubCodeHost(provider: GitHubCodeHostProvider, options: GitHubCodeHostOptions): CodeHost {
  async function fileDetailsRead<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); }
    catch (error) { throw provider.fileDetailsError?.(error) ?? error; }
  }
  const pathKindOfProvider = typeof provider.getPathKindAtCommit === "function" ? provider.getPathKindAtCommit.bind(provider) : undefined;
  const commitFilesOfProvider = typeof provider.commitFilesToBranch === "function" ? provider.commitFilesToBranch.bind(provider) : undefined;
  const findPullRequestOfProvider = typeof provider.findLessonsPullRequest === "function" ? provider.findLessonsPullRequest.bind(provider) : undefined;
  const deleteBranchOfProvider = typeof provider.deleteLessonsBranch === "function" ? provider.deleteLessonsBranch.bind(provider) : undefined;
  const listComments = typeof provider.listPullRequestComments === "function" ? provider.listPullRequestComments.bind(provider) : undefined;
  const postComment = typeof provider.postPullRequestComment === "function" ? provider.postPullRequestComment.bind(provider) : undefined;
  const readTree = fileTrees(provider, options.credentialRef);
  const host: CodeHost = {
    kind: options.name ?? GITHUB_HOST_KIND,
    provider: GITHUB_HOST_KIND,
    ...(options.isDefault === true ? { defaultConnection: true } : {}),
    capabilities: GITHUB_CODE_HOST_CAPABILITIES,
    // P6: with a webhook secret the adapter verifies and maps GitHub's deliveries (events.ts); the broker's existing route keeps its own intake until the cut-over.
    events: options.webhookSecret === undefined ? { mode: "webhook" } : githubCodeHostEvents(options.webhookSecret, options.name ?? GITHUB_HOST_KIND),

    async repositoryIdentity(repository: RepositoryRef, scope: HostScope): Promise<RepositoryIdentity | undefined> {
      const identity = await provider.getRepositoryIdentity(repository.url, checkedScope(scope));
      return identity === undefined ? undefined : { id: String(identity.repositoryId), fullName: identity.fullName, ...(identity.defaultBranch === undefined ? {} : { defaultBranch: identity.defaultBranch }), ...(identity.private === undefined ? {} : { private: identity.private }) };
    },

    async checkRepository(repository: RepositoryRef, scope: HostScope): Promise<void> {
      await provider.checkRepository({ credentialRef: options.credentialRef, url: repository.url }, checkedScope(scope));
    },

    async standing(repository: RepositoryRef, person: HostAccount, scope: HostScope, budget?: ReadBudget): Promise<HostStanding> {
      const standing = await provider.getRepositoryStanding(repository.url, person.login, checkedScope(scope), budget);
      return { permission: standing.permission, ...(standing.userType === undefined ? {} : { accountType: accountKindOf(standing.userType) }) };
    },

    async issueGitCredential(repository: RepositoryRef, access: GitAccess, scope: HostScope): Promise<GitCredential> {
      const credential = await provider.resolveWithExpiry(options.credentialRef, repository.url, access, checkedScope(scope));
      // An empty answer means the provider does not serve this credential reference: never hand out nothing as if it were a credential.
      if (credential.username === undefined || credential.password === undefined || credential.username === "" || credential.password === "") {
        throw agentXError("CONFIG_INVALID", "the repository does not use the configured GitHub App");
      }
      // The expiry GitHub stated for the token. A token that came with none is refused: an expiry made up here would let `workerGitCredentialUsable` pass what it cannot check.
      const stated = credential.expiresAt === undefined ? Number.NaN : Date.parse(credential.expiresAt);
      if (!Number.isFinite(stated)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub gave no expiry for the repository credential");
      return { kind: "basic", username: credential.username, password: credential.password, expiresAt: new Date(stated).toISOString() };
    },

    async fileAtRevision(repository: RepositoryRef, path: string, revision: string, scope: HostScope, fileOptions?: { untilLine?: number; timeoutMs?: number; maxBytes?: number }): Promise<string | undefined> {
      return provider.getFileAtCommit(repository.url, path, revision, checkedScope(scope), fileOptions);
    },

    // Only where the provider can tell (a partial provider of a harness cannot): a host without `kind` leaves a directory unverified.
    ...(pathKindOfProvider === undefined ? {} : {
      async pathKind(repository: RepositoryRef, path: string, revision: string, scope: HostScope, kindOptions?: { timeoutMs?: number }): Promise<PathKind> {
        return pathKindOfProvider(repository.url, path, revision, checkedScope(scope), kindOptions);
      },
    }),

    async tree(repository: RepositoryRef, revision: string, scope: HostScope): Promise<string> {
      return provider.getCommitTree(repository.url, revision, checkedScope(scope));
    },

    async branchHead(repository: RepositoryRef, branch: string, scope: HostScope): Promise<string> {
      // Rovara's own working branches only. The branch goes into an API address, so the shape is held here whatever client sits under the adapter.
      if (!WORKING_BRANCH.test(branch)) throw agentXError("CONFIG_INVALID", "branch name is invalid");
      return provider.getBranchHead(repository.url, branch, checkedScope(scope));
    },

    async baseBranchHead(repository: RepositoryRef, branch: string, scope: HostScope): Promise<string> {
      return provider.getDefaultBranchHead(repository.url, branch, checkedScope(scope));
    },

    async commitParents(repository: RepositoryRef, revision: string, scope: HostScope): Promise<string[]> {
      return provider.getCommitParents(repository.url, revision, checkedScope(scope));
    },

    async listBranches(repository: RepositoryRef, page: number, scope: HostScope): Promise<BranchPage> {
      const checked = checkedScope(scope);
      // The listing is one organization's: a system scope names none. Held here, whatever client sits under the adapter.
      if (!("orgId" in checked)) throw agentXError("CONFIG_INVALID", "the branch listing needs an organization scope");
      if (!Number.isSafeInteger(page) || page < 1 || page > MAX_BRANCH_PAGE) throw agentXError("CONFIG_INVALID", "the page is invalid");
      const identity = await provider.getRepositoryIdentity(repository.url, checked);
      const parsed = parseGitHubRepository(repository.url);
      const installation = await provider.installationForRepository(parsed.owner, parsed.name);
      if (identity === undefined || installation === undefined) throw agentXError("CONFIG_INVALID", "the repository is not reachable through the GitHub App");
      const listed = await provider.listWorkingBranches(repository.url, { installationId: installation.installationId, repositoryId: identity.repositoryId }, checked, page);
      return { branches: listed.branches, page: listed.page, mayHaveMore: listed.mayHaveMore, omittedUnsupported: listed.omittedUnsupported };
    },

    async codeOwners(repository: RepositoryRef, branch: string, scope: HostScope): Promise<CodeOwnersRead | undefined> {
      const text = await provider.readCodeOwners(repository.url, branch, checkedScope(scope));
      return text === undefined ? undefined : readCodeOwnersFile(text);
    },

    // Item C1 (decision 59): only where the client can. A host without these simply has no lessons file.
    ...(commitFilesOfProvider === undefined ? {} : {
      async commitFiles(input: CommitFilesInput, scope: HostScope): Promise<CommitFilesResult> {
        const parsed = CommitFilesInputSchema.parse(input);
        return commitFilesOfProvider(parsed.repository.url, {
          branch: parsed.branch, baseBranch: parsed.baseBranch, message: parsed.message, files: parsed.files, fromBase: parsed.fromBase,
          baseRevision: parsed.baseRevision, expectedHead: parsed.expectedHead, previous: parsed.previous,
        }, checkedScope(scope));
      },
    }),
    ...(findPullRequestOfProvider === undefined ? {} : {
      async changeRequestForBranch(repository: RepositoryRef, branch: string, scope: HostScope): Promise<ChangeRequestRef | undefined> {
        const found = await findPullRequestOfProvider(repository.url, branch, checkedScope(scope));
        return found === undefined ? undefined : refOf(repository.url, found.number, found.url);
      },
    }),
    ...(deleteBranchOfProvider === undefined ? {} : {
      async deleteBranch(repository: RepositoryRef, branch: string, scope: HostScope): Promise<"deleted" | "gone"> {
        return deleteBranchOfProvider(repository.url, branch, checkedScope(scope));
      },
    }),

    async reconcileChangeRequest(input: ChangeRequestInput, scope: HostScope): Promise<ChangeRequestReconciled> {
      const parsed = ChangeRequestInputSchema.parse(input);
      const result = await provider.reconcilePullRequest({
        repositoryUrl: parsed.repository.url, headBranch: parsed.sourceBranch, baseBranch: parsed.targetBranch, title: parsed.title,
        ...(parsed.body === undefined ? {} : { body: parsed.body }), ...(parsed.draft === undefined ? {} : { draft: parsed.draft }),
      }, checkedScope(scope));
      return { ref: refOf(parsed.repository.url, result.number, result.url), reconciled: result.reconciled, ...(result.draftRefused === true ? { draftRefused: true as const } : {}) };
    },

    async getChangeRequest(ref: ChangeRequestRef, scope: HostScope): Promise<ChangeRequestDetails> {
      return detailsOf(ref.repository.url, await provider.getPullRequest(ref.repository.url, pullRequestNumber(ref), checkedScope(scope)));
    },

    async updateChangeRequest(ref: ChangeRequestRef, update: ChangeRequestUpdate, scope: HostScope): Promise<void> {
      const parsed = ChangeRequestUpdateSchema.parse(update);
      await provider.updatePullRequest(ref.repository.url, pullRequestNumber(ref), {
        ...(parsed.title === undefined ? {} : { title: parsed.title }), ...(parsed.body === undefined ? {} : { body: parsed.body }), ...(parsed.state === undefined ? {} : { state: parsed.state }),
      }, checkedScope(scope));
    },

    async mergeObservation(ref: ChangeRequestRef, scope: HostScope, budget: ReadBudget): Promise<MergeObservation> {
      const observed = await provider.getPullRequestMergeObservation(ref.repository.url, pullRequestNumber(ref), budget, checkedScope(scope));
      return { ...detailsOf(ref.repository.url, observed), headTreeRevision: observed.headTreeSha };
    },

    async changeRequestStatus(ref: ChangeRequestRef, scope: HostScope, budget?: ReadBudget): Promise<ChangeRequestStatus> {
      return statusOf(await provider.getPullRequestStatus(ref.repository.url, pullRequestNumber(ref), checkedScope(scope), budget));
    },

    async changedFiles(ref: ChangeRequestRef, page: number, scope: HostScope, readOptions?: { expectedHead?: string }): Promise<ChangeRequestFilesPage> {
      const checked = checkedScope(scope);
      const listed = await fileDetailsRead(() => provider.listPullRequestFiles(ref.repository.url, pullRequestNumber(ref), { page }, checked));
      const files = listed.files.map(fileOf);
      if (files.length > 0 && provider.listTreeAtCommit !== undefined && provider.getPullRequestFileRevisions !== undefined) {
        try {
          const revisions = await fileDetailsRead(() => provider.getPullRequestFileRevisions!(ref.repository.url, pullRequestNumber(ref), checked));
          if (readOptions?.expectedHead !== undefined && revisions.head !== readOptions.expectedHead) return { files, ...(listed.nextPage === undefined ? {} : { nextPage: listed.nextPage }) };
          const head = await fileDetailsRead(() => readTree(ref.repository.url, revisions.head, checked, undefined, true));
          const base = await fileDetailsRead(() => readTree(ref.repository.url, revisions.base, checked, undefined, true));
          for (const file of files) {
            const headType = entryAt(head, file.path), baseType = entryAt(base, file.previousPath ?? file.path);
            if (headType === undefined || baseType === undefined) continue;
            const consistent = file.status === "added" ? headType !== "none" && baseType === "none"
              : file.status === "removed" ? headType === "none" && baseType !== "none"
              : (file.status === "modified" || file.status === "renamed") && headType !== "none" && baseType !== "none";
            if (consistent) file.entry = { head: headType, base: baseType };
          }
        } catch (error) {
          if (hostRateLimitRetryAt(error) !== undefined) throw error;
          // Metadata is optional: failures never turn into a guessed ordinary file.
        }
      }
      return { files, ...(listed.nextPage === undefined ? {} : { nextPage: listed.nextPage }) };
    },

    ...(provider.listTreeAtCommit === undefined ? {} : {
      async instructionFiles(repository: RepositoryRef, revision: string, scope: HostScope, readOptions?: { max?: number; timeoutMs?: number }) {
        const checked = checkedScope(scope);
        const max = readOptions?.max ?? 500;
        if (!Number.isSafeInteger(max) || max < 0) throw agentXError("CONFIG_INVALID", "instruction file limit is invalid");
        return instructionList(await fileDetailsRead(() => readTree(repository.url, revision, checked, readOptions)), max);
      },
    }),

    async feedback(ref: ChangeRequestRef, scope: HostScope): Promise<ChangeRequestFeedback> {
      return feedbackOf(ref.repository.url, await provider.getPullRequestFeedback(ref.repository.url, pullRequestNumber(ref), checkedScope(scope)));
    },

    async reply(ref: ChangeRequestRef, commentId: string, body: string, scope: HostScope, budget?: ReadBudget): Promise<"replied" | "gone"> {
      const number = pullRequestNumber(ref);
      const checked = checkedScope(scope);
      const target = replyTargetOf(commentId);
      // The text is checked first, whatever the comment: Rovara posts its own fixed text or nothing.
      if (body.length === 0 || body.length > 200 || /[\p{Cc}@]/u.test(body)) throw agentXError("CONFIG_INVALID", "the reply is not Rovara's fixed text");
      if (target.kind === "none") return "gone";
      return provider.replyToReviewThread(ref.repository.url, number, target.id, body, checked, budget);
    },

    // Lane L12 (decision 66): fetch only. Only where the client can read comments.
    ...(listComments === undefined ? {} : {
      async comments(ref: ChangeRequestRef, commentOptions: { since?: string; page?: number }, scope: HostScope, budget?: ReadBudget): Promise<HostCommentsPage> {
        const listed = await listComments(ref.repository.url, pullRequestNumber(ref), commentOptions, checkedScope(scope), budget);
        return {
          comments: listed.comments.map((comment) => ({
            // The place is what GitHub reported for the comment, not what was asked: the core compares it with the request's thread.
            id: comment.id, ref: refOf(comment.onRepositoryUrl, comment.number, ""), author: { login: comment.authorLogin, ...(comment.authorId === undefined ? {} : { hostUserId: comment.authorId }), isBot: comment.isBot },
            body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt,
          })),
          ...(listed.nextPage === undefined ? {} : { nextPage: listed.nextPage }),
        };
      },
    }),
    ...(postComment === undefined ? {} : {
      async postComment(ref: ChangeRequestRef, text: string, scope: HostScope, budget?: ReadBudget): Promise<"posted" | "gone"> {
        return postComment(ref.repository.url, pullRequestNumber(ref), text, checkedScope(scope), budget);
      },
    }),

    async markReady(ref: ChangeRequestRef, scope: HostScope, budget?: ReadBudget): Promise<"ready" | "already_ready"> {
      return provider.markPullRequestReady(ref.repository.url, pullRequestNumber(ref), checkedScope(scope), budget);
    },

    async requestReviewers(ref: ChangeRequestRef, reviewers: readonly string[], scope: HostScope, budget?: ReadBudget): Promise<"requested" | "refused"> {
      return provider.requestReviewers(ref.repository.url, pullRequestNumber(ref), reviewers, checkedScope(scope), budget);
    },

    async merge(ref: ChangeRequestRef, input: { revision: string; method: MergeMethod }, scope: HostScope): Promise<MergeResult> {
      return mergeResultOf(await provider.mergePullRequest(ref.repository.url, pullRequestNumber(ref), { sha: input.revision, method: input.method }, checkedScope(scope)));
    },
  };
  return host;
}
