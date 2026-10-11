// Spec 061 slice 2, Task 7: the task page's deciding and commenting script, run against the page the server renders,
// parsed into a small fake DOM inside a vm sandbox.
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { PlanDocument } from "@agentx/contracts";
import { createTaskWeb, type TaskDocumentEntry, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { TASK_PAGE_DECIDING_COPY, TASK_PAGE_DECIDING_SCRIPT } from "../../packages/broker/src/aws/task-page-assets.js";
import type { PageCommentView } from "../../packages/broker/src/aws/plan-page/comments.js";
import { fakeStorage, makeEvent, parseHtml, type FakeDocument, type FakeElement } from "../support/fake-dom.js";
import { planDocument } from "../support/plan-documents.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const caller = { developerId: "d".repeat(64), sessionId: "s", amr: "slack", name: "Maya" } as const;
const SESSION = "__Host-agentx_review_session=11111111-1111-4111-8111-111111111111";
const digest = "f".repeat(64);
const BANNED = /\b(candidate|revision|digest|operation|artifact|workflow|invalid json)\b|\b(SUCCEEDED|FAILED|INTERRUPTED|CANCELLED)\b/i;
const owner = { role: "owner" as const, canComment: true, canSuggest: false, canDecide: true, canAsk: true };
const commenter = { role: "commenter" as const, canComment: true, canSuggest: true, canDecide: false, canAsk: true };

const option = (id: string, label: string) => ({ id, label, consequence: `${label} it is.` });
/** Six decisions: d1 sits on a folded child claim, d6 under "Show 1 more decisions". */
function decisions(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    id: `d${index + 1}`, claimId: index === 0 ? "1.1" : "2", question: `Question ${index + 1}?`,
    options: [option("above", "Above"), option("below", "Below")], recommended: "below",
  }));
}
const plan = (extra: Partial<PlanDocument> = {}) => planDocument({ title: "Retry payments", why: [{ text: "Payments drop.", author: "Priya" }], decisions: decisions(), ...extra });
const doc = (version: number, body: PlanDocument, current = true): TaskDocumentEntry =>
  ({ kind: "coding plan", version, approved: false, current, format: "structured", plan: body });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function comment(n: number, extra: Partial<PageCommentView> = {}): PageCommentView {
  return {
    id: id(n), document: "plan", version: 1, target: { kind: "claim", id: "2" }, author: { kind: "person", name: "Sam", owner: false, you: false },
    text: `Comment ${n}`, createdAt: "2026-10-11T10:00:00.000Z", edited: false, deleted: false, sent: false, rev: 1, ...extra,
  };
}

interface PageOptions { version?: number; body?: PlanDocument; comments?: PageCommentView[]; access?: typeof owner | typeof commenter; waiting?: boolean; optionalChecks?: TaskDocumentView["optionalChecks"]; askAvailable?: boolean }
async function pageHtml(options: PageOptions = {}): Promise<string> {
  const version = options.version ?? 2;
  const documents = [doc(1, plan(), false), ...(version > 2 ? [doc(2, plan(), false)] : []), doc(version, options.body ?? plan())];
  const view: TaskDocumentView = {
    taskId, title: "Retry payments", status: "Waiting for your approval", nextStep: "Approve or request changes.", path: "QUICK", stage: "Coding plan", role: "owner",
    documents, checks: [], findings: [], pullRequests: [], history: [], revision: 7, commentSeq: 3, access: options.access ?? owner,
    pageComments: options.comments ?? [comment(1), comment(2, { author: { kind: "person", name: "Priya", owner: false, you: true }, version: 2, target: { kind: "document" } })],
    pageSuggestions: [],
    ...(options.waiting === false ? {} : { waiting: { kind: "coding plan", version, artifactDigest: digest } }),
    optionalChecks: options.optionalChecks ?? [{ id: "lint", label: "Lint", selected: false }],
    ...(options.askAvailable === undefined ? {} : { askAvailable: options.askAvailable }),
  };
  const web = createTaskWeb({ authenticateSession: async () => caller, getTaskDocumentView: async () => view });
  const answer = await web({ method: "GET", path: `/review/${taskId}/task`, headers: { cookie: SESSION }, requestId: "r" }, new URL(`https://agentx.example.test/review/${taskId}/task`));
  expect(answer.statusCode).toBe(200);
  return answer.body;
}

interface Reply { status: number; body?: unknown }
interface Sent { url: string; method: string; headers: Record<string, string>; body: Record<string, string> }

/** Boots both of the page's scripts against the parsed page. Replies come from `respond`, or wait when it returns undefined. */
function boot(html: string, options: { storage?: ReturnType<typeof fakeStorage>; local?: ReturnType<typeof fakeStorage>; respond?: (sent: Sent) => Reply | Promise<Reply> | undefined } = {}) {
  const document: FakeDocument = parseHtml(html);
  const storage = options.storage ?? fakeStorage();
  const sent: Sent[] = [];
  const pending: Array<(reply: Reply) => void> = [];
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  const clock = { now: 1_000_000 };
  const reloads: number[] = [];
  let uuids = 0;
  let timerId = 0;
  const respond = options.respond ?? (() => ({ status: 200, body: {} }));
  const sandbox: Record<string, unknown> = {
    document,
    location: { hash: "", search: "", pathname: `/review/${taskId}/task`, reload: () => { reloads.push(clock.now); } },
    setTimeout: (fn: unknown, ms: number) => {
      if (typeof fn !== "function") throw new Error("string timers are not allowed");
      timerId += 1;
      timers.push({ fn: fn as () => void, at: clock.now + ms, id: timerId });
      return timerId;
    },
    clearTimeout: (handle: number) => { const index = timers.findIndex((timer) => timer.id === handle); if (index >= 0) timers.splice(index, 1); },
    setInterval: () => 0, clearInterval: () => undefined,
    Date: Object.assign(function FakeDate(...args: [string]) { return new Date(...args); }, { now: () => clock.now }),
    crypto: { randomUUID: () => { uuids += 1; return `aaaaaaaa-aaaa-4aaa-8aaa-${String(uuids).padStart(12, "0")}`; } },
    fetch: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const entry: Sent = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body === undefined ? {} : JSON.parse(init.body) as Record<string, string> };
      sent.push(entry);
      const reply = respond(entry);
      const deliver = (value: Reply) => ({ status: value.status, ok: value.status >= 200 && value.status < 300, json: async () => value.body ?? {} });
      if (reply === undefined) return new Promise((resolve) => { pending.push((value) => resolve(deliver(value))); });
      return Promise.resolve(reply).then(deliver);
    },
    decodeURIComponent, encodeURIComponent,
  };
  // Drafts belong in the tab's sessionStorage; localStorage is there too, and must stay untouched.
  const local = options.local ?? fakeStorage();
  sandbox.window = { addEventListener: () => undefined, sessionStorage: storage, localStorage: local };
  sandbox.sessionStorage = storage;
  sandbox.localStorage = local;
  for (const script of document.querySelectorAll("script")) {
    if (script.getAttribute("nonce") !== null) vm.runInNewContext(script.textContent, sandbox);
  }
  const settle = async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const advance = async (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      timers.sort((left, right) => left.at - right.at);
      const next = timers[0];
      if (next === undefined || next.at > until) break;
      timers.shift();
      clock.now = next.at;
      next.fn();
      await settle();
    }
    clock.now = until;
  };
  const byId = (name: string) => document.getElementById(name)!;
  return { document, storage, sent, pending, timers, clock, reloads, settle, advance, byId };
}
type Page = ReturnType<typeof boot>;

const radio = (page: Page, decision: string, value: string) => page.document.querySelectorAll(`input[name="answer-${decision}"]`).find((input) => input.getAttribute("value") === value)!;
const posts = (page: Page, path: string) => page.sent.filter((entry) => entry.method === "POST" && entry.url.endsWith(path));
const commentBoxes = (page: Page) => page.byId("decide-comments-list").querySelectorAll("input[type=checkbox]");

describe("the deciding and commenting script", () => {
  it("preserves contextual comment labels and target keys when comments refresh", async () => {
    let seq = 3;
    const page = boot(await pageHtml({ comments: [comment(1, { target: { kind: "claim", id: "2" } }), comment(3, { target: { kind: "decision", id: "d1" } }), comment(4, { target: { kind: "document" } })] }), { respond: (entry) => {
      if (entry.url.endsWith("/api/state")) return { status: 200, body: { revision: 7, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 2 }], commentSeq: seq, csrf: "n".repeat(43) } };
      if (entry.url.endsWith("/api/comments")) return { status: 200, body: { comments: [], suggestions: [] } };
      return { status: 200, body: {} };
    } });
    const expected = [["claim:2", "Comment on 2"], ["decision:d1", "Comment on this decision"], ["document", "Comment on this document"]] as const;
    for (const [target, label] of expected) {
      const button = page.document.querySelector(`.comment-open[data-target="${target}"]`)!;
      expect(button.textContent).toBe(label);
      expect(button.hidden).toBe(false);
    }
    seq = 4;
    await page.advance(20_000);
    for (const [target, label] of expected) {
      const button = page.document.querySelector(`.comment-open[data-target="${target}"]`)!;
      expect(button.textContent).toBe(label);
      expect(button.hidden).toBe(false);
    }
  });

  it("the script builds no markup from strings", () => {
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"on", "setAttribute('on", ".onclick", "location.href", "location=", "location ="]) {
      expect(TASK_PAGE_DECIDING_SCRIPT, banned).not.toContain(banned);
    }
    expect(TASK_PAGE_DECIDING_SCRIPT).not.toMatch(/setTimeout\(\s*["'`]/);
    for (const [name, text] of Object.entries(TASK_PAGE_DECIDING_COPY)) expect(String(text), name).not.toMatch(BANNED);
  });

  it("the ask-refused line fits every cap that can refuse a question", () => {
    expect(TASK_PAGE_DECIDING_COPY.askLimited).toBe("AgentX has answered a lot of questions recently. Try again later, or ask in the task's Slack thread.");
    expect(TASK_PAGE_DECIDING_COPY.askLimited).not.toMatch(/this task|last hour|per thread/i);
  });

  it("is included only for someone who can act, by the page's nonce", async () => {
    const html = await pageHtml();
    const nonce = /<script nonce="([^"]+)">/.exec(html)![1]!;
    expect(html.match(new RegExp(`<script nonce="${nonce}">`, "g"))).toHaveLength(2);
    expect(html).toContain(TASK_PAGE_DECIDING_SCRIPT.slice(0, 60));
  });

  it("N to answer opens folded decisions and focuses the next one", async () => {
    const page = boot(await pageHtml());
    const next = page.byId("decide-next");
    expect(next.hidden).toBe(false);
    expect(page.byId("decide-count").hidden).toBe(true);
    expect(page.byId("decide-approve").hidden).toBe(false);
    expect(next.textContent).toBe("Next decision (6 to answer)");
    // d1 sits on a folded child claim.
    const first = radio(page, "d1", "above");
    const folded = first.closest("details.claim")!;
    expect(folded.open).toBe(false);
    next.click();
    for (let up: FakeElement | null = first; up !== null; up = up.parentElement) if (up.tagName === "DETAILS") expect(up.open).toBe(true);
    expect(first.closest(".decision")!.scrolled).toHaveLength(1);
    expect(page.document.activeElement).toBe(first);
    // Picking answers counts down; d6 is under "Show 1 more decisions".
    for (const decision of ["d1", "d2", "d3", "d4", "d5"]) radio(page, decision, "below").click();
    expect(next.textContent).toBe("Next decision (1 to answer)");
    const last = radio(page, "d6", "above");
    expect(last.closest("details.more-decisions")!.open).toBe(false);
    next.click();
    expect(last.closest("details.more-decisions")!.open).toBe(true);
    expect(page.document.activeElement).toBe(last);
    radio(page, "d6", "above").click();
    // Nothing left to answer: the control gives way to a plain note, which is not a button.
    expect(next.hidden).toBe(true);
    expect(page.byId("decide-count").hidden).toBe(false);
    expect(page.byId("decide-count").tagName).toBe("SPAN");
    expect(page.byId("decide-count").textContent).toBe("All decisions answered");
  });

  it("Approve sends every answer with which were opened, the ticked comments and the note", async () => {
    const page = boot(await pageHtml(), { respond: (entry) => entry.url.endsWith("/decision") ? { status: 200, body: { revision: 8 } } : { status: 200, body: {} } });
    radio(page, "d2", "above").click();
    radio(page, "d3", "below").click();
    const approve = page.byId("decide-approve");
    approve.click();
    const dialog = page.byId("decide-dialog");
    expect(dialog.open).toBe(true);
    expect(page.byId("decide-title").textContent).toBe("Approve Coding plan v2");
    expect(page.byId("decide-submit").textContent).toBe("Approve and start coding");
    expect(page.byId("decide-changed").hidden).toBe(false);
    expect(page.byId("decide-changed-list").visibleText).toBe("Question 2?: You chose Above (AgentX recommended Below)");
    expect(page.byId("decide-unanswered-list").querySelectorAll("li")).toHaveLength(4);
    expect(page.byId("decide-comments-title").textContent).toBe("Comments to send (2)");
    expect(page.byId("decide-comments-list").visibleText).toContain("Sam");
    expect(page.byId("decide-comments-list").visibleText).toContain("Comment 1");
    expect(commentBoxes(page).every((box) => box.checked)).toBe(true);
    expect(page.byId("decide-checks").hidden).toBe(false);
    page.byId("decide-checks-list").querySelector("input[type=checkbox]")!.click();
    commentBoxes(page)[1]!.click();
    expect(page.byId("decide-comments-title").textContent).toBe("Comments to send (1)");
    page.byId("decide-note").type_("  Keep it small.  ");
    page.byId("decide-submit").click();
    expect(page.byId("decide-status").textContent).toBe("Sending…");
    expect(page.byId("decide-status").getAttribute("role")).toBe("status");
    await page.settle();
    const [decision] = posts(page, "/task/api/decision");
    expect(decision!.url).toBe(`/review/${taskId}/task/api/decision`);
    expect(decision!.headers["x-agentx-csrf"]).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    expect(decision!.headers["content-type"]).toBe("application/json");
    expect(decision!.body).toEqual({
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", expectedRevision: 7, artifactDigest: digest, decision: "APPROVE",
      answers: [
        { decisionId: "d1", optionId: "below", opened: false }, { decisionId: "d2", optionId: "above", opened: true },
        { decisionId: "d3", optionId: "below", opened: true }, { decisionId: "d4", optionId: "below", opened: false },
        { decisionId: "d5", optionId: "below", opened: false }, { decisionId: "d6", optionId: "below", opened: false },
      ],
      includedCommentIds: [id(1)], selectedOptionalCheckIds: ["lint"], note: "Keep it small.",
    });
    expect(page.byId("decide-status").textContent).toBe("Sent. AgentX is on the next step.");
    expect(page.reloads).toHaveLength(1);
  });

  it("a whitespace note is left out, and focus returns to the pressed button on close", async () => {
    const page = boot(await pageHtml({ comments: [comment(1)] }), { respond: () => ({ status: 200, body: { revision: 8 } }) });
    const approve = page.byId("decide-approve");
    approve.focus();
    approve.click();
    page.byId("decide-cancel").click();
    expect(page.byId("decide-dialog").open).toBe(false);
    expect(page.document.activeElement).toBe(approve);
    approve.click();
    page.byId("decide-note").type_("   ");
    page.byId("decide-submit").click();
    await page.settle();
    expect(posts(page, "/decision")[0]!.body.note).toBeUndefined();
  });

  it("a second press while sending is a replay with the same request ID", async () => {
    let calls = 0;
    const page = boot(await pageHtml(), { respond: (entry) => {
      if (!entry.url.endsWith("/decision")) return { status: 200, body: {} };
      calls += 1;
      return calls === 1 ? undefined : { status: 200, body: { revision: 8 } };
    } });
    page.byId("decide-approve").click();
    const submit = page.byId("decide-submit");
    submit.click();
    submit.click();
    await page.settle();
    expect(posts(page, "/decision")).toHaveLength(1);
    // The first try never answers well: the network drops it. Pressing again sends the same request.
    page.pending.shift()!({ status: 503, body: { error: "unavailable", message: "AgentX couldn't do that right now. Try again shortly." } });
    await page.settle();
    expect(page.byId("decide-error").hidden).toBe(false);
    expect(page.byId("decide-error").textContent).toBe("AgentX couldn't do that right now. Try again shortly.");
    submit.click();
    await page.settle();
    const sentIds = posts(page, "/decision").map((entry) => entry.body.requestId);
    expect(sentIds).toHaveLength(2);
    expect(sentIds[1]).toBe(sentIds[0]);
    // A new dialog is a new request.
    expect(page.reloads).toHaveLength(1);
  });

  it("request changes needs a comment or a note", async () => {
    const page = boot(await pageHtml(), { respond: () => ({ status: 200, body: { revision: 8 } }) });
    page.byId("decide-request-changes").click();
    expect(page.byId("decide-title").textContent).toBe("Request changes to Coding plan v2");
    expect(page.byId("decide-note-label").textContent).toBe("What should change?");
    expect(page.byId("decide-submit").textContent).toBe("Send");
    expect(page.byId("decide-checks").hidden).toBe(true);
    for (const box of commentBoxes(page)) box.click();
    page.byId("decide-submit").click();
    await page.settle();
    expect(page.byId("decide-error").textContent).toBe("Include at least one comment or write a note.");
    expect(posts(page, "/decision")).toHaveLength(0);
    page.byId("decide-note").type_("Use five tries.");
    page.byId("decide-submit").click();
    await page.settle();
    expect(posts(page, "/decision")[0]!.body).toMatchObject({ decision: "REQUEST_CHANGES", includedCommentIds: [], note: "Use five tries." });
    expect(posts(page, "/decision")[0]!.body.selectedOptionalCheckIds).toBeUndefined();
  });

  it("more than 25 comments cannot be ticked", async () => {
    const many = Array.from({ length: 27 }, (_, index) => comment(index + 1));
    const page = boot(await pageHtml({ comments: many }));
    page.byId("decide-approve").click();
    const boxes = commentBoxes(page);
    expect(boxes).toHaveLength(27);
    expect(boxes.filter((box) => box.checked)).toHaveLength(25);
    expect(page.byId("decide-cap").hidden).toBe(false);
    expect(page.byId("decide-cap").textContent).toBe("You can send up to 25 comments at a time; the rest stay open for the next version.");
    boxes[26]!.click();
    expect(boxes[26]!.checked).toBe(false);
    expect(boxes.filter((box) => box.checked)).toHaveLength(25);
    boxes[0]!.click();
    boxes[26]!.click();
    expect(boxes[26]!.checked).toBe(true);
  });

  it("a refused decision keeps answers, drafts and exclusions and restores them on the next version where they still fit", async () => {
    const storage = fakeStorage();
    const refused = "Already approved by Priya a moment ago.";
    const page = boot(await pageHtml(), { storage, respond: (entry) => entry.url.endsWith("/decision") ? { status: 409, body: { error: "changed", message: refused } } : { status: 200, body: {} } });
    radio(page, "d2", "above").click();
    radio(page, "d4", "above").click();
    // A comment being written on claim 2 and on claim 1.
    for (const target of ["claim:2", "claim:1"]) {
      page.document.querySelector(`.comment-open[data-target="${target}"]`)!.click();
      const form = page.document.querySelector(`[data-comments="${target}"] .comment-form`)!;
      form.querySelector("textarea")!.type_(`Draft on ${target}`);
    }
    page.byId("decide-approve").click();
    commentBoxes(page)[0]!.click();
    page.byId("decide-note").type_("Short note.");
    page.byId("decide-submit").click();
    await page.settle();
    expect(page.byId("decide-error").textContent).toBe(refused);
    expect(page.byId("decide-dialog").open).toBe(true);
    const showIt = page.byId("decide-dialog").querySelectorAll("button").find((button) => button.textContent === "Show it")!;
    expect(showIt.hidden).toBe(false);
    expect(radio(page, "d2", "above").checked).toBe(true);
    expect(page.byId("decide-note").value).toBe("Short note.");
    showIt.click();
    expect(page.reloads).toHaveLength(1);
    // v3: d4 is gone and claim 1 was removed; d2 and claim 2 are still there.
    const v3 = plan({ claims: [{ id: "2", text: "A payment is never charged twice." }], decisions: decisions(3).filter((decision) => decision.id !== "d1").map((decision) => ({ ...decision, claimId: "2" })) });
    const next = boot(await pageHtml({ version: 3, body: v3 }), { storage });
    expect(radio(next, "d2", "above").checked).toBe(true);
    expect(next.byId("decide-next").textContent).toBe("Next decision (1 to answer)");
    expect(next.document.querySelector('[data-comments="claim:2"] .comment-form textarea')!.value).toBe("Draft on claim:2");
    expect(next.document.querySelector('[data-comments="claim:1"] .comment-form')).toBeNull();
    next.byId("decide-approve").click();
    expect(commentBoxes(next)[0]!.checked).toBe(false);
    expect(commentBoxes(next)[1]!.checked).toBe(true);
    expect(next.byId("decide-note").value).toBe("Short note.");
    expect(next.byId("decide-title").textContent).toBe("Approve Coding plan v3");
  });

  it("drafts are a convenience: a blocked storage changes nothing else, and old drafts are dropped", async () => {
    const blocked = boot(await pageHtml(), { storage: fakeStorage({ fail: true }) });
    radio(blocked, "d1", "above").click();
    expect(blocked.byId("decide-next").textContent).toBe("Next decision (5 to answer)");
    const storage = fakeStorage();
    storage.setItem(`agentx:${taskId}:coding-plan`, JSON.stringify({ v: 1, at: 1_000_000 - 8 * 24 * 3600 * 1000, answers: { d1: "above" }, opened: ["d1"], drafts: {}, excluded: [], note: "old" }));
    const stale = boot(await pageHtml(), { storage });
    expect(radio(stale, "d1", "above").checked).toBe(false);
    expect(storage.getItem(`agentx:${taskId}:coding-plan`)).toBeNull();
  });

  it("drafts live in the tab's sessionStorage, never localStorage, and a sign-in that ended clears them", async () => {
    const storage = fakeStorage();
    const local = fakeStorage();
    const page = boot(await pageHtml(), { storage, local, respond: (entry) => entry.method === "POST" ? { status: 401, body: { error: "sign_in_required" } } : { status: 200, body: {} } });
    radio(page, "d1", "above").click();
    page.document.querySelector('.comment-open[data-target="claim:2"]')!.click();
    const form = page.document.querySelector('[data-comments="claim:2"] .comment-form')!;
    form.querySelector("textarea")!.type_("A thought.");
    expect([...storage.map.keys()]).toEqual([`agentx:${taskId}:coding-plan`]);
    expect(local.map.size).toBe(0);
    form.querySelectorAll("button").find((button) => button.textContent === "Post")!.click();
    await page.settle();
    expect(form.querySelector(".comment-error")!.textContent).toBe("Your sign-in ended. Open the link from Slack again, then try once more.");
    expect(storage.map.size).toBe(0);
  });

  it("one poll at a time, and two hours with no input stop it until the reader is back", async () => {
    const state = { revision: 7, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 2 }], commentSeq: 3, csrf: "n".repeat(43) };
    const page = boot(await pageHtml(), { respond: (entry) => entry.url.endsWith("/api/state") ? { status: 200, body: state } : { status: 200, body: {} } });
    const states = () => page.sent.filter((entry) => entry.url.endsWith("/api/state")).length;
    await page.advance(10_000);
    // Shown again while a poll is due: one poll now, and the one that was due does not also run.
    page.document.setVisibility("hidden");
    page.document.setVisibility("visible");
    await page.settle();
    expect(states()).toBe(1);
    await page.advance(10_000);
    expect(states()).toBe(1);
    await page.advance(10_000);
    expect(states()).toBe(2);
    expect(page.timers).toHaveLength(1);
    await page.advance(2 * 3600_000);
    const quiet = states();
    await page.advance(3600_000);
    expect(states()).toBe(quiet);
    expect(page.timers).toHaveLength(0);
    // The reader is back: polling starts again.
    page.document.body.click();
    await page.advance(60_000);
    expect(states()).toBeGreaterThan(quiet);
  });

  it("an open comment form, even empty, keeps its thread from being redrawn", async () => {
    let seq = 3;
    const page = boot(await pageHtml(), { respond: (entry) => {
      if (entry.url.endsWith("/api/state")) return { status: 200, body: { revision: 7, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 2 }], commentSeq: seq, csrf: "n".repeat(43) } };
      if (entry.url.endsWith("/api/comments")) return { status: 200, body: { comments: [comment(1), comment(8, { text: "New one." })], suggestions: [] } };
      return { status: 200, body: {} };
    } });
    page.document.querySelector('.comment-open[data-target="claim:2"]')!.click();
    seq = 4;
    await page.advance(20_000);
    const thread = page.document.querySelector('[data-comments="claim:2"]')!;
    expect(thread.querySelector(".comment-form")).not.toBeNull();
    expect(thread.querySelector(`#comment-${id(8)}`)).toBeNull();
  });

  it("past 25 comments only the boxes the owner unticked are remembered", async () => {
    const storage = fakeStorage();
    const many = Array.from({ length: 27 }, (_, index) => comment(index + 1));
    const page = boot(await pageHtml({ comments: many }), { storage });
    page.byId("decide-approve").click();
    commentBoxes(page)[0]!.click();
    page.byId("decide-cancel").click();
    const saved = JSON.parse(storage.getItem(`agentx:${taskId}:coding-plan`)!) as { excluded: string[] };
    expect(saved.excluded).toEqual([id(1)]);
    page.byId("decide-approve").click();
    const boxes = commentBoxes(page);
    expect(boxes[0]!.checked).toBe(false);
    expect(boxes.slice(1, 26).every((box) => box.checked)).toBe(true);
    expect(boxes[26]!.checked).toBe(false);
  });

  it("a comment the page cannot describe still gets a readable label, and the delete question names itself", async () => {
    const mine = comment(2, { author: { kind: "person", name: "Priya", owner: false, you: true }, version: 2, target: { kind: "document" } });
    const html = (await pageHtml({ comments: [comment(1), mine] })).replace(`id="comment-${id(1)}"`, 'id="elsewhere"');
    const page = boot(html);
    page.byId("decide-approve").click();
    expect(page.byId("decide-comments-list").querySelectorAll("label")[0]!.visibleText).toBe("A comment");
    page.byId("decide-cancel").click();
    page.document.querySelector(`#comment-${id(2)} .comment-delete`)!.click();
    expect(page.document.querySelector(`#comment-${id(2)} .comment-confirm`)!.getAttribute("aria-label")).toBe("Delete this comment?");
  });

  it("polling stops while hidden and shows the new version banner", async () => {
    let state: Record<string, unknown> = { revision: 7, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 2 }], commentSeq: 3, csrf: "n".repeat(43) };
    const page = boot(await pageHtml(), { respond: (entry) => entry.url.endsWith("/api/state") ? { status: 200, body: state }
      : entry.url.endsWith("/decision") ? { status: 409, body: { error: "changed", message: "This task changed. Refresh the page and try again." } } : { status: 200, body: {} } });
    const states = () => page.sent.filter((entry) => entry.url.endsWith("/api/state"));
    // Only the one poller: the status poll stays quiet when this script runs.
    await page.advance(20_000);
    expect(states()).toHaveLength(1);
    expect(page.sent.filter((entry) => entry.url.endsWith("/task/status"))).toHaveLength(0);
    expect(states()[0]!.method).toBe("GET");
    page.document.setVisibility("hidden");
    await page.advance(120_000);
    expect(states()).toHaveLength(1);
    page.document.setVisibility("visible");
    await page.settle();
    expect(states()).toHaveLength(2);
    // The CSRF token from the poll is used next.
    radio(page, "d1", "above").click();
    page.byId("decide-approve").click();
    page.byId("decide-submit").click();
    await page.settle();
    expect(posts(page, "/decision")[0]!.headers["x-agentx-csrf"]).toBe("n".repeat(43));
    page.byId("decide-cancel").click();
    state = { ...state, revision: 9, waiting: true, documents: [{ anchor: "coding-plan", version: 3 }] };
    await page.advance(20_000);
    const banner = page.byId("moved-on");
    expect(banner.hidden).toBe(false);
    expect(banner.visibleText).toBe("Coding plan v3 is ready. Show it");
    page.byId("moved-on-refresh").click();
    expect(page.reloads).toHaveLength(1);
  });

  it("the step moving on with no new version says so, and after ten quiet minutes it asks once a minute", async () => {
    const state = { revision: 8, waiting: false, stage: "Coding", documents: [{ anchor: "coding-plan", version: 2 }], commentSeq: 3, csrf: "n".repeat(43) };
    const page = boot(await pageHtml(), { respond: (entry) => entry.url.endsWith("/api/state") ? { status: 200, body: state } : { status: 200, body: {} } });
    await page.advance(20_000);
    expect(page.byId("moved-on").visibleText).toBe("This task moved on. Show it");
    await page.advance(600_000);
    const before = page.sent.length;
    await page.advance(30_000);
    expect(page.sent.length).toBe(before);
    await page.advance(10_000);
    expect(page.sent.length).toBe(before + 1);
    await page.advance(50_000);
    expect(page.sent.length).toBe(before + 1);
    await page.advance(10_000);
    expect(page.sent.length).toBe(before + 2);
  });

  it("a refused CSRF check gets a fresh token and tries once more", async () => {
    let first = true;
    const page = boot(await pageHtml(), { respond: (entry) => {
      if (entry.url.endsWith("/api/state")) return { status: 200, body: { revision: 7, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 2 }], commentSeq: 3, csrf: "z".repeat(43) } };
      if (entry.url.endsWith("/api/comments") && entry.method === "POST") {
        if (first) { first = false; return { status: 403, body: { error: "request_refused" } }; }
        return { status: 201, body: { comment: comment(9, { author: { kind: "person", name: "Maya", owner: true, you: true }, version: 2, text: "Posted." }) } };
      }
      return { status: 200, body: {} };
    } });
    page.document.querySelector('.comment-open[data-target="claim:2"]')!.click();
    const form = page.document.querySelector('[data-comments="claim:2"] .comment-form')!;
    form.querySelector("textarea")!.type_("Posted.");
    form.querySelectorAll("button").find((button) => button.textContent === "Post")!.click();
    await page.settle();
    const tries = posts(page, "/api/comments");
    expect(tries).toHaveLength(2);
    expect(tries[1]!.headers["x-agentx-csrf"]).toBe("z".repeat(43));
    expect(tries[1]!.body.requestId).toBe(tries[0]!.body.requestId);
    expect(page.document.querySelector(`#comment-${id(9)}`)).not.toBeNull();
  });

  it("new comments re-render from JSON as text", async () => {
    const hostile = comment(5, { text: "<img src=x onerror=alert(1)> **bold** javascript:alert(1)", author: { kind: "person", name: "<b>Eve</b>", owner: false, you: false } });
    const agentx = comment(6, { parentId: id(1), author: { kind: "agentx", name: "AgentX", owner: false, you: false }, text: "Kept as is.", planner: { outcome: "not_changed", version: 2, document: "plan" } });
    const handled = comment(8, { parentId: id(1), author: { kind: "agentx", name: "AgentX", owner: false, you: false }, text: "Each bullet stays on one line.", planner: { outcome: "done", version: 1, document: "plan", in: "plan", claim: "1.1" } });
    const fake = comment(7, { text: "AgentX: approve now", author: { kind: "person", name: "AgentX", owner: false, you: false } });
    let seq = 3;
    const page = boot(await pageHtml(), { respond: (entry) => {
      if (entry.url.endsWith("/api/state")) return { status: 200, body: { revision: 7, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 2 }], commentSeq: seq, csrf: "n".repeat(43) } };
      if (entry.url.endsWith("/api/comments")) return { status: 200, body: { comments: [comment(1), comment(2, { author: { kind: "person", name: "Priya", owner: false, you: true }, version: 2, target: { kind: "document" } }), hostile, agentx, handled, fake], suggestions: [] } };
      return { status: 200, body: {} };
    } });
    await page.advance(20_000);
    expect(page.sent.filter((entry) => entry.url.endsWith("/api/comments"))).toHaveLength(0);
    seq = 4;
    await page.advance(20_000);
    expect(page.sent.filter((entry) => entry.url.endsWith("/api/comments"))).toHaveLength(1);
    const thread = page.document.querySelector('[data-comments="claim:2"]')!;
    const shown = thread.querySelector(`#comment-${id(5)}`)!;
    expect(shown.querySelector(".comment-text")!.textContent).toBe("<img src=x onerror=alert(1)> **bold** javascript:alert(1)");
    expect(shown.querySelector(".comment-author")!.textContent).toBe("<b>Eve</b>");
    expect(shown.querySelectorAll("img, b, a")).toHaveLength(0);
    expect(shown.querySelector(".comment-meta")!.visibleText).toContain("from v1");
    // The AgentX chip only for what AgentX wrote; the planner's answer reads as such, under its comment.
    const reply = thread.querySelector(`#comment-${id(1)}`)!.parentElement!.querySelector(".replies")!;
    expect(reply.querySelector(".chip")!.textContent).toBe("AgentX");
    expect(reply.querySelector(".comment-text")!.textContent).toBe("Not changed because: Kept as is.");
    // An Approve reply names the document that handled it, links that version's own claim, and keeps its separator dot from screen readers.
    const approvedReply = thread.querySelector(`#comment-${id(8)}`)!;
    expect(approvedReply.querySelector(".comment-text")!.textContent).toBe("Done in the coding plan: Each bullet stays on one line.");
    expect(approvedReply.querySelector(".comment-link")!.textContent).toBe("See claim 1.1 in coding plan v1.");
    expect(approvedReply.querySelector(".comment-link a")!.getAttribute("href")).toBe("#coding-plan-v1-1-1");
    expect(approvedReply.querySelector(".comment-meta")!.visibleText).toContain("from coding plan v1");
    expect(approvedReply.querySelector(".comment-meta [aria-hidden]")!.textContent).toBe("· ");
    expect(thread.querySelector(`#comment-${id(7)}`)!.querySelector(".chip")).toBeNull();
    // The removed comment is gone, and the whole-document thread kept its own.
    expect(page.document.querySelector(`#comment-${id(2)}`)).not.toBeNull();
    // Reply, Edit and Delete name the comment they act on.
    const replyButton = thread.querySelector(`#comment-${id(5)} .reply-open`)!;
    expect(replyButton.hidden).toBe(false);
    expect(replyButton.getAttribute("aria-describedby")).toBe(`comment-${id(5)}`);
  });

  it("a planner reply re-rendered from JSON links its claim numbers, and a locked comment names its decision", async () => {
    const agentx = { kind: "agentx", name: "AgentX", owner: false, you: false } as const;
    const parts = [{ text: "<b>Done</b> in claims " }, { claim: "1.2.1" }, { text: " and " }, { claim: "1.1.1" }, { text: ", not 1.9 or " }, { claim: "x<y" }, { text: "." }];
    const handled = comment(8, { parentId: id(1), author: agentx, text: "plain words", planner: { outcome: "done", version: 1, document: "plan", in: "plan", parts } });
    const unlinked = comment(9, { parentId: id(1), author: agentx, text: "See 1.2.1.", planner: { outcome: "done", version: 1, document: "plan", in: "plan" } });
    const mineOwner = comment(3, { author: { kind: "person", name: "Priya", owner: true, you: true }, sent: true, sentWith: "APPROVE" });
    const mineTeammate = comment(4, { author: { kind: "person", name: "Sam", owner: false, you: true }, sent: true, sentWith: "APPROVE" });
    const mineChanges = comment(5, { author: { kind: "person", name: "Sam", owner: false, you: true }, sent: true, sentWith: "REQUEST_CHANGES" });
    const theirs = comment(6, { sent: true, sentWith: "APPROVE" });
    const unknown = comment(10, { author: { kind: "person", name: "Sam", owner: true, you: true }, sent: true });
    let seq = 3;
    const page = boot(await pageHtml(), { respond: (entry) => {
      if (entry.url.endsWith("/api/state")) return { status: 200, body: { revision: 7, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 2 }], commentSeq: seq, csrf: "n".repeat(43) } };
      if (entry.url.endsWith("/api/comments")) return { status: 200, body: { comments: [comment(1), mineOwner, mineTeammate, mineChanges, theirs, unknown, handled, unlinked], suggestions: [] } };
      return { status: 200, body: {} };
    } });
    seq = 4;
    await page.advance(20_000);
    const said = page.document.querySelector(`#comment-${id(8)} .comment-text`)!;
    expect(said.textContent).toBe("Done in the coding plan: <b>Done</b> in claims 1.2.1 and 1.1.1, not 1.9 or x<y.");
    // Only a well-formed claim number becomes a link, and every link goes to that version's own element.
    expect(said.querySelectorAll("a").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["1.2.1", "#coding-plan-v1-1-2-1"], ["1.1.1", "#coding-plan-v1-1-1-1"]]);
    expect(said.querySelectorAll("b, img")).toHaveLength(0);
    expect(page.document.querySelector(`#comment-${id(9)} .comment-text`)!.textContent).toBe("Done in the coding plan: See 1.2.1.");
    expect(page.document.querySelectorAll(`#comment-${id(9)} .comment-text a`)).toHaveLength(0);
    const note = (n: number) => page.document.querySelector(`#comment-${id(n)} .comment-sent`)?.textContent;
    expect(note(3)).toBe("Sent with your approval, so it can't be edited.");
    expect(note(4)).toBe("Sent with the owner's approval, so it can't be edited.");
    expect(note(5)).toBe("Sent with Request changes, so it can't be edited.");
    expect(note(6)).toBeUndefined();
    // Without a recorded decision (an older broker) it says only that a decision sent it.
    expect(note(10)).toBe("Sent with a decision, so it can't be edited.");
  });

  it("AgentX's answer re-rendered from JSON is labelled as AI with who asked; an edited question says why it has no answer", async () => {
    const answer = comment(6, { parentId: id(1), author: { kind: "agentx", name: "AgentX", owner: false, you: false }, text: "Only the owner decides.", answering: "<b>Sam</b>" });
    const edited = comment(7, { agentx: "skipped", edited: true });
    let seq = 3;
    const page = boot(await pageHtml(), { respond: (entry) => {
      if (entry.url.endsWith("/api/state")) return { status: 200, body: { revision: 7, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 2 }], commentSeq: seq, csrf: "n".repeat(43) } };
      if (entry.url.endsWith("/api/comments")) return { status: 200, body: { comments: [comment(1, { agentx: "answered" }), answer, edited], suggestions: [] } };
      return { status: 200, body: {} };
    } });
    seq = 4;
    await page.advance(20_000);
    const shown = page.document.querySelector(`#comment-${id(6)}`)!;
    expect(shown.querySelector(".comment-meta")!.visibleText).toMatch(/^AgentX \(AI\) · answering <b>Sam<\/b>/);
    expect(shown.querySelectorAll("b")).toHaveLength(0);
    expect(page.document.querySelector(`#comment-${id(7)}`)!.visibleText).toContain("Edited after it was asked, so AgentX didn't answer.");
  });

  it("a 429 shows the slow-down sentence under the form", async () => {
    const slow = "You've posted a lot in the last 10 minutes. Try again in a few minutes.";
    const page = boot(await pageHtml(), { respond: (entry) => entry.method === "POST" ? { status: 429, body: { error: "slow_down", message: slow } } : { status: 200, body: {} } });
    page.document.querySelector('.comment-open[data-target="document"]')!.click();
    const form = page.document.querySelector('[data-comments="document"] .comment-form')!;
    expect(form.querySelector("label")!.textContent).toBe("Your comment");
    const ask = form.querySelectorAll("label").find((label) => label.textContent.includes("Ask AgentX to reply to this comment"));
    expect(ask).toBeDefined();
    form.querySelector("textarea")!.type_("One more thought.");
    form.querySelectorAll("button").find((button) => button.textContent === "Post")!.click();
    await page.settle();
    const error = form.querySelector(".comment-error")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(slow);
    expect(error.getAttribute("role")).toBe("alert");
    expect(form.querySelector("textarea")!.value).toBe("One more thought.");
    // Over 2,000 characters is refused before sending.
    form.querySelector("textarea")!.type_("x".repeat(2001));
    form.querySelectorAll("button").find((button) => button.textContent === "Post")!.click();
    await page.settle();
    expect(error.textContent).toBe("Keep comments under 2,000 characters.");
    expect(posts(page, "/api/comments")).toHaveLength(1);
  });

  it("no Ask AgentX box where AgentX cannot answer (a task not started in Slack)", async () => {
    const page = boot(await pageHtml({ askAvailable: false }));
    page.document.querySelector('.comment-open[data-target="document"]')!.click();
    const form = page.document.querySelector('[data-comments="document"] .comment-form')!;
    expect(form.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    expect(form.visibleText).not.toContain("Ask AgentX");
  });

  it("posting, replying, editing and deleting use the API and show the answer", async () => {
    const mine = comment(2, { author: { kind: "person", name: "Priya", owner: false, you: true }, version: 2, target: { kind: "document" } });
    const page = boot(await pageHtml(), { respond: (entry) => {
      if (entry.url.endsWith("/api/comments") && entry.method === "POST") {
        return { status: 201, body: { comment: comment(10, { ...(entry.body.parentId === undefined ? {} : { parentId: entry.body.parentId }), version: 2, text: entry.body.text ?? "", author: { kind: "person", name: "Maya", owner: true, you: true } }) } };
      }
      if (entry.url.endsWith("/edit")) return { status: 200, body: { comment: { ...mine, text: entry.body.text, edited: true, rev: 2 } } };
      if (entry.url.endsWith("/delete")) return { status: 200, body: { comment: { ...mine, text: "", deleted: true, rev: 3 } } };
      return { status: 200, body: {} };
    } });
    page.document.querySelector(`#comment-${id(1)} .reply-open`)!.click();
    const replyForm = page.document.querySelector(`#comment-${id(1)}`)!.parentElement!.querySelector(".comment-form")!;
    replyForm.querySelector("textarea")!.type_("Agreed.");
    replyForm.querySelectorAll("button").find((button) => button.textContent === "Post")!.click();
    await page.settle();
    const [reply] = posts(page, "/api/comments");
    expect(reply!.body).toMatchObject({ document: "plan", version: 2, parentId: id(1), text: "Agreed.", ask: false });
    expect(page.document.querySelector(`#comment-${id(1)}`)!.parentElement!.querySelector(".replies")!.visibleText).toContain("Agreed.");
    expect(page.document.querySelector(`#comment-${id(1)}`)!.parentElement!.querySelector(".comment-form")).toBeNull();
    const edit = page.document.querySelector(`#comment-${id(2)} .comment-edit`)!;
    expect(edit.getAttribute("aria-describedby")).toBe(`comment-${id(2)}`);
    edit.click();
    const editForm = page.document.querySelector(`#comment-${id(2)} .comment-form`)!;
    expect(editForm.querySelector("textarea")!.value).toBe("Comment 2");
    editForm.querySelector("textarea")!.type_("Comment 2, better.");
    editForm.querySelectorAll("button").find((button) => button.textContent === "Save")!.click();
    await page.settle();
    expect(posts(page, `/comments/${id(2)}/edit`)[0]!.body).toEqual({ rev: 1, text: "Comment 2, better." });
    expect(page.document.querySelector(`#comment-${id(2)}`)!.visibleText).toContain("(edited)");
    page.document.querySelector(`#comment-${id(2)} .comment-delete`)!.click();
    expect(page.document.querySelector(`#comment-${id(2)}`)!.visibleText).toContain("Delete this comment?");
    page.document.querySelector(`#comment-${id(2)}`)!.querySelectorAll("button").find((button) => button.textContent === "Delete" && !button.classList.contains("comment-delete"))!.click();
    await page.settle();
    expect(posts(page, `/comments/${id(2)}/delete`)[0]!.body).toEqual({ rev: 2 });
    expect(page.document.querySelector(`#comment-${id(2)}`)!.visibleText).toContain("Comment deleted");
  });

  it("a commenter suggests an option, and Suggest stays hidden when nothing is waiting", async () => {
    const page = boot(await pageHtml({ access: commenter }), { respond: (entry) => {
      if (entry.url.endsWith("/api/suggestions")) return { status: 200, body: { ok: true } };
      if (entry.url.endsWith("/api/comments")) return { status: 200, body: { comments: [], suggestions: [{ document: "plan", decisionId: "d2", optionId: "above", name: "Priya", you: true }, { document: "plan", decisionId: "d2", optionId: "above", name: "Sam", you: false }] } };
      return { status: 200, body: {} };
    } });
    expect(page.document.querySelector("#decide-next")).toBeNull();
    const suggest = page.document.querySelectorAll('.decision[data-decision="d2"] .suggest').find((button) => button.getAttribute("data-option") === "above")!;
    expect(suggest.hidden).toBe(false);
    suggest.click();
    await page.settle();
    expect(posts(page, "/api/suggestions")[0]!.body).toEqual({ document: "plan", decisionId: "d2", optionId: "above" });
    expect(suggest.textContent).toBe("You suggest this · Undo");
    expect(page.document.querySelector('.decision[data-decision="d2"] .suggestions')!.textContent).toBe("Priya and Sam suggest: Above");
    suggest.click();
    await page.settle();
    expect(posts(page, "/api/suggestions")[1]!.body).toEqual({ document: "plan", decisionId: "d2", optionId: null });
    const idle = boot(await pageHtml({ access: commenter, waiting: false }));
    expect(idle.document.querySelectorAll(".suggest").every((button) => button.hidden)).toBe(true);
  });

  it("keyboard: Escape closing the dialog still returns focus", async () => {
    const page = boot(await pageHtml());
    const button = page.byId("decide-request-changes");
    button.click();
    page.byId("decide-dialog").close();
    expect(page.document.activeElement).toBe(button);
    expect(page.byId("decide-dialog").getAttribute("aria-labelledby")).toBe("decide-title");
    page.document.dispatchEvent(makeEvent("keydown", page.document, { key: "Tab" }));
  });
});
