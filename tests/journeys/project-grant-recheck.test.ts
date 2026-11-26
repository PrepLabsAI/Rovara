// journey-gate: project-grant-recheck
// PROJECT-GRANT-RECHECK (security hotfix): a person STARTS a task (so they are its stored person; the task has no People list), and is then removed from the PROJECT (still in the company) or from the
// COMPANY. The stored person passes only with live company membership AND a current project grant (the test a People entry meets): no read and no act answers them, and nothing is started or spent.
// Real hosted wiring (the journey world: `createBrokerCoreRoot` over the fake table), the web app's own client and a CLI sign-in on the same front, Code's task page with a review session, the task
// action registry's presses as a chat account resolving to the person (the Slack press path, in process), and a colleague who is a current project administrator or company admin.
//   (a) removed from the PROJECT only (the grant is dropped with the one grant revoke, admin-actions.ts revokeProjectAccess); still a company member;
//   (b) removed from the COMPANY: (b1) the membership row is stamped revoked and NOTHING else happens (sessions alive, grant still there), (b2) what a member removal does in full.
//   (c) the leaver's open task is not orphaned: a current project administrator or company admin still acts on it, and `standing` says who it waits on.
// Every refusal case expects NO answer that shows the person the task or takes a move from them. A case that fails names the routes still answering.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_LEFT_PROJECT_WORDS } from "../../packages/contracts/src/index.js";
import { revokeProjectAccess } from "../../packages/broker/src/aws/admin-actions.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { TASK_ACTION_ENTRIES } from "../../packages/broker/src/core/task-actions/entries.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { createJourneyWorld, MAYA, type JourneyWorld } from "./harness/hosted-core.js";
import { asRemovedPerson, pageReader, removeFromCompany, writeReviewSession } from "./harness/page.js";
import { bearerRequest, writeCliSession } from "./harness/surviving.js";
import { planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

interface Observed { surface: string; route: string; method: string; status: number; code: string; shows: boolean; body: string }
type Ask = (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;

const errorOf = (text: string): { code: string } => {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return { code: parsed.error };
    const error = parsed.error as { code?: unknown } | undefined;
    return { code: typeof error?.code === "string" ? error.code : "-" };
  } catch { return { code: "-" }; }
};
/** The lists name the caller's own tasks (a 200 that does not name this task shows nothing of it); every other route is the task's own (or its session's), so a 2xx is an admission. */
const LISTS = new Set(["task list", "involved list", "decisions list", "sessions list"]);

interface Route { route: string; method: string; path: string; body?: unknown; read: boolean }
const req = (): { requestId: string } => ({ requestId: randomUUID() });

/** Every route a person's tools read, then every move (task action) the core serves on a task, with bodies that are at least well-formed: the access check comes first, so any answer but "no such task" admits the caller. */
function routes(taskId: string, sessionId: string): Route[] {
  const t = `/v1/dev/tasks/${taskId}`;
  const reads: Array<[string, string]> = [
    ["task read", t], ["events", `${t}/events`], ["diff (changes)", `${t}/diff?repository=demo`], ["plan", `${t}/plan`], ["proof / evidence", `${t}/evidence`], ["comments", `${t}/comments`],
    ["people", `${t}/people`], ["readers", `${t}/readers`], ["pr feedback", `${t}/workflow/feedback`], ["task list", "/v1/dev/tasks"], ["involved list", "/v1/dev/tasks?involved=1"],
    ["decisions list", "/v1/app/decisions"], ["merge state", `/v1/app/tasks/${taskId}/merge`], ["feature choices", `/v1/app/tasks/${taskId}/feature-choices`],
    ["sessions list", "/v1/app/sessions"], ["session read", `/v1/app/sessions/${sessionId}`], ["session log", `/v1/app/sessions/${sessionId}/log`],
  ];
  const posts: Array<[string, string, unknown]> = [
    ["answers (a move)", `${t}/answers`, { ...req(), round: 1, answers: [{ question: "q1", option: "a" }] }],
    ["cancel (a move)", `${t}/cancel`, req()],
    ["close", `${t}/close`, req()],
    ["plan decision (approve)", `${t}/workflow/decision`, { ...req(), decision: "APPROVE", expectedRevision: 1 }],
    ["step retry", `${t}/workflow/retry`, { ...req(), expectedRevision: 1 }],
    ["publish retry", `${t}/workflow/publish-retry`, { ...req(), expectedRevision: 1 }],
    ["send back", `${t}/workflow/send-back`, { ...req(), instructions: "do it again" }],
    ["review findings", `${t}/workflow/review-findings`, { ...req(), expectedRevision: 1, resolutions: [] }],
    ["run review", `${t}/workflow/review`, req()],
    ["open pull request", `${t}/pull-requests`, req()],
    ["share", `${t}/share`, req()],
    ["continue", `${t}/continue`, { ...req(), instructions: "keep going" }],
    ["feedback decision", `${t}/workflow/feedback-decision`, { ...req(), decision: "FIX" }],
    ["feedback retry", `${t}/workflow/feedback-retry`, req()],
    ["keep pull requests", `${t}/workflow/keep-pull-requests`, req()],
    ["page: accept findings", `/v1/app/tasks/${taskId}/review-findings`, { ...req(), expectedRevision: 1, candidateDigest: "a".repeat(64), resolutions: [] }],
    ["merge press", `/v1/app/tasks/${taskId}/merge`, { ...req(), expectedHeads: [{ repositoryId: "demo", number: 1, sha: "a".repeat(40) }], risk: "low" }],
    ["people: take ownership", `${t}/people/take-ownership`, { ...req(), expectedPeopleRevision: 1 }],
    ["people: set role", `${t}/people/role`, { ...req(), expectedPeopleRevision: 1, personId: randomUUID(), role: "viewer" }],
    ["people: add", `${t}/people/add`, { ...req(), expectedPeopleRevision: 1, developerId: "f".repeat(64), role: "viewer" }],
    ["readers: share", `${t}/readers/${"f".repeat(64)}`, { ...req(), role: "viewer" }],
    ["comment (a move)", `${t}/comments`, { ...req(), text: "hello", anchor: {} }],
    ["session: stop", `/v1/app/sessions/${sessionId}/stop`, req()],
    ["session: retry", `/v1/app/sessions/${sessionId}/retry`, req()],
    ["session: tell the agent", `/v1/app/sessions/${sessionId}/messages`, { ...req(), text: "also add a test" }],
    ["session: answers", `/v1/app/sessions/${sessionId}/answers`, { ...req(), answers: [] }],
    ["session: revise plan", `/v1/app/sessions/${sessionId}/revise-plan`, { ...req(), text: "change it" }],
    ["session: close", `/v1/app/sessions/${sessionId}/close`, req()],
    ["session: follow", `/v1/app/sessions/${sessionId}/follow`, {}],
  ];
  return [
    ...reads.map(([route, path]) => ({ route, method: "GET", path, read: true })),
    ...posts.map(([route, path, body]) => ({ route, method: route === "readers: share" ? "PUT" : "POST", path, body, read: false })),
  ];
}

/** `removed`: "company": the person is out of the company, so each request is refused, either by the core itself or at SIGN-IN with a 401 before any engine is asked (`asRemovedPerson`, harness/page.ts). "project": still in the company, so the core answers every request itself (the lists with 200, naming nothing of this task: `shows` checks that). */
async function observe(w: JourneyWorld, taskId: string, removed: "project" | "company" | false = "company"): Promise<Observed[]> {
  const sessionId = taskSessionId(taskId);
  const asked = <T>(request: () => Promise<T>): Promise<T> => removed === "company" ? asRemovedPerson(w, request) : request();
  const web: Ask = async (method, path, body) => { const r = await asked(() => w.maya(method, path, body)); return { status: r.status, text: JSON.stringify(r.body) }; };
  const cliPerson = writeCliSession(w, MAYA, Math.floor(Date.now() / 1000) + 6 * 86_400);
  const cli: Ask = async (method, path, body) => { const r = await asked(() => bearerRequest(w, cliPerson, method, path, body)); return { status: r.status, text: r.text }; };
  const out: Observed[] = [];
  for (const [surface, ask] of [["web client", web], ["CLI session", cli]] as const) {
    for (const r of routes(taskId, sessionId)) {
      const answer = await ask(r.method, r.path, r.body);
      const shows = answer.status < 300 && (!LISTS.has(r.route) || answer.text.includes(taskId));
      out.push({ surface, route: `${r.method} ${r.route}`, method: r.method, status: answer.status, ...errorOf(answer.text), shows, body: answer.text.slice(0, 160) });
    }
  }
  // D1-2 (pre-review S3): Code's task page is deleted and answers 404 to everyone, the owner included, so the "task page" rows below prove nothing; the rows that still prove the rule are the web client and CLI ones above.
  // Code's task page, with the person's review session (a plain sign-in, 30 days).
  const page = pageReader(w, taskId, writeReviewSession(w, MAYA));
  for (const [route, reply] of [["page: open", await page.open()], ["page: api state", await page.read("state")], ["page: api comments", await page.read("comments")]] as const) {
    out.push({ surface: "task page", route, method: "GET", status: reply.status, ...errorOf(reply.text), shows: reply.status === 200, body: reply.text.slice(0, 160) });
  }
  return out;
}

const table = (rows: Observed[]) => rows.map((row) => `${row.surface} | ${row.route} | ${String(row.status)} ${row.code}${row.shows ? " | SHOWS" : ""}`).join("\n");
const stillShown = (rows: Observed[]) => rows.filter((row) => row.shows).map((row) => `${row.surface}: ${row.route} -> ${String(row.status)}`);
/** Every route answers "no such task" (or, for the People proof, the proof's own refusal; for sessions, no such session) and nothing else: never a validation error, which would mean the access check let the caller in. */
const NOT_THERE = new Set(["TASK_NOT_FOUND", "NOT_FOUND"]);
/** The few refusals that are not "no such task" and that the owner meets too: the People proof's own words, taking ownership of a task that has an owner, and the two web-only routes a CLI sign-in is refused. They admit nothing. */
const OTHER_REFUSALS: Array<{ route: RegExp; surface?: string; status: number; code: string }> = [
  { route: /^GET people$/u, status: 403, code: "PROJECT_ACCESS_DENIED" },
  { route: /^POST people: (take ownership|set role|add)$/u, status: 403, code: "TASK_ACCESS_DENIED" },
  { route: /^POST (page: accept findings|merge press)$/u, surface: "CLI session", status: 403, code: "FORBIDDEN" },
];
const admitted = (rows: Observed[]) => rows.filter((row) => !LISTS.has(row.route.replace(/^GET /u, "")) && !(row.status === 404 && NOT_THERE.has(row.code))
  && !OTHER_REFUSALS.some((other) => other.route.test(row.route) && (other.surface === undefined || other.surface === row.surface) && other.status === row.status && other.code === row.code)
  && !(row.surface === "task page" && row.status === 404)).map((row) => `${row.surface}: ${row.route} -> ${String(row.status)} ${row.code}`);

/** What starting or spending would change: the admission asks, the machines started, the audit rows, the task's own rows. */
function ledgerOf(w: JourneyWorld, taskId: string) {
  return {
    spend: w.harness.world.spend.length,
    audit: w.harness.world.audit.length,
    rows: JSON.stringify(w.harness.db.find((row) => row.pk === `DEVTASK#${taskId}` || String(row.pk).includes(taskId))),
  };
}

/** A press answer line that says "no such task" and wrote nothing (the two held entries, people add and role, are offered to nobody: not_offered, for anyone). */
const REFUSED_AS_MISSING = /^(?:people\.add|people\.set-role): describe=refused\/not_offered perform=refused\/not_offered\/none$|describe=refused\/not_found perform=refused\/not_found\/none$/u;
const CHAT = { channel: "examplechat", tenant: "journey-team", userId: "maya" } as const;
const CONVERSATION = { channel: "examplechat", tenant: "journey-team", space: "orders", thread: "t1" } as const;

async function startedByMaya(options: { colleague?: NonNullable<Parameters<typeof createJourneyWorld>[0]>["colleague"] } = {}) {
  world = await createJourneyWorld({ page: true, chatPerson: async (_company, actor) => (actor.userId === "maya" ? { personId: MAYA.developerId, via: "signin" as const } : undefined), ...(options.colleague === undefined ? {} : { colleague: options.colleague }) });
  const taskId = await startTask(world);
  await planUntilCard(world, taskId);
  const companyId = world.harness.runtime.flow.deps.companyId;
  return { w: world, taskId, companyId };
}

const callerOf = () => ({ developerId: MAYA.developerId, sessionId: "journey-chat", name: MAYA.name });

/** The registry's presses, one per action (and the describe of each), as a chat account resolving to Maya: the Slack press path. `bindings` are the offers she had before. */
async function pressEveryAction(w: JourneyWorld, taskId: string, bindings: ReadonlyMap<string, unknown>): Promise<string[]> {
  const entry = w.harness.core.coreTasks!;
  const answers: string[] = [];
  for (const { id } of TASK_ACTION_ENTRIES) {
    const binding = bindings.get(id) ?? { revision: 1 };
    const base = { actionId: id, taskId, binding, conversation: CONVERSATION, actor: CHAT };
    const described = await entry.taskAction!(callerOf(), { mode: "describe", ...base });
    const performed = await entry.taskAction!(callerOf(), { mode: "perform", ...base, requestKey: `k-${id}-${randomUUID()}`, values: { reason: "x" } });
    answers.push(`${id}: describe=${described.mode === "describe" ? `${described.description.status}${described.description.status === "refused" ? `/${described.description.reason}` : ""}` : "?"} perform=${performed.mode === "perform" ? `${performed.result.status}${performed.result.status === "refused" ? `/${performed.result.reason}/${performed.result.writes}` : ""}` : "?"}`);
  }
  return answers;
}

async function offersOf(w: JourneyWorld, taskId: string): Promise<Map<string, unknown>> {
  const offers = await w.harness.core.coreTasks!.taskActions!(callerOf(), taskId);
  return new Map((offers ?? []).map((offer) => [offer.id, offer.binding]));
}

describe("a person who started a task (no People list) and is then removed", () => {
  it("(control) before any removal the owner is answered by every route, so a refusal below is the access rule and not a missing route", async () => {
    const { w, taskId } = await startedByMaya();
    const offers = await offersOf(w, taskId);
    expect([...offers.keys()], "the owner is offered moves through the registry").toEqual(expect.arrayContaining(["task.close", "people.view"]));
    // The chat path names her: a describe of a move she is offered is answered (so the refusals below are the access rule, not an unlinked chat).
    const described = await w.harness.core.coreTasks!.taskAction!(callerOf(), { mode: "describe", actionId: "task.close", taskId, binding: offers.get("task.close"), conversation: CONVERSATION, actor: CHAT });
    expect(described, JSON.stringify(described)).toMatchObject({ mode: "describe", description: { status: "ok" } });
    w.proof.assertAllCore();
    const rows = await observe(w, taskId, false);
    // Her own task: the reads show, and no route she could use answers "no such task".
    // (Two routes answer 404 for the owner for their own reasons: there is no PR feedback review yet, and the comment's anchor is not a plan's.)
    const missing = rows.filter((row) => row.status === 404 && row.code === "TASK_NOT_FOUND" && !/pr feedback|comment \(a move\)/u.test(row.route)).map((row) => `${row.surface}: ${row.route}`);
    expect(missing, `routes that do not know the task even for its owner:\n${table(rows)}`).toEqual([]);
    expect(stillShown(rows)).toEqual(expect.arrayContaining(["web client: GET task read -> 200", "web client: GET events -> 200", "web client: GET plan -> 200", "web client: GET session read -> 200"]));
  }, 240_000);

  it("(a) removed from the PROJECT only, still a company member: nothing shows, nothing moves, nothing starts or is spent", async () => {
    const { w, taskId, companyId } = await startedByMaya();
    const offers = await offersOf(w, taskId);
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", MAYA.developerId, companyId)).toEqual({ revoked: true });
    const before = ledgerOf(w, taskId);
    const rows = await observe(w, taskId, "project");
    expect(stillShown(rows), `routes that still answer a person removed from the project:\n${table(rows)}`).toEqual([]);
    expect(admitted(rows), `routes that let a person removed from the project in:\n${table(rows)}`).toEqual([]);
    // Every read says exactly "no such task".
    for (const route of ["GET task read", "GET events", "GET diff (changes)", "GET plan", "GET proof / evidence", "GET comments", "POST answers (a move)"]) {
      for (const row of rows.filter((candidate) => candidate.route === route)) expect([row.surface, row.status, row.code], row.route).toEqual([row.surface, 404, "TASK_NOT_FOUND"]);
    }
    // The task action registry, pressed as a chat account that is her (the Slack path): every action and its describe is refused as "not found", writing nothing.
    const presses = await pressEveryAction(w, taskId, offers);
    const taken = presses.filter((line) => !REFUSED_AS_MISSING.test(line));
    expect(taken, `registry presses that were not refused as not found:\n${presses.join("\n")}`).toEqual([]);
    expect(ledgerOf(w, taskId)).toEqual(before);
    w.proof.assertAllCore();
  }, 400_000);

  it("(b1) removed from the COMPANY (membership ended; sessions alive, grant not yet dropped): nothing shows, nothing moves", async () => {
    const { w, taskId } = await startedByMaya();
    const offers = await offersOf(w, taskId);
    removeFromCompany(w, MAYA);
    const before = ledgerOf(w, taskId);
    const rows = await observe(w, taskId);
    expect(stillShown(rows), `routes that still answer a person removed from the company:\n${table(rows)}`).toEqual([]);
    expect(rows.filter((row) => row.surface !== "task page" && !LISTS.has(row.route.replace(/^GET /u, "")) && row.status < 400).map((row) => `${row.surface}: ${row.route} -> ${String(row.status)}`)).toEqual([]);
    const presses = await pressEveryAction(w, taskId, offers);
    expect(presses.filter((line) => !REFUSED_AS_MISSING.test(line)), presses.join("\n")).toEqual([]);
    expect(ledgerOf(w, taskId)).toEqual(before);
    // A removed person's requests are each refused by the core or at sign-in with a 401 (the real-core check holds them to it), so nothing of the task was answered to them.
    w.proof.assertAllCore();
  }, 400_000);

  it("(b2) removed from the COMPANY by a full member removal (membership ended, sessions ended, non-admin grants dropped): nothing shows or moves, and her sign-in is refused", async () => {
    const { w, taskId, companyId } = await startedByMaya();
    const at = new Date(Date.now() + 1_000).toISOString();
    expect(await new CompanySignInStore({ documentClient: w.harness.db, tableName: "signin", now: Date.now }).setRevoked(companyId, MAYA.developerId, true)).toBe(true);
    expect(await new DeveloperSignInStore({ documentClient: w.harness.db, tableName: "signin", now: Date.now }).endSessions(MAYA.developerId, at)).toBe("ended");
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", MAYA.developerId, companyId)).toEqual({ revoked: true });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const before = ledgerOf(w, taskId);
    const rows = await observe(w, taskId);
    expect(stillShown(rows), `routes that still answer a fully removed person:\n${table(rows)}`).toEqual([]);
    expect(rows.find((row) => row.surface === "web client" && row.route === "GET task read")?.status).toBe(401);
    expect(ledgerOf(w, taskId)).toEqual(before);
    w.proof.assertAllCore();
  }, 400_000);

  it("(c1) the leaver's task is not orphaned: a current PROJECT ADMINISTRATOR (not a company admin) still reads it, stops it, and the standing says who it waits on", async () => {
    const { w, taskId, companyId } = await startedByMaya({ colleague: { role: "member", grant: "administrator" } });
    // While the owner holds the project, nobody reads "the owner left" on the task.
    const sessionBefore = await w.priya("GET", `/v1/app/sessions/${taskSessionId(taskId)}`);
    expect(sessionBefore.status, JSON.stringify(sessionBefore.body)).toBe(200);
    expect((sessionBefore.body as { session: { you: Record<string, unknown> } }).session.you).not.toHaveProperty("ownerLeft");
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", MAYA.developerId, companyId)).toEqual({ revoked: true });
    // Maya is out; Priya (project administrator) is not.
    expect((await w.maya("GET", `/v1/dev/tasks/${taskId}`)).status).toBe(404);
    // The leaver's merge state is no "mayMerge" at all (not found), never `true`; hers is `true`.
    expect((await w.maya("GET", `/v1/app/tasks/${taskId}/merge`)).body).not.toMatchObject({ mayMerge: true });
    const sessionId = taskSessionId(taskId);
    const session = await w.priya("GET", `/v1/app/sessions/${sessionId}`);
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    // The session says plainly, in the words table's own sentence, that the owner no longer has the project and what she can do (stop, merge): never a wait on nobody.
    expect((session.body as { session: { you: { ownerLeft?: string } } }).session.you.ownerLeft).toBe(OWNER_LEFT_PROJECT_WORDS);
    expect(OWNER_LEFT_PROJECT_WORDS).toMatch(/no longer has access to this project[\s\S]*stop[\s\S]*merge/u);
    // She reads it as a project maintainer (not as its owner) and may steer and stop it: the task is not left to nobody.
    expect(session.body).toMatchObject({ session: { you: { owner: false, level: "edit" } } });
    expect((session.body as { session: { you: { actions: string[] } } }).session.you.actions).toEqual(expect.arrayContaining(["steer", "stop"]));
    // What the task waits on, for the person who may act: the merge standing says she may merge (a project administrator), and she may stop it.
    const merge = await w.priya("GET", `/v1/app/tasks/${taskId}/merge`);
    expect(merge.status, JSON.stringify(merge.body)).toBe(200);
    expect(merge.body).toMatchObject({ mayMerge: true });
    const stopped = await w.priya("POST", `/v1/app/sessions/${sessionId}/stop`, { requestId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBeLessThan(300);
    w.proof.assertAllCore();
  }, 400_000);

  it("(c2) a COMPANY ADMIN who is not on the project still stops the leaver's task and may merge it; the leaver may not", async () => {
    const { w, taskId, companyId } = await startedByMaya({ colleague: { role: "admin", grant: "developer" } });
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", MAYA.developerId, companyId)).toEqual({ revoked: true });
    expect((await w.maya("POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() })).status).toBe(404);
    // A company admin who sees the task reads the same plain words.
    const seen = await w.priya("GET", `/v1/app/sessions/${taskSessionId(taskId)}`);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect((seen.body as { session: { you: { ownerLeft?: string } } }).session.you.ownerLeft).toBe(OWNER_LEFT_PROJECT_WORDS);
    const merge = await w.priya("GET", `/v1/app/tasks/${taskId}/merge`);
    expect(merge.status, JSON.stringify(merge.body)).toBe(200);
    expect(merge.body).toMatchObject({ mayMerge: true });
    // The registry gives her a standing (a live company admin reads the People view of any task; the stop is offered while a step runs), and gives the leaver none.
    const offered = await w.harness.core.coreTasks!.taskActions!({ developerId: "9".repeat(64), sessionId: "s-priya", name: "Priya Rao" }, taskId);
    expect((offered ?? []).map((offer) => offer.id)).toContain("people.view");
    expect(await w.harness.core.coreTasks!.taskActions!(callerOf(), taskId)).toEqual([]);
    const stopped = await w.priya("POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBeLessThan(300);
    w.proof.assertAllCore();
  }, 400_000);
});
