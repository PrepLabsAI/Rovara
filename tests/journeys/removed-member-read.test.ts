// journey-gate: removed-member-read
// REMOVED-MEMBER-READ (briefs/arch-cleanup/REMOVED-MEMBER-READ-REPRO.md): a person STARTS a task (so they are its stored person; the task has no People list), and is then removed.
// Which reads (and the two moves a starter makes) does the hosted core still answer for them? Real hosted wiring (the journey world: `createBrokerCoreRoot` over the fake table), the web app's
// own client and a CLI sign-in on the same front, and Code's task page with a review session. Nothing here is a unit fake of the access rule.
//   (a) removed from the PROJECT only (the grant is dropped with the one grant revoke, admin-actions.ts revokeProjectAccess); still a company member;
//   (b) removed from the COMPANY: (b1) the membership row is stamped revoked and NOTHING else happens (sessions alive, grant still there), (b2) what a member removal does in full
//       (company-member-routes.ts dropLeaversHold: the membership ended, the sessions ended, the non-administrator grants dropped).
// Every case expects NO answer that shows the person the task. A case that fails names the routes still answering.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { revokeProjectAccess } from "../../packages/broker/src/aws/admin-actions.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { createJourneyWorld, MAYA, type JourneyWorld } from "./harness/hosted-core.js";
import { asRemovedPerson, pageReader, removeFromCompany, writeReviewSession } from "./harness/page.js";
import { bearerRequest, writeCliSession } from "./harness/surviving.js";
import { planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

interface Observed { surface: string; route: string; status: number; code: string; message: string; shows: boolean }
type Ask = (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;

const errorOf = (text: string): { code: string; message: string } => {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") return { code: parsed.error, message: typeof parsed.message === "string" ? parsed.message : "" };
    const error = parsed.error as { code?: unknown; message?: unknown } | undefined;
    return { code: typeof error?.code === "string" ? error.code : "-", message: typeof error?.message === "string" ? error.message : "" };
  } catch { return { code: "-", message: "" }; }
};
/** The two lists name the caller's own tasks (a 200 that does not name this task shows nothing of it); every other route is the task's own, so a 2xx is an admission. */
const LISTS = new Set(["involved list", "decisions list"]);

/** The task's own routes a person's tools read, then the two moves the starter makes. */
function routes(taskId: string): Array<{ route: string; method: string; path: string; body?: unknown }> {
  const t = `/v1/dev/tasks/${taskId}`;
  return [
    { route: "task read", method: "GET", path: t },
    { route: "events", method: "GET", path: `${t}/events` },
    { route: "diff (changes)", method: "GET", path: `${t}/diff` },
    { route: "plan", method: "GET", path: `${t}/plan` },
    { route: "proof / evidence", method: "GET", path: `${t}/evidence` },
    { route: "comments", method: "GET", path: `${t}/comments` },
    { route: "people", method: "GET", path: `${t}/people` },
    { route: "readers", method: "GET", path: `${t}/readers` },
    { route: "involved list", method: "GET", path: "/v1/dev/tasks" },
    { route: "decisions list", method: "GET", path: "/v1/app/decisions" },
    { route: "merge state", method: "GET", path: `/v1/app/tasks/${taskId}/merge` },
    { route: "feature choices", method: "GET", path: `/v1/app/tasks/${taskId}/feature-choices` },
    { route: "answers (a move)", method: "POST", path: `${t}/answers`, body: { requestId: randomUUID(), answers: [] } },
    { route: "cancel (a move)", method: "POST", path: `${t}/cancel`, body: { requestId: randomUUID() } },
  ];
}

/** `removed` (not `project`): the person is out of the company, so each request is refused, either by the core itself or at SIGN-IN with a 401 before any engine is asked (`asRemovedPerson`, harness/page.ts); the owner's own control run before the removal is not. Removed from the PROJECT only, the core answers every request itself. */
async function observe(w: JourneyWorld, taskId: string, removed = true, project = false): Promise<Observed[]> {
  const moves = removed;
  // Removed from the PROJECT only, the person's OWN two lists (their tasks, their decision cards) answer 200 and name nothing of this task (`shows` checks that).
  const asked = <T>(request: () => Promise<T>): Promise<T> => removed && !project ? asRemovedPerson(w, request) : request();
  const web: Ask = async (method, path, body) => { const r = await asked(() => w.maya(method, path, body)); return { status: r.status, text: JSON.stringify(r.body) }; };
  const cliPerson = writeCliSession(w, MAYA, Math.floor(Date.now() / 1000) + 6 * 86_400);
  const cli: Ask = async (method, path, body) => { const r = await asked(() => bearerRequest(w, cliPerson, method, path, body)); return { status: r.status, text: r.text }; };
  const out: Observed[] = [];
  for (const [surface, ask] of [["web client", web], ["CLI session", cli]] as const) {
    for (const r of routes(taskId).filter((candidate) => moves || candidate.method === "GET")) {
      const answer = await ask(r.method, r.path, r.body);
      // "shows": a 2xx from a task's own route (or a list that names the task): the task was shown, or the move was taken.
      const shows = answer.status < 300 && (!LISTS.has(r.route) || answer.text.includes(taskId));
      out.push({ surface, route: r.route, status: answer.status, ...errorOf(answer.text), shows });
    }
  }
  // Code's task page, with the person's review session (a plain sign-in, 30 days).
  const page = pageReader(w, taskId, writeReviewSession(w, MAYA));
  for (const [route, reply] of [["page: open", await page.open()], ["page: api state", await page.read("state")], ["page: api comments", await page.read("comments")]] as const) {
    out.push({ surface: "task page", route, status: reply.status, ...errorOf(reply.text), shows: reply.status === 200 });
  }
  return out;
}

const table = (rows: Observed[]) => rows.map((row) => `${row.surface} | ${row.route} | ${String(row.status)} ${row.code} ${row.message}${row.shows ? " | SHOWS" : ""}`).join("\n");

async function startedByMaya() {
  world = await createJourneyWorld({ page: true });
  const taskId = await startTask(world);
  await planUntilCard(world, taskId);
  const companyId = world.harness.runtime.flow.deps.companyId;
  // Sanity: before any removal she reads her own task (the table has rows that show it).
  const before = await observe(world, taskId, false);
  expect(before.filter((row) => row.shows).map((row) => `${row.surface}: ${row.route}`), `before a removal the owner reads her task:\n${table(before)}`).toContain("web client: task read");
  return { w: world, taskId, companyId };
}

const stillShown = (rows: Observed[]) => rows.filter((row) => row.shows).map((row) => `${row.surface}: ${row.route} -> ${String(row.status)}`);

describe("a person who started a task (no People list) and is then removed", () => {
  it("(a) removed from the PROJECT only, still a company member: nothing shows or moves the task", async () => {
    const { w, taskId, companyId } = await startedByMaya();
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", MAYA.developerId, companyId)).toEqual({ revoked: true });
    const rows = await observe(w, taskId, true, true);
    expect(stillShown(rows), `routes that still answer a person removed from the project:\n${table(rows)}`).toEqual([]);
    w.proof.assertAllCore();
  }, 240_000);

  it("(b1) removed from the COMPANY (membership ended; sessions alive, grant not yet dropped): nothing shows or moves the task", async () => {
    const { w, taskId } = await startedByMaya();
    removeFromCompany(w, MAYA);
    const rows = await observe(w, taskId);
    expect(stillShown(rows), `routes that still answer a person removed from the company:\n${table(rows)}`).toEqual([]);
    w.proof.assertAllCore();
  }, 240_000);

  it("(b2) removed from the COMPANY by a full member removal (membership ended, sessions ended, non-admin grants dropped): nothing shows or moves the task, and her sign-in is refused", async () => {
    const { w, taskId, companyId } = await startedByMaya();
    const at = new Date(Date.now() + 1_000).toISOString();
    // The membership ends as the sign-in service's own operator write (no actor named: the direct operator invoke the broker's removal route reaches through the sign-in Lambda).
    expect(await new CompanySignInStore({ documentClient: w.harness.db, tableName: "signin", now: Date.now }).setRevoked(companyId, MAYA.developerId, true)).toBe(true);
    expect(await new DeveloperSignInStore({ documentClient: w.harness.db, tableName: "signin", now: Date.now }).endSessions(MAYA.developerId, at)).toBe("ended");
    expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", MAYA.developerId, companyId)).toEqual({ revoked: true });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const rows = await observe(w, taskId);
    expect(stillShown(rows), `routes that still answer a fully removed person:\n${table(rows)}`).toEqual([]);
    // Her sessions are over: the web client's own call is a sign-in refusal, not a "not found".
    expect(rows.find((row) => row.surface === "web client" && row.route === "task read")?.status).toBe(401);
    w.proof.assertAllCore();
  }, 240_000);
});
