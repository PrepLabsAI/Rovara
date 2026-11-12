// The CodeHost contract: what every code-host adapter must do, written once. The fake runs it, and so does every real adapter (against recorded
// fixtures, and against a live sandbox where one exists). A caller branches on capabilities, never on the adapter's name, so each check that depends on
// a capability says so with `needs`.
import { expect } from "vitest";
import {
  ChangeRequestDetailsSchema, ChangeRequestFeedbackSchema, ChangeRequestStatusSchema, CodeHostCapabilitiesSchema, CodeHostEventSchema, GitCredentialSchema, hostRateLimitRetryAt, MergeObservationSchema,
  type ChangeRequestRef, type CodeHost, type HostScope, type RawDelivery, type ReadBudget, type RepositoryRef,
} from "@agentx/contracts";
import type { FakeHostModel } from "@agentx/broker/fakes";
import { workerGitCredentialUsable } from "@agentx/contracts";
import { twoCompanyChecks, type TwoCompanyIsolation } from "../isolation/two-company.js";
import { rejection, SHA40, type ContractCheck } from "./plugin-contract-kit.js";

export interface CodeHostWorld {
  /** Two companies that share raw ids on this adapter, for the isolation kit. Absent: the adapter serves one company, and the isolation checks show as skipped. */
  readonly isolation?: TwoCompanyIsolation;
  readonly host: CodeHost;
  /** The state of the host. The fake reads it directly; a real adapter's fixtures are served from it. The suite only sets state up through it. */
  readonly model: FakeHostModel;
  readonly repository: RepositoryRef;
  /** A repository nobody registered. */
  readonly unregistered: RepositoryRef;
  readonly scope: HostScope;
  /** The adapter's clock, in milliseconds. */
  readonly now: () => number;
  /**
   * A branch name the adapter can read the head of. `branchHead` reads Rovara's own working branches, and the GitHub adapter only accepts the names Rovara
   * gives them, so the world says what a working branch is called (the fake accepts any name). `branch(1)`, `branch(2)` ... are distinct.
   */
  readonly branch: (n: number) => string;
  /** A delivery the host's events accept (a valid signature), for the neutral event it names; only for a host that verifies webhooks. */
  readonly signedDelivery?: (event: { kind: "change_request.opened"; id: string } | { kind: "revision.pushed"; branch: string; revision: string }) => RawDelivery;
  /** A delivery whose signature does not verify. */
  readonly forgedDelivery?: () => RawDelivery;
  /** P6: makes the host answer every read as rate limited until `retryAt` (milliseconds), in the host's own way (a 429 for GitHub). */
  readonly limitReads?: (retryAt: number) => void;
}

/** A read allowance that counts its requests, as a tracking pass's does. */
export function countingBudget(): { budget: ReadBudget; requests: () => number } {
  let count = 0;
  return { budget: { signal: new AbortController().signal, beforeRequest: () => { count += 1; } }, requests: () => count };
}

/** Opens a change request from a new branch with one added file, and returns it. */
async function openChangeRequest(world: CodeHostWorld, options: { draft?: boolean; branch?: string } = {}): Promise<{ ref: ChangeRequestRef; head: string; branch: string }> {
  const branch = options.branch ?? world.branch(1);
  const head = world.model.commit(branch, { "src/a.ts": "export const a = 1;\n" });
  const { ref } = await world.host.reconcileChangeRequest({ repository: world.repository, sourceBranch: branch, targetBranch: world.model.defaultBranch, title: "Add a", body: "Adds a.", ...(options.draft === undefined ? {} : { draft: options.draft }) }, world.scope);
  return { ref, head, branch };
}

const ownChecks: readonly ContractCheck<CodeHostWorld>[] = [
  {
    name: "advertises capabilities that fit the schema and a kind",
    async run({ host }) {
      expect(CodeHostCapabilitiesSchema.safeParse(host.capabilities).success).toBe(true);
      expect(host.kind).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    },
  },
  {
    name: "identifies a registered repository, and never an unregistered one",
    async run({ host, model, repository, unregistered, scope }) {
      expect(await host.repositoryIdentity(repository, scope)).toMatchObject({ id: model.id, fullName: model.fullName, defaultBranch: model.defaultBranch });
      // Either "not found" or a refusal, never an identity.
      let found: unknown;
      const refused = await rejection(async () => { found = await host.repositoryIdentity(unregistered, scope); });
      expect(found === undefined || refused !== undefined).toBe(true);
    },
  },
  {
    name: "checks a registered repository and refuses one that is not registered",
    async run({ host, repository, unregistered, scope }) {
      await host.checkRepository(repository, scope);
      expect(await rejection(() => host.checkRepository(unregistered, scope))).toBeDefined();
    },
  },
  {
    name: "reports a person's standing: permission and account type, and none for a stranger",
    async run({ host, model, repository, scope }) {
      model.setAccount("priya", "write");
      model.setAccount("ci-bot", "read", "bot");
      expect(await host.standing(repository, { login: "priya" }, scope)).toMatchObject({ permission: "write" });
      expect((await host.standing(repository, { login: "ci-bot" }, scope)).accountType).toBe("bot");
      expect(await host.standing(repository, { login: "nobody" }, scope)).toEqual({ permission: "none" });
    },
  },
  {
    name: "hands out a short-lived git credential of an advertised kind for clone and push",
    async run({ host, repository, scope, now }) {
      for (const access of ["clone", "push"] as const) {
        const credential = GitCredentialSchema.parse(await host.issueGitCredential(repository, access, scope));
        expect(host.capabilities.credentialKinds).toContain(credential.kind);
        // Always with an expiry, no more than an hour out, and fit to hand to a worker.
        expect(workerGitCredentialUsable(credential, { now: now(), actingAs: "service" })).toMatchObject({ ok: true });
      }
    },
  },
  {
    name: "refuses a credential for a repository that is not registered",
    async run({ host, unregistered, scope }) {
      expect(await rejection(() => host.issueGitCredential(unregistered, "clone", scope))).toBeDefined();
    },
  },
  {
    name: "reads a file at a revision, and the file as it was at an older one",
    async run({ host, model, repository, scope }) {
      const first = model.commit("main", { "notes.txt": "one\n" });
      const second = model.commit("main", { "notes.txt": "two\n", "gone.txt": "x\n" });
      expect(await host.fileAtRevision(repository, "notes.txt", first, scope)).toBe("one\n");
      expect(await host.fileAtRevision(repository, "notes.txt", second, scope)).toBe("two\n");
      expect(await host.fileAtRevision(repository, "missing.txt", second, scope)).toBeUndefined();
    },
  },
  {
    name: "refuses a file over the caller's size cap, never cutting it, and reads one within it",
    async run({ host, model, repository, scope }) {
      const body = "x".repeat(200);
      const revision = model.commit("main", { "config.yml": body });
      expect(await host.fileAtRevision(repository, "config.yml", revision, scope, { maxBytes: 200 })).toBe(body);
      expect(await host.fileAtRevision(repository, "config.yml", revision, scope, { maxBytes: 4_096 })).toBe(body);
      const refused = await rejection(() => host.fileAtRevision(repository, "config.yml", revision, scope, { maxBytes: 199 }));
      expect(refused?.code).toBe("CONFIG_INVALID");
      // A file that is not there is still not there, whatever the cap.
      expect(await host.fileAtRevision(repository, "missing.yml", revision, scope, { maxBytes: 10 })).toBeUndefined();
    },
  },
  {
    name: "reads a branch head and a revision's tree, and the tree follows the content",
    async run({ host, model, repository, scope, branch }) {
      const first = model.commit(branch(1), { "a.txt": "a\n" });
      expect(await host.branchHead(repository, branch(1), scope)).toBe(first);
      const tree = await host.tree(repository, first, scope);
      expect(tree).toMatch(SHA40);
      // A new revision with the same files has the same tree; a changed file changes it.
      const same = model.commit(branch(1), {});
      expect(same).not.toBe(first);
      expect(await host.branchHead(repository, branch(1), scope)).toBe(same);
      expect(await host.tree(repository, same, scope)).toBe(tree);
      const changed = model.commit(branch(1), { "a.txt": "b\n" });
      expect(await host.tree(repository, changed, scope)).not.toBe(tree);
      expect(await rejection(() => host.branchHead(repository, branch(9), scope))).toBeDefined();
    },
  },
  {
    name: "lists branches",
    async run({ host, model, repository, scope, branch }) {
      model.commit(branch(1), { "x.txt": "x\n" });
      const page = await host.listBranches(repository, 1, scope);
      expect(page.branches).toEqual(expect.arrayContaining(["main", branch(1)]));
      expect(page.page).toBe(1);
    },
  },
  {
    name: "reads the code owners file when the repository has one",
    needs: ({ host }) => host.codeOwners !== undefined,
    async run({ host, model, repository, scope }) {
      expect(await host.codeOwners!(repository, "main", scope)).toBeUndefined();
      model.commit("main", { ".github/CODEOWNERS": "* @max\n/docs/ @acme/writers a@example.com\n" });
      // Item C4: the host reads its own owners file and answers in Rovara's words; the core never parses it.
      const owners = (await host.codeOwners!(repository, "main", scope))!;
      expect(owners.unsupported).toBe(false);
      expect(owners.ownersOf("src/a.ts")).toEqual([{ kind: "person", login: "max" }]);
      expect(owners.ownersOf("docs/guide.md")).toEqual([{ kind: "team", team: "acme/writers" }, { kind: "other", label: "a@example.com" }]);
      // A file the host cannot read the way it does is flagged as a whole, not half read.
      model.commit("main", { ".github/CODEOWNERS": "* @max\n!/secure/ @max\n" });
      expect((await host.codeOwners!(repository, "main", scope))!.unsupported).toBe(true);
    },
  },
  {
    name: "says whether Rovara's own account made a change request, and which repository it is against",
    async run(world) {
      const { host, scope, model } = world;
      const { ref } = await openChangeRequest(world);
      const details = await host.getChangeRequest(ref, scope);
      // True for a host that can tell its own account; absent for one that cannot (a laptop signed in with a person's own token): never false for Rovara's own, and never a guess.
      expect(details.authoredByRovara === undefined || details.authoredByRovara === true).toBe(true);
      expect(details.baseRepositoryId).toBe(model.id);
      // A change request a person opened is not Rovara's, and an unknown author is never taken as a yes (absent or false).
      model.commit(world.branch(2), { "src/b.ts": "export const b = 1;\n" });
      const theirs = model.reconcile({ sourceBranch: world.branch(2), targetBranch: model.defaultBranch, title: "Theirs" }, "a-person").cr;
      const mine = await host.getChangeRequest({ repository: world.repository, id: theirs.id, url: "" }, scope);
      expect(mine.authoredByRovara === undefined || mine.authoredByRovara === false).toBe(true);
      expect(mine.authoredByRovara).not.toBe(true);
    },
  },
  {
    name: "tells a symbolic link from a file, and never answers 'none' for a path below one",
    needs: ({ host }) => host.pathKind !== undefined,
    async run({ host, model, repository, scope }) {
      model.commit("main", { "real.md": "x\n" });
      const head = model.commitSymlink("main", "AGENTS.md");
      expect(await host.pathKind!(repository, "AGENTS.md", head, scope)).toBe("symlink");
      expect(await host.pathKind!(repository, "real.md", head, scope)).toBe("file");
      expect(await host.pathKind!(repository, "nothing.md", head, scope)).toBe("none");
      expect(await rejection(() => host.pathKind!(repository, "AGENTS.md/inner.md", head, scope))).toBeDefined();
    },
  },
  {
    name: "writes the lessons file on a branch Rovara owns: idempotent, never the base branch, never another path or branch name",
    needs: ({ host }) => host.commitFiles !== undefined,
    async run({ host, model, repository, scope }) {
      const base = model.headOf("main");
      const branch = "rovara/lessons-0123456789ab";
      const input = { repository, branch, baseBranch: "main", message: "Add lessons", files: [{ path: ".rovara/lessons.md", content: "one\n" }], fromBase: true, baseRevision: base };
      const first = await host.commitFiles!(input, scope);
      expect(first.changed).toBe(true);
      expect(model.headOf(branch)).toBe(first.revision);
      expect(await host.fileAtRevision(repository, ".rovara/lessons.md", first.revision, scope)).toBe("one\n");
      // The base branch was not touched.
      expect(model.headOf("main")).toBe(base);
      // A new change request needs a branch nobody has: the same branch again is a conflict and is left as it is.
      const again = await rejection(() => host.commitFiles!(input, scope));
      expect(again?.code).toBe("CONFIG_INVALID");
      expect(model.headOf(branch)).toBe(first.revision);
      // Updating the open branch: the same text changes nothing, new text is a commit on top.
      const update = { ...input, fromBase: false, expectedHead: first.revision, previous: [{ path: ".rovara/lessons.md", content: "one\n" }] };
      expect(await host.commitFiles!({ ...update, files: [{ path: ".rovara/lessons.md", content: "one\n" }] }, scope)).toEqual({ revision: first.revision, changed: false });
      const second = await host.commitFiles!({ ...update, files: [{ path: ".rovara/lessons.md", content: "two\n" }] }, scope);
      expect(second.changed).toBe(true);
      expect(model.revision(second.revision).parents).toEqual([first.revision]);
      // A push made since the head was read is never overwritten.
      expect((await rejection(() => host.commitFiles!({ ...update, files: [{ path: ".rovara/lessons.md", content: "three\n" }] }, scope)))?.code).toBe("CONFIG_INVALID");
      expect((await rejection(() => host.commitFiles!({ ...update, expectedHead: second.revision, files: [{ path: ".rovara/lessons.md", content: "three\n" }] }, scope)))?.code).toBe("CONFIG_INVALID");
      // Another path, another branch name, and the base branch itself are refused.
      expect((await rejection(() => host.commitFiles!({ ...input, branch: "rovara/lessons-aaaaaaaaaaaa", files: [{ path: "src/a.ts", content: "x" }] }, scope)))?.code).toBe("CONFIG_INVALID");
      expect((await rejection(() => host.commitFiles!({ ...input, branch: "main" }, scope)))?.code).toBe("CONFIG_INVALID");
      expect((await rejection(() => host.commitFiles!({ ...input, branch: "agentx/not-a-lessons-branch" }, scope)))?.code).toBe("CONFIG_INVALID");
    },
  },
  {
    name: "refuses to write over a symbolic link",
    needs: ({ host }) => host.commitFiles !== undefined,
    async run({ host, model, repository, scope }) {
      const head = model.commitSymlink("main", "AGENTS.md");
      const refused = await rejection(() => host.commitFiles!({
        repository, branch: "rovara/lessons-0123456789ab", baseBranch: "main", message: "Add pointer", files: [{ path: "AGENTS.md", content: "see lessons\n" }], fromBase: true, baseRevision: head,
      }, scope));
      expect(refused?.code).toBe("CONFIG_INVALID");
      expect(refused?.message).toContain("symbolic link");
    },
  },
  {
    name: "finds the change request of a lessons branch, and deleting the branch closes it",
    needs: ({ host }) => host.commitFiles !== undefined && host.changeRequestForBranch !== undefined && host.deleteBranch !== undefined,
    async run({ host, model, repository, scope }) {
      const branch = "rovara/lessons-0123456789ab";
      expect(await host.changeRequestForBranch!(repository, branch, scope)).toBeUndefined();
      expect(await host.deleteBranch!(repository, branch, scope)).toBe("gone");
      await host.commitFiles!({ repository, branch, baseBranch: "main", message: "Add lessons", files: [{ path: ".rovara/lessons.md", content: "one\n" }], fromBase: true }, scope);
      const { ref } = await host.reconcileChangeRequest({ repository, sourceBranch: branch, targetBranch: "main", title: "Lessons" }, scope);
      expect(await host.changeRequestForBranch!(repository, branch, scope)).toMatchObject({ id: ref.id });
      expect(await host.deleteBranch!(repository, branch, scope)).toBe("deleted");
      expect(model.branches.has(branch)).toBe(false);
      expect((await host.getChangeRequest(ref, scope)).state).toBe("closed");
      // Any other name is refused before the host is asked.
      expect((await rejection(() => host.deleteBranch!(repository, "main", scope)))?.code).toBe("CONFIG_INVALID");
      expect((await rejection(() => host.changeRequestForBranch!(repository, "agentx/x", scope)))?.code).toBe("CONFIG_INVALID");
    },
  },
  {
    name: "opens a change request once: asking again answers the same one, marked as found again",
    async run(world) {
      const { host, model, repository, scope } = world;
      const { ref, branch } = await openChangeRequest(world);
      const again = await host.reconcileChangeRequest({ repository, sourceBranch: branch, targetBranch: model.defaultBranch, title: "Add a (again)" }, scope);
      expect(again.reconciled).toBe(true);
      expect(again.ref.id).toBe(ref.id);
      expect(model.changeRequests).toHaveLength(1);
    },
  },
  {
    name: "refuses to open a change request from a branch that does not exist",
    async run({ host, model, repository, scope, branch }) {
      expect(await rejection(() => host.reconcileChangeRequest({ repository, sourceBranch: branch(9), targetBranch: model.defaultBranch, title: "x" }, scope))).toBeDefined();
      expect(model.changeRequests).toHaveLength(0);
    },
  },
  {
    name: "reads a change request, updates its title and body, and closes it",
    async run(world) {
      const { host, scope } = world;
      const { ref, head, branch } = await openChangeRequest(world);
      const details = ChangeRequestDetailsSchema.parse(await host.getChangeRequest(ref, scope));
      expect(details).toMatchObject({ state: "open", sourceBranch: branch, targetBranch: "main", headRevision: head, title: "Add a", body: "Adds a." });
      await host.updateChangeRequest(ref, { title: "Add a, better", body: "More." }, scope);
      expect(await host.getChangeRequest(ref, scope)).toMatchObject({ title: "Add a, better", body: "More." });
      await host.updateChangeRequest(ref, { state: "closed" }, scope);
      expect((await host.getChangeRequest(ref, scope)).state).toBe("closed");
    },
  },
  {
    name: "follows the head of the source branch while the change request is open",
    async run(world) {
      const { host, scope } = world;
      const { ref, branch } = await openChangeRequest(world);
      const next = world.model.commit(branch, { "src/b.ts": "export const b = 2;\n" });
      expect((await host.getChangeRequest(ref, scope)).headRevision).toBe(next);
    },
  },
  {
    name: "lists the files a change request changes",
    async run(world) {
      const { host, scope } = world;
      const { ref, branch } = await openChangeRequest(world);
      world.model.commit(branch, { "README.md": "# changed\n" });
      const page = await host.changedFiles(ref, 1, scope);
      expect(page.files.map((file) => [file.path, file.status]).sort()).toEqual([["README.md", "modified"], ["src/a.ts", "added"]]);
      expect(page.nextPage).toBeUndefined();
    },
  },
  {
    name: "reports status: the head, finished checks with conclusions, reviews, and what blocks a merge",
    async run(world) {
      const { host, model, scope } = world;
      const { ref, head } = await openChangeRequest(world);
      model.requiredChecks = ["unit"];
      model.setChecks(head, [{ name: "unit", state: "pending", required: true, url: "", runId: "11" }]);
      model.addReview(ref.id, { login: "priya", state: "APPROVED" });
      const blocked = ChangeRequestStatusSchema.parse(await host.changeRequestStatus(ref, scope));
      expect(blocked).toMatchObject({ state: "open", draft: false, headRevision: head, targetBranch: "main", mergeableState: "blocked", targetHasRequiredChecks: true });
      expect(blocked.checks).toEqual([expect.objectContaining({ name: "unit", state: "pending", required: true })]);
      expect(blocked.reviews).toHaveLength(1);
      expect(blocked.reviews[0]).toMatchObject({ reviewer: { login: "priya" }, state: "APPROVED", revision: head });
      expect(blocked.requiredChecks.map((check) => check.name)).toEqual(["unit"]);

      model.setChecks(head, [{ name: "unit", state: "completed", conclusion: "success", required: true, url: "", runId: "11" }]);
      const green = await host.changeRequestStatus(ref, scope);
      expect(green.mergeableState).toBe("clean");
      expect(green.checks[0]).toMatchObject({ state: "completed", conclusion: "success" });
    },
  },
  {
    name: "never reads a missing required check as passing",
    async run(world) {
      const { host, model, scope } = world;
      const { ref } = await openChangeRequest(world);
      model.requiredChecks = ["unit"];
      const status = await host.changeRequestStatus(ref, scope);
      expect(status.mergeableState).not.toBe("clean");
      expect(status.checks).toEqual([]);
    },
  },
  {
    name: "stops a status read when its read budget is spent",
    async run(world) {
      const { host, scope } = world;
      const { ref } = await openChangeRequest(world);
      const spent = { signal: new AbortController().signal, beforeRequest: () => { throw new Error("read allowance spent"); } };
      expect(await rejection(() => host.changeRequestStatus(ref, scope, spent))).toBeDefined();
    },
  },
  {
    name: "reads feedback: comments, review text and threads, with Rovara's own replies left out",
    async run(world) {
      const { host, model, scope } = world;
      const { ref, head } = await openChangeRequest(world);
      model.addDiscussionComment(ref.id, "priya", "Please rename a.");
      model.addReviewComment(ref.id, "sam", "Why a const?", "src/a.ts", 1);
      model.addReview(ref.id, { login: "sam", state: "CHANGES_REQUESTED", body: "Needs work." });
      model.addReview(ref.id, { login: "lee", state: "APPROVED" });
      const feedback = ChangeRequestFeedbackSchema.parse(await host.feedback(ref, scope));
      expect(feedback.changeRequest.headRevision).toBe(head);
      expect(feedback.changeRequest.headTreeRevision).toBe(await host.tree(world.repository, head, scope));
      // Ids are the adapter's own: found here by what was said and by whom.
      const discussion = feedback.comments.find((comment) => comment.body === "Please rename a.");
      const inline = feedback.comments.find((comment) => comment.body === "Why a const?");
      expect(discussion).toMatchObject({ kind: "discussion", author: "priya" });
      expect(inline).toMatchObject({ kind: "review_comment", author: "sam", path: "src/a.ts", line: 1 });
      expect(feedback.comments.filter((comment) => comment.kind === "review").map((comment) => comment.author)).toEqual(["sam"]);
      expect(feedback.threads).toEqual([expect.objectContaining({ resolved: false, commentIds: [inline!.id] })]);
      expect(inline!.threadId).toBe(feedback.threads[0]!.id);

      expect(await host.reply(ref, inline!.id, "Thanks, this is fixed.", scope)).toBe("replied");
      const after = await host.feedback(ref, scope);
      expect(after.comments.map((comment) => comment.body)).not.toContain("Thanks, this is fixed.");
      expect(after.threads[0]!.commentIds).toEqual([inline!.id]);
    },
  },
  {
    name: "replies only with fixed text, and says 'gone' for a comment that is not in a thread",
    async run(world) {
      const { host, model, scope } = world;
      const { ref } = await openChangeRequest(world);
      model.addDiscussionComment(ref.id, "priya", "Please rename a.");
      model.addReviewComment(ref.id, "sam", "Why?", "src/a.ts", 1);
      const feedback = await host.feedback(ref, scope);
      const discussion = feedback.comments.find((comment) => comment.body === "Please rename a.")!;
      const inline = feedback.comments.find((comment) => comment.body === "Why?")!;
      expect(await host.reply(ref, discussion.id, "Done.", scope)).toBe("gone");
      expect(await host.reply(ref, "424242", "Done.", scope)).toBe("gone");
      for (const text of ["", "x".repeat(201), "thanks @sam", "two\nlines"]) {
        expect(await rejection(() => host.reply(ref, inline.id, text, scope))).toBeDefined();
      }
      expect(model.getChangeRequest(ref.id).comments.filter((comment) => comment.author === "rovara-app[bot]")).toHaveLength(0);
    },
  },
  {
    name: "merges only at the head the caller checked, only when open and mergeable, and is then 'already merged'",
    needs: ({ host }) => host.merge !== undefined,
    async run(world) {
      const { host, model, scope } = world;
      const { ref, head, branch } = await openChangeRequest(world);
      model.requiredChecks = ["unit"];
      expect(await host.merge!(ref, { revision: head, method: "squash" }, scope)).toMatchObject({ outcome: "refused", reason: "not_mergeable" });
      model.setChecks(head, [{ name: "unit", state: "completed", conclusion: "success", required: true, url: "" }]);
      const moved = model.commit(branch, { "src/b.ts": "export const b = 2;\n" });
      expect(await host.merge!(ref, { revision: head, method: "squash" }, scope)).toEqual({ outcome: "refused", reason: "head_changed" });
      model.setChecks(moved, [{ name: "unit", state: "completed", conclusion: "success", required: true, url: "" }]);
      const merged = await host.merge!(ref, { revision: moved, method: "squash" }, scope);
      expect(merged).toMatchObject({ outcome: "merged", method: "squash", fellBack: false });
      expect((await host.getChangeRequest(ref, scope)).state).toBe("merged");
      expect(await host.merge!(ref, { revision: moved, method: "squash" }, scope)).toEqual({ outcome: "already_merged" });
    },
  },
  {
    name: "does not merge a closed change request",
    needs: ({ host }) => host.merge !== undefined,
    async run(world) {
      const { host, scope } = world;
      const { ref, head } = await openChangeRequest(world);
      await host.updateChangeRequest(ref, { state: "closed" }, scope);
      expect(await host.merge!(ref, { revision: head, method: "merge" }, scope)).toEqual({ outcome: "refused", reason: "closed" });
    },
  },
  {
    name: "opens as a draft when asked, and takes it out of draft once",
    needs: ({ host }) => host.markReady !== undefined && host.capabilities.drafts,
    async run(world) {
      const { host, scope } = world;
      const { ref } = await openChangeRequest(world, { draft: true });
      expect((await host.changeRequestStatus(ref, scope)).draft).toBe(true);
      expect(await host.markReady!(ref, scope)).toBe("ready");
      expect((await host.changeRequestStatus(ref, scope)).draft).toBe(false);
      expect(await host.markReady!(ref, scope)).toBe("already_ready");
    },
  },
  {
    name: "asks for reviews, and treats a name the host refuses as refused, not as an error",
    needs: ({ host }) => host.requestReviewers !== undefined,
    async run(world) {
      const { host, model, scope } = world;
      const { ref } = await openChangeRequest(world);
      model.setAccount("priya", "write");
      expect(await host.requestReviewers!(ref, ["priya"], scope)).toBe("requested");
      expect((await host.changeRequestStatus(ref, scope)).requestedReviewers).toBe(1);
      expect(await host.requestReviewers!(ref, ["unknown-person"], scope)).toBe("refused");
      expect(await rejection(() => host.requestReviewers!(ref, [], scope))).toBeDefined();
    },
  },
  {
    name: "refuses a call with no valid scope, before touching the host",
    async run(world) {
      const { host, repository } = world;
      for (const scope of [{}, { system: "anything" }, undefined, { orgId: "" }] as unknown as HostScope[]) {
        expect(await rejection(() => host.checkRepository(repository, scope))).toBeDefined();
        expect(await rejection(() => host.branchHead(repository, world.branch(1), scope))).toBeDefined();
      }
    },
  },
  {
    name: "maps a signed delivery to neutral events, and never returns events from one that does not verify",
    needs: (world) => world.host.events.mode === "webhook" && world.host.events.normalise !== undefined && world.signedDelivery !== undefined && world.forgedDelivery !== undefined,
    async run(world) {
      const { host, scope } = world;
      const { ref, head, branch } = await openChangeRequest(world);
      const opened = await host.events.normalise!(world.signedDelivery!({ kind: "change_request.opened", id: ref.id }), scope);
      expect(opened).toHaveLength(1);
      expect(CodeHostEventSchema.parse(opened[0])).toMatchObject({ type: "change_request.opened", ref: { id: ref.id } });
      const pushed = await host.events.normalise!(world.signedDelivery!({ kind: "revision.pushed", branch, revision: head }), scope);
      expect(pushed[0]).toMatchObject({ type: "revision.pushed", branch, revision: head });
      let events: unknown;
      const refused = await rejection(async () => { events = await host.events.normalise!(world.forgedDelivery!(), scope); });
      expect(refused).toBeDefined();
      expect(events).toBeUndefined();
    },
  },
  {
    name: "reads the head of an ordinary branch and the parents of a revision",
    async run(world) {
      const { host, model, repository, unregistered, scope } = world;
      const root = model.headOf(model.defaultBranch);
      expect(await host.baseBranchHead(repository, model.defaultBranch, scope)).toBe(root);
      // An ordinary branch name, not only Rovara's own: a base branch named with a slash.
      const release = model.commit("release/2026-11", { "VERSION": "1\n" });
      expect(await host.baseBranchHead(repository, "release/2026-11", scope)).toBe(release);
      expect(await host.commitParents(repository, root, scope)).toEqual([]);
      expect(await host.commitParents(repository, release, scope)).toEqual([root]);
      const { head } = await openChangeRequest(world);
      expect(await host.commitParents(repository, head, scope)).toHaveLength(1);
      expect(await rejection(() => host.baseBranchHead(repository, "no-such-branch", scope))).toBeDefined();
      expect(await rejection(() => host.commitParents(repository, "f".repeat(40), scope))).toBeDefined();
      expect(await rejection(() => host.baseBranchHead(unregistered, model.defaultBranch, scope))).toBeDefined();
    },
  },
  {
    name: "observes a merge: what it merged as and when, within the read allowance",
    needs: ({ host }) => host.mergeObservation !== undefined && host.merge !== undefined,
    async run(world) {
      const { host, scope } = world;
      const { ref, head } = await openChangeRequest(world);
      const open = countingBudget();
      const before = MergeObservationSchema.parse(await host.mergeObservation!(ref, scope, open.budget));
      expect(before).toMatchObject({ state: "open", headRevision: head });
      expect(before.mergedAt).toBeUndefined();
      expect(before.mergeRevision).toBeUndefined();
      expect(open.requests()).toBeGreaterThan(0);
      const merged = await host.merge!(ref, { revision: head, method: "merge" }, scope);
      expect(merged.outcome).toBe("merged");
      const after = MergeObservationSchema.parse(await host.mergeObservation!(ref, scope, countingBudget().budget));
      expect(after.state).toBe("merged");
      expect(after.mergeRevision).toBe(merged.outcome === "merged" ? merged.mergeRevision : undefined);
      expect(Number.isFinite(Date.parse(after.mergedAt ?? ""))).toBe(true);
      // The details a plain read gives carry the same time.
      expect((await host.getChangeRequest(ref, scope)).mergedAt).toBe(after.mergedAt);
      // A spent allowance stops the read.
      expect(await rejection(() => host.mergeObservation!(ref, scope, { signal: new AbortController().signal, beforeRequest: () => { throw new Error("allowance spent"); } }))).toBeDefined();
    },
  },
  {
    name: "signals its rate limit as the neutral error, with the time to try again",
    needs: (world) => world.limitReads !== undefined,
    async run(world) {
      const { host, scope } = world;
      const { ref } = await openChangeRequest(world);
      const retryAt = world.now() + 60_000;
      world.limitReads!(retryAt);
      const { budget } = countingBudget();
      for (const read of [() => host.changeRequestStatus(ref, scope, budget), () => host.standing(world.repository, { login: "priya" }, scope, budget), ...(host.mergeObservation === undefined ? [] : [() => host.mergeObservation!(ref, scope, budget)])]) {
        expect(hostRateLimitRetryAt(await rejection(read))).toBe(retryAt);
      }
    },
  },
];

export const codeHostChecks: readonly ContractCheck<CodeHostWorld>[] = [...ownChecks, ...twoCompanyChecks<CodeHostWorld>()];
