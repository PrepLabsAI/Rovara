// L4-B5: `GET /v1/app/sessions/<session>/log`. The task's log is read by who may read the task's session (owner, co-owners, people with view on the task, as the session levels say), as the company's own rows
// of that one task, drawn through the write-time safety once more. Everyone else, another company, another project's people and an unknown session get the same missing-session answer.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, TaskLogViewSchema, agentSessionKey, taskLogKey, type OrgId, type Principal } from "@agentx/contracts";
import { createTaskSessionItems, developerIdOf, taskSessionId } from "../../../packages/broker/src/core/sessions/index.js";
import type { SessionCompanyRole, SessionMembers, SessionProjectRole } from "../../../packages/broker/src/core/sessions/access.js";
import { answerEntriesOf, appendTaskLog, approvalEntryOf, planSummaryEntryOf, pullRequestEntryOf, questionEntriesOf, statusEntryOf } from "../../../packages/broker/src/core/task-log/index.js";
import { createSessionRoutes } from "../../../packages/broker/src/core-host/app/session-routes.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;
const OWNER = localOwnerPrincipal();
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const TASK_2 = "9c68ac5c-fbb8-4cf3-98cd-7eb97ca7d7f7";
const SESSION = taskSessionId(TASK);
const SESSION_2 = taskSessionId(TASK_2);
const T0 = "2026-11-17T10:00:00.000Z";
const person = (id: string, org: OrgId = ORG): Principal => ({ companyId: org, personId: id, displayName: id, roles: [], provider: "oidc" });
const id = (principal: Principal): string => developerIdOf(principal);
const fakeToken = (): string => `${["gh", "p_"].join("")}${"A1b2".repeat(9)}`;
const QUESTIONS = [{ id: "q1", text: "Cap value?", options: [{ id: "a", label: "20,000" }, { id: "b", label: "50,000" }] }];

type Table = Record<string, { role?: SessionCompanyRole; grants?: Record<string, SessionProjectRole> }>;
function members(table: Table): SessionMembers {
  const row = (developerId: string) => (developerId === id(OWNER) ? table["__owner"] ?? { role: "owner" as const, grants: { web: "maintainer" as const, api: "maintainer" as const } } : Object.entries(table).find(([personId]) => id(person(personId)) === developerId)?.[1]);
  return { companyRole: (who) => row(who.developerId)?.role, projectGrant: (who, project) => row(who.developerId)?.grants?.[project] };
}

async function world(options: { org?: OrgId; project?: string; taskId?: string; sessionId?: string; people?: unknown; store?: MemoryDocumentStore } = {}) {
  const org = options.org ?? ORG;
  const taskId = options.taskId ?? TASK;
  const sessionId = options.sessionId ?? SESSION;
  const store = options.store ?? new MemoryDocumentStore({ indexes: [] });
  await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, companyId: org, sessionId, conversationId: "c", title: "Add retry", requestText: "Add retry", workflow: { definitionVersion: "1.1.0", stage: "PLAN", state: "RUNNING", revision: 2, path: "QUICK", artifacts: [], decisions: [] } } });
  if (options.people !== undefined) await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "PEOPLE", ...(options.people as Record<string, unknown>) } });
  await store.transact(createTaskSessionItems({
    orgId: org, sessionId, taskId, project: options.project ?? "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: id(OWNER) } as never, now: T0,
  }));
  return store;
}

const entriesOf = (body: string): unknown[] => (JSON.parse(body) as { entries: unknown[] }).entries;
const routes = (store: MemoryDocumentStore, table?: Table, companyId: OrgId = ORG) =>
  createSessionRoutes({ flow: { deps: { store, companyId } } as never, blobs: {} as never, companyId, origin: () => "https://example.test", ...(table === undefined ? {} : { members: members(table) }) });
const get = (route: ReturnType<typeof routes>, who: Principal, session = SESSION, suffix = "/log") => route({ method: "GET", path: `/v1/app/sessions/${session}${suffix}`, headers: {} }, { principal: who });

async function fill(store: MemoryDocumentStore, taskId = TASK, org: OrgId = ORG) {
  await appendTaskLog(store, { orgId: org, taskId, entries: [
    statusEntryOf({ kind: "started", at: T0, pullRequests: undefined })!,
    ...questionEntriesOf({ round: 1, at: "2026-11-17T10:01:00.000Z", questions: QUESTIONS }),
    ...answerEntriesOf({ round: 1, at: "2026-11-17T10:02:00.000Z", by: "Ana Ruiz", surface: "linear", questions: QUESTIONS, answers: [{ questionId: "q1", optionId: "a" }] }),
    approvalEntryOf({ requestId: "r1", at: "2026-11-17T10:03:00.000Z", what: "plan", outcome: "approved", artifactDigest: "ab".repeat(32), revision: 1, by: "Nick P.", surface: "web" })!,
    planSummaryEntryOf({ revision: 1, at: "2026-11-17T10:00:30.000Z", needed: "Add a retry", lines: ["Retry three times"], risk: "low", estimate: "$2 to $4" })!,
    pullRequestEntryOf({ at: "2026-11-17T10:04:00.000Z", pullRequests: [{ repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7" }] })!,
  ] });
}

describe("who reads a task's log", () => {
  it("the local owner reads it, oldest first, as the contract's view and nothing more of the rows", async () => {
    const store = await world();
    await fill(store);
    const answer = await get(routes(store), OWNER);
    expect(answer?.statusCode).toBe(200);
    const body = JSON.parse(answer!.body) as unknown;
    const view = TaskLogViewSchema.parse(body);
    expect(view.entries.map((entry) => entry.kind)).toEqual(["status", "plan_summary", "question", "answer", "approval", "pr"]);
    expect(Object.keys(body as object)).toEqual(["entries"]);
    expect(answer!.body).not.toContain(ORG);
    expect(answer!.body).not.toContain(TASK);
    expect(answer!.headers["content-type"]).toBe("application/json");
  });

  it("a task with an empty log answers an empty list", async () => {
    const store = await world();
    expect(JSON.parse((await get(routes(store), OWNER))!.body)).toEqual({ entries: [] });
  });

  it("a project maintainer, contributor, collaborator and viewer each read it; a company admin reads it", async () => {
    const store = await world();
    await fill(store);
    const table: Table = {
      mia: { role: "member", grants: { web: "maintainer" } }, cole: { role: "member", grants: { web: "contributor" } }, cara: { role: "member", grants: { web: "collaborator" } },
      vic: { role: "member", grants: { web: "viewer" } }, ada: { role: "admin" },
    };
    for (const name of Object.keys(table)) expect((await get(routes(store, table), person(name)))?.statusCode, name).toBe(200);
  });

  it("a person the task's People list names as a viewer reads it, and a person it denies does not", async () => {
    const store = await world({ people: { schemaVersion: 1, people: [{ developerId: person("pat").personId, role: "viewer" }, { developerId: person("dee").personId, role: "denied" }] } });
    await fill(store);
    const table: Table = { pat: { role: "member", grants: { web: "viewer" } }, dee: { role: "member", grants: { web: "contributor" } } };
    expect((await get(routes(store, table), person("pat")))?.statusCode).toBe(200);
    expect((await get(routes(store, table), person("dee")))?.statusCode).toBe(404);
  });

  it("a shared person reads it (a share on the session is a reader)", async () => {
    const store = await world();
    await fill(store);
    await store.put({ item: { ...agentSessionKey(ORG, SESSION, "SHARE#0"), principal: { kind: "member", developerId: id(person("sam")) }, level: "view", sharedBy: { developerId: id(OWNER), name: "Owner" }, sharedAt: T0 } });
    const table: Table = { sam: { role: "member" } };
    expect((await get(routes(store, table), person("sam")))?.statusCode).toBe(200);
  });

  it("a stranger, a member with no role on the project, an auditor with no grant and another project's maintainer get the missing session's answer, word for word", async () => {
    const store = await world({ project: "web" });
    await fill(store);
    const table: Table = { ned: { role: "member" }, aud: { role: "auditor" }, api: { role: "member", grants: { api: "maintainer" } } };
    const missing = await get(routes(store, table), OWNER, "ses_zzzzzzzzzzzzzzzzzzzz");
    expect(missing?.statusCode).toBe(404);
    for (const who of [person("dana"), person("ned"), person("aud"), person("api")]) {
      const answer = await get(routes(store, table), who);
      expect(answer?.statusCode, who.personId).toBe(404);
      expect(answer?.body, who.personId).toBe(missing?.body);
      expect(answer!.body).not.toContain("Ana Ruiz");
    }
    // The local owner's install: nobody but the owner holds anything.
    expect((await get(routes(store), person("dana")))?.statusCode).toBe(404);
  });

  it("two projects: the maintainer of the other project reads that project's task log and not this one's", async () => {
    const store = await world({ project: "web" });
    await world({ project: "api", taskId: TASK_2, sessionId: SESSION_2, store });
    await fill(store, TASK);
    await appendTaskLog(store, { orgId: ORG, taskId: TASK_2, entries: answerEntriesOf({ round: 1, at: T0, by: "Bo", surface: "web", questions: QUESTIONS, answers: [{ questionId: "q1", optionId: "b" }] }) });
    const table: Table = { api: { role: "member", grants: { api: "maintainer" } } };
    expect((await get(routes(store, table), person("api"), SESSION))?.statusCode).toBe(404);
    const own = await get(routes(store, table), person("api"), SESSION_2);
    expect(own?.statusCode).toBe(200);
    expect(own!.body).toContain("50,000");
    expect(own!.body).not.toContain("Ana Ruiz");
  });

  it("two companies: another company's person, and a route made for another company, read a missing session, and one company's log never shows the other's rows", async () => {
    const store = await world();
    await world({ org: OTHER_ORG, taskId: TASK_2, sessionId: SESSION_2, store });
    await fill(store, TASK, ORG);
    await appendTaskLog(store, { orgId: OTHER_ORG, taskId: TASK_2, entries: answerEntriesOf({ round: 1, at: T0, by: "Zed", surface: "web", questions: QUESTIONS, answers: [{ questionId: "q1", optionId: "b" }] }) });
    // A person of the other company, even holding the owner role there, reads nothing of this company's session.
    expect((await get(routes(store), { ...OWNER, companyId: OTHER_ORG }))?.statusCode).toBe(404);
    // The other company's route does not know this company's session id, and this company's route does not know theirs.
    expect((await get(routes(store, undefined, OTHER_ORG), OWNER))?.statusCode).toBe(404);
    expect((await get(routes(store), OWNER, SESSION_2))?.statusCode).toBe(404);
    // A row of another company written into this task's partition (a bad write) is never shown.
    const stray = taskLogKey(TASK, "answer:r9:zz");
    await store.put({ item: { ...stray, entityType: "TASK_LOG", orgId: OTHER_ORG, taskId: TASK, entry: { key: "answer:r9:zz", at: T0, kind: "answer", questionId: "zz", round: 9, text: "from the other company", by: "Zed", surface: "web" } } });
    const answer = await get(routes(store), OWNER);
    expect(answer?.statusCode).toBe(200);
    expect(answer!.body).not.toContain("from the other company");
    expect(answer!.body).not.toContain("Zed");
  });

  it("a session whose task record is another company's reads missing", async () => {
    const store = await world();
    await fill(store);
    await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, companyId: OTHER_ORG, sessionId: SESSION, title: "x", requestText: "x" } });
    const answer = await get(routes(store), OWNER);
    expect(answer?.statusCode).toBe(404);
    expect(answer?.body).toBe((await get(routes(store), OWNER, "ses_zzzzzzzzzzzzzzzzzzzz"))?.body);
  });

  it("the task is the session's own: a query or a header naming another task changes nothing", async () => {
    const store = await world();
    await world({ taskId: TASK_2, sessionId: SESSION_2, store });
    await fill(store, TASK);
    await appendTaskLog(store, { orgId: ORG, taskId: TASK_2, entries: answerEntriesOf({ round: 1, at: T0, by: "Bo", surface: "web", questions: QUESTIONS, answers: [{ questionId: "q1", optionId: "b" }] }) });
    const answer = await routes(store)({ method: "GET", path: `/v1/app/sessions/${SESSION}/log?task=${TASK_2}&taskId=${TASK_2}&session=${SESSION_2}`, headers: { "x-task-id": TASK_2 } }, { principal: OWNER });
    expect(answer?.statusCode).toBe(200);
    expect(answer!.body).toContain("Ana Ruiz");
    expect(answer!.body).not.toContain("Bo");
  });

  it("only GET is served on the path", async () => {
    const store = await world();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const answer = await routes(store)({ method, path: `/v1/app/sessions/${SESSION}/log`, headers: {}, body: "{}" }, { principal: OWNER });
      expect(answer?.statusCode, method).toBe(404);
    }
    expect(await get(routes(store), OWNER, SESSION, "/logs")).toBeUndefined();
    expect(await get(routes(store), OWNER, SESSION, "/log/extra")).toBeUndefined();
  });
});

describe("what is shown of an entry", () => {
  it("is made safe again on the way out: a credential written into a row by hand is redacted, a control character is a space, and the bound holds", async () => {
    const store = await world();
    const token = fakeToken();
    const row = (key: string, entry: Record<string, unknown>) => store.put({ item: { ...taskLogKey(TASK, key), entityType: "TASK_LOG", orgId: ORG, taskId: TASK, entry: { key, at: T0, ...entry } } });
    await row("answer:r1:q1", { kind: "answer", questionId: "q1", round: 1, text: `use ${token} then ok`, by: `Ana ${token}`, surface: "web" });
    await row("question:r1:q1", { kind: "question", questionId: "q1", round: 1, text: `which? ${token}`, choices: [`a ${token}`, "b"] });
    await row("approval:hand", { kind: "approval", what: "plan", outcome: "approved", by: `Nick ${token}`, surface: "web" });
    await row("plan:r1", { kind: "plan_summary", revision: 1, needed: `need ${token}`, lines: [`do ${token}`], risk: "low", estimate: "$4.37 to $10.19" });
    const answer = await get(routes(store), OWNER);
    expect(answer?.statusCode).toBe(200);
    expect(answer!.body).not.toContain(token);
    expect(answer!.body).toContain("[REDACTED]");
    expect(entriesOf(answer!.body)).toHaveLength(4);
    expect(answer!.body).not.toContain("$4.37");
    expect(answer!.body).not.toContain("estimate");
  });

  it("leaves out an entry that does not parse and an entry whose key is not its row's", async () => {
    const store = await world();
    await fill(store);
    await store.put({ item: { ...taskLogKey(TASK, "answer:r7:q7"), entityType: "TASK_LOG", orgId: ORG, taskId: TASK, entry: { key: "answer:r7:q7", at: T0, kind: "answer", text: "no question id", by: "Ana", surface: "web" } } });
    await store.put({ item: { ...taskLogKey(TASK, "answer:r8:q8"), entityType: "TASK_LOG", orgId: ORG, taskId: TASK, entry: { key: "answer:r8:other", at: T0, kind: "answer", questionId: "q8", round: 8, text: "wrong key", by: "Ana", surface: "web" } } });
    const view = TaskLogViewSchema.parse(JSON.parse((await get(routes(store), OWNER))!.body));
    expect(view.entries).toHaveLength(6);
    expect(JSON.stringify(view)).not.toContain("wrong key");
  });

  it("keeps a pull request's plain https address and drops a credentialed one", async () => {
    const store = await world();
    await store.put({ item: { ...taskLogKey(TASK, "pr:aaa"), entityType: "TASK_LOG", orgId: ORG, taskId: TASK, entry: { key: "pr:aaa", at: T0, kind: "pr", urls: ["https://user:pw@github.com/a/b/pull/1", "https://github.com/a/b/pull/2"] } } });
    await store.put({ item: { ...taskLogKey(TASK, "pr:bbb"), entityType: "TASK_LOG", orgId: ORG, taskId: TASK, entry: { key: "pr:bbb", at: T0, kind: "pr", urls: ["https://user:pw@github.com/a/b/pull/3"] } } });
    const body = (await get(routes(store), OWNER))!.body;
    expect(body).toContain("https://github.com/a/b/pull/2");
    expect(body).not.toContain("pw@");
    expect(entriesOf(body)).toHaveLength(1);
  });

  it("is bounded at the log's own limit", async () => {
    const store = await world();
    const entries = Array.from({ length: 205 }, (_, n) => answerEntriesOf({ round: n, at: new Date(Date.parse(T0) + n * 1000).toISOString(), by: "Ana", surface: "web", questions: QUESTIONS, answers: [{ questionId: "q1", optionId: "a" }] })[0]!);
    await appendTaskLog(store, { orgId: ORG, taskId: TASK, entries });
    expect(entriesOf((await get(routes(store), OWNER))!.body)).toHaveLength(200);
  });
});
