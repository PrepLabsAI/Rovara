// Lane L8: fakes for the local pages' data and actions, and a raw HTTP client that can set any Host header (fetch cannot).
import { request as httpRequest } from "node:http";
import { type ApprovalOffer, type DesignReviewView, type LessonLocalToolsView, type LessonReposView, type LessonView, type LocalActionResult, type LocalPageActions, type LocalPageData, type PlanPageView, type ProofReportView } from "../../packages/broker/src/core/local-pages/index.js";
import { planDocument } from "./plan-documents.js";

export const TASK = "0b4f2b1e-3c6a-4d2e-9a77-5f1d8c0a1e11";
export const OTHER_TASK = "9d2c7a40-1b3e-4f55-8a21-6c7e90b4d2aa";

export const OFFER: ApprovalOffer = { requestId: "card-1", revision: 3, artifactDigest: "sha256-aaaa", kind: "plan" };
export const DESIGN_OFFER: ApprovalOffer = { requestId: "design-card-1", revision: 5, artifactDigest: "sha256-bbbb", kind: "design" };

export function planView(overrides: Partial<PlanPageView> = {}): PlanPageView {
  return {
    taskId: TASK, title: "Retry failed payments", status: "waiting for your decision", revision: 3,
    versions: [{ version: 2, kind: "coding plan", approved: false, current: true, content: { format: "structured", plan: planDocument() } }],
    checks: [{ label: "unit tests", status: "passed" }, { label: "lint", status: "not_run" }],
    findings: [{ role: "security", text: "Check the retry limit.", file: "src/charge.ts", line: 12 }],
    pullRequests: [{ url: "https://github.com/example/repo/pull/7", number: 7, state: "open" }],
    comments: [{ id: "c1", author: "Dana", at: "2026-11-09 10:00", target: "1", text: "Please cap the wait." }],
    approval: OFFER,
    ...overrides,
  };
}

export function designView(overrides: Partial<DesignReviewView> = {}): DesignReviewView {
  return {
    taskId: TASK, title: "New settings screen", state: "waiting", revision: 5, summary: "Two reviewers checked the layout.",
    mockups: [{ id: "m1", caption: "Settings, desktop", contentType: "image/png" }, { id: "m2", caption: "Vector", contentType: "image/svg+xml" }],
    findings: [{ id: "f1", severity: "concern", reviewer: "model-a", text: "The save button is hard to find.", evidence: [{ label: "Settings, desktop", mockupId: "m1" }] }],
    approval: DESIGN_OFFER,
    ...overrides,
  };
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface FakeWorld {
  data: LocalPageData & { plan: PlanPageView | undefined; design: DesignReviewView | undefined; lessons: LessonView[]; lessonRepos: LessonReposView[]; lessonLocalTools: LessonLocalToolsView | undefined; proof: ProofReportView | undefined; mockupReads: string[] };
  actions: LocalPageActions & { calls: Array<{ name: string; input: unknown }>; next: LocalActionResult };
}

export function fakeWorld(): FakeWorld {
  const data: FakeWorld["data"] = {
    plan: planView(), design: designView(), lessons: [
      { id: "L1", text: "Run the formatter before committing.", scope: "this repository", status: "proposed", usedIn: [{ taskId: TASK, title: "Retry failed payments" }] },
      { id: "L2", text: "Prefer small commits.", scope: "this repository", status: "active", usedIn: [] },
    ],
    proof: { taskId: TASK, title: "Retry failed payments", revision: 3, summary: "Two of three claims have a passing check.", cost: "spent $0.42", rows: [
      { claim: "Timeouts are retried", check: "retry.test.ts", status: "passed" }, { claim: "Never charged twice", check: "idempotency.test.ts", status: "failed", detail: "1 failing" },
    ], pullRequests: [{ url: "https://github.com/example/repo/pull/7", number: 7, state: "open" }] },
    lessonRepos: [{ project: "payments", canEnable: true, repos: [{ repo: "api", enabled: false, fileDeleted: false, pointer: "not_yet", notices: [] }], available: [] }],
    lessonLocalTools: undefined,
    mockupReads: [],
    async listPending() { return [{ kind: "plan", taskId: TASK, title: "Retry failed payments", since: "10:00" }, { kind: "design", taskId: OTHER_TASK, title: "<b>Settings</b>", since: "09:00" }]; },
    async getPlanPage(taskId) { return taskId === TASK ? data.plan : undefined; },
    async getDesignReview(taskId) { return taskId === TASK ? data.design : undefined; },
    async readMockup(taskId, mockupId) {
      data.mockupReads.push(`${taskId}/${mockupId}`);
      return mockupId === "m1" ? { contentType: "image/png", bytes: PNG } : mockupId === "m2" ? { contentType: "image/svg+xml", bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>") } : undefined;
    },
    async listLessons() { return data.lessons; },
    async listLessonRepos() { return data.lessonRepos; },
    async listLessonLocalTools() { return data.lessonLocalTools; },
    async getProofReport(taskId) { return taskId === TASK ? data.proof : undefined; },
  };
  const calls: FakeWorld["actions"]["calls"] = [];
  const actions: FakeWorld["actions"] = {
    calls, next: { ok: true },
    async decidePlan(input) { calls.push({ name: "decidePlan", input }); return actions.next; },
    async decideDesign(input) { calls.push({ name: "decideDesign", input }); return actions.next; },
    async addComment(input) { calls.push({ name: "addComment", input }); return actions.next; },
    async lessonAction(input) { calls.push({ name: "lessonAction", input }); return actions.next; },
    async lessonRepoAction(input) { calls.push({ name: "lessonRepoAction", input }); return actions.next; },
    async lessonLocalToolsAction(input) { calls.push({ name: "lessonLocalToolsAction", input }); return actions.next; },
  };
  return { data, actions };
}

export interface RawReply { status: number; headers: Record<string, string | string[] | undefined>; body: string; bytes: Buffer }

/** One request with exactly the headers given (a real Host header, any Origin), so a test can play a browser or an attacker. */
export function raw(origin: string, input: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawReply> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: url.hostname, port: Number(url.port), method: input.method ?? "GET", path: input.path, headers: input.headers, setHost: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: bytes.toString("utf8"), bytes });
      });
    });
    request.on("error", reject);
    request.end(input.body);
  });
}

/** The hidden fields of the first form on a page whose action ends with `suffix`, and its action path. */
export function formOf(page: string, suffix: string): { action: string; fields: Record<string, string> } {
  const decode = (text: string) => text.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const match of page.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    const action = decode(match[1] ?? "");
    if (!action.endsWith(suffix)) continue;
    const fields: Record<string, string> = {};
    for (const input of (match[2] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[decode(input[1] ?? "")] = decode(input[2] ?? "");
    return { action, fields };
  }
  throw new Error(`no form ending ${suffix}`);
}

export const formBody = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
