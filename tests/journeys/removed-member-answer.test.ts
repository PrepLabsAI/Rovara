// journey-gate: removed-member-answer
// MEMBERSHIP-READ-FAILS-SAFE (was REMOVED-MEMBER-ANSWER, security; briefs/arch-cleanup/REMOVED-MEMBER-ANSWER-FINDINGS.md; plan DECOUPLE-CODE-CLOUD-PLAN.md 9.4): what the hosted core answers
// a person whose company membership is gone, and what it answers when the membership READ fails for a moment. The rule: "the read says NO membership" ends access as it always did; "the read FAILED" is a retryable 503
// that serves nothing, ends nothing and is never read as "no such task" or "sign in again" (core/membership-read.ts). The engine's own 401 `UNAUTHENTICATED` and the no-company words are NOT this lane's (T1a/T1b). Real hosted wiring (the journey world), the web app's own client and a CLI sign-in
// on the same front. A member starts a task and has its screen open (control: every read is 200), then:
//   (a) is REMOVED FROM THE COMPANY (the membership row is stamped revoked; sessions alive, which is the window between the stamp and the session end): the web client's every route and the access check
//       answer 401 AUTH_REQUIRED at sign-in, exactly as before the fix;
//   (b) the membership store THROWS once (a plain error, not a throttle the broker would already answer 503, so every unwrapped read shows), for ONE read of one request (every read a request makes in turn): no route may answer 401 (a 401 ends the person's session at Cloud), and every
//       route that cannot be served answers a retryable 503 (never "no such task", never "no such session");
//   (c) PROOF a failing read cannot keep anyone in: a REMOVED person is served nothing on any route whichever read fails; a session that has ENDED stays ended (401) whichever read fails.
// A case that fails names the route, the read that failed and the answer.
import { afterEach, describe, expect, it } from "vitest";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { createJourneyWorld, MAYA, type JourneyWorld } from "./harness/hosted-core.js";
import { removeFromCompany } from "./harness/page.js";
import { bearerRequest, writeCliSession } from "./harness/surviving.js";
import { planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

interface Row { surface: string; route: string; status: number; code: string; message: string }
type Ask = (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;

const errorOf = (text: string): { code: string; message: string } => {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") return { code: parsed.error, message: typeof parsed.message === "string" ? parsed.message : "" };
    const error = parsed.error as { code?: unknown; message?: unknown } | undefined;
    return { code: typeof error?.code === "string" ? error.code : "-", message: typeof error?.message === "string" ? error.message : "" };
  } catch { return { code: "-", message: "" }; }
};

/** What a task screen reads (the task, its plan, its comments, its session, the lists) and the person's access check, with the move-free routes only: a read never changes the task, so a failing read can be repeated. */
function reads(taskId: string): Array<{ route: string; method: string; path: string; body?: unknown }> {
  const t = `/v1/dev/tasks/${taskId}`;
  const sessionId = taskSessionId(taskId);
  return [
    { route: "task read", method: "GET", path: t },
    { route: "events", method: "GET", path: `${t}/events` },
    { route: "plan", method: "GET", path: `${t}/plan` },
    { route: "proof / evidence", method: "GET", path: `${t}/evidence` },
    { route: "comments", method: "GET", path: `${t}/comments` },
    { route: "readers", method: "GET", path: `${t}/readers` },
    { route: "task list", method: "GET", path: "/v1/dev/tasks" },
    { route: "decisions list", method: "GET", path: "/v1/app/decisions" },
    { route: "merge state", method: "GET", path: `/v1/app/tasks/${taskId}/merge` },
    { route: "sessions list", method: "GET", path: "/v1/app/sessions" },
    { route: "session read", method: "GET", path: `/v1/app/sessions/${sessionId}` },
    { route: "session log", method: "GET", path: `/v1/app/sessions/${sessionId}/log` },
    { route: "access check", method: "POST", path: "/v1/dev/access", body: {} },
    { route: "projects", method: "GET", path: "/v1/dev/projects" },
  ];
}

function surfaces(w: JourneyWorld, wrap: <T>(request: () => Promise<T>) => Promise<T> = (request) => request()): Array<[string, Ask]> {
  const cli = writeCliSession(w, MAYA, Math.floor(Date.now() / 1000) + 6 * 86_400);
  return [
    ["web client", async (method, path, body) => { const r = await wrap(() => w.maya(method, path, body)); return { status: r.status, text: JSON.stringify(r.body) }; }],
    ["CLI session", async (method, path, body) => { const r = await wrap(() => bearerRequest(w, cli, method, path, body)); return { status: r.status, text: r.text }; }],
  ];
}

const table = (rows: Row[]) => rows.map((row) => `${row.surface} | ${row.route} | ${String(row.status)} ${row.code} | ${row.message.slice(0, 90)}`).join("\n");

async function memberWithTaskOpen() {
  world = await createJourneyWorld({ page: true });
  const taskId = await startTask(world);
  await planUntilCard(world, taskId);
  return { w: world, taskId };
}

/** A read of a person's company membership row, or of their project grant row (`MEMBER#<person>` / `PROJECT#<name>`, under the company's partition or not): the reads this journey fails one at a time. */
function isMembershipOrGrantRead(input: Record<string, unknown>): boolean {
  const key = input["Key"] as { pk?: unknown; sk?: unknown } | undefined;
  if (typeof key?.pk !== "string" || typeof key.sk !== "string") return false;
  return key.pk.startsWith("COMPANY_MEMBER#") || (/(?:^|#)MEMBER#/u.test(key.pk) && key.sk.startsWith("PROJECT#"));
}

/** A request the broker's own front answers (its sign-in check, before any engine is asked) is not the core's, and is not held to the real-core rule. */
function frontAnswers(w: JourneyWorld, since: number): void {
  for (const call of w.proof.seen.slice(since)) if (!call.answeredByCore) call.kind = "other";
}
const refusedBeforeTheCore = (w: JourneyWorld) => async <T>(request: () => Promise<T>): Promise<T> => { const since = w.proof.seen.length; const answer = await request(); frontAnswers(w, since); return answer; };

describe("a member with a task screen open", () => {
  it("(control) before anything fails, every read of the screen answers 200 (or its own fixed refusal), so an answer below is the removal or the failed read and not a missing route", async () => {
    const { w, taskId } = await memberWithTaskOpen();
    for (const [surface, ask] of surfaces(w)) {
      for (const r of reads(taskId).filter((candidate) => ["task read", "plan", "comments", "task list", "decisions list", "merge state", "sessions list", "session read"].includes(candidate.route) || (surface === "web client" && candidate.route === "access check"))) {
        const answer = await ask(r.method, r.path, r.body);
        expect(answer.status, `${surface} ${r.route}: ${answer.text.slice(0, 200)}`).toBe(200);
      }
    }
    w.proof.assertAllCore({ callbacks: false });
  }, 240_000);

  it("(a1) REMOVED FROM THE COMPANY, web client (Cloud's kind of token): every read and the access check answer 401 AUTH_REQUIRED at sign-in, so Cloud's refresh and its access check both end the sign-in (it never reaches the 501 'not on this Code yet')", async () => {
    const { w, taskId } = await memberWithTaskOpen();
    removeFromCompany(w, MAYA);
    const rows: Row[] = [];
    const web: Ask = surfaces(w, refusedBeforeTheCore(w))[0]![1];
    for (const r of reads(taskId)) { const a = await web(r.method, r.path, r.body); rows.push({ surface: "web client", route: r.route, status: a.status, ...errorOf(a.text) }); }
    expect(rows.filter((row) => !(row.status === 401 && row.code === "AUTH_REQUIRED")).map((row) => `${row.route} -> ${String(row.status)} ${row.code}`), table(rows)).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 240_000);

  it("(b1) the membership read FAILS once, in any one place of a request: no route answers 401 (a 401 ends the session at Cloud, and the person is still a member)", async () => {
    const { w, taskId } = await memberWithTaskOpen();
    const failures = await readsWithOneFailedMembershipRead(w, taskId);
    expect(failures.filter((row) => row.status === 401).map((row) => `${row.surface}: ${row.route}, read #${row.read} of ${row.reads} failed -> ${String(row.status)} ${row.code} "${row.message.slice(0, 60)}"`)).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);

  it("(b2) the membership read FAILS once: each route is served anyway (2xx) or answers a retryable 503 RUNTIME_UNAVAILABLE, never 'no such task', 'no such session' or a sign-in refusal", async () => {
    const { w, taskId } = await memberWithTaskOpen();
    const failures = await readsWithOneFailedMembershipRead(w, taskId);
    const wrong = failures.filter((row) => !(row.status < 300 || (row.status === 503 && row.code === "RUNTIME_UNAVAILABLE")));
    expect(wrong.map((row) => `${row.surface}: ${row.route}, read #${row.read} of ${row.reads} failed -> ${String(row.status)} ${row.code} "${row.message.slice(0, 60)}"`)).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);

  it("(c1) PROOF: a REMOVED person cannot use a failing read to stay served: whichever read fails, no route answers them 2xx (a failed read refuses or answers 503, never serves)", async () => {
    const { w, taskId } = await memberWithTaskOpen();
    removeFromCompany(w, MAYA);
    const answers = await readsWithOneFailedMembershipRead(w, taskId, { served: false });
    expect(answers.length, "the failing read was exercised").toBeGreaterThan(10);
    expect(answers.filter((row) => row.status < 300).map((row) => `${row.surface}: ${row.route}, read #${row.read} failed -> ${String(row.status)}`)).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);

  it("(c2) PROOF: a session that has ENDED, was REVOKED or was ended by an admin stays ended: whichever membership read fails, the web client's every route answers 401 and a failed read never extends it", async () => {
    const { w, taskId } = await memberWithTaskOpen();
    const sessionKey = `SESSION#web-app-${MAYA.sessionId}`;
    const developerKey = `DEVELOPER#${MAYA.developerId}`;
    const session = w.harness.db.get(sessionKey, "META")!;
    const developer = w.harness.db.get(developerKey, "META")!;
    // `strict`: the session row is checked BEFORE any membership read, so every answer is the 401. An admin's end is checked AFTER the membership read, so a failed read there may answer the retryable 503 first (nothing is served; the retry is the 401).
    const variants: Array<[string, boolean, () => void]> = [
      ["past endsAt", true, () => w.harness.db.set({ ...session, endsAt: Math.floor(Date.now() / 1000) - 60 })],
      ["revokedAt", true, () => w.harness.db.set({ ...session, revokedAt: new Date(Date.now() - 1_000).toISOString(), revokedReason: "admin" })],
      ["sessionsEndedAt", false, () => w.harness.db.set({ ...developer, sessionsEndedAt: new Date(Date.now() + 5_000).toISOString() })],
    ];
    const state = { count: 0, failAt: 0 };
    const db = w.harness.db as unknown as { send: (command: { input: Record<string, unknown> }) => Promise<unknown> };
    const original = db.send;
    db.send = async (command) => {
      if (isMembershipOrGrantRead(command.input)) { state.count += 1; if (state.count === state.failAt) throw new Error("the store failed"); }
      return original(command);
    };
    const web: Ask = surfaces(w, refusedBeforeTheCore(w))[0]![1];
    const answered: string[] = [];
    try {
      for (const [name, strict, end] of variants) {
        w.harness.db.set(session); w.harness.db.set(developer);
        end();
        for (const r of reads(taskId)) for (let failAt = 0; failAt <= 3; failAt += 1) {
          state.count = 0; state.failAt = failAt;
          const a = await web(r.method, r.path, r.body);
          if (a.status !== 401 && !(!strict && a.status === 503)) answered.push(`${name}: ${r.route}, read #${String(failAt)} failed -> ${String(a.status)}`);
        }
      }
    } finally { db.send = original; }
    expect(answered).toEqual([]);
    w.proof.assertAllCore({ callbacks: false });
  }, 400_000);
});

interface Failure extends Row { read: number; reads: number }

/**
 * For each route and each surface: ask once to count the membership reads the request makes, then ask again once per read with ONLY that read failing (the store throws as DynamoDB does
 * when throttled). The failing read is the Nth membership-row read of that one request, wherever it sits (the broker's sign-in check, the engine's caller mapping, a grant or standing check).
 */
async function readsWithOneFailedMembershipRead(w: JourneyWorld, taskId: string, options: { served?: boolean } = {}): Promise<Failure[]> {
  const state = { count: 0, failAt: 0 };
  const db = w.harness.db as unknown as { send: (command: { input: Record<string, unknown> }) => Promise<unknown> };
  const original = db.send;
  db.send = async (command) => {
    if (isMembershipOrGrantRead(command.input)) {
      state.count += 1;
      if (state.count === state.failAt) throw new Error("the store failed");
    }
    return original(command);
  };
  const out: Failure[] = [];
  try {
    for (const [surface, ask] of surfaces(w)) {
      // The access check is the web client's own (a CLI session is refused it before and after any failure).
      for (const r of reads(taskId).filter((candidate) => candidate.route !== "access check" || surface === "web client")) {
        state.failAt = 0; state.count = 0;
        const countedSince = w.proof.seen.length;
        const counted = await ask(r.method, r.path, r.body);
        frontAnswers(w, countedSince);
        if (options.served !== false) expect(counted.status, `${surface} ${r.route} before any failure: ${counted.text.slice(0, 160)}`).toBeLessThan(300);
        const reads = state.count;
        for (let read = 1; read <= reads; read += 1) {
          state.count = 0; state.failAt = read;
          const since = w.proof.seen.length;
          const answer = await ask(r.method, r.path, r.body);
          frontAnswers(w, since);
          out.push({ surface, route: r.route, status: answer.status, ...errorOf(answer.text), read, reads });
        }
      }
    }
  } finally {
    db.send = original;
  }
  return out;
}
