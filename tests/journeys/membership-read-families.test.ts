// journey-gate: membership-read-families
// MEMBERSHIP-READ-FAILS-SAFE, the route families the owner-task journey (removed-member-answer.test.ts) does not drive. Each family is driven with ONE failed membership or grant read, at each read of each
// request in turn (a plain error, so every unwrapped read shows), and the rule is the one rule: the request is served exactly as it is with every read working, or it answers the retryable 503
// RUNTIME_UNAVAILABLE; never 401, never "no such task" / "No such project.", never TASK_ACCESS_DENIED. A family whose control answer is itself a refusal (a member asking for an admin's route) keeps that refusal.
//   (d1) a company-sign-in CLI session (shared sign-in method), not only the Slack-typed one;
//   (d2) a task with a People list: its viewer (a web-proof person) and its owner;
//   (d2) a task shared to a reader;
//   (d3) the lessons, knowledge and erase routes (a member), (d4) the company admin routes (an admin): members, audit, events, invites, (d5) a person with no company at the access check, and (d6) a project administrator who is not the owner at the merge state.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { createJourneyWorld, MAYA, type JourneyWorld } from "./harness/hosted-core.js";
import { bearerRequest } from "./harness/surviving.js";
import { WEB_CLIENT, clientBearer, type Developer } from "../support/developer-task-broker.js";
import { planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

type Ask = (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;
interface Route { route: string; method: string; path: string; body?: unknown }
const PRIYA_ID = "9".repeat(64);

const codeOf = (text: string): string => {
  try { const parsed = JSON.parse(text) as { error?: unknown }; return typeof parsed.error === "string" ? parsed.error : typeof (parsed.error as { code?: unknown } | undefined)?.code === "string" ? (parsed.error as { code: string }).code : "-"; } catch { return "-"; }
};

/** A read of a person's company membership row or project grant row: the reads these journeys fail one at a time. */
function isMembershipOrGrantRead(input: Record<string, unknown>): boolean {
  const key = input["Key"] as { pk?: unknown; sk?: unknown } | undefined;
  if (typeof key?.pk !== "string" || typeof key.sk !== "string") return false;
  return key.pk.startsWith("COMPANY_MEMBER#") || (/(?:^|#)MEMBER#/u.test(key.pk) && key.sk.startsWith("PROJECT#"));
}

/** A request the broker's own front answers (its sign-in check, before any engine is asked) is not the core's, and is not held to the real-core rule. */
function frontAnswers(w: JourneyWorld, since: number): void { for (const call of w.proof.seen.slice(since)) if (!call.answeredByCore) call.kind = "other"; }

const asWeb = (w: JourneyWorld, who: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>): Ask => async (method, path, body) => {
  const since = w.proof.seen.length; const r = await who(method, path, body); frontAnswers(w, since); return { status: r.status, text: JSON.stringify(r.body) };
};

/** The control answer of each route (every read working), then one run per read with only that read failing. Returns the answers that break the rule, named. */
async function sweep(w: JourneyWorld, family: string, ask: Ask, routes: Route[], options: { mustServe?: boolean } = {}): Promise<string[]> {
  const state = { count: 0, failAt: 0 };
  const db = w.harness.db as unknown as { send: (command: { input: Record<string, unknown> }) => Promise<unknown> };
  const original = db.send;
  db.send = async (command) => {
    if (isMembershipOrGrantRead(command.input)) { state.count += 1; if (state.count === state.failAt) throw new Error("the store failed"); }
    return original(command);
  };
  const broken: string[] = [];
  let exercised = 0;
  try {
    for (const r of routes) {
      state.failAt = 0; state.count = 0;
      const control = await ask(r.method, r.path, r.body);
      const reads = state.count;
      if (options.mustServe !== false) expect(control.status, `${family} ${r.route}: the control answer is served (${control.text.slice(0, 160)})`).toBeLessThan(300);
      expect(control.status, `${family} ${r.route}: the control is not a sign-in refusal`).not.toBe(401);
      for (let read = 1; read <= reads; read += 1) {
        state.count = 0; state.failAt = read;
        const answer = await ask(r.method, r.path, r.body);
        exercised += 1;
        const retryable = answer.status === 503 && codeOf(answer.text) === "RUNTIME_UNAVAILABLE";
        if (!retryable && answer.status !== control.status) broken.push(`${family}: ${r.route}, read #${String(read)} of ${String(reads)} failed -> ${String(answer.status)} ${codeOf(answer.text)} (control ${String(control.status)})`);
      }
    }
  } finally { db.send = original; }
  expect(exercised, `${family}: the failing read was exercised`).toBeGreaterThan(0);
  return broken;
}

const taskReads = (taskId: string): Route[] => [
  { route: "task read", method: "GET", path: `/v1/dev/tasks/${taskId}` },
  { route: "events", method: "GET", path: `/v1/dev/tasks/${taskId}/events` },
  { route: "plan", method: "GET", path: `/v1/dev/tasks/${taskId}/plan` },
  { route: "comments", method: "GET", path: `/v1/dev/tasks/${taskId}/comments` },
  { route: "session read", method: "GET", path: `/v1/app/sessions/${taskSessionId(taskId)}` },
];

async function worldWithTask(options: { admin?: boolean } = {}) {
  world = await createJourneyWorld({ page: true, ...(options.admin === true ? { colleague: { role: "admin" as const, grant: "developer" as const } } : {}) });
  const taskId = await startTask(world);
  await planUntilCard(world, taskId);
  return { w: world, taskId };
}

describe("route families, each with ONE failed membership or grant read", () => {
  it("(d1) a company-sign-in CLI session (shared sign-in method) is served or told the retryable 503, never 'your sign-in has ended'", async () => {
    const { w, taskId } = await worldWithTask();
    const company = w.harness.runtime.flow.deps.companyId;
    // The session row a company's shared-method sign-in writes: a uuid id, the company, and the installMethod mark (the company-sign-in checks read only such a session).
    const sessionId = randomUUID();
    w.harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: MAYA.developerId, amr: "slack", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 6 * 86_400, companyId: company, installMethod: true });
    const cli: Developer = { ...MAYA, sessionId };
    const ask: Ask = async (method, path, body) => { const since = w.proof.seen.length; const r = await bearerRequest(w, cli, method, path, body); frontAnswers(w, since); return { status: r.status, text: r.text }; };
    const broken = await sweep(w, "company-sign-in CLI", ask, [...taskReads(taskId), { route: "task list", method: "GET", path: "/v1/dev/tasks" }, { route: "projects", method: "GET", path: "/v1/dev/projects" }]);
    expect(broken).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);

  it("(d2) a task shared to a reader: the reader is served or told the retryable 503, never 'no such task'", async () => {
    const { w, taskId } = await worldWithTask();
    const shared = await w.maya("PUT", `/v1/dev/tasks/${taskId}/readers/${PRIYA_ID}`, { requestId: randomUUID(), role: "viewer" });
    expect(shared.status, JSON.stringify(shared.body)).toBeLessThan(300);
    const broken = await sweep(w, "shared reader", asWeb(w, w.priya), taskReads(taskId).filter((r) => r.route === "task read" || r.route === "events"));
    expect(broken).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);

  it("(d3) the lessons, knowledge and erase routes (a member): served as with every read working, or the retryable 503; never 401 or 'No such project.'", async () => {
    const { w } = await worldWithTask();
    const routes: Route[] = [
      { route: "lessons-slack", method: "GET", path: "/v1/dev/me/lessons-slack" },
      { route: "company local-tools", method: "GET", path: "/v1/dev/company/lessons/local-tools" },
      { route: "project local-tools", method: "GET", path: "/v1/dev/projects/payments/lessons/local-tools" },
      { route: "lessons list", method: "GET", path: "/v1/dev/projects/payments/lessons?list=proposed" },
      { route: "lessons repeats", method: "GET", path: "/v1/dev/projects/payments/lessons/repeats?month=2026-11" },
      { route: "person erase", method: "POST", path: `/v1/app/people/${PRIYA_ID}/erase`, body: { requestId: randomUUID() } },
    ];
    const broken = await sweep(w, "lessons / knowledge / erase", asWeb(w, w.maya), routes, { mustServe: false });
    expect(broken).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);

  it("(d5) a person with NO company (no membership row): the access check is served or the retryable 503, never the 401 that signs a person without a company out", async () => {
    const { w } = await worldWithTask();
    const NEW: Developer = { developerId: "7".repeat(64), name: "New Person", provider: "oidc", sessionId: "s-new" };
    w.harness.db.set({ pk: `SESSION#web-app-${NEW.sessionId}`, sk: "META", sessionId: `web-app-${NEW.sessionId}`, developerId: NEW.developerId, amr: "oidc", clientId: "web-app", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    w.harness.db.set({ pk: `DEVELOPER#${NEW.developerId}`, sk: "META", entityType: "DEVELOPER", developerId: NEW.developerId, provider: "oidc", issuer: "https://x.example", subject: "new", displayName: NEW.name, firstSignInAt: "2026-11-01T00:00:00.000Z", lastSignInAt: "2026-11-01T00:00:00.000Z", revoked: false, companyless: true });
    const ask: Ask = async (method, path, body) => {
      const since = w.proof.seen.length;
      const r = await w.handler({ version: "2.0", rawPath: path.split("?")[0]!, rawQueryString: path.split("?")[1] ?? "", headers: { authorization: await clientBearer(NEW, WEB_CLIENT, `${WEB_CLIENT.clientId}-${NEW.sessionId}`) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: randomUUID(), http: { method } } });
      frontAnswers(w, since);
      return { status: r.statusCode, text: String(r.body) };
    };
    const broken = await sweep(w, "no company", ask, [{ route: "access check", method: "POST", path: "/v1/dev/access", body: {} }]);
    expect(broken).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);

  it("(d6) a project administrator who is not the task's owner asks its merge state: served as with every read working, or the retryable 503; never 'no such task'", async () => {
    world = await createJourneyWorld({ page: true, colleague: { role: "member" as const, grant: "administrator" as const } });
    const w = world;
    const taskId = await startTask(w);
    await planUntilCard(w, taskId);
    const broken = await sweep(w, "project administrator merge state", asWeb(w, w.priya), [{ route: "merge state", method: "GET", path: `/v1/app/tasks/${taskId}/merge` }]);
    expect(broken).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);

  it("(d4) the company admin routes (an admin): members, audit records, events, invites are served as with every read working, or the retryable 503; never 401", async () => {
    const { w } = await worldWithTask({ admin: true });
    const routes: Route[] = [
      { route: "members", method: "GET", path: "/v1/dev/company/members" },
      { route: "audit records", method: "GET", path: "/v1/dev/client/company/audit/records" },
      { route: "events", method: "GET", path: "/v1/dev/client/company/events" },
      { route: "invites", method: "GET", path: "/v1/dev/company/preapprovals" },
    ];
    const broken = await sweep(w, "company admin", asWeb(w, w.priya), routes, { mustServe: false });
    expect(broken).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);
});
