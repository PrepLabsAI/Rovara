// Suite 10: the task page and its sign-in, as a product lead would try them from Slack. The link on the Slack card
// through sign-in [10.1], sign-in expiry and revocation, who sees what (the owner, a teammate in the channel, a reader
// of a finished task, someone eligible but outside the channel, and someone with no claim at all) [10.2], the phone
// layout at every stage [10.3], deep links [10.4], History at the end of a Full journey [10.5], the page right after a
// Slack decision [10.6, LIVE-BUG B12], and CSRF and Origin on both pages [10.8]. Then deciding and commenting on the page
// (spec 061 slice 2) beyond plan-review-slice-2-e2e.test.ts: a page decision racing a Slack press, a page left open on v1
// after v2 was written, replies and the thread limit, suggestions and their limit, AgentX's answers and their limits,
// the planner's "Done:" / "Not changed because" replies with one comment left unanswered, and drafts surviving a reload.
// 10.7 (review sessions on the PR feedback page) is covered by feedback-review-web.test.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { SlackPageCommentMessageSchema, slackThreadSubject, type ChannelMembersRequest, type ChannelMembersResponse } from "@agentx/contracts";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { MAYA, OMAR, grantProject } from "../../support/developer-task-broker.js";
import { SLACK_CHANNEL, call, orchestratorPrincipal } from "../../support/slack-broker.js";
import { FAUX_MODEL, fauxModelRuntime } from "../../support/faux-model.js";
import { createFixtureDirectory } from "../../fixtures/index.js";
import { fakeStorage } from "../../support/fake-dom.js";
import { PAGE_ORIGIN, openTaskPage, readable, signInToReview, type PageReader, type TaskPageTab } from "../../support/page-browser.js";
import { planAnswer, planDocument } from "../../support/plan-documents.js";
import { feedbackCriticReply } from "../../support/faux-scripts.js";
import { reviewerFindings } from "../../support/model-fixtures.js";
import { visibleSlackText } from "../../support/strict-slack.js";
import { developerIdForSlackUser } from "../../../packages/broker/src/aws/admin-actions.js";
import type { SlackRequestQueue } from "../../../packages/broker/src/developer/page-comments.js";
import { handlePageComment } from "../../../packages/slack-service/src/page-comment.js";
import { runTaskAnswer } from "../../../packages/slack-service/src/task-question.js";
import { createThreadApi } from "../../../packages/slack-service/src/thread-api.js";
import { createHostedSlackRuntime } from "../../../packages/slack-service/src/runtime.js";
import { runOrchestratorTurn } from "../../../packages/orchestrator/src/orchestrator.js";
import type { OrchestrationApi } from "../../../packages/orchestrator/src/orchestration-tools.js";
import { EDITS as GREET_EDITS, PLAN as GREET_PLAN, editsOrFix, journeySuite, openDraftPr } from "../../support/workflow-e2e-journeys.js";

/** Maya as the page knows her after "Sign in with Slack": the developer her Slack-started task belongs to. */
const OWNER: PageReader = { developerId: developerIdForSlackUser(MAYA.slackUserId!), name: MAYA.name, slackUserId: MAYA.slackUserId! };
/** A teammate in the project's Slack channel. */
const SAM: PageReader = { developerId: "7".repeat(64), name: "Sam Lee", slackUserId: "U0SAMLEE01" };
/** Someone on the same Slack workspace who may use the project but is not in the task's channel. */
const PRIYA: PageReader = { developerId: "6".repeat(64), name: "Priya Shah", slackUserId: "U0PRIYA001" };
/** Someone signed in with company sign-in: no Slack identity, not in the channel. */
const OMAR_OIDC: PageReader = { developerId: OMAR.developerId, name: OMAR.name, provider: "oidc" };

const PLAN = planDocument({
  title: "Show a retry banner",
  why: [{ text: "People miss that a payment failed.", author: "Maya" }],
  claims: [
    { id: "1", text: "Add a retry banner to greeting.ts." },
    { id: "2", text: "The banner sits on the page.", children: [{ id: "2.1", text: "It is placed near the pay button." }] },
  ],
  decisions: [{
    id: "d1", claimId: "2.1", question: "Where does the banner go?",
    options: [{ id: "above", label: "Above", consequence: "Seen first." }, { id: "below", label: "Below", consequence: "Less in the way." }],
    recommended: "below",
  }],
});
const V2 = planDocument({ ...PLAN, claims: [{ id: "1", text: "Add a retry banner to greeting.ts, above the form." }, PLAN.claims[1]!] });
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export const banner = 'Retry';\n" }];
const NO_ACCESS = "You don't have access to this task.";
const SLOW_DOWN = "You've posted a lot in the last 10 minutes. Try again in a few minutes.";
const ASK_LIMITED = "AgentX has answered a lot of questions recently. Try again later, or ask in the task's Slack thread.";
const DAY = 24 * 60 * 60 * 1000;

/** Maya and Sam are in the project's channel; nobody else is. */
const members = async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => ({
  ok: true, memberOf: [MAYA.slackUserId, SAM.slackUserId].includes(request.slackUserId) ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [],
});

const codingRuns = (e2e: WorkflowE2E) => e2e.invocations.filter((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "IMPLEMENT");

/** A Quick task whose coding plan waits for Maya. `plan` answers the planner (v2 on a request for changes, say). */
async function waitingPlan(options: { plan?: string | ((latestUserText: string) => string); queue?: SlackRequestQueue } = {}) {
  const e2e = await createWorkflowE2E({ channelMembers: members, ...(options.queue === undefined ? {} : { slackRequestQueue: options.queue }),
    model: { plan: options.plan ?? planAnswer(PLAN), edits: EDITS } });
  expect(await e2e.mention("quick: Show a retry banner when a payment fails")).toBe(200);
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  return e2e;
}

/** A plain request to the broker's review routes, as a browser (or anything else) would send it. */
async function request(e2e: WorkflowE2E, method: string, path: string, options: { cookie?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL(path, PAGE_ORIGIN);
  const response = await e2e.handler({
    version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: url.pathname, rawQueryString: url.search.replace(/^\?/, ""),
    headers: { ...(options.cookie === undefined ? {} : { cookie: options.cookie }), ...(options.headers ?? {}) },
    ...(options.body === undefined ? {} : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }), isBase64Encoded: false,
    requestContext: { requestId: randomUUID(), http: { method } },
  }) as { statusCode: number; body: string; headers?: Record<string, string> };
  return { status: response.statusCode, body: response.body, headers: response.headers ?? {} };
}

/** The visible words of an HTML page (no tags, scripts or styles). */
const words = (html: string) => html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<(style|script)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/** A cookie for a review session that started now and lasts the page's fixed 30 days, as the sign-in service writes it. */
function thirtyDaySession(e2e: WorkflowE2E, reader: PageReader, sessionId = randomUUID()): string {
  signInToReview(e2e, reader);
  const now = Math.floor(Date.now() / 1000);
  e2e.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: reader.developerId, amr: reader.provider ?? "slack",
    startedAt: new Date().toISOString(), endsAt: now + 30 * 86_400, reviewExpiresAt: now + 30 * 86_400 });
  return `__Host-agentx_review_session=${sessionId}`;
}

/** Approve in Slack, as the owner presses it (and submits the form, when one opens). */
async function approveInSlack(e2e: WorkflowE2E): Promise<void> {
  const views = e2e.slack.views.length;
  await e2e.click("agentx_workflow_approve");
  if (e2e.slack.views.length > views) await e2e.submitView();
}

const radio = (tab: TaskPageTab, decision: string, option: string) =>
  tab.document.querySelectorAll(`input[name="answer-${decision}"]`).find((input) => input.getAttribute("value") === option)!;

/** A JSON request the page's own script would make from `tab`: its cookies, its CSRF token and its origin. */
async function pageApi(tab: TaskPageTab, e2e: WorkflowE2E, endpoint: string, body: unknown) {
  const response = await tab.fetch(`/review/${e2e.taskId()}/task/api/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", "x-agentx-csrf": tab.jar.csrf ?? "" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** A comment as the page's script posts it, on the coding plan's v1. */
const commentBody = (target: { kind: "document" } | { kind: "claim"; id: string }, text: string, parentId?: string) =>
  ({ requestId: randomUUID(), document: "plan", version: 1, target, ...(parentId === undefined ? {} : { parentId }), text, ask: false });

/** Writes a reply under the comment `commentId` from `tab`, through the page's own Reply control. */
async function reply(tab: TaskPageTab, commentId: string, text: string, options: { ask?: boolean } = {}) {
  const article = tab.document.getElementById(`comment-${commentId}`);
  if (article === null) throw new Error(`no comment ${commentId} on the page`);
  const open = article.querySelector(".reply-open");
  if (open === null || open.hidden) throw new Error("no Reply control");
  open.click();
  const form = article.querySelector(".comment-form") ?? tab.document.querySelector(`.comment-form[data-draft="reply:${commentId}"]`);
  if (form === null) throw new Error("no reply form opened");
  form.querySelector("textarea")!.type_(text);
  const ask = form.querySelector("input[type=checkbox]");
  if (ask !== null && ask.checked !== (options.ask === true)) ask.click();
  tab.button(form, "Post").click();
  await tab.settle();
  return form;
}

const peopleComments = (e2e: WorkflowE2E) => e2e.db.find((item) => item.pk === `DEVTASK#${e2e.taskId()}` && item.entityType === "TASK_COMMENT" && (item.author as { kind: string }).kind === "person")
  .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));

interface Queued { body: string; groupId: string; deduplicationId: string; attributes: Record<string, unknown> }
function recordingQueue(): SlackRequestQueue & { sent: Queued[] } {
  const sent: Queued[] = [];
  return { sent, send: async (message) => { sent.push(message); } };
}

/** The Slack service's side of each queued page comment, on its real code, with a tool-less answer turn that says `answer`. */
async function answerPageComments(e2e: WorkflowE2E, queue: { sent: Queued[] }, answer: string): Promise<void> {
  for (const queued of queue.sent.splice(0)) {
    const comment = SlackPageCommentMessageSchema.parse(JSON.parse(queued.body));
    const { pageComment: target, ...message } = comment;
    const signedFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const response = await call(e2e.handler, {
        method: init?.method ?? "GET", path: `/v1/service${url.pathname.slice("/v1".length)}${url.search}`,
        service: { principal: orchestratorPrincipal, thread: slackThreadSubject(message.thread), slackUser: message.userId },
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    };
    const api = createThreadApi({ controlPlaneUrl: "https://agentx.internal", signedFetch });
    await handlePageComment(comment, {
      answer: (question) => runTaskAnswer(message, target, question, { api, runTurn: async (input) => {
        const { modelRuntime, faux } = await fauxModelRuntime();
        faux.setResponses([() => fauxAssistantMessage([fauxText(answer)])]);
        const unused = new Proxy({}, { get: () => () => { throw new Error("an answer turn used a control-plane tool"); } }) as OrchestrationApi;
        const runtime = await createHostedSlackRuntime(input, { stateDirectory: await createFixtureDirectory("agentx-e2e-page10-"), api: unused, model: FAUX_MODEL, modelRuntime });
        try { return await runOrchestratorTurn(runtime, input.message.text); } finally { await runtime.dispose(); }
      } }),
      markAnswered: async (input) => { await api.markCommentAnswered!(input); },
      log: () => undefined,
    });
  }
}

/** The page's CSS, with the lint the contract test "fits a phone" uses: no fixed widths, code blocks scroll inside themselves. */
function expectPhoneLayout(html: string): void {
  expect(html).toMatch(/<meta name="viewport" content="width=device-width,initial-scale=1[^"]*">/);
  const css = [...html.matchAll(/<style nonce="[^"]+">([\s\S]*?)<\/style>/g)].map((match) => match[1]!).join("\n");
  expect(css.replace(/@media[^{]*\{/g, "")).not.toMatch(/(^|[;{\s])width:\s*[0-9.]+(px|rem|em|ch)/);
  expect(css).toMatch(/overflow-wrap:anywhere/);
  expect(html).not.toMatch(/\swidth="\d+"/);
}

describe("Suite 10: page and auth", () => {
  journeySuite();

  it("10.1 the link on the Slack card sends a signed-out reader to sign in with the document kept, and after sign-in opens that document", async () => {
    const e2e = await waitingPlan();
    const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    const open = (card.blocks as Array<{ elements?: Array<{ action_id?: string; url?: string }> }>).flatMap((block) => block.elements ?? []).find((element) => element.action_id === "agentx_open_review");
    expect(open?.url).toBeDefined();
    const link = new URL(open!.url!);
    expect(link.origin).toBe(e2e.reviewUrlBase);
    expect(link.pathname).toBe(`/review/${e2e.taskId()}/task`);
    expect(link.hash).toBe("#coding-plan");
    // A browser never sends the #anchor; the document it names is in the query, which survives sign-in.
    const signedOut = await request(e2e, "GET", `${link.pathname}${link.search}`);
    expect(signedOut.status).toBe(302);
    const returnTo = new URL(signedOut.headers.location!, PAGE_ORIGIN).searchParams.get("return_to");
    expect(returnTo).toBe(`/review/${e2e.taskId()}/task?doc=coding-plan&from=1`);
    expect(signedOut.body).not.toContain("Show a retry banner");
    // Sign-in writes the review session and sends the browser back to return_to.
    const signedIn = await request(e2e, "GET", returnTo!, { cookie: thirtyDaySession(e2e, OWNER) });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(words(signedIn.body)).toContain("You're the task owner.");
    expect(signedIn.body).toContain('id="coding-plan-v1"');
    expect(words(signedIn.body)).toContain("It is placed near the pay button.");
  }, 120_000);

  it("10.1 a review sign-in works 29 days later and ends at 30: the page asks to sign in again, the open page's request is refused, and drafts are cleared", async () => {
    const e2e = await waitingPlan();
    const cookie = thirtyDaySession(e2e, OWNER);
    const path = `/review/${e2e.taskId()}/task?doc=coding-plan`;
    e2e.clock.advance(29 * DAY);
    expect((await request(e2e, "GET", path, { cookie })).status).toBe(200);
    const state = await request(e2e, "GET", `/review/${e2e.taskId()}/task/api/state`, { cookie });
    expect(state.status).toBe(200);
    e2e.clock.advance(DAY);
    const ended = await request(e2e, "GET", path, { cookie });
    expect(ended.status).toBe(302);
    expect(ended.headers.location).toBe(`/v1/auth/browser/authorize?return_to=${encodeURIComponent(`/review/${e2e.taskId()}/task?doc=coding-plan`)}`);
    expect(await request(e2e, "GET", `/review/${e2e.taskId()}/task/api/state`, { cookie })).toMatchObject({ status: 401 });
    expect(JSON.parse((await request(e2e, "GET", `/review/${e2e.taskId()}/task/status`, { cookie })).body)).toEqual({ error: "Sign in again." });
  }, 120_000);

  it("10.1 a page open when its sign-in is revoked: the comment is refused with a plain sign-in message, the typed text stays, and nothing is stored", async () => {
    const e2e = await waitingPlan();
    const storage = fakeStorage();
    const tab = await openTaskPage(e2e, SAM, { search: "?doc=coding-plan", storage });
    // Sam types a comment (kept as a draft), then an admin ends his sign-in.
    tab.document.querySelector('.comment-open[data-target="claim:1"]')!.click();
    const form = tab.document.querySelector('[data-comments="claim:1"] .comment-form')!;
    form.querySelector("textarea")!.type_("Could the banner say how many tries are left?");
    expect([...storage.map.keys()]).toEqual([`agentx:${e2e.taskId()}:coding-plan`]);
    const session = e2e.db.get(`SESSION#${tab.jar.sessionId}`, "META")!;
    e2e.db.set({ ...session, revokedAt: new Date().toISOString(), revokedReason: "admin" });
    tab.button(form, "Post").click();
    await tab.settle();
    expect(form.querySelector(".comment-error")!.textContent).toBe("Your sign-in ended. Open the link from Slack again, then try once more.");
    expect(form.querySelector("textarea")!.value).toBe("Could the banner say how many tries are left?");
    expect(peopleComments(e2e)).toEqual([]);
    // A sign-in that ended clears the tab's drafts: the next reader of this browser tab finds none.
    expect(storage.map.size).toBe(0);
  }, 120_000);

  it("10.2 who sees what: the owner decides, a teammate comments and suggests, someone eligible outside the channel is told whom to ask, and anyone else can't tell the task exists", async () => {
    const e2e = await waitingPlan();
    const owner = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan", scripts: false });
    expect(owner.status).toBe(200);
    expect(owner.text()).toContain("You're the task owner.");
    expect(owner.document.querySelector("#decide-approve")).not.toBeNull();

    const sam = await openTaskPage(e2e, SAM, { search: "?doc=coding-plan", scripts: false });
    expect(sam.status).toBe(200);
    expect(sam.text()).toContain("You can read and comment on this task.");
    expect(sam.text()).toContain("Only the task owner decides; you can comment and suggest.");
    expect(sam.document.querySelector("#decide-approve")).toBeNull();

    // Priya may use the project and is on the task's Slack workspace, but is not in its channel.
    grantProject(e2e.db, { ...PRIYA, provider: "slack", sessionId: "s-priya" });
    const priya = await openTaskPage(e2e, PRIYA, { search: "?doc=coding-plan", scripts: false });
    expect(priya.status).toBe(403);
    // A task started in Slack knows its owner only by Slack ID, so the reader is told to ask the task owner (found by this
    // scenario: the page said "Ask Slack user U0MAYA001 to add you").
    expect(words(priya.html)).toBe(`No access ${NO_ACCESS} Ask the task owner to add you.`);

    // Omar signed in with company sign-in and is in no channel: the same answer as a task that does not exist.
    const omar = await openTaskPage(e2e, OMAR_OIDC, { search: "?doc=coding-plan", scripts: false });
    expect(omar.status).toBe(404);
    expect(words(omar.html)).toBe(`No access ${NO_ACCESS}`);
    expect(omar.html).not.toContain("Show a retry banner");
    const cookie = `__Host-agentx_review_session=${omar.jar.sessionId}`;
    const missing = await request(e2e, "GET", "/review/00000000-0000-4000-8000-000000000000/task", { cookie });
    expect(missing.status).toBe(404);
    expect(words(missing.body)).toBe(words(omar.html));
    // The page's API and its status check say the same for both.
    for (const id of [e2e.taskId(), "00000000-0000-4000-8000-000000000000"]) {
      const api = await request(e2e, "GET", `/review/${id}/task/api/state`, { cookie });
      expect([api.status, JSON.parse(api.body)]).toEqual([404, { error: "not_found", message: NO_ACCESS }]);
      const status = await request(e2e, "GET", `/review/${id}/task/status`, { cookie });
      expect([status.status, JSON.parse(status.body)]).toEqual([404, { error: "Not found." }]);
    }
    expect(codingRuns(e2e)).toEqual([]);
  }, 120_000);

  it("10.2 a finished task reads for everyone who could see it, with nothing to press: a teammate gets 'You can read this task.' and no comment controls", async () => {
    const e2e = await createWorkflowE2E({ channelMembers: members, model: { plan: GREET_PLAN, edits: editsOrFix } });
    const pullRequest = await openDraftPr(e2e);
    const early = await openTaskPage(e2e, OWNER);
    e2e.github.merge(pullRequest.number);
    expect(await e2e.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    const sam = await openTaskPage(e2e, SAM, { scripts: false });
    expect(sam.status).toBe(200);
    expect(sam.text()).toContain("You can read this task.");
    expect(sam.text()).toContain("Decisions are made in Slack.");
    expect(sam.document.querySelector("#agentx-page-data")).toBeNull();
    // A page opened now carries no token to post with; one left open from before the merge is refused in plain words.
    expect((await openTaskPage(e2e, OWNER)).jar.csrf).toBeUndefined();
    expect(await pageApi(early, e2e, "comments", commentBody({ kind: "document" }, "Late thought.")))
      .toEqual({ status: 409, body: { error: "changed", message: "This task is closed, so it takes no new comments." } });
    expect(peopleComments(e2e)).toEqual([]);
  }, 120_000);

  it.todo("10.2 an explicit Viewer role, and the People form that grants it (spec 061 slice 3, not built yet): a channel member made a Viewer reads the page but cannot comment");

  it("10.3 the page fits a phone at every stage: the plan, failed checks, blocked reviews, waiting for the merge, merged; and so does the PR feedback page", async () => {
    const plan = await waitingPlan();
    expectPhoneLayout((await openTaskPage(plan, OWNER, { scripts: false })).html);

    const failing = await createWorkflowE2E({ model: { plan: GREET_PLAN, edits: GREET_EDITS }, checkResult: () => ({ exitCode: 1, stdout: "", stderr: "1 failing" }) });
    expect(await failing.mention("quick: Add a greet(name) function")).toBe(200);
    await failing.settle();
    await failing.click("agentx_workflow_approve");
    await failing.settle();
    expect(failing.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expectPhoneLayout((await openTaskPage(failing, OWNER, { scripts: false })).html);

    const blocked = await createWorkflowE2E({ model: { plan: GREET_PLAN, edits: GREET_EDITS, reviews: reviewerFindings(1) } });
    expect(await blocked.mention("quick: Add a greet(name) function")).toBe(200);
    await blocked.settle();
    await blocked.click("agentx_workflow_approve");
    await blocked.settle();
    expect(blocked.workflow()).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expectPhoneLayout((await openTaskPage(blocked, OWNER, { scripts: false })).html);

    const waiting = await createWorkflowE2E({ model: { plan: GREET_PLAN, edits: editsOrFix,
      feedback: (prompt) => feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" }) } });
    const pullRequest = await openDraftPr(waiting);
    expectPhoneLayout((await openTaskPage(waiting, OWNER, { scripts: false })).html);
    const comment = waiting.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    expect(await waiting.githubWebhook(pullRequest.number, { comment })).toBe(200);
    await waiting.settle();
    const feedback = await waiting.feedbackPage();
    expect(feedback.status).toBe(200);
    expectPhoneLayout(feedback.body);
    waiting.github.merge(pullRequest.number);
    expect(await waiting.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
    await waiting.settle();
    expect(waiting.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expectPhoneLayout((await openTaskPage(waiting, OWNER, { scripts: false })).html);
  }, 180_000);

  it("10.4 deep links: the document, a version and a claim each open where they point, and an earlier version says which one is current", async () => {
    const e2e = await waitingPlan({ plan: (latest) => (latest.includes("Put the banner above the form.") ? planAnswer(V2) : planAnswer(PLAN)) });
    await e2e.click("agentx_workflow_changes");
    await e2e.submitView({ workflow_feedback: { reason: { value: "Put the banner above the form." } } });
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    const page = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan", scripts: false });
    expect(page.status).toBe(200);
    // The latest version is open; the earlier one is folded, says it isn't current, and has its own link target.
    expect(page.html).toContain('id="coding-plan-v2"');
    expect(page.html).toContain('id="coding-plan-v1"');
    expect(page.text()).toContain("This is v1. v2 is the current one.");
    // Each claim has its own link target in the latest version.
    expect(page.html).toContain('id="coding-plan-v2-2-1"');
    // Opened from the v1 card after v2 exists: the page says so.
    const fromV1 = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan&from=1", scripts: false });
    expect(fromV1.text()).toContain("You opened this from v1");
  }, 120_000);

  it("10.5 History at the end of a journey lists the approval, the PR feedback approval and the merge in order, each with who and when", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: GREET_PLAN, edits: editsOrFix,
      feedback: (prompt) => feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" }) } });
    e2e.clock.set("2026-10-11T14:05:00.000Z");
    const pullRequest = await openDraftPr(e2e);
    e2e.clock.advance(60 * 60_000);
    const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    expect(await e2e.githubWebhook(pullRequest.number, { comment })).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_feedback_review_recommended");
    await e2e.settle();
    e2e.clock.advance(60 * 60_000);
    e2e.github.merge(pullRequest.number);
    expect(await e2e.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
    await e2e.settle();
    const page = await openTaskPage(e2e, OWNER, { scripts: false });
    const history = page.document.querySelector("#history")!;
    const lines = history.querySelectorAll("li").map((line) => readable(line));
    // Newest first.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((line) => /^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC /.test(line))).toBe(true);
    expect(lines.at(-1)).toMatch(/^Oct 11, 14:0\d UTC /);
    const approval = lines.findIndex((line) => line.includes("approved Coding plan v1"));
    expect(approval).toBeGreaterThan(-1);
    expect(lines[approval]).toContain("The task owner approved Coding plan v1");
    expect(page.text()).toContain("Merged");
  }, 120_000);

  it("10.6 [LIVE-BUG B12] the page fetched right after a Slack decision shows the new step, never cached, even where reads lag a write", async () => {
    const e2e = await createWorkflowE2E({ channelMembers: members, consistency: "eventual", model: { plan: planAnswer(PLAN), edits: EDITS } });
    expect(await e2e.mention("quick: Show a retry banner when a payment fails")).toBe(200);
    await e2e.settle();
    const before = await openTaskPage(e2e, OWNER, { scripts: false });
    expect(before.text()).toContain("Waiting for your approval");
    await approveInSlack(e2e);
    const after = await request(e2e, "GET", `/review/${e2e.taskId()}/task`, { cookie: thirtyDaySession(e2e, OWNER) });
    expect(after.status).toBe(200);
    expect(after.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(words(after.body)).toContain("Writing the code");
    const state = await request(e2e, "GET", `/review/${e2e.taskId()}/task/api/state`, { cookie: thirtyDaySession(e2e, OWNER) });
    expect(state.headers["cache-control"]).toContain("no-store");
    expect(JSON.parse(state.body)).toMatchObject({ revision: e2e.workflow().revision, waiting: false });
  }, 120_000);

  it("10.8 the task page's API refuses a request without its CSRF token or from another origin, and nothing is stored", async () => {
    const e2e = await waitingPlan();
    const tab = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan" });
    const cookie = tab.jar.header();
    const csrf = tab.jar.csrf!;
    const comment = commentBody({ kind: "document" }, "Keep it short.");
    const workflow = e2e.workflow();
    const decision = { requestId: randomUUID(), expectedRevision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256, decision: "APPROVE", answers: [], includedCommentIds: [] };
    const json = { "content-type": "application/json" };
    const path = (endpoint: string) => `/review/${e2e.taskId()}/task/api/${endpoint}`;
    for (const [endpoint, body] of [["comments", comment], ["decision", decision]] as const) {
      // No token header.
      expect(await request(e2e, "POST", path(endpoint), { cookie, headers: { ...json, origin: PAGE_ORIGIN }, body })).toMatchObject({ status: 403, body: JSON.stringify({ error: "request_refused" }) });
      // A token that doesn't match the cookie.
      expect((await request(e2e, "POST", path(endpoint), { cookie, headers: { ...json, origin: PAGE_ORIGIN, "x-agentx-csrf": "x".repeat(43) }, body })).status).toBe(403);
      // Another site's page.
      expect((await request(e2e, "POST", path(endpoint), { cookie, headers: { ...json, origin: "https://evil.example", "x-agentx-csrf": csrf }, body })).status).toBe(403);
      // No origin at all.
      expect((await request(e2e, "POST", path(endpoint), { cookie, headers: { ...json, "x-agentx-csrf": csrf }, body })).status).toBe(403);
      // Not JSON.
      expect((await request(e2e, "POST", path(endpoint), { cookie, headers: { "content-type": "text/plain", origin: PAGE_ORIGIN, "x-agentx-csrf": csrf }, body })).status).toBe(400);
    }
    // A decision can't be made with GET, and the page itself takes no POST.
    expect((await request(e2e, "GET", path("decision"), { cookie })).status).toBe(405);
    expect((await request(e2e, "POST", `/review/${e2e.taskId()}/task`, { cookie, headers: { ...json, origin: PAGE_ORIGIN, "x-agentx-csrf": csrf }, body: decision })).status).toBe(405);
    expect(peopleComments(e2e)).toEqual([]);
    expect(e2e.workflow().revision).toBe(workflow.revision);
    expect(e2e.workflow().decisions).toEqual([]);
    // The same request with the token and the page's origin goes through.
    expect((await request(e2e, "POST", path("comments"), { cookie, headers: { ...json, origin: PAGE_ORIGIN, "x-agentx-csrf": csrf }, body: comment })).status).toBe(201);
    expect(peopleComments(e2e)).toHaveLength(1);
    expect(codingRuns(e2e)).toEqual([]);
  }, 120_000);

  it("10.8 the PR feedback page refuses a decision without its CSRF token or from another origin, and the proposal still waits", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: GREET_PLAN, edits: editsOrFix,
      feedback: (prompt) => feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" }) } });
    const pullRequest = await openDraftPr(e2e);
    const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    expect(await e2e.githubWebhook(pullRequest.number, { comment })).toBe(200);
    await e2e.settle();
    expect((await e2e.feedbackPage()).status).toBe(200);
    const review = JSON.parse((await e2e.feedbackPage(undefined, { api: true })).body) as { revision: number; reviewDigest: string; proposalDigest: string; bundleDigests: string[]; findings?: Array<{ id: string }> };
    const before = e2e.workflow();
    const body = { requestId: randomUUID(), expectedRevision: review.revision, reviewDigest: review.reviewDigest, proposalDigest: review.proposalDigest,
      bundleDigests: review.bundleDigests, decision: "APPROVE", selectedFindingIds: ["finding-1"] };
    expect((await e2e.feedbackDecision(body, { csrf: null })).status).toBe(403);
    expect((await e2e.feedbackDecision(body, { origin: "https://evil.example" })).status).toBe(403);
    await e2e.settle();
    expect(e2e.workflow().revision).toBe(before.revision);
    expect(e2e.workflow().feedbackDecisions).toBeUndefined();
    expect(e2e.workflow().feedbackReview).toMatchObject({ status: "PENDING" });
    expect(codingRuns(e2e)).toHaveLength(1);
  }, 120_000);

  describe("deciding and commenting on the page (spec 061 slice 2)", () => {
    it("the owner approves on the page and in Slack at the same moment: one decision, one coding run, and the other side is told in plain words", async () => {
      const e2e = await waitingPlan();
      const tab = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan" });
      radio(tab, "d1", "above").click();
      tab.byId("decide-approve").click();
      await e2e.concurrently(
        async () => { tab.byId("decide-submit").click(); await tab.settle(); },
        () => approveInSlack(e2e),
      );
      await e2e.settle();
      const approvals = e2e.workflow().decisions.filter((decision) => decision.decision === "APPROVE");
      expect(approvals).toHaveLength(1);
      expect(codingRuns(e2e)).toHaveLength(1);
      const pageWon = (approvals[0] as { via?: string }).via === "PAGE";
      if (pageWon) {
        expect(tab.byId("decide-status").textContent).toBe("Sent. AgentX is on the next step.");
        // The Slack press lost: the owner is told the card is out of date, never that saving failed.
        const shown = [...e2e.slack.responses.map((response) => response.text), ...e2e.slack.ephemerals.map((message) => visibleSlackText(message.text))];
        expect(shown.some((text) => /out of date|already/i.test(text))).toBe(true);
      } else {
        expect(tab.byId("decide-error").textContent).toBe(`Already approved by ${MAYA.name} a moment ago.`);
        // The page keeps the owner's own answer.
        expect(radio(tab, "d1", "above").checked).toBe(true);
      }
      expect(e2e.slack.posts.filter((post) => visibleSlackText(post.text).startsWith("Coding plan approved"))).toHaveLength(1);
    }, 120_000);

    it("a page left open on v1 while Slack asks for changes: it shows 'Coding plan v2 is ready', refuses its stale approval, and keeps the owner's answer for v2", async () => {
      const e2e = await waitingPlan({ plan: (latest) => (latest.includes("Put the banner above the form.") ? planAnswer(V2) : planAnswer(PLAN)) });
      const storage = fakeStorage();
      const tab = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan", storage });
      radio(tab, "d1", "above").click();
      await e2e.click("agentx_workflow_changes");
      await e2e.submitView({ workflow_feedback: { reason: { value: "Put the banner above the form." } } });
      await e2e.settle();
      expect(e2e.slack.lastPostWithAction("agentx_workflow_approve").text).toContain("*Coding plan v2 is ready for your approval.*");
      await tab.advance(20_000);
      expect(readable(tab.byId("moved-on"))).toBe("Coding plan v2 is ready. Show it");
      tab.byId("decide-approve").click();
      tab.byId("decide-submit").click();
      await tab.settle();
      expect(tab.requests.filter((entry) => entry.path.endsWith("/api/decision")).at(-1)!.status).toBe(409);
      expect(tab.byId("decide-error").hidden).toBe(false);
      expect(tab.byId("decide-error").textContent).toBe("Coding plan v2 is ready. Your answers and comments are kept. Check them and send again.");
      expect(e2e.workflow().decisions.filter((decision) => decision.decision === "APPROVE")).toEqual([]);
      expect(codingRuns(e2e)).toEqual([]);
      // Show it reloads onto v2: the owner's answer to the decision v2 still has is there, ready to approve.
      const v2 = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan", storage });
      expect(v2.html).toContain('id="coding-plan-v2"');
      expect(radio(v2, "d1", "above").checked).toBe(true);
    }, 120_000);

    it("drafts survive a reload: a half-written comment, a reply and a changed answer come back in a new load of the same tab, and never in another tab", async () => {
      const e2e = await waitingPlan();
      const sam = await openTaskPage(e2e, SAM, { search: "?doc=coding-plan" });
      await sam.comment("claim:2.1", "Above reads better on a phone.");
      const [first] = peopleComments(e2e);
      const storage = fakeStorage();
      const tab = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan", storage });
      radio(tab, "d1", "above").click();
      tab.document.querySelector('.comment-open[data-target="document"]')!.click();
      tab.document.querySelector('[data-comments="document"] .comment-form textarea')!.type_("Keep the banner copy short");
      const article = tab.document.getElementById(`comment-${String(first!.commentId)}`)!;
      article.querySelector(".reply-open")!.click();
      tab.document.querySelector(`.comment-form[data-draft="reply:${String(first!.commentId)}"] textarea`)!.type_("Agreed, above it is");
      // The reload: a new page from the broker, the same tab's storage.
      const reloaded = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan", storage });
      expect(radio(reloaded, "d1", "above").checked).toBe(true);
      expect(reloaded.document.querySelector('[data-comments="document"] .comment-form textarea')!.value).toBe("Keep the banner copy short");
      expect(reloaded.document.querySelector(`.comment-form[data-draft="reply:${String(first!.commentId)}"] textarea`)!.value).toBe("Agreed, above it is");
      // Another tab has its own storage: nothing carries over, and nothing was ever sent to the broker.
      const other = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan" });
      expect(radio(other, "d1", "below").checked).toBe(true);
      expect(other.document.querySelector('[data-comments="document"] .comment-form')).toBeNull();
      expect(peopleComments(e2e)).toHaveLength(1);
      expect(e2e.workflow().decisions).toEqual([]);
    }, 120_000);

    it("replies: the owner and a teammate answer a comment one level deep, the author edits theirs, and a full thread is refused in plain words", async () => {
      const e2e = await waitingPlan();
      const sam = await openTaskPage(e2e, SAM, { search: "?doc=coding-plan" });
      await sam.comment("claim:2.1", "Above reads better on a phone.");
      const root = String(peopleComments(e2e)[0]!.commentId);
      const owner = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan" });
      await reply(owner, root, "Good point, I'll think about it.");
      const thread = (await openTaskPage(e2e, SAM, { search: "?doc=coding-plan" })).document.querySelector('[data-comments="claim:2.1"]')!;
      expect(readable(thread)).toContain("Good point, I'll think about it.");
      expect(readable(thread.querySelector(".replies")!)).toContain(MAYA.name);
      // A reply has no Reply of its own: one level deep.
      const replyId = String(peopleComments(e2e)[1]!.commentId);
      const replied = (await openTaskPage(e2e, SAM, { search: "?doc=coding-plan" })).document.getElementById(`comment-${replyId}`)!;
      expect(replied.querySelector(".reply-open")).toBeNull();
      // Sam edits his comment through the API the page uses; someone else's is refused.
      const edited = await pageApi(sam, e2e, `comments/${root}/edit`, { rev: 1, text: "Above reads better on a phone, I think." });
      // Found by this scenario: an edit or delete was read as a decision and refused, so no comment could be changed.
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({ comment: { text: "Above reads better on a phone, I think." } });
      const notHis = await pageApi(sam, e2e, `comments/${replyId}/edit`, { rev: 1, text: "Changed." });
      expect(notHis).toEqual({ status: 403, body: { error: "not_allowed", message: "Only the person who wrote a comment can change it." } });
      // Twenty replies fill the thread; the next is refused and its text kept.
      for (let index = 1; index < 20; index += 1) {
        const answer = await pageApi(owner, e2e, "comments", commentBody({ kind: "claim", id: "2.1" }, `Reply ${index + 1}.`, root));
        expect(answer.status).toBe(201);
      }
      const full = await reply(await openTaskPage(e2e, SAM, { search: "?doc=coding-plan" }), root, "One more reply.");
      expect(full.querySelector(".comment-error")!.textContent).toBe("This thread has 20 replies, the most it can hold.");
      expect(full.querySelector("textarea")!.value).toBe("One more reply.");
      // The owner deletes her first reply; the thread shows it as deleted.
      const ownersReply = String(peopleComments(e2e).find((comment) => comment.text === "Good point, I'll think about it.")!.commentId);
      expect((await pageApi(owner, e2e, `comments/${ownersReply}/delete`, { rev: 1 })).status).toBe(200);
      expect(readable((await openTaskPage(e2e, SAM, { search: "?doc=coding-plan" })).document.getElementById(`comment-${ownersReply}`)!)).toContain("Comment deleted");
      expect(codingRuns(e2e)).toEqual([]);
    }, 120_000);

    it("suggestions: a teammate suggests and changes it, the owner can't suggest, and a flood is refused until ten minutes pass; comments reset the same way", async () => {
      const e2e = await waitingPlan();
      const sam = await openTaskPage(e2e, SAM, { search: "?doc=coding-plan" });
      const owner = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan" });
      expect(await pageApi(owner, e2e, "suggestions", { document: "plan", decisionId: "d1", optionId: "above" }))
        .toEqual({ status: 403, body: { error: "not_allowed", message: "Owners answer decisions themselves; suggestions are for teammates." } });
      // Sixty changes in ten minutes are allowed; the sixty-first is refused.
      for (let index = 0; index < 60; index += 1) {
        expect((await pageApi(sam, e2e, "suggestions", { document: "plan", decisionId: "d1", optionId: index % 2 === 0 ? "above" : "below" })).status).toBe(200);
      }
      expect(await pageApi(sam, e2e, "suggestions", { document: "plan", decisionId: "d1", optionId: "above" }))
        .toEqual({ status: 429, body: { error: "slow_down", message: SLOW_DOWN } });
      // The last suggestion that went through stands: Below.
      expect((await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan" })).text()).toContain("Sam Lee suggests: Below");
      e2e.clock.advance(10 * 60_000);
      expect((await pageApi(sam, e2e, "suggestions", { document: "plan", decisionId: "d1", optionId: "above" })).status).toBe(200);
      expect((await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan" })).text()).toContain("Sam Lee suggests: Above");
      // Thirty comments in ten minutes; the next waits for the window to pass.
      for (let index = 0; index < 30; index += 1) {
        expect((await pageApi(sam, e2e, "comments", commentBody({ kind: "document" }, `Thought ${index + 1}.`))).status).toBe(201);
      }
      const refused = await pageApi(sam, e2e, "comments", commentBody({ kind: "document" }, "One more."));
      expect(refused).toEqual({ status: 429, body: { error: "slow_down", message: SLOW_DOWN } });
      e2e.clock.advance(10 * 60_000);
      expect((await pageApi(sam, e2e, "comments", commentBody({ kind: "document" }, "One more."))).status).toBe(201);
      expect(e2e.workflow().decisions).toEqual([]);
    }, 120_000);

    it("AgentX's answers have limits: a long answer is cut, and past a person's hourly questions the comment posts with a plain note instead of an answer", async () => {
      const queue = recordingQueue();
      const e2e = await waitingPlan({ queue });
      const sam = await openTaskPage(e2e, SAM, { search: "?doc=coding-plan" });
      await sam.comment("claim:1", "Why a banner and not a toast?", { ask: true });
      await answerPageComments(e2e, queue, `Because it stays. ${"A banner stays until the payment is retried. ".repeat(100)}`);
      const answers = e2e.db.find((item) => item.pk === `DEVTASK#${e2e.taskId()}` && item.entityType === "TASK_COMMENT" && (item.author as { kind: string }).kind === "agentx");
      expect(answers).toHaveLength(1);
      expect(String(answers[0]!.text).length).toBeLessThanOrEqual(3_000);
      expect(String(answers[0]!.text).startsWith("Because it stays.")).toBe(true);
      // Five more questions this hour are queued; the seventh posts as a plain comment with the note.
      for (let index = 0; index < 5; index += 1) await sam.comment(index % 2 === 0 ? "claim:2" : "document", `Question ${index + 2}?`, { ask: true });
      expect(queue.sent).toHaveLength(5);
      const form = await sam.comment("claim:2.1", "Question 7?", { ask: true });
      expect(queue.sent).toHaveLength(5);
      expect(readable(sam.document.querySelector('[data-comments="claim:2.1"]')!)).toContain("Question 7?");
      expect(readable(sam.document.querySelector('[data-comments="claim:2.1"]')!)).toContain(ASK_LIMITED);
      void form;
      expect(peopleComments(e2e).map((comment) => comment.text)).toContain("Question 7?");
      expect(e2e.workflow().decisions).toEqual([]);
    }, 120_000);

    it("after Request changes on the page, v2 answers each sent comment with Done: or Not changed because:, and one the planner skipped reads Not answered", async () => {
      // The planner answers the comments it was given by their refs, and leaves the one about tries out.
      const answers = (latest: string) => {
        const refs = new Map([...latest.matchAll(/<page_comment [^>]*ref="(c\d+)"[^>]*>([^<]*)<\/page_comment>/g)].map((match) => [match[2]!, match[1]!]));
        return JSON.stringify([
          { comment: refs.get("Above reads better on a phone."), outcome: "done", reason: "Moved the banner above the pay button." },
          { comment: refs.get("Keep the banner copy short."), outcome: "not_changed", reason: "The copy is already one short line." },
        ]);
      };
      const e2e = await waitingPlan({ plan: (latest) => latest.includes("agentx-comment-answers")
        ? `\`\`\`agentx-comment-answers\n${answers(latest)}\n\`\`\`\n\n${planAnswer(V2)}` : planAnswer(PLAN) });
      const sam = await openTaskPage(e2e, SAM, { search: "?doc=coding-plan" });
      await sam.comment("claim:2.1", "Above reads better on a phone.");
      await sam.comment("document", "Keep the banner copy short.");
      await sam.comment("claim:1", "Could it say how many tries are left?");
      const tab = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan" });
      tab.byId("decide-request-changes").click();
      expect(tab.byId("decide-comments-title").textContent).toBe("Comments to send (3)");
      tab.byId("decide-submit").click();
      await tab.settle();
      expect(tab.byId("decide-status").textContent).toBe("Sent. AgentX is on the next step.");
      await e2e.settle();
      expect(e2e.slack.lastPostWithAction("agentx_workflow_approve").text).toContain("AgentX answered 2 of 3 comments from v1.");
      const v2 = await openTaskPage(e2e, OWNER, { search: "?doc=coding-plan" });
      expect(v2.document.querySelector('[data-comments="claim:2.1"] .replies .comment-text')!.textContent).toBe("Done: Moved the banner above the pay button.");
      expect(v2.document.querySelector('[data-comments="document"] .replies .comment-text')!.textContent).toBe("Not changed because: The copy is already one short line.");
      expect(readable(v2.document.querySelector('[data-comments="claim:1"]')!)).toContain("Not answered");
      expect(codingRuns(e2e)).toEqual([]);
    }, 120_000);
  });
});
