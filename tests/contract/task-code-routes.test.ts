// The deployed API's task messages, pull request diff and plan comments: `/v1/dev/tasks/{id}/messages`, `/diff` and `/comments`.
// The response shapes are written out here by hand as strict schemas (they mirror the web app's contract, version 0), so a
// drifting field fails a test. Every route: same access refusals as the other task routes, the company rule, runtime input checks.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { COMMENT_RATE, WORKFLOW_THREAD_NOTES_MAX } from "@agentx/contracts";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { routeDeveloperTaskRequest } from "../../packages/broker/src/aws/developer-tasks.js";
import { createPlanComment, DIFF_PATCH_MAX_CHARS, DIFF_PATCH_TOO_LONG, listPlanComments, listTaskMessages, MESSAGES_PAGE_MAX, readTaskDiff, sendTaskMessage } from "../../packages/broker/src/developer/task-code-routes.js";
import { expectLinearScalingAsync } from "../support/scaling.js";
import { OMAR, PRIYA, SAM, START, pagePlan, pageTask, type PageTaskFixture } from "../support/page-tasks.js";

// ---- the contract's shapes, by hand
const Author = z.object({ developerId: z.string().min(1), name: z.string().min(1) }).strict();
const Message = z.object({
  messageId: z.string().min(1), kind: z.enum(["comment", "steer"]), author: Author, text: z.string(), at: z.string().datetime(), rev: z.number().int(),
  threadId: z.string().optional(), anchor: z.string().optional(),
}).strict();
const Messages = z.object({ messages: z.array(Message), next: z.string().optional() }).strict();
const Sent = z.object({ message: Message }).strict();
const Diff = z.object({
  repository: z.string(), number: z.number().int(), page: z.number().int(), more: z.boolean(),
  files: z.array(z.object({ path: z.string(), additions: z.number().int(), deletions: z.number().int(), patch: z.string() }).strict()),
}).strict();
const PlanComment = z.object({
  commentId: z.string(), document: z.enum(["requirements", "design", "plan"]), author: Author, text: z.string(), at: z.string().datetime(), rev: z.number().int(), resolved: z.boolean(),
}).strict();
const Comments = z.object({ comments: z.array(PlanComment) }).strict();
const Created = z.object({ comment: PlanComment }).strict();

const OTHER = "org_aaaaaaaaaaaaaaaaaaaa";
const URL_BASE = "https://agentx.invalid";
const STRANGER: DeveloperCaller = { developerId: "9".repeat(64), sessionId: "s-stranger", amr: "slack", name: "Stranger" };
const withPlan = () => { const fixture = pageTask(); fixture.addVersion("plan", pagePlan()); return fixture; };
const at = (fixture: PageTaskFixture, path: string) => new URL(`/v1/dev/tasks/${fixture.taskId}${path}`, URL_BASE);
const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string; pageReason?: string }; }
  throw new Error("expected a refusal");
};

/** The task row, with fields set. */
function patchTask(fixture: PageTaskFixture, fields: Record<string, unknown>): void {
  fixture.db.set({ ...(fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as Record<string, unknown>), ...fields });
}

const PR = { repository: "demo", number: 7, url: "https://github.com/acme/demo/pull/7", state: "open" as const };
function withPullRequests(fixture: PageTaskFixture, read: NonNullable<PageTaskFixture["deps"]["readPullRequestDiff"]> | undefined, prs: unknown[] = [PR]): void {
  Object.assign(fixture.deps, {
    actions: { ...fixture.deps.actions, pullRequests: vi.fn(async () => prs) },
    ...(read === undefined ? {} : { readPullRequestDiff: read }),
  });
}
const goodDiff = async () => ({ files: [{ filename: "src/a.ts", additions: 3, deletions: 1, patch: "@@ -1 +1,3 @@\n-a\n+b\n+c\n+d" }, { filename: "logo.png", additions: 0, deletions: 0 }], more: true });

describe("plan comments", () => {
  it("lists and creates in the contract's shapes", async () => {
    const fixture = withPlan();
    expect(Comments.parse(await listPlanComments(fixture.deps, SAM, fixture.taskId))).toEqual({ comments: [] });
    const created = Created.parse(await createPlanComment(fixture.deps, SAM, fixture.taskId, { requestId: "req-1", document: "plan", text: "Should this be above?", anchor: "claim:2.1" }));
    expect(created.comment).toMatchObject({ document: "plan", text: "Should this be above?", rev: 1, resolved: false, author: { developerId: SAM.developerId, name: "Sam Lee" } });
    const owner = Created.parse(await createPlanComment(fixture.deps, PRIYA, fixture.taskId, { requestId: "req-2", document: "plan", text: "Agreed.", replyTo: created.comment.commentId }));
    expect(owner.comment.author.name).toBe("Priya Shah");
    const listed = Comments.parse(await listPlanComments(fixture.deps, PRIYA, fixture.taskId));
    expect(listed.comments.map((comment) => comment.commentId)).toEqual([created.comment.commentId, owner.comment.commentId]);
    // The same request again is the same comment.
    expect((await createPlanComment(fixture.deps, SAM, fixture.taskId, { requestId: "req-1", document: "plan", text: "Different", anchor: "claim:2.1" })).comment.commentId).toBe(created.comment.commentId);
    expect(Comments.parse(await listPlanComments(fixture.deps, PRIYA, fixture.taskId)).comments).toHaveLength(2);
  });

  it("a deleted comment is not listed and a comment sent with a decision is resolved", async () => {
    const fixture = withPlan();
    const created = await createPlanComment(fixture.deps, SAM, fixture.taskId, { requestId: "r1", document: "plan", text: "First" });
    await createPlanComment(fixture.deps, SAM, fixture.taskId, { requestId: "r2", document: "plan", text: "Second" });
    const key = `COMMENT#${created.comment.commentId}`;
    fixture.db.set({ ...fixture.db.get(`DEVTASK#${fixture.taskId}`, key)!, lockedBy: { requestId: randomUUID(), decision: "REQUEST_CHANGES", at: new Date(START).toISOString() } });
    expect((await listPlanComments(fixture.deps, SAM, fixture.taskId)).comments.map((comment) => comment.resolved)).toEqual([true, false]);
    const second = (await listPlanComments(fixture.deps, SAM, fixture.taskId)).comments[1]!;
    fixture.db.set({ ...fixture.db.get(`DEVTASK#${fixture.taskId}`, `COMMENT#${second.commentId}`)!, deletedAt: new Date(START).toISOString(), text: "" });
    expect((await listPlanComments(fixture.deps, SAM, fixture.taskId)).comments).toHaveLength(1);
  });

  it("refuses a caller who may not see the task, and one who may not comment, as the page does", async () => {
    const fixture = withPlan();
    for (const stranger of [STRANGER, OMAR]) {
      expect((await refusal(listPlanComments(fixture.deps, stranger, fixture.taskId))).code).toMatch(/^TASK_(NOT_FOUND|ACCESS_DENIED)$/);
      expect((await refusal(createPlanComment(fixture.deps, stranger, fixture.taskId, { requestId: "r", document: "plan", text: "hi" }))).code).toMatch(/^TASK_(NOT_FOUND|ACCESS_DENIED)$/);
    }
    expect((await refusal(listPlanComments(fixture.deps, SAM, randomUUID()))).code).toBe("TASK_NOT_FOUND");
    expect((await refusal(listPlanComments(fixture.deps, SAM, "not-an-id"))).code).toBe("TASK_NOT_FOUND");
    fixture.close();
    expect((await refusal(createPlanComment(fixture.deps, SAM, fixture.taskId, { requestId: "r", document: "plan", text: "late" }))).pageReason).toBe("closed");
  });

  it("checks the input at runtime and says nothing of it back", async () => {
    const fixture = withPlan();
    const hostile = "sk-abcdefabcdefabcdefabcdef-<script>";
    for (const bad of [
      null, [], "text", {}, { requestId: "r", document: "plan" }, { requestId: "", document: "plan", text: "x" }, { requestId: "r", document: "other", text: "x" },
      { requestId: "r", document: "plan", text: 5 }, { requestId: "r", document: "plan", text: "x", extra: hostile }, { requestId: "r".repeat(129), document: "plan", text: "x" },
      { requestId: "r", document: "plan", text: "x", replyTo: "not-a-uuid" }, { requestId: "r", document: "plan", text: "x".repeat(16_385) },
      { requestId: "r", document: "plan", text: "x", anchor: hostile }, { requestId: "r", document: "plan", text: "x", anchor: "claim:" }, { requestId: "r", document: "plan", text: "x", anchor: "claim:abc" },
    ]) {
      const error = await refusal(createPlanComment(fixture.deps, SAM, fixture.taskId, bad));
      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.message).not.toContain(hostile);
      expect(error.message).not.toContain("sk-abcdef");
    }
    expect((await refusal(createPlanComment(fixture.deps, SAM, fixture.taskId, { requestId: "r", document: "plan", text: " \u0007 " }))).pageReason).toBe("empty");
    expect((await refusal(createPlanComment(fixture.deps, SAM, fixture.taskId, { requestId: "r", document: "plan", text: "x".repeat(2_001) }))).pageReason).toBe("too_long");
    expect((await refusal(createPlanComment(fixture.deps, SAM, fixture.taskId, { requestId: "r", document: "design", text: "no design yet" }))).pageReason).toBe("not_here");
    expect((await refusal(createPlanComment(fixture.deps, SAM, fixture.taskId, { requestId: "r", document: "plan", text: "x", anchor: "claim:9" }))).pageReason).toBe("not_here");
    expect((await refusal(createPlanComment(fixture.deps, SAM, fixture.taskId, { requestId: "r", document: "plan", text: "x", replyTo: randomUUID() }))).pageReason).toBe("not_here");
  });
});

describe("task messages", () => {
  it("a comment and a steering note list together, oldest first, in the contract's shape", async () => {
    const fixture = withPlan();
    const comment = await sendTaskMessage(fixture.deps, SAM, fixture.taskId, { requestId: "m1", kind: "comment", text: "Looks right", anchor: "claim:2.1" });
    fixture.advance(1_000);
    const steer = await sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "m2", kind: "steer", text: "Use the retry helper" });
    fixture.advance(1_000);
    const reply = await sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "m3", kind: "comment", text: "Thanks", threadId: comment.message.messageId });
    for (const sent of [comment, steer, reply]) Sent.parse(sent);
    expect(comment.message).toMatchObject({ kind: "comment", anchor: "claim:2.1", rev: 1, author: { developerId: SAM.developerId, name: "Sam Lee" } });
    expect(comment.message.threadId).toBeUndefined();
    expect(steer.message).toMatchObject({ kind: "steer", rev: 1, text: "Use the retry helper", author: { developerId: PRIYA.developerId, name: "Priya Shah" } });
    expect(reply.message).toMatchObject({ kind: "comment", threadId: comment.message.messageId });
    const listed = Messages.parse(await listTaskMessages(fixture.deps, SAM, fixture.taskId, at(fixture, "/messages")));
    expect(listed.messages.map((message) => message.messageId)).toEqual([comment.message.messageId, steer.message.messageId, reply.message.messageId]);
    expect(listed.next).toBeUndefined();
  });

  it("pages with a cursor and a bounded limit, with no gap or repeat", async () => {
    const fixture = withPlan();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      fixture.advance(index % 2 === 0 ? 0 : 1_000); // some share a time
      const sent = await sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: `p${index}`, kind: "steer", text: `note ${index}` });
      ids.push(sent.message.messageId);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = Messages.parse(await listTaskMessages(fixture.deps, SAM, fixture.taskId, at(fixture, `/messages?limit=2${cursor === undefined ? "" : `&cursor=${cursor}`}`)));
      expect(page.messages.length).toBeLessThanOrEqual(2);
      seen.push(...page.messages.map((message) => message.messageId));
      cursor = page.next;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
    // The last page has no marker; a full read is one page.
    expect((await listTaskMessages(fixture.deps, SAM, fixture.taskId, at(fixture, "/messages?limit=5"))).next).toBeUndefined();
  });

  it("refuses a limit or a marker that is not valid, in fixed words", async () => {
    const fixture = withPlan();
    for (const query of ["limit=0", `limit=${MESSAGES_PAGE_MAX + 1}`, "limit=abc", "limit=-1", "limit=1.5", "limit=", "cursor=!!!", `cursor=${"a".repeat(201)}`, `cursor=${Buffer.from("{\"at\":1}").toString("base64url")}`, `cursor=${Buffer.from("not json").toString("base64url")}`]) {
      const error = await refusal(listTaskMessages(fixture.deps, SAM, fixture.taskId, at(fixture, `/messages?${query}`)));
      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.message).not.toContain("abc");
    }
    await expect(listTaskMessages(fixture.deps, SAM, fixture.taskId, at(fixture, `/messages?limit=${MESSAGES_PAGE_MAX}`))).resolves.toMatchObject({ messages: [] });
  });

  it("refuses a caller who may not see the task", async () => {
    const fixture = withPlan();
    for (const stranger of [STRANGER, OMAR]) {
      expect((await refusal(listTaskMessages(fixture.deps, stranger, fixture.taskId, at(fixture, "/messages")))).code).toMatch(/^TASK_(NOT_FOUND|ACCESS_DENIED)$/);
      for (const kind of ["comment", "steer"] as const) {
        expect((await refusal(sendTaskMessage(fixture.deps, stranger, fixture.taskId, { requestId: "x", kind, text: "hello" }))).code).toMatch(/^TASK_(NOT_FOUND|ACCESS_DENIED)$/);
      }
    }
    expect(fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")).not.toHaveProperty("threadNoteCount");
  });

  it("only the owner steers; a teammate who may comment gets the same answer as a missing task", async () => {
    const fixture = withPlan();
    const missing = await refusal(sendTaskMessage(fixture.deps, SAM, randomUUID(), { requestId: "s", kind: "steer", text: "go left" }));
    const teammate = await refusal(sendTaskMessage(fixture.deps, SAM, fixture.taskId, { requestId: "s", kind: "steer", text: "go left" }));
    expect([teammate.code, teammate.message]).toEqual([missing.code, missing.message]);
    expect(Object.keys(fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")!)).not.toContain("threadNoteCount");
    // The owner is the only one whose steering note is saved.
    await sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "s", kind: "steer", text: "go left" });
    expect(fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")).toMatchObject({ threadNoteCount: 1 });
  });

  it("a steering note is the task flow's own note item, counted once, and a resent request is the same note", async () => {
    const fixture = withPlan();
    const first = await sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "same", kind: "steer", text: "Use the helper. password=hunter2hunter2" });
    const again = await sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "same", kind: "steer", text: "Something else" });
    expect(again.message).toEqual(first.message);
    expect(first.message.text).not.toContain("hunter2hunter2");
    const stored = fixture.db.get(`DEVTASK#${fixture.taskId}`, `NOTE#${first.message.messageId}`)!;
    expect(stored).toMatchObject({ entityType: "WORKFLOW_THREAD_NOTE", source: "app", developerId: PRIYA.developerId, isOwner: true, taskId: fixture.taskId, messageId: first.message.messageId });
    expect(stored["indexExpiresAt"]).toEqual(expect.any(Number));
    expect(fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")).toMatchObject({ threadNoteCount: 1 });
    // Another person's request ID is their own request, and nobody can write over this note.
    expect(first.message.messageId).toMatch(/^msg_[0-9a-f]{20}$/);
  });

  it("stamps a note after the mark a step has taken notes through", async () => {
    const fixture = withPlan();
    const mark = new Date(START + 60_000).toISOString();
    patchTask(fixture, { threadNotesFedThrough: mark });
    const sent = await sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "late", kind: "steer", text: "after the mark" });
    expect(sent.message.at > mark).toBe(true);
  });

  it("refuses a steering note on a closed task, a task with no workflow, a full task, and too fast", async () => {
    const closed = withPlan();
    closed.close();
    expect((await refusal(sendTaskMessage(closed.deps, PRIYA, closed.taskId, { requestId: "c", kind: "steer", text: "x" }))).code).toBe("TASK_NOT_FOUND");
    const plain = withPlan();
    const row = { ...(plain.db.get(`DEVTASK#${plain.taskId}`, "META") as Record<string, unknown>) };
    delete row["workflow"];
    plain.db.set(row);
    expect((await refusal(sendTaskMessage(plain.deps, PRIYA, plain.taskId, { requestId: "p", kind: "steer", text: "x" }))).message).toContain("owner's next request");
    const full = withPlan();
    patchTask(full, { threadNoteCount: WORKFLOW_THREAD_NOTES_MAX });
    // A refusal costs the caller none of their rate: past the limit it is still the same refusal.
    for (let index = 0; index <= COMMENT_RATE.comments + 1; index += 1) {
      expect((await refusal(sendTaskMessage(full.deps, PRIYA, full.taskId, { requestId: `f${index}`, kind: "steer", text: "x" }))).message).toContain("holds all the messages");
    }
    const fast = withPlan();
    for (let index = 0; index < COMMENT_RATE.comments; index += 1) await sendTaskMessage(fast.deps, PRIYA, fast.taskId, { requestId: `r${index}`, kind: "steer", text: `n${index}` });
    expect((await refusal(sendTaskMessage(fast.deps, PRIYA, fast.taskId, { requestId: "r-over", kind: "steer", text: "n" }))).pageReason).toBe("slow_down");
    fast.advance(COMMENT_RATE.windowMs);
    await expect(sendTaskMessage(fast.deps, PRIYA, fast.taskId, { requestId: "r-later", kind: "steer", text: "n" })).resolves.toBeDefined();
  });

  it("checks the input at runtime and says nothing of it back", async () => {
    const fixture = withPlan();
    const hostile = "sk-abcdefabcdefabcdefabcdef";
    for (const bad of [
      null, [], "x", {}, { kind: "steer", text: "x" }, { requestId: "r", text: "x" }, { requestId: "r", kind: "shout", text: "x" }, { requestId: "r", kind: "steer", text: 1 },
      { requestId: "r", kind: "steer", text: "x", extra: hostile }, { requestId: "r", kind: "steer", text: "x", threadId: randomUUID() }, { requestId: "r", kind: "steer", text: "x", anchor: "claim:1" },
      { requestId: "r", kind: "comment", text: "x", threadId: hostile }, { requestId: "r", kind: "comment", text: "x", anchor: hostile }, { requestId: "r", kind: "steer", text: "x".repeat(16_385) },
    ]) {
      const error = await refusal(sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, bad));
      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.message).not.toContain(hostile);
    }
    expect((await refusal(sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "r", kind: "steer", text: "  " }))).pageReason).toBe("empty");
    expect((await refusal(sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "r", kind: "steer", text: "x".repeat(2_001) }))).pageReason).toBe("too_long");
    expect(fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")).not.toHaveProperty("threadNoteCount");
  });
});

describe("the pull request diff", () => {
  it("answers one page in the contract's shape", async () => {
    const fixture = withPlan();
    const read = vi.fn(goodDiff);
    withPullRequests(fixture, read);
    const diff = Diff.parse(await readTaskDiff(fixture.deps, SAM, fixture.taskId, at(fixture, "/diff?repository=demo&number=7&page=2")));
    expect(diff).toEqual({
      repository: "demo", number: 7, page: 2, more: true,
      files: [{ path: "src/a.ts", additions: 3, deletions: 1, patch: "@@ -1 +1,3 @@\n-a\n+b\n+c\n+d" }, { path: "logo.png", additions: 0, deletions: 0, patch: "" }],
    });
    expect(read).toHaveBeenCalledWith("https://github.com/acme/demo", 7, 2);
    // The page defaults to the first.
    await readTaskDiff(fixture.deps, SAM, fixture.taskId, at(fixture, "/diff?repository=demo&number=7"));
    expect(read).toHaveBeenLastCalledWith("https://github.com/acme/demo", 7, 1);
  });

  it("reads only a pull request this task opened", async () => {
    const fixture = withPlan();
    const read = vi.fn(goodDiff);
    withPullRequests(fixture, read);
    for (const query of ["repository=demo&number=8", "repository=other&number=7"]) {
      expect((await refusal(readTaskDiff(fixture.deps, SAM, fixture.taskId, at(fixture, `/diff?${query}`)))).code).toBe("NOT_FOUND");
    }
    expect(read).not.toHaveBeenCalled();
    // A stored URL that is not a GitHub pull request page for that number is never fetched.
    for (const url of ["https://evil.example/acme/demo/pull/7", "https://github.com/acme/demo/pull/8", "http://github.com/acme/demo/pull/7", "https://github.com/acme/demo/pull/7/files", "https://github.com/../demo/pull/7", "https://github.com/acme/../pull/7", "https://github.com/./demo/pull/7"]) {
      withPullRequests(fixture, read, [{ ...PR, url }]);
      expect((await refusal(readTaskDiff(fixture.deps, SAM, fixture.taskId, at(fixture, "/diff?repository=demo&number=7")))).code).toBe("RUNTIME_UNAVAILABLE");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("checks the query at runtime, and refuses a caller who may not see the task", async () => {
    const fixture = withPlan();
    const read = vi.fn(goodDiff);
    withPullRequests(fixture, read);
    for (const query of ["", "repository=demo", "number=7", "repository=Demo&number=7", "repository=demo&number=0", "repository=demo&number=-1", "repository=demo&number=1.5", "repository=demo&number=99999999999",
      "repository=demo&number=7&page=0", "repository=demo&number=7&page=101", "repository=demo&number=7&page=x", "repository=demo&number=7&page=", `repository=${"a".repeat(64)}&number=7`]) {
      const error = await refusal(readTaskDiff(fixture.deps, SAM, fixture.taskId, at(fixture, `/diff?${query}`)));
      expect(error.code).toBe("CONFIG_INVALID");
    }
    for (const stranger of [STRANGER, OMAR]) {
      expect((await refusal(readTaskDiff(fixture.deps, stranger, fixture.taskId, at(fixture, "/diff?repository=demo&number=7")))).code).toMatch(/^TASK_(NOT_FOUND|ACCESS_DENIED)$/);
    }
    expect((await refusal(readTaskDiff(fixture.deps, SAM, randomUUID(), at(fixture, "/diff?repository=demo&number=7")))).code).toBe("TASK_NOT_FOUND");
    expect(read).not.toHaveBeenCalled();
  });

  it("is unavailable, not guessed, when GitHub cannot be read, answers oddly, or the reader is not set up", async () => {
    const fixture = withPlan();
    withPullRequests(fixture, undefined);
    const error = await refusal(readTaskDiff(fixture.deps, SAM, fixture.taskId, at(fixture, "/diff?repository=demo&number=7")));
    expect(error.code).toBe("RUNTIME_UNAVAILABLE");
    const secret = ["gh", "s_"].join("") + "q7".repeat(18); // built at run time, so no token-shaped text sits in the file
    for (const read of [
      async () => { throw new Error(`GitHub said ${secret}`); },
      async () => ({ files: "nope", more: false }),
      async () => ({ files: [{ filename: "", additions: 1, deletions: 1 }], more: false }),
      async () => ({ files: [{ filename: "a", additions: -1, deletions: 1 }], more: false }),
      async () => ({ files: Array.from({ length: 31 }, (_, index) => ({ filename: `f${index}`, additions: 1, deletions: 1 })), more: false }),
      async () => ({ files: [], more: "yes" }),
      async () => null,
    ]) {
      withPullRequests(fixture, read as never);
      const refused = await refusal(readTaskDiff(fixture.deps, SAM, fixture.taskId, at(fixture, "/diff?repository=demo&number=7")));
      expect(refused.code).toBe("RUNTIME_UNAVAILABLE");
      expect(refused.message).not.toContain(secret);
    }
  });

  it("bounds a page: 30 files, and a patch that is too long is said to be, never cut", async () => {
    const fixture = withPlan();
    const readDiff = (from: PageTaskFixture) => readTaskDiff(from.deps, SAM, from.taskId, at(from, "/diff?repository=demo&number=7"));
    // The work does not grow with the length of a too-long patch: it is refused by its length, never read.
    // The 15 long patches share one string, so one unit of n is one byte. N stays above the patch limit (30,000) and 8N at 256 KiB so it stays in CPU cache; the full 2,000,000-character patch is read once below.
    const diffs = new Map<number, Awaited<ReturnType<typeof readDiff>>>();
    const sizedFixture = (length: number) => {
      const sized = withPlan();
      const huge = "+".repeat(length);
      withPullRequests(sized, async () => ({
        files: Array.from({ length: 30 }, (_, index) => ({ filename: `src/f${index}.ts`, additions: 5, deletions: 0, patch: index % 2 === 0 ? huge : "+small" })), more: true,
      }));
      return sized;
    };
    await expectLinearScalingAsync((length) => {
      const sized = sizedFixture(length);
      return async () => { diffs.set(length, await readDiff(sized)); };
    }, { n: 32_768, label: "task diff: too-long patches" });
    const diff = diffs.get(32_768)!;
    expect(diffs.get(262_144)).toEqual(diff);
    expect(await readDiff(sizedFixture(2_000_000))).toEqual(diff);
    expect(diff.files).toHaveLength(30);
    expect(diff.files.filter((file) => file.patch === DIFF_PATCH_TOO_LONG)).toHaveLength(15);
    expect(JSON.stringify(diff).length).toBeLessThan(30 * DIFF_PATCH_MAX_CHARS + 10_000);
    // A patch exactly at the limit is shown whole.
    withPullRequests(fixture, async () => ({ files: [{ filename: "a", additions: 1, deletions: 0, patch: "+".repeat(DIFF_PATCH_MAX_CHARS) }], more: false }));
    expect((await readTaskDiff(fixture.deps, SAM, fixture.taskId, at(fixture, "/diff?repository=demo&number=7"))).files[0]!.patch).toHaveLength(DIFF_PATCH_MAX_CHARS);
  });
});

describe("the company rule", () => {
  const routes = (fixture: PageTaskFixture, caller: DeveloperCaller) => [
    () => listTaskMessages(fixture.deps, caller, fixture.taskId, at(fixture, "/messages")),
    () => sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "k", kind: "steer", text: "hello" }),
    () => sendTaskMessage(fixture.deps, caller, fixture.taskId, { requestId: "k", kind: "comment", text: "hello" }),
    () => readTaskDiff(fixture.deps, caller, fixture.taskId, at(fixture, "/diff?repository=demo&number=7")),
    () => listPlanComments(fixture.deps, caller, fixture.taskId),
    () => createPlanComment(fixture.deps, caller, fixture.taskId, { requestId: "k", document: "plan", text: "hello" }),
  ];

  it("a task of another company reads as a missing task on every route, even to its own owner", async () => {
    for (const owned of [{ companyId: OTHER }, { orgId: OTHER }]) {
      const fixture = withPlan();
      withPullRequests(fixture, vi.fn(goodDiff));
      patchTask(fixture, owned);
      const gone = await refusal(listTaskMessages(fixture.deps, PRIYA, randomUUID(), at(fixture, "/messages")));
      for (const call of routes(fixture, PRIYA)) {
        const error = await refusal(call());
        expect([error.code, error.message]).toEqual([gone.code, gone.message]);
        expect(error.message).not.toContain(OTHER);
      }
      expect(fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")).not.toHaveProperty("threadNoteCount");
      expect(fixture.db.get(`DEVTASK#${fixture.taskId}`, "COMMENTS")).toBeUndefined();
    }
  });

  it("a task of this company is served, and a task that names none belongs to the implicit company only", async () => {
    const own = withPlan();
    own.deps.companyId = OTHER;
    patchTask(own, { companyId: OTHER });
    await expect(listPlanComments(own.deps, SAM, own.taskId)).resolves.toEqual({ comments: [] });
    // No company on the row: the implicit company's, so a call for another company does not see it.
    const old = withPlan();
    await expect(listPlanComments(old.deps, SAM, old.taskId)).resolves.toBeDefined();
    old.deps.companyId = "org_00000000000000000000";
    await expect(listPlanComments(old.deps, SAM, old.taskId)).resolves.toBeDefined();
    old.deps.companyId = OTHER;
    expect((await refusal(listPlanComments(old.deps, SAM, old.taskId))).code).toBe("TASK_NOT_FOUND");
    expect((await refusal(listTaskMessages(old.deps, SAM, old.taskId, at(old, "/messages")))).code).toBe("TASK_NOT_FOUND");
    // A stored company that is not an organisation id is never read as the implicit one.
    for (const bad of ["acme", "", 7, null, {}]) {
      const odd = withPlan();
      patchTask(odd, { companyId: bad });
      expect((await refusal(listPlanComments(odd.deps, SAM, odd.taskId))).code).toBe("TASK_NOT_FOUND");
    }
  });

  it("a note row that names another company is left out of the list", async () => {
    const fixture = withPlan();
    const mine = await sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "mine", kind: "steer", text: "mine" });
    const stored = fixture.db.get(`DEVTASK#${fixture.taskId}`, `NOTE#${mine.message.messageId}`)!;
    fixture.db.set({ ...stored, sk: "NOTE#msg_aaaaaaaaaaaaaaaaaaaa", messageId: "msg_aaaaaaaaaaaaaaaaaaaa", orgId: OTHER, text: "theirs" });
    const listed = await listTaskMessages(fixture.deps, SAM, fixture.taskId, at(fixture, "/messages"));
    expect(listed.messages.map((message) => message.text)).toEqual(["mine"]);
    // A row that names this company is read (the company field is checked, then set aside).
    fixture.db.set({ ...stored, sk: "NOTE#msg_bbbbbbbbbbbbbbbbbbbb", messageId: "msg_bbbbbbbbbbbbbbbbbbbb", companyId: "org_00000000000000000000", text: "ours" });
    expect((await listTaskMessages(fixture.deps, SAM, fixture.taskId, at(fixture, "/messages"))).messages.map((message) => message.text).sort()).toEqual(["mine", "ours"]);
    // A resent request whose stored note names another company is not answered with that note.
    fixture.db.set({ ...stored, orgId: OTHER });
    expect((await refusal(sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "mine", kind: "steer", text: "mine" }))).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("a task of a real company keeps its own steering notes: listed, and a resent request is the same note", async () => {
    const fixture = withPlan();
    fixture.deps.companyId = OTHER;
    patchTask(fixture, { companyId: OTHER });
    const sent = await sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "c1", kind: "steer", text: "in company" });
    expect((await sendTaskMessage(fixture.deps, PRIYA, fixture.taskId, { requestId: "c1", kind: "steer", text: "again" })).message).toEqual(sent.message);
    expect((await listTaskMessages(fixture.deps, SAM, fixture.taskId, at(fixture, "/messages"))).messages.map((message) => message.text)).toEqual(["in company"]);
    expect(fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")).toMatchObject({ threadNoteCount: 1 });
  });

  it("a task of another company answers a reader on its workspace who is not in its channel exactly as a missing task does", async () => {
    const fixture = withPlan();
    const before = await refusal(listTaskMessages(fixture.deps, OMAR, fixture.taskId, at(fixture, "/messages")));
    expect(before.code).toBe("TASK_ACCESS_DENIED");
    patchTask(fixture, { companyId: OTHER });
    const gone = await refusal(listTaskMessages(fixture.deps, OMAR, randomUUID(), at(fixture, "/messages")));
    for (const call of routes(fixture, OMAR)) {
      const error = await refusal(call());
      expect([error.code, error.message]).toEqual([gone.code, gone.message]);
      expect(error).not.toHaveProperty("owners");
    }
  });
});

describe("the routes on the task router", () => {
  const call = (fixture: PageTaskFixture, caller: DeveloperCaller, method: string, path: string, body?: unknown) => routeDeveloperTaskRequest(
    fixture.deps, caller, { method, path, headers: {}, requestId: randomUUID(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(path, URL_BASE),
  );

  it("serves all five, and refuses other methods", async () => {
    const fixture = withPlan();
    withPullRequests(fixture, goodDiff);
    const base = `/v1/dev/tasks/${fixture.taskId}`;
    Comments.parse(await call(fixture, SAM, "GET", `${base}/comments`));
    Created.parse(await call(fixture, SAM, "POST", `${base}/comments`, { requestId: "a", document: "plan", text: "hello" }));
    Sent.parse(await call(fixture, PRIYA, "POST", `${base}/messages`, { requestId: "b", kind: "steer", text: "hello" }));
    expect(Messages.parse(await call(fixture, SAM, "GET", `${base}/messages?limit=10`)).messages).toHaveLength(2);
    Diff.parse(await call(fixture, SAM, "GET", `${base}/diff?repository=demo&number=7&page=1`));
    for (const [method, path] of [["PUT", "messages"], ["DELETE", "messages"], ["POST", "diff"], ["PUT", "comments"], ["GET", "messages/extra"]] as const) {
      expect((await refusal(call(fixture, SAM, method, `${base}/${path}`))).code).toBe("NOT_FOUND");
    }
    expect((await refusal(call(fixture, SAM, "POST", `${base}/messages`, undefined))).code).toBe("CONFIG_INVALID");
  });
});
