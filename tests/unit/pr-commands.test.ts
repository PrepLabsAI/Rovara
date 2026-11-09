// Lane L8: commands in pull request comments, against the W0 fakes: a memory document store, and the local-owner approvers fed a fake code host.
import { describe, expect, it } from "vitest";
import type { ApprovalOffer } from "../../packages/broker/src/core/local-pages/index.js";
import { createPrCommentCommands, type CommentPermission, type PendingOffer, type PrCommentEvent, type PrCommandWorld } from "../../packages/broker/src/core/pr-commands/index.js";
import { CODE_HOST_COMMENT_METHOD, createLocalOwnerApprovers } from "../../packages/broker/src/ports/policy-defaults.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { IMPLICIT_COMPANY_ID, parseRovaraComment, type ApprovalProof, type ExternalAccountRef } from "@agentx/contracts";

const OFFER: ApprovalOffer = { requestId: "card-7", revision: 4, artifactDigest: "sha256-1234", kind: "plan" };
const PENDING: PendingOffer = { taskId: "0b4f2b1e-3c6a-4d2e-9a77-5f1d8c0a1e11", approval: OFFER, postedAt: "2026-11-09T10:00:00.000Z", repository: "example/repo" };
const AUTHOR: ExternalAccountRef = { provider: "examplehost", tenant: "", accountId: "dana" };

function comment(body: string, overrides: Partial<PrCommentEvent> = {}): PrCommentEvent {
  return { companyId: IMPLICIT_COMPANY_ID, action: "created", repository: "example/repo", number: 12, commentId: "c-100", body, createdAt: "2026-11-09T10:05:00.000Z", author: AUTHOR, authorIsBot: false, ...overrides };
}

function setup(options: { permission?: CommentPermission; pending?: PendingOffer | undefined; hostPermission?: "none" | "read" | "write" | "admin" } = {}) {
  const replies: string[] = [];
  const decided: Array<{ taskId: string; decision: string; note?: string; proof: ApprovalProof }> = [];
  const verdicts: unknown[] = [];
  let failNext = false;
  // The approvers seam, fed by a fake host that looks a comment up by id: what the real task flow does with the proof.
  const approvers = createLocalOwnerApprovers({ verifyComment: (commentId) => ({ author: AUTHOR, permission: options.hostPermission ?? "write", approves: commentId.startsWith("c-") }) });
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
    host: { async authorPermission() { return options.permission ?? "write"; }, async reply(_event, text) { replies.push(text); } },
    now: () => new Date("2026-11-09T10:06:00.000Z"),
  });
  return { commands, replies, decided, verdicts, failNext: () => { failNext = true; } };
}

describe("which comments run", () => {
  it("ignores a plain reply, a loop keyword and a file command", async () => {
    const { commands, replies, decided } = setup();
    expect(await commands.handle(comment("looks good to me"))).toEqual({ handled: false, reason: "not_a_command" });
    expect(await commands.handle(comment("/rovara quick fix the retry test"))).toEqual({ handled: false, reason: "other_command" });
    expect(await commands.handle(comment("/rovara file 2"))).toEqual({ handled: false, reason: "other_command" });
    expect(replies).toEqual([]);
    expect(decided).toEqual([]);
  });

  it("never runs an edited or deleted comment, or a bot's", async () => {
    const { commands, decided } = setup();
    expect(await commands.handle(comment("/rovara approve", { action: "edited" }))).toEqual({ handled: false, reason: "not_created" });
    expect(await commands.handle(comment("/rovara approve", { action: "deleted" }))).toEqual({ handled: false, reason: "not_created" });
    expect(await commands.handle(comment("/rovara approve", { authorIsBot: true }))).toEqual({ handled: false, reason: "bot" });
    expect(decided).toEqual([]);
  });

  it("does nothing, and says nothing, for an author without write permission", async () => {
    for (const permission of ["none", "read"] as const) {
      const { commands, replies, decided } = setup({ permission });
      expect(await commands.handle(comment("/rovara approve"))).toEqual({ handled: false, reason: "no_permission" });
      expect(replies).toEqual([]);
      expect(decided).toEqual([]);
    }
  });

  it("runs a comment once, however often the host delivers it, and again after a failure that could be retried", async () => {
    const world = setup();
    expect((await world.commands.handle(comment("/rovara approve"))).handled).toBe(true);
    expect(await world.commands.handle(comment("/rovara approve"))).toEqual({ handled: false, reason: "duplicate" });
    expect(world.decided).toHaveLength(1);
    const retry = setup();
    retry.failNext();
    await expect(retry.commands.handle(comment("/rovara approve"))).rejects.toThrow("store unavailable");
    expect((await retry.commands.handle(comment("/rovara approve"))).handled).toBe(true);
    expect(retry.decided).toHaveLength(1);
  });
});

describe("approve and changes", () => {
  it("approves with a code-host-comment proof for exactly the offer, and the approvers seam accepts it", async () => {
    const { commands, decided, replies } = setup();
    const outcome = await commands.handle(comment("/rovara approve"));
    expect(outcome).toEqual({ handled: true, command: "approve", result: { ok: true } });
    expect(decided[0]!.proof).toMatchObject({ method: CODE_HOST_COMMENT_METHOD, token: "c-100", requestId: "card-7", revision: 4, artifactDigest: "sha256-1234", claimedAccount: AUTHOR });
    expect(replies).toEqual(["Approved. I am going ahead."]);
  });

  it("does not approve when the host says the author may not (the approvers' rule, not this module's)", async () => {
    const { commands, replies } = setup({ hostPermission: "read" });
    const outcome = await commands.handle(comment("/rovara approve"));
    expect(outcome).toMatchObject({ handled: true, command: "approve", result: { ok: false } });
    expect(replies[0]).toContain("Not approved");
  });

  it("sends the text of a changes request", async () => {
    const { commands, decided } = setup();
    await commands.handle(comment("/rovara changes: keep the old API too\nand add a test"));
    expect(decided[0]).toMatchObject({ decision: "changes", note: "keep the old API too\nand add a test" });
  });

  it("refuses a comment written before the latest version was posted", async () => {
    const { commands, decided, replies } = setup();
    const outcome = await commands.handle(comment("/rovara approve", { createdAt: "2026-11-09T09:59:59.000Z" }));
    expect(outcome).toMatchObject({ result: { ok: false, reason: "stale" } });
    expect(decided).toEqual([]);
    expect(replies[0]).toContain("before the latest version was posted");
  });

  it("refuses an approval that names another repository", async () => {
    const { commands, decided } = setup();
    expect(await commands.handle(comment("/rovara approve other/place"))).toMatchObject({ result: { ok: false, reason: "refused" } });
    expect((await commands.handle(comment("/rovara approve Example/Repo", { commentId: "c-101" }))).handled).toBe(true);
    expect(decided).toHaveLength(1);
  });

  it("says so when nothing waits", async () => {
    const { commands, replies } = setup({ pending: undefined });
    expect(await commands.handle(comment("/rovara approve"))).toMatchObject({ result: { ok: false, reason: "not_found" } });
    expect(replies).toEqual(["Nothing is waiting for a decision here."]);
  });

  it("explains a command it cannot read", async () => {
    const { commands, replies } = setup();
    expect(await commands.handle(comment("/rovara changes:"))).toMatchObject({ command: "invalid" });
    expect(replies[0]).toContain("Say what to change");
  });
});

describe("lessons and stop", () => {
  it("passes a lesson verdict and a stop to the task flow", async () => {
    const { commands, verdicts, replies } = setup();
    await commands.handle(comment("/rovara lesson 3 wrong", { commentId: "c-1" }));
    await commands.handle(comment("/rovara stop", { commentId: "c-2" }));
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
