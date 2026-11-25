// journey-gate: A1-12
// A1-12: the behaviour journey 15 (Code's own task page, deleted by D1-3 per DEC 254zzz511) covered that OUTLIVES the page, proved on the surfaces that stay, on the real core
// (briefs/arch-cleanup/A1-12-BRIEF.md, A1-11-REVIEW-OPUS.md section 0). Every case asserts what the code does TODAY (file:line in the comments).
//   1. the comment limits of createTaskComment, through POST /v1/dev/tasks/{id}/comments on a core task;
//   2. authenticateSession, the check of every bearer /v1/dev call: the session's end, a revoked session, a revoked person, an admin's end;
// The 30-day review window on /review/link/ is tests/contract/review-window-link.test.ts (the journey world has no channel adapters). The PR-feedback review page is not proved here: it cannot show a core task (404, task-access.ts:64) and
// D1 deletes it (D1-PLAN 2.1 item 6); the link page is the surface that keeps the window.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVELOPER_SESSION_SECONDS } from "@agentx/contracts";
import { createJourneyWorld, MAYA, OMAR, type JourneyWorld } from "./harness/hosted-core.js";
import { bearerRequest, DAY_MS, writeCliSession } from "./harness/surviving.js";
import { planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { vi.useRealTimers(); await world?.close(); world = undefined; });

const comment = (text: string, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), document: "plan", text, ...extra });
const storedComments = (w: JourneyWorld, taskId: string) => w.harness.db.find((row) => row.pk === `DEVTASK#${taskId}` && row.entityType === "TASK_COMMENT");
const WINDOW_MS = 600_000;

describe("A1-12: what journey 15 covered that outlives Code's task page", () => {
  it("comment limits on POST /v1/dev/tasks/{id}/comments: 2,000 characters, nothing empty, thirty comments in ten minutes, twenty replies to a thread", async () => {
    world = await createJourneyWorld();
    const w = world;
    const taskId = await startTask(w);
    await planUntilCard(w, taskId);
    const post = (text: string, extra: Record<string, unknown> = {}) => w.maya("POST", `/v1/dev/tasks/${taskId}/comments`, comment(text, extra));
    const refused = (reply: { status: number; body: Record<string, unknown> }) => ({ status: reply.status, ...(reply.body.error as { code: string; message: string }) });
    // The rate window is a fixed ten-minute bucket (page-comments.ts:224 takeRateAt: floor(now / windowMs)); a run that crossed a bucket edge would reset the count. Start a minute into a bucket.
    vi.useFakeTimers({ toFake: ["Date"] });
    const startOfNextBucket = (Math.floor(Date.now() / WINDOW_MS) + 1) * WINDOW_MS;
    vi.setSystemTime(startOfNextBucket + 60_000);
    const nextWindow = () => vi.setSystemTime((Math.floor(Date.now() / WINDOW_MS) + 1) * WINDOW_MS + 60_000);

    // 2,000 characters is the most; one more is refused in words and stores nothing (cleanCommentText, contracts/task-comments.ts:162-174, called at page-comments.ts:328; the route is core-task-rule-routes.ts:134 -> createCorePlanComment (task-code-routes.ts:139), which calls createTaskComment (task-code-routes.ts:154, page-comments.ts:317)).
    const tooLong = await post("a".repeat(2_001));
    expect(refused(tooLong)).toEqual({ status: 400, code: "CONFIG_INVALID", message: "Keep comments under 2,000 characters." });
    // Nothing (only spaces) is refused too; the text is trimmed first, so 2,000 characters plus spaces around them is still 2,000.
    expect(refused(await post("   \n  "))).toEqual({ status: 400, code: "CONFIG_INVALID", message: "Write something first." });
    expect(storedComments(w, taskId), "a refused comment is stored nowhere").toEqual([]);
    const exact = await post(`  ${"a".repeat(2_000)}  `);
    expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    expect(storedComments(w, taskId), "2,000 characters is accepted").toHaveLength(1);

    // Thirty comments in ten minutes (COMMENT_RATE.comments, contracts/task-comments.ts:17, taken at page-comments.ts:348); the 31st is refused in words until the window passes. Replies count as comments, so the replies of
    // the thread below start in a new window.
    for (let index = 2; index <= 30; index += 1) expect((await post(`Thought ${String(index)}.`)).status, `comment ${String(index)}`).toBe(200);
    expect(storedComments(w, taskId)).toHaveLength(30);
    const slow = await post("One more.");
    expect(refused(slow)).toEqual({ status: 409, code: "TASK_BUSY", message: "You've posted a lot in the last 10 minutes. Try again in a few minutes." });
    expect(storedComments(w, taskId), "the refused 31st is stored nowhere").toHaveLength(30);
    // A resent request (same person, same request ID) is the stored comment, not a second one and not spent against the limit (page-comments.ts:326).
    nextWindow();
    const body = comment("Once.");
    const first = await w.maya("POST", `/v1/dev/tasks/${taskId}/comments`, body);
    const again = await w.maya("POST", `/v1/dev/tasks/${taskId}/comments`, body);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect((again.body.comment as { commentId: string }).commentId).toBe((first.body.comment as { commentId: string }).commentId);
    expect(storedComments(w, taskId), "the resend added nothing").toHaveLength(31);

    // A thread holds twenty replies (COMMENT_THREAD_REPLIES_MAX, contracts/task-comments.ts:13; page-comments.ts:336 and the parent row's replyCount condition in the transaction); the 21st is refused.
    nextWindow();
    const root = (await post("A thread.")).body.comment as { commentId: string };
    for (let reply = 1; reply <= 20; reply += 1) {
      if (reply === 15) nextWindow(); // the root and 14 replies are 15 of this window's 30; the window is not the limit under test
      const answered = await post(`Reply ${String(reply)}.`, { replyTo: root.commentId });
      expect(answered.status, `reply ${String(reply)}: ${JSON.stringify(answered.body)}`).toBe(200);
    }
    const full = await post("Reply 21.", { replyTo: root.commentId });
    expect(refused(full)).toEqual({ status: 400, code: "CONFIG_INVALID", message: "This thread has 20 replies, the most it can hold." });
    expect(storedComments(w, taskId).filter((row) => row.parentId === root.commentId), "twenty replies stored, the 21st nowhere").toHaveLength(20);
    // Who may comment is the route's own access rule (a colleague without the task is told what a missing task is told) and another company's member is refused by that rule (404) before any limit is touched; the test does not show that a second person has a count of their own.
    const stranger = await w.proof.probe(() => w.omar("POST", `/v1/dev/tasks/${taskId}/comments`, comment("Let me in.")));
    expect(stranger.status).toBe(404);
    w.proof.assertAllCore();
  }, 240_000);
  it("authenticateSession on a /v1/dev route: a session works until its end (29 days of a 30-day sign-in, 6 days of the CLI's 7) and not at it; a revoked session, a revoked person and an admin's end are refused", async () => {
    world = await createJourneyWorld();
    const w = world;
    const taskId = await startTask(w);
    await planUntilCard(w, taskId);
    const read = (who: typeof MAYA) => bearerRequest(w, who, "GET", `/v1/dev/tasks/${taskId}/comments`);
    const signInAgain = (reply: { status: number; json(): Record<string, unknown> }) => ({ status: reply.status, ...(reply.json().error as { code: string; message: string }) });
    const SIGN_IN_AGAIN = { status: 401, code: "AUTH_REQUIRED", message: "your AgentX sign-in has ended; run agentx login <url> again" };
    // A session row is just data to authenticateSession; its end is `endsAt` (developer-routes.ts:795: `session.endsAt <= now` ends it). The browser sign-in writes 30 days, the CLI's token
    // sign-in DEVELOPER_SESSION_SECONDS (7 days, contracts/developer.ts:18). The bearer token is minted at each request, so a moved clock does not expire the token itself.
    vi.useFakeTimers({ toFake: ["Date"] });
    const day = (days: number) => Math.floor((Date.now() + days * DAY_MS) / 1000);
    const sessions = [
      { shape: "a 30-day sign-in", person: writeCliSession(w, MAYA, day(30)), lastGoodDay: 29, endDay: 30 },
      { shape: "the CLI's own session", person: writeCliSession(w, MAYA, Math.floor(Date.now() / 1000) + DEVELOPER_SESSION_SECONDS), lastGoodDay: 6, endDay: 7 },
    ];
    const start = Date.now();
    for (const { shape, person, lastGoodDay, endDay } of sessions) {
      vi.setSystemTime(start);
      expect((await read(person)).status, `${shape}: signed in`).toBe(200);
      vi.setSystemTime(start + lastGoodDay * DAY_MS + 23 * 3_600_000);
      expect((await read(person)).status, `${shape}: day ${String(lastGoodDay)} and 23 hours on`).toBe(200);
      vi.setSystemTime(start + endDay * DAY_MS);
      const ended = await w.proof.probe(() => read(person));
      expect(signInAgain(ended), `${shape}: at day ${String(endDay)}`).toEqual(SIGN_IN_AGAIN);
    }
    vi.setSystemTime(start);

    // A revoked session (the token endpoint's revoke, an admin ending it): refused at once, and the same person's other session still works (developer-routes.ts:795 `revokedAt`).
    const revoked = writeCliSession(w, MAYA, day(30), { revokedAt: new Date().toISOString(), revokedReason: "admin" });
    const other = writeCliSession(w, MAYA, day(30));
    expect(signInAgain(await w.proof.probe(() => read(revoked))), "a revoked session").toEqual(SIGN_IN_AGAIN);
    expect((await read(other)).status, "the same person's other session").toBe(200);
    // A session of a person who is not the token's (the session belongs to another registered person): refused (developer-routes.ts:795 `developerId`).
    const borrowed = { ...writeCliSession(w, OMAR, day(30)), developerId: MAYA.developerId };
    expect(signInAgain(await w.proof.probe(() => read(borrowed))), "a session of another person").toEqual(SIGN_IN_AGAIN);
    // A registered client's session never acts as the CLI, whatever token names it (spec 063 FR-003, developer-routes.ts:799).
    const clientSession = writeCliSession(w, MAYA, day(30), { clientId: "tool-app" });
    expect(signInAgain(await w.proof.probe(() => read(clientSession))), "a client's session on the CLI's door").toEqual(SIGN_IN_AGAIN);
    // A person whose registration is revoked is refused whatever their session says (developer-routes.ts:813), and is let back when it is restored.
    const registration = w.harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META")!;
    w.harness.db.set({ ...registration, revoked: true });
    expect(signInAgain(await w.proof.probe(() => read(other))), "a revoked person").toEqual(SIGN_IN_AGAIN);
    w.harness.db.set(registration);
    expect((await read(other)).status, "restored").toBe(200);
    // An admin ending the person's sign-ins ends every session that started before it, and says so (developer-routes.ts:814 endedByAdmin).
    w.harness.db.set({ ...registration, sessionsEndedAt: new Date(Date.now() + 1_000).toISOString() });
    const adminEnded = await w.proof.probe(() => read(other));
    expect({ status: adminEnded.status, message: (adminEnded.json().error as { message: string }).message }, "an admin ended the sign-in").toEqual({ status: 401, message: "an AgentX admin ended your sign-in; run agentx login <url> again" });
    w.harness.db.set(registration);
    w.proof.assertAllCore();
  }, 240_000);
});
