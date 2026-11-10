// Lane L8: commands in pull request comments, against the W0 fakes: a memory document store, and the local-owner approvers fed a fake code host.
import { describe, expect, it } from "vitest";
import type { ApprovalOffer } from "../../packages/broker/src/core/local-pages/index.js";
import { createPrCommentCommands, type CommentPermission, type LookedUpComment, type PendingOffer, type PrCommentEvent, type PrCommandWorld } from "../../packages/broker/src/core/pr-commands/index.js";
import { CODE_HOST_COMMENT_METHOD, createLocalOwnerApprovers } from "../../packages/broker/src/ports/policy-defaults.js";
import { ARTIFACT_DIGEST, commentReads, freshComment } from "../support/comment-fakes.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { IMPLICIT_COMPANY_ID, ROVARA_REPLY_MARKER, parseRovaraComment, type ApprovalProof, type ExternalAccountRef } from "@agentx/contracts";

const OFFER: ApprovalOffer = { requestId: "card-7", revision: 4, artifactDigest: ARTIFACT_DIGEST, kind: "plan" };
const PENDING: PendingOffer = { taskId: "0b4f2b1e-3c6a-4d2e-9a77-5f1d8c0a1e11", approval: OFFER, postedAt: "2026-11-09T10:00:00.000Z", repository: "example/repo" };
const AUTHOR: ExternalAccountRef = { provider: "examplehost", tenant: "", accountId: "dana" };

/** What the webhook says; the text, author and time are read back from the fake host below. */
const event = (overrides: Partial<PrCommentEvent> = {}): PrCommentEvent => ({ companyId: IMPLICIT_COMPANY_ID, action: "created", repository: "example/repo", number: 12, commentId: "c-100", ...overrides });

function hostComment(body: string, overrides: Partial<LookedUpComment> = {}): LookedUpComment {
  return { body, createdAt: "2026-11-09T10:05:00.000Z", updatedAt: "2026-11-09T10:05:00.000Z", author: AUTHOR, authorPermission: "write", authorIsBot: false, on: { repository: "example/repo", number: 12 }, ...overrides };
}

function setup(options: { permission?: CommentPermission; pending?: PendingOffer | undefined | "several"; hostPermission?: "none" | "read" | "write" | "admin" } = {}) {
  const replies: string[] = [];
  const decided: Array<{ taskId: string; decision: string; note?: string; proof: ApprovalProof }> = [];
  const verdicts: unknown[] = [];
  let failNext = false;
  const stored = new Map<string, LookedUpComment>();
  // The approvers seam, fed by a fake host that looks a comment up by id: what the real task flow does with the proof.
  const approvers = createLocalOwnerApprovers({ ...commentReads(freshComment(AUTHOR, { permission: options.hostPermission ?? "write" })) });
  const world: PrCommandWorld = {
    async pendingFor() { return "pending" in options ? options.pending : PENDING; },
    async decide(input) {
      if (failNext) { failNext = false; throw new Error("store unavailable"); }
      decided.push({ taskId: input.taskId, decision: input.decision, ...(input.note === undefined ? {} : { note: input.note }), proof: input.proof });
      const verdict = await approvers.verify({ companyId: IMPLICIT_COMPANY_ID, requestId: input.approval.requestId, kind: "plan", subject: { type: "task", id: input.taskId }, revision: input.approval.revision, artifactDigest: input.approval.artifactDigest }, input.proof);
      return verdict.approved ? { ok: true } : { ok: false, reason: "refused", message: `Not approved: ${verdict.reason}.` };
    },
    async lesson(input) { verdicts.push(input); return { ok: true }; },
    async stop() { verdicts.push("stop"); return { ok: true, message: "Stopped the work on this change." }; },
  };
  const commands = createPrCommentCommands({
    store: new MemoryDocumentStore(), world,
    host: {
      async lookupComment(ref) { return stored.get(ref.commentId); },
      async reply(_event, text) { replies.push(text); },
    },
    now: () => new Date("2026-11-09T10:06:00.000Z"),
  });
  /** Says a comment exists at the host, with this text, by this author (permission as set up). */
  const say = (body: string, commentId = "c-100", overrides: Partial<LookedUpComment> = {}) => { stored.set(commentId, hostComment(body, { authorPermission: options.permission ?? "write", ...overrides })); return event({ commentId }); };
  return { commands, replies, decided, verdicts, say, failNext: () => { failNext = true; } };
}

describe("which comments run", () => {
  it("ignores a plain reply, a loop keyword and a file command", async () => {
    const { commands, replies, decided, say } = setup();
    expect(await commands.handle(say("looks good to me", "c-1"))).toEqual({ handled: false, reason: "not_a_command" });
    expect(await commands.handle(say("/rovara quick fix the retry test", "c-2"))).toEqual({ handled: false, reason: "other_command" });
    expect(await commands.handle(say("/rovara file 2", "c-3"))).toEqual({ handled: false, reason: "other_command" });
    expect(replies).toEqual([]);
    expect(decided).toEqual([]);
  });

  it("never runs an edited or deleted comment, one that is gone, a bot's, or one Rovara posted itself", async () => {
    const { commands, decided, say } = setup();
    expect(await commands.handle({ ...say("/rovara approve 3f2a9c00", "c-1"), action: "edited" })).toEqual({ handled: false, reason: "not_created" });
    expect(await commands.handle({ ...say("/rovara approve 3f2a9c00", "c-2"), action: "deleted" })).toEqual({ handled: false, reason: "not_created" });
    expect(await commands.handle(event({ commentId: "never-posted" }))).toEqual({ handled: false, reason: "gone" });
    expect(await commands.handle(say("/rovara approve 3f2a9c00", "c-3", { authorIsBot: true }))).toEqual({ handled: false, reason: "bot" });
    // Rovara posts with the owner's own token in Code, so the author looks like the owner: Rovara's reply carries its marker, and the core reads that.
    expect(await commands.handle(say(`Approved.\n\n${ROVARA_REPLY_MARKER}`, "c-4"))).toEqual({ handled: false, reason: "own_comment" });
    // A comment the host records an edit of never runs, and a comment that is on another thread than the one named is not this thread's.
    expect(await commands.handle(say("/rovara approve 3f2a9c00", "c-5", { updatedAt: "2026-11-09T10:05:30.000Z" }))).toEqual({ handled: false, reason: "edited" });
    expect(await commands.handle(say("/rovara approve 3f2a9c00", "c-6", { on: { repository: "example/repo", number: 99 } }))).toEqual({ handled: false, reason: "other_thread" });
    expect(decided).toEqual([]);
  });

  it("believes the host, not the webhook: the text, author and time come from the lookup", async () => {
    const { commands, decided, say } = setup();
    // The host says the comment is a plain reply, whatever the delivery claimed.
    const claimed = { ...say("thanks!", "c-1"), body: "/rovara approve", author: AUTHOR, createdAt: "2026-11-09T11:00:00.000Z" };
    expect(await commands.handle(claimed)).toEqual({ handled: false, reason: "not_a_command" });
    expect(decided).toEqual([]);
  });

  it("does nothing, and says nothing, for an author without write permission", async () => {
    for (const permission of ["none", "read"] as const) {
      const { commands, replies, decided, say } = setup({ permission });
      expect(await commands.handle(say("/rovara approve 3f2a9c00"))).toEqual({ handled: false, reason: "no_permission" });
      expect(replies).toEqual([]);
      expect(decided).toEqual([]);
    }
  });

  it("runs a comment once, however often the host delivers it, and again after a failure that could be retried", async () => {
    const world = setup();
    const delivery = world.say("/rovara approve 3f2a9c00");
    expect((await world.commands.handle(delivery)).handled).toBe(true);
    expect(await world.commands.handle(delivery)).toEqual({ handled: false, reason: "duplicate" });
    expect(world.decided).toHaveLength(1);
    const retry = setup();
    const again = retry.say("/rovara approve 3f2a9c00");
    retry.failNext();
    await expect(retry.commands.handle(again)).rejects.toThrow("store unavailable");
    expect((await retry.commands.handle(again)).handled).toBe(true);
    expect(retry.decided).toHaveLength(1);
  });
});

describe("approve and changes", () => {
  it("approves with a code-host-comment proof for exactly the offer, and the approvers seam accepts it", async () => {
    const { commands, decided, replies, say } = setup();
    const outcome = await commands.handle(say("/rovara approve 3f2a9c00"));
    expect(outcome).toEqual({ handled: true, command: "approve", result: { ok: true } });
    expect(decided[0]!.proof).toMatchObject({ method: CODE_HOST_COMMENT_METHOD, token: "c-100", requestId: "card-7", revision: 4, artifactDigest: ARTIFACT_DIGEST, claimedAccount: AUTHOR });
    expect(replies).toEqual(["Approved. I am going ahead."]);
  });

  it("does not approve when the host says the author may not (the approvers' rule, not this module's)", async () => {
    const { commands, replies, say } = setup({ hostPermission: "read" });
    const outcome = await commands.handle(say("/rovara approve 3f2a9c00"));
    expect(outcome).toMatchObject({ handled: true, command: "approve", result: { ok: false } });
    expect(replies[0]).toContain("Not approved");
  });

  it("sends the text of a changes request", async () => {
    const { commands, decided, say } = setup();
    await commands.handle(say("/rovara changes: keep the old API too\nand add a test"));
    expect(decided[0]).toMatchObject({ decision: "changes", note: "keep the old API too\nand add a test" });
  });

  it("refuses a comment written before the latest version was posted, and one whose time cannot be read", async () => {
    const { commands, decided, replies, say } = setup();
    expect(await commands.handle(say("/rovara approve 3f2a9c00", "c-1", { createdAt: "2026-11-09T09:59:59.000Z", updatedAt: "2026-11-09T09:59:59.000Z" }))).toMatchObject({ result: { ok: false, reason: "stale" } });
    expect(await commands.handle(say("/rovara approve 3f2a9c00", "c-2", { createdAt: "yesterday-ish", updatedAt: "yesterday-ish" }))).toMatchObject({ result: { ok: false, reason: "stale" } });
    expect(decided).toEqual([]);
    expect(replies[0]).toContain("before the latest version was posted");
  });

  it("refuses an approval that does not name the waiting version, and tells which version waits (decision 66: the version the person read)", async () => {
    const { commands, decided, replies, say } = setup();
    expect(await commands.handle(say("/rovara approve", "c-1"))).toMatchObject({ result: { ok: false, reason: "stale" } });
    expect(await commands.handle(say("/rovara approve 1111111111", "c-2"))).toMatchObject({ result: { ok: false, reason: "stale" } });
    expect(replies).toEqual(["Version 3f2a9c00 is waiting. To approve that one, say /rovara approve 3f2a9c00.", "Version 3f2a9c00 is waiting. To approve that one, say /rovara approve 3f2a9c00."]);
    expect(decided).toEqual([]);
    // Asking for changes names no version.
    expect(await commands.handle(say("/rovara changes: keep it", "c-3"))).toMatchObject({ result: { ok: true } });
  });

  it("decides nothing when several tasks wait on the change: a comment names no task", async () => {
    const world = setup({ pending: "several" });
    expect(await world.commands.handle(world.say("/rovara approve 3f2a9c00"))).toMatchObject({ result: { ok: false, reason: "refused" } });
    expect(world.replies[0]).toContain("Several tasks wait on this change");
    expect(world.decided).toEqual([]);
  });

  it("refuses a decision on a task that works on another repository than the comment's, even for a writer there", async () => {
    const world = setup({ pending: { ...PENDING, repository: "example/other" } });
    expect(await world.commands.handle(world.say("/rovara approve 3f2a9c00"))).toMatchObject({ result: { ok: false, reason: "refused" } });
    expect(world.decided).toEqual([]);
  });

  it("refuses an approval that names another repository", async () => {
    const { commands, decided, say } = setup();
    expect(await commands.handle(say("/rovara approve other/place 3f2a9c00", "c-1"))).toMatchObject({ result: { ok: false, reason: "refused" } });
    expect((await commands.handle(say("/rovara approve Example/Repo 3f2a9c00", "c-101"))).handled).toBe(true);
    expect(decided).toHaveLength(1);
  });

  it("says so when nothing waits", async () => {
    const { commands, replies, say } = setup({ pending: undefined });
    expect(await commands.handle(say("/rovara approve 3f2a9c00"))).toMatchObject({ result: { ok: false, reason: "not_found" } });
    expect(replies).toEqual(["Nothing is waiting for a decision here."]);
  });

  it("explains a command it cannot read", async () => {
    const { commands, replies, say } = setup();
    expect(await commands.handle(say("/rovara changes:"))).toMatchObject({ command: "invalid" });
    expect(replies[0]).toContain("Say what to change");
  });
});

describe("lessons and stop", () => {
  it("passes a lesson verdict and a stop to the task flow", async () => {
    const { commands, verdicts, replies, say } = setup();
    await commands.handle(say("/rovara lesson 3 wrong", "c-1"));
    await commands.handle(say("/rovara stop", "c-2"));
    expect(verdicts).toEqual([{ repository: "example/repo", number: 12, lessonNumber: 3, verdict: "wrong" }, "stop"]);
    expect(replies).toEqual(["Thanks. I noted that.", "Stopped the work on this change."]);
  });
});

describe("the shared grammar", () => {
  it("reads lesson commands and refuses odd ones", () => {
    expect(parseRovaraComment("/rovara lesson 3 wrong")).toEqual({ kind: "lesson", number: 3, verdict: "wrong" });
    expect(parseRovaraComment("/rovara lesson #12 Retire")).toEqual({ kind: "lesson", number: 12, verdict: "retire" });
    expect(parseRovaraComment("/rovara lesson 3 useful")).toEqual({ kind: "lesson", number: 3, verdict: "right" });
    for (const bad of ["/rovara lesson", "/rovara lesson 0 wrong", "/rovara lesson 3", "/rovara lesson 3 maybe", "/rovara lesson 3 wrong now"]) expect(parseRovaraComment(bad).kind, bad).toBe("invalid");
  });

  it("only treats a first line that starts with /rovara as a command", () => {
    expect(parseRovaraComment("thanks!\n/rovara approve").kind).toBe("reply");
    expect(parseRovaraComment(" /rovara approve ").kind).toBe("approve");
    expect(parseRovaraComment("/rovaraapprove").kind).toBe("other");
    expect(parseRovaraComment("/rovara   STOP")).toEqual({ kind: "stop" });
  });
});
