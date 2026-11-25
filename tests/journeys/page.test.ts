// journey-gate: 15
// Journey 15 "the page" (D1-PLAN 5.3 G-E): the task page and its JSON API for a CORE task, on the real core. A core task's page is served by the broker's /review routes
// (aws/task-web.ts, aws/task-web-api.ts) over the task's stored record; the person is a browser with a review session cookie. Every case asserts what the page does TODAY (file:line in the
// comments); a behaviour the page does not support is a finding in A1-11-DONE.md, never a skipped test. This replaces tests/integration/workflow-e2e/10-page-auth.test.ts's behaviours that
// reach the page for a core task (the old suite drives Slack-started tasks on the old engine).
// DELETED WITH CODE'S TASK PAGE (DEC 254zzz511): every case here drives Code's own /review/{id}/task page and its JSON API, which D1-3 deletes; this file goes with it (D1-3 also takes "15" off
// journey-gate.test.ts JOURNEYS and this file's row off tests/pinned-tests.json). It does not gate D1. The behaviours under it that outlive the page (the comment store's limits behind POST /v1/dev/tasks/{id}/comments,
// the session checks of authenticateSession, a removed member on the core routes) need their proof on those surfaces before D1-3 (the comment limits have none outside this file and the old 10-page-auth).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJourneyWorld, MAYA, OMAR, type JourneyWorld } from "./harness/hosted-core.js";
import { DAY_SECONDS, PAGE_ORIGIN, pageReader, pageRequest, removeFromCompany, storedComments, words, writeReviewSession } from "./harness/page.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { planUntilCard, startTask } from "./harness/task.js";
import type { Developer } from "../support/developer-task-broker.js";

let world: JourneyWorld | undefined;
afterEach(async () => { vi.useRealTimers(); await world?.close(); world = undefined; });

const NO_ACCESS = "You don't have access to this task.";
// The colleague of journey 5 (hosted-core.ts): a second member of the owner's company with the project grant, who is not the task's owner.
const PRIYA: Developer = { developerId: "9".repeat(64), name: "Priya Rao", provider: "slack", sessionId: "s-priya", slackUserId: "U0PRIYA001" };
/** Another company's member, signed in with Slack (the fixture's Omar signs in with company sign-in, which the page answers with a sign-in redirect). */
const OMAR_SLACK: Developer = { ...OMAR, provider: "slack", slackUserId: "U0OMAR0001" };

/** A task whose plan waits for its owner, and Maya's browser on its page. */
async function waitingPlan() {
  world = await createJourneyWorld({ page: true });
  const taskId = await startTask(world);
  await planUntilCard(world, taskId);
  const maya = pageReader(world, taskId, writeReviewSession(world, MAYA));
  expect((await maya.read("state")).status).toBe(200);
  return { taskId, maya, world };
}
const commentBody = (text: string, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), document: "plan", version: 1, target: { kind: "document" }, text, ask: false, ...extra });
const workflowRevisionOf = (w: JourneyWorld, taskId: string) => (w.taskRow(taskId)!.workflow as unknown as { revision: number }).revision;
const returnTo = (location: string | undefined) => new URL(location ?? "", PAGE_ORIGIN).searchParams.get("return_to");

describe("journey 15: the task page for a core task", () => {
  it("sign-in: signed out is sent to sign in with the document kept; a review sign-in works 29 days later and ends at 30; a revoked sign-in is refused on the page and in an open page's request", async () => {
    const { taskId, maya, world: w } = await waitingPlan();
    // Signed out: the page redirects (task-web.ts:576-581) and shows nothing of the task; only a known document and an earlier version survive sign-in (signInQuery, task-web.ts:201).
    const signedOut = await pageRequest(w, "GET", `/review/${taskId}/task?doc=coding-plan&from=1`);
    expect(signedOut.status).toBe(302);
    expect(returnTo(signedOut.headers.location)).toBe(`/review/${taskId}/task?doc=coding-plan&from=1`);
    expect(signedOut.text).not.toContain("health");
    expect(returnTo((await pageRequest(w, "GET", `/review/${taskId}/task?doc=evil&from=abc`)).headers.location), "an unknown document and a bad version are dropped").toBe(`/review/${taskId}/task`);
    // The page's own API answers a signed-out caller 401, not a redirect (task-web-api.ts:193); so does the "moved on" check (task-web.ts:549).
    expect(await pageRequest(w, "GET", `/review/${taskId}/task/api/state`).then((reply) => [reply.status, reply.json()])).toEqual([401, { error: "sign_in_required" }]);
    expect(await pageRequest(w, "GET", `/review/${taskId}/task/status`).then((reply) => [reply.status, reply.json()])).toEqual([401, { error: "Sign in again." }]);
    expect((await pageRequest(w, "GET", `/review/${taskId}/task`, { sessionId: "not-a-session" })).status, "a cookie that is no session id is signed out").toBe(302);
    // Signed in: the page, private and unframed.
    const page = await maya.open("?doc=coding-plan");
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(words(page.text)).toContain("You're the task owner.");
    // 29 days on the session still works; at 30 days the page asks to sign in again and the open page's requests are refused (developer-routes.ts:827-833; the review window is fixed at 30 days).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 29 * DAY_SECONDS * 1000);
    expect((await maya.open("?doc=coding-plan")).status).toBe(200);
    expect((await maya.read("state")).status).toBe(200);
    vi.setSystemTime(Date.now() + DAY_SECONDS * 1000);
    const ended = await maya.open("?doc=coding-plan");
    expect(ended.status).toBe(302);
    expect(ended.headers.location).toBe(`/v1/auth/browser/authorize?return_to=${encodeURIComponent(`/review/${taskId}/task?doc=coding-plan`)}`);
    expect((await maya.read("state")).status).toBe(401);
    expect((await maya.post("comments", commentBody("Too late."))).status, "an open page's request after the sign-in ended").toBe(401);
    vi.useRealTimers();
    // A page open when its sign-in is revoked (an admin ends it): the next request is refused and nothing is stored.
    const open = pageReader(w, taskId, writeReviewSession(w, MAYA));
    await open.read("state");
    expect((await open.post("comments", commentBody("Before the revoke."))).status).toBe(201);
    const row = w.harness.db.get(`SESSION#${open.sessionId}`, "META")!;
    w.harness.db.set({ ...row, revokedAt: new Date().toISOString(), revokedReason: "admin" });
    expect(await open.post("comments", commentBody("After the revoke.")).then((reply) => [reply.status, reply.json()])).toEqual([401, { error: "sign_in_required" }]);
    expect((await open.open()).status).toBe(302);
    expect(storedComments(w, taskId).map((comment) => comment.text), "only the comment made while signed in is stored").toEqual(["Before the revoke."]);
    // A person whose registration is revoked is signed out whatever their session says.
    const developer = w.harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META")!;
    const fresh = pageReader(w, taskId, writeReviewSession(w, MAYA));
    w.harness.db.set({ ...developer, revoked: true });
    expect((await fresh.open()).status).toBe(302);
    expect((await fresh.read("state")).status).toBe(401);
    w.harness.db.set(developer);
    w.proof.assertAllCore();
  }, 180_000);

  it("who sees what: the owner reads, comments and decides; a colleague, a shared reader and another company's member are told what a missing task is told; a removed member is refused (G1)", async () => {
    const { taskId, maya, world: w } = await waitingPlan();
    // The owner: task-access.ts:106 (the task's developer is the caller), pageAccess (developer-tasks.ts:3295).
    const page = await maya.open("?doc=coding-plan");
    expect(words(page.text)).toContain("You're the task owner.");
    const state = (await maya.read("state")).json();
    expect(state).toMatchObject({ canRead: true, canComment: true, canDecide: true, canSuggest: false, canAsk: false, canManagePeople: false, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 1 }] });
    expect(await pageRequest(w, "GET", `/review/${taskId}/task/status`, { sessionId: maya.sessionId }).then((reply) => reply.json())).toMatchObject({ stage: "Coding plan", revision: workflowRevisionOf(w, taskId) });
    // An owner cannot suggest ("Owners answer decisions themselves; suggestions are for teammates.").
    expect(await maya.post("suggestions", { document: "plan", decisionId: "d1", optionId: "three" }).then((reply) => [reply.status, reply.json()]))
      .toEqual([403, { error: "not_allowed", message: "Owners answer decisions themselves; suggestions are for teammates." }]);
    // FINDING (pinned to today): the page offers the owner "decide" (canDecide is true) but its decision API answers 404 "no access" for a core task: the task stays at its plan review. The decision
    // is taken on the web app's card (journey 1) or in the chat thread. decideOnPage reads the task through the old workflow's access (developer-tasks.ts, task-access.ts:64 "a task the core owns reads as not found").
    const workflow = w.taskRow(taskId)!.workflow as unknown as { revision: number; artifacts: Array<{ sha256: string }> };
    const decided = await maya.post("decision", { requestId: randomUUID(), expectedRevision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256, decision: "APPROVE", answers: [], includedCommentIds: [] });
    expect([decided.status, decided.json().error]).toEqual([404, "not_found"]);
    expect(w.taskRow(taskId)!.workflow, "nothing was decided").toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", revision: workflow.revision });

    const missingId = randomUUID();
    const missing = await pageRequest(w, "GET", `/review/${missingId}/task`, { sessionId: writeReviewSession(w, PRIYA) });
    expect(missing.status).toBe(404);
    const refusals = async (who: Developer, label: string) => {
      const reader = pageReader(w, taskId, writeReviewSession(w, who));
      const answers = {
        page: await reader.open(), state: await reader.read("state"), comments: await reader.read("comments"),
        status: await pageRequest(w, "GET", `/review/${taskId}/task/status`, { sessionId: reader.sessionId }),
        // The person has no CSRF cookie (the page gave none), so a request that gets past the CSRF check carries a token of their own making: still a missing task's answer.
        comment: await reader.post("comments", commentBody("Let me in."), { csrfHeader: "c".repeat(43), cookieCsrf: "c".repeat(43) }),
        decision: await reader.post("decision", { requestId: randomUUID(), expectedRevision: 1, artifactDigest: "a".repeat(64), decision: "APPROVE", answers: [], includedCommentIds: [] }, { csrfHeader: "c".repeat(43), cookieCsrf: "c".repeat(43) }),
      };
      expect([answers.page.status, answers.state.status, answers.comments.status, answers.status.status, answers.comment.status, answers.decision.status], label).toEqual([404, 404, 404, 404, 404, 404]);
      expect(words(answers.page.text), label).toBe(words(missing.text));
      expect(answers.state.json(), label).toEqual({ error: "not_found", message: NO_ACCESS });
      expect(answers.page.text, "the page says nothing of the task").not.toContain("health");
    };
    // A colleague: same company, the project grant, not the task's owner and not shared the task (task-access.ts:109-120: no Slack share, so "not found").
    await refusals(PRIYA, "a colleague");
    // A shared reader: the owner shares the task read-only; the dev API now reads it for her (spec 067) ...
    const shared = await w.maya("PUT", `/v1/dev/tasks/${taskId}/readers/${PRIYA.developerId}`, { requestId: randomUUID(), role: "viewer" });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect((await w.priya("GET", `/v1/dev/tasks/${taskId}`)).status).toBe(200);
    // ... but FINDING (pinned to today): the task PAGE does not know readers (the page's access rule, task-access.ts:84-124, takes the owner, a People role or a Slack channel member): she is told
    // what a missing task is told, and so is every request of the page's API.
    await refusals(PRIYA, "a shared reader");
    // Another company's member (signed in with Slack): the same.
    await refusals(OMAR_SLACK, "another company's member");
    expect(storedComments(w, taskId), "no refused request stored anything").toEqual([]);

    // G1: a person removed from the company with a still valid plain-Slack review session. The owner's own page and API, open before the removal: the page is "no access" (a missing task's words)
    // for her own task, and her page's comment is refused and stored nowhere. FINDING (pinned to today): the page's JSON API (state, comments) answers 503 "couldn't do that right now", not the 404
    // the page gives (the removed person's live company cannot be read, commentPageRouteDependencies, developer-routes.ts:2001, so the refusal is not a hidden-task code).
    removeFromCompany(w, MAYA);
    const removedPage = await maya.open("?doc=coding-plan");
    expect([removedPage.status, words(removedPage.text)]).toEqual([404, words(missing.text)]);
    expect((await maya.read("state")).status, "the open page's state poll answers like the comment API").toBe(503);
    const removedComment = await maya.post("comments", commentBody("I was removed."));
    expect([removedComment.status, removedComment.json().error]).toEqual([503, "unavailable"]);
    expect(storedComments(w, taskId), "the removed person's comment is stored nowhere").toEqual([]);
    w.proof.assertAllCore();
  }, 240_000);

  it("CSRF and Origin: a request to the page API without its token, with a wrong token, from another origin, without an origin or not as JSON is refused and stores nothing; the same request done right goes through", async () => {
    const { taskId, maya, world: w } = await waitingPlan();
    const workflow = w.taskRow(taskId)!.workflow as unknown as { revision: number; artifacts: Array<{ sha256: string }> };
    const decision = { requestId: randomUUID(), expectedRevision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256, decision: "APPROVE", answers: [], includedCommentIds: [] };
    const csrf = maya.csrf!;
    for (const [endpoint, body] of [["comments", commentBody("Keep it short.")], ["decision", decision], ["suggestions", { document: "plan", decisionId: "d1", optionId: "three" }]] as const) {
      // task-web-api.ts:250-251: the page's own origin, the CSRF header equal to its cookie, in that order of refusal; then the JSON type.
      expect((await maya.post(endpoint, body, { csrfHeader: null }))).toMatchObject({ status: 403, text: JSON.stringify({ error: "request_refused" }) });
      expect((await maya.post(endpoint, body, { csrfHeader: "x".repeat(43) })).status, "a token that is not the cookie's").toBe(403);
      expect((await maya.post(endpoint, body, { cookieCsrf: null })).status, "no CSRF cookie").toBe(403);
      expect((await maya.post(endpoint, body, { cookieCsrf: "short", csrfHeader: "short" })).status, "a token of the wrong shape").toBe(403);
      expect((await maya.post(endpoint, body, { origin: "https://evil.example" })).status, "another site's page").toBe(403);
      expect((await maya.post(endpoint, body, { origin: null })).status, "no origin").toBe(403);
      expect(await maya.post(endpoint, body, { contentType: "text/plain" }).then((reply) => [reply.status, reply.json()])).toEqual([400, { error: "invalid_request", message: "Send this as JSON." }]);
    }
    expect((await maya.post("comments", "{not json")).status, "a body that is not JSON").toBe(400);
    expect((await maya.post("comments", { ...commentBody("Extra."), surprise: 1 })).status, "a body with a field the schema does not know").toBe(400);
    expect(await maya.post("comments", commentBody("x".repeat(17_000))).then((reply) => [reply.status, reply.json().message])).toEqual([400, "That is too long to send."]);
    // Methods: a decision cannot be made with GET (405 allow POST); the page itself takes no POST; an unknown API path is "not_found".
    const get = await pageRequest(w, "GET", `/review/${taskId}/task/api/decision`, { sessionId: maya.sessionId });
    expect([get.status, get.headers.allow]).toEqual([405, "POST"]);
    const post = await pageRequest(w, "POST", `/review/${taskId}/task`, { sessionId: maya.sessionId, csrf, headers: { origin: PAGE_ORIGIN, "x-agentx-csrf": csrf, "content-type": "application/json" }, body: decision });
    expect([post.status, post.headers.allow]).toEqual([405, "GET"]);
    expect((await maya.post("nothing-here", {})).status).toBe(404);
    expect(storedComments(w, taskId), "nothing was stored").toEqual([]);
    expect(w.taskRow(taskId)!.workflow, "nothing was decided").toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", revision: workflow.revision });
    // The same request with the token and the page's origin goes through.
    expect((await maya.post("comments", commentBody("Keep it short."))).status).toBe(201);
    expect(storedComments(w, taskId)).toHaveLength(1);
    w.proof.assertAllCore();
  }, 180_000);

  it("G1: a person removed from the company with a still valid review session still reads an OLD unstamped task's page today (and cannot post on it), and reads and posts nothing on a core task", async () => {
    const { taskId, maya, world: w } = await waitingPlan();
    // A task the retired spec 056 workflow started (before #1275): its record has no core stamp. The old engine can no longer start one, so the record is a copy of the core task's record under a new
    // id, with the same documents (the page reads a task's documents through its own private prefix), and no stamp row.
    const oldId = randomUUID();
    const record = w.harness.db.get(`DEVTASK#${taskId}`, "META")!;
    w.harness.db.set({ ...record, pk: `DEVTASK#${oldId}`, taskId: oldId });
    expect(w.harness.db.find((row) => row.pk === `DEVTASK#${oldId}` && String(row.sk).startsWith("STAMP")), "the copy carries no stamp").toEqual([]);
    const old = pageReader(w, oldId, maya.sessionId);
    expect((await old.open()).status, "the owner reads the old task's page while a member").toBe(200);
    await old.read("state");
    removeFromCompany(w, MAYA);
    // ACCEPTED TODAY (G1, D1-BRIEF-NOTES.md): her own old task's page still opens for the removed person until her review sign-in ends (task-access.ts:106, the owner branch asks for no company).
    // The page's JSON API (state, comments) and a comment are refused 503 for her, as for a core task, because they read her live company first. D1 deletes the old path (`resolveTaskAccess`): the
    // page then answers "no task" too, and the first expectation flips.
    expect(await old.open().then((reply) => [reply.status, words(reply.text).includes("You're the task owner.")]), "G1: the removed owner reads her own old task's page").toEqual([200, true]);
    expect((await old.read("state")).status, "the old task's page API").toBe(503);
    expect((await old.post("comments", commentBody("Still here."))).status, "a comment on the old task").toBe(503);
    // A core task answers the same person nothing (see "who sees what"): the page is "no access" and the comment is refused and stored nowhere.
    expect((await maya.open()).status).toBe(404);
    expect((await maya.post("comments", commentBody("Core task."))).status).toBe(503);
    expect(storedComments(w, taskId)).toEqual([]);
    expect(storedComments(w, oldId), "nothing was stored on the old task either").toEqual([]);
    w.proof.assertAllCore();
  }, 180_000);

  it("deep links: the document, a version and a claim each open where they point; after Request changes with a page comment, the earlier version says which one is current, and the planner is told the comment", async () => {
    const { taskId, maya, world: w } = await waitingPlan();
    // v1: the document and the claim have their own link targets (task-web.ts markdownDocument / the structured plan's anchors).
    const v1 = await maya.open("?doc=coding-plan&from=1");
    expect(v1.status).toBe(200);
    for (const anchor of ["coding-plan-v1", "coding-plan-v1-1", "coding-plan-v1-decision-d1", "coding-plan-v1-checks"]) expect(v1.text, anchor).toContain(`id="${anchor}"`);
    expect(words(v1.text), "opened from the version that is current").not.toContain("You opened this from v1");
    // A link to a document the task does not have still opens the task (an unknown anchor names nothing), and a malformed document or version is ignored.
    expect((await maya.open("?doc=design")).status).toBe(200);
    expect((await maya.open("?doc=nope&from=0")).status).toBe(200);
    // The owner comments on claim 1 and asks for changes on the web app's card with that comment sent along: v2 is planned with the comment and the reason in the planner's prompt.
    const commented = await maya.post("comments", commentBody("Say how many tries are left.", { target: { kind: "claim", id: "1" } }));
    expect(commented.status).toBe(201);
    const commentId = String((commented.json().comment as { id: string }).id);
    await w.runJobs();
    const listed = await w.maya("GET", "/v1/app/decisions");
    const card = (listed.body.cards as Array<{ id: string; taskId?: string }>).find((item) => item.taskId === taskId)!;
    const changes = await w.maya("POST", `/v1/app/decisions/${card.id.replace(":", "/")}/request-changes`, { requestId: randomUUID(), shownDigest: (listed.body.digests as Record<string, string>)[card.id], reason: "Put the banner above the form.", includedCommentIds: [commentId] });
    expect(changes.status, JSON.stringify(changes.body)).toBe(200);
    const v2 = planAnswer(planDocument({ title: "Add the health endpoint", claims: [{ id: "1", text: "The service answers /health, above the form. The change is in health.txt, and tests/health.test.ts covers it." }] }),
      { checks: { checks: [{ label: "node runs", cwd: "repo/demo", executable: "node", args: ["--version"], proves: ["1", "nc1"] }], none_reason: null } });
    const replanned = await w.runStep("PLAN", [fauxAssistantMessage(v2)]);
    expect(replanned.operation.status, String(replanned.operation.error)).toBe("SUCCEEDED");
    const prompt = JSON.stringify(replanned.invocation);
    expect(prompt, "the planner is told the page comment").toContain("Say how many tries are left.");
    expect(prompt, "and the owner's reason").toContain("Put the banner above the form.");
    // v2 is the current one; the link from v1's card says so, and v1 stays readable with its own targets.
    const fromV1 = await maya.open("?doc=coding-plan&from=1");
    const text = words(fromV1.text);
    expect(text).toContain("You opened this from v1");
    expect(text).toContain("This is v1. v2 is the current one.");
    for (const anchor of ["coding-plan-v2", "coding-plan-v2-1", "coding-plan-v1", "coding-plan-v1-1"]) expect(fromV1.text, anchor).toContain(`id="${anchor}"`);
    expect((await maya.read("state")).json()).toMatchObject({ documents: [{ anchor: "coding-plan", version: 2 }] });
    w.proof.assertAllCore();
  }, 240_000);

  it("limits: thirty comments in ten minutes, sixty edits, twenty replies to a thread, 2,000 characters, nothing empty; the window passing lets the owner on, and no one on a core task can suggest", async () => {
    const { taskId, maya, world: w } = await waitingPlan();
    const SLOW_DOWN = "You've posted a lot in the last 10 minutes. Try again in a few minutes.";
    const text = (reply: { json(): Record<string, unknown> }) => reply.json().message;
    // Too long, empty and too big (page-comments.ts: PAGE_REFUSALS; task-web-api.ts:253).
    expect(await maya.post("comments", commentBody("x".repeat(2_001))).then((reply) => [reply.status, text(reply)])).toEqual([400, "Keep comments under 2,000 characters."]);
    expect(await maya.post("comments", commentBody("   ")).then((reply) => [reply.status, text(reply)])).toEqual([400, "Write something first."]);
    expect(storedComments(w, taskId)).toEqual([]);
    // Thirty comments in ten minutes; the next is refused in words until the window passes (COMMENT_RATE).
    let first = "";
    for (let index = 0; index < 30; index += 1) {
      const reply = await maya.post("comments", commentBody(`Thought ${String(index + 1)}.`));
      expect(reply.status, `comment ${String(index + 1)}`).toBe(201);
      if (index === 0) first = String((reply.json().comment as { id: string }).id);
    }
    expect(await maya.post("comments", commentBody("One more.")).then((reply) => [reply.status, reply.json()])).toEqual([429, { error: "slow_down", message: SLOW_DOWN }]);
    expect(storedComments(w, taskId)).toHaveLength(30);
    // The window passes (the broker reads the clock at each request).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000);
    expect((await maya.post("comments", commentBody("One more."))).status).toBe(201);
    // Sixty edits of one's own comment in ten minutes, then the sixty-first (a delete) is refused until the window passes.
    for (let rev = 1; rev <= 60; rev += 1) expect((await maya.post(`comments/${first}/edit`, { rev, text: `Thought, take ${String(rev)}.` })).status, `edit ${String(rev)}`).toBe(200);
    expect(await maya.post(`comments/${first}/delete`, { rev: 61 }).then((reply) => [reply.status, reply.json()])).toEqual([429, { error: "slow_down", message: SLOW_DOWN }]);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000);
    expect((await maya.post(`comments/${first}/delete`, { rev: 61 })).status).toBe(200);
    // A thread holds twenty replies; the twenty-first is refused ("This thread has 20 replies, the most it can hold.").
    const root = String(((await maya.post("comments", commentBody("A thread."))).json().comment as { id: string }).id);
    for (let reply = 1; reply <= 20; reply += 1) {
      if (reply === 10) vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000);
      expect((await maya.post("comments", commentBody(`Reply ${String(reply)}.`, { parentId: root }))).status, `reply ${String(reply)}`).toBe(201);
    }
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000);
    expect(await maya.post("comments", commentBody("Reply 21.", { parentId: root })).then((reply) => [reply.status, reply.json()])).toEqual([409, { error: "full", message: "This thread has 20 replies, the most it can hold." }]);
    // FINDING (not testable here): the suggestion limit (sixty changes in ten minutes) needs a teammate with the commenter role; a web-started core task has none (see "who sees what": a colleague
    // and a shared reader are refused, People is "unavailable", and the owner's own suggestion is refused), so the limit has no case to run.
    w.proof.assertAllCore();
  }, 240_000);
});
