// Spec 061 slice 2, Task 7: the task page's deciding and commenting script, run against the page the server renders,
// parsed into a small fake DOM inside a vm sandbox.
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { PlanDocument } from "@agentx/contracts";
import { createTaskWeb, type TaskDocumentEntry, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { TASK_PAGE_DECIDING_COPY, TASK_PAGE_DECIDING_SCRIPT } from "../../packages/broker/src/aws/task-page-assets.js";
import type { PageCommentView } from "../../packages/broker/src/aws/plan-page/comments.js";
import { fakeStorage, parseHtml, type FakeDocument } from "../support/fake-dom.js";
import { planDocument } from "../support/plan-documents.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const caller = { developerId: "d".repeat(64), sessionId: "s", amr: "slack", name: "Maya" } as const;
const SESSION = "__Host-agentx_review_session=11111111-1111-4111-8111-111111111111";
const digest = "f".repeat(64);
const BANNED = /\b(candidate|revision|digest|operation|artifact|workflow|invalid json)\b|\b(SUCCEEDED|FAILED|INTERRUPTED|CANCELLED)\b/i;
const owner = { role: "owner" as const, canComment: true, canSuggest: false, canDecide: true, canAsk: true };

const option = (id: string, label: string) => ({ id, label, consequence: `${label} it is.` });
/** Six decisions: d1 sits on a folded child claim, d6 under "Show 1 more decision". */
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

interface PageOptions { applicationRetry?: { canRetry: boolean }; version?: number; body?: PlanDocument; comments?: PageCommentView[]; access?: typeof owner | { role: "commenter"; canComment: boolean; canSuggest: boolean; canDecide: boolean; canAsk: boolean }; waiting?: boolean; optionalChecks?: TaskDocumentView["optionalChecks"]; askAvailable?: boolean }
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
    ...(options.applicationRetry === undefined ? {} : { applicationRetry: options.applicationRetry }),
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
  const navigations: string[] = [];
  let uuids = 0;
  let timerId = 0;
  const respond = options.respond ?? (() => ({ status: 200, body: {} }));
  const sandbox: Record<string, unknown> = {
    document,
    location: { hash: "", search: "", pathname: `/review/${taskId}/task`, reload: () => { reloads.push(clock.now); }, assign: (value: string) => { navigations.push(value); } },
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
  return { document, storage, sent, pending, timers, clock, reloads, navigations, settle, advance, byId };
}
type Page = ReturnType<typeof boot>;

const radio = (page: Page, decision: string, value: string) => page.document.querySelectorAll(`input[name="answer-${decision}"]`).find((input) => input.getAttribute("value") === value)!;
const posts = (page: Page, path: string) => page.sent.filter((entry) => entry.method === "POST" && entry.url.endsWith(path));
const commentBoxes = (page: Page) => page.byId("decide-comments-list").querySelectorAll("input[type=checkbox]");

describe("the deciding and commenting script", () => {
  describe("retrying a blocked browser and API round", () => {
    const blockedPage = async (canRetry = true) => (await pageHtml({ waiting: false, applicationRetry: { canRetry } }));

    it("shows the owner a Retry button that posts the page's revision and a fresh request ID, then reloads", async () => {
      const page = boot(await blockedPage(), { respond: (entry) => entry.url.endsWith("/api/retry") ? { status: 200, body: { revision: 8 } } : { status: 200, body: {} } });
      const button = page.byId("retry-application");
      expect(button.hidden).toBe(false);
      button.click();
      await page.settle();
      expect(posts(page, "/api/retry")).toHaveLength(1);
      expect(posts(page, "/api/retry")[0]!.body).toEqual({ requestId: posts(page, "/api/retry")[0]!.body.requestId, expectedRevision: 7 });
      expect(posts(page, "/api/retry")[0]!.body.requestId).toMatch(/^aaaaaaaa-aaaa-4aaa-8aaa-/);
      expect(page.reloads).toHaveLength(1);
    });

    it("gives a reader who is not the owner no button and no way to post", async () => {
      const html = await blockedPage(false);
      expect(html).not.toContain('id="retry-application"');
      expect(html).toContain("Only the task owner can retry these checks.");
      expect(boot(html).sent.filter((entry) => entry.method === "POST")).toEqual([]);
    });

  });


  it.each([403, 404])("invalidates handlers and pending writes when state returns %i", async (status) => {
    const storage = fakeStorage();
    storage.setItem(`agentx:${taskId}:coding-plan`, JSON.stringify({ v: 1, at: 1_000_000, answers: {}, opened: [], drafts: {}, excluded: [], note: "private" }));
    storage.setItem("agentx:other-task:coding-plan", JSON.stringify({ v: 1, at: 1_000_000, answers: {}, opened: [], drafts: {}, excluded: [], note: "other" }));
    const page = boot(await pageHtml(), { storage, respond: (entry) => {
      if (entry.url.endsWith("/api/state")) return { status, body: { error: "reader_removed" } };
      if (entry.method === "POST") return undefined;
      return { status: 200, body: {} };
    } });
    page.document.querySelector('.comment-open[data-target="claim:2"]')!.click();
    const form = page.document.querySelector('[data-comments="claim:2"] .comment-form')!;
    form.querySelector("textarea")!.type_("late");
    form.querySelectorAll("button").find((button) => button.textContent === "Post")!.click();
    await page.advance(20_000);
    page.pending[0]!({ status: 200, body: { comment: comment(78) } });
    await page.settle();
    expect(page.document.querySelector("main")!.hidden).toBe(true);
    expect(page.document.getElementById("comment-" + id(78))).toBeNull();
    expect(storage.getItem(`agentx:${taskId}:coding-plan`)).toBeNull();
    expect(storage.getItem("agentx:other-task:coding-plan")).not.toBeNull();
    const before = posts(page, "/comments").length;
    form.querySelectorAll("button").find((button) => button.textContent === "Post")!.click();
    await page.advance(60_000);
    expect(posts(page, "/comments")).toHaveLength(before);
    expect(page.sent.filter((entry) => entry.url.endsWith("/api/state"))).toHaveLength(1);
    expect(page.timers).toHaveLength(0);
  });

  it.each([403, 404])("clears the exact task after a write response returns %i", async (status) => {
    const storage = fakeStorage();
    storage.setItem(`agentx:${taskId}:coding-plan`, JSON.stringify({ v: 1, at: 1_000_000, answers: {}, opened: [], drafts: {}, excluded: [], note: "private" }));
    storage.setItem("agentx:other-task:coding-plan", JSON.stringify({ v: 1, at: 1_000_000, answers: {}, opened: [], drafts: {}, excluded: [], note: "other" }));
    const page = boot(await pageHtml(), { storage, respond: (entry) => entry.method === "POST" ? { status, body: { error: "reader_removed" } } : { status: 200, body: {} } });
    page.document.querySelector('.comment-open[data-target="claim:2"]')!.click();
    const form = page.document.querySelector('[data-comments="claim:2"] .comment-form')!;
    form.querySelector("textarea")!.type_("remove me");
    form.querySelectorAll("button").find((button) => button.textContent === "Post")!.click();
    await page.settle();
    expect(page.document.querySelector("main")!.hidden).toBe(true);
    expect(storage.getItem(`agentx:${taskId}:coding-plan`)).toBeNull();
    expect(storage.getItem("agentx:other-task:coding-plan")).not.toBeNull();
  });

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

});
