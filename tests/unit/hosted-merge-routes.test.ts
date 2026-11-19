// Owner DEC 254zzz94 / 254zzz104: the in-Rovara Merge button on the hosted install (`GET/POST /v1/app/tasks/{id}/merge`, core-host/hosted-merge-routes.ts) over the REAL merge core
// (`pressMergeAsPerson`, every gate of `pressMerge` but the approver proof) on the fake GitHub host (tests/support/merge-world.ts).
// The route decides WHERE (the website only, for a press), WHO (the task owner or co-owner, a project admin, a company admin) and the company; one merge at a time per task; one answer per request id;
// audit before the core runs. The core decides everything else: approvals and self-approval, the recorded base, the scope hold, the closed task, the checks (PASSED, never "no CI"), the head, the tier.
// Mutants are listed in the PR body with the test that kills each.
/* eslint-disable @typescript-eslint/no-explicit-any -- a JSON answer is read field by field */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, ON_THE_WEBSITE_MESSAGE, change, type AuditEvent, type CodeHost, type OrgId, type OrgRole } from "@agentx/contracts";
import { FakeCodeHost, type FakeHostModel } from "@agentx/broker/fakes";
import { HOSTED_MERGE_WORDS, MERGE_LOCK_MS, MERGE_PRESSED_AUDIT, MERGE_RESULT_AUDIT, isHostedMergePath, routeHostedMerge, type HostedMergeWiring } from "../../packages/broker/src/core-host/hosted-merge-routes.js";
import { SCOPE_HELD } from "../../packages/broker/src/core/merge/merge.js";
import { taskRecordKey } from "../../packages/broker/src/core/merge/store.js";
import { ORG, TASK_ID, mergeWorld, wrapStore, type MergeWorld } from "../support/merge-world.js";

const OWNER = "owner-1", CO_OWNER = "co-owner-1", MAINTAINER = "maint-1", DEVELOPER = "dev-1", STRANGER = "stranger-1", ADMIN = "admin-1";
const OTHER_COMPANY = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
type Body = Record<string, any>;
type ErrorBody = { error: { code: string; message: string } };

/** The fake host, counting the merges sent to it (and able to refuse them). */
function countingHost(model: FakeHostModel, calls: Array<{ revision: string }>, refuse: { value: boolean }): CodeHost {
  const fake = new FakeCodeHost(model);
  return Object.create(fake, {
    kind: { value: "github" },
    merge: { value: async (...args: Parameters<NonNullable<CodeHost["merge"]>>) => {
      calls.push({ revision: args[1].revision });
      if (refuse.value) return { outcome: "refused" as const, reason: "forbidden" as const, hostMessage: "Resource not accessible by integration ghs_secret" };
      return fake.merge(...args);
    } },
  }) as CodeHost;
}

interface Options { changeAfterPrepare?: { workflow: { revision: number } } | { closedAt: string }; scopeUnreadable?: boolean; allowSelfApproval?: boolean; wiring?: false; audit?: "fail"; mergeThrows?: boolean; pullRequests?: Array<{ repositoryId: string; number: number }> }

async function hosted(options: Options = {}) {
  const merges: Array<{ revision: string }> = [];
  const refuse = { value: false };
  const world: MergeWorld = await mergeWorld({ allowSelfApproval: options.allowSelfApproval ?? true, codeHost: (model) => countingHost(model, merges, refuse), ...(options.pullRequests === undefined ? {} : { pullRequests: options.pullRequests }) });
  await world.seedTracking();
  // The flow reads the task as the hosted core keeps it: its company and its own person.
  await world.store.update({ key: taskRecordKey(TASK_ID), ops: [change.set(["companyId"], ORG), change.set(["developerId"], OWNER)] });
  const woken: string[] = [];
  const audited: AuditEvent[] = [];
  const audit = { stage: () => [], record: async (event: AuditEvent) => { if (options.audit === "fail") throw new Error("audit down"); audited.push(event); } };
  const flow = {
    store: world.store, companyId: ORG,
    access: {
      canAct: async (principal: { personId: string }, task: { developerId: string }) => principal.personId === task.developerId || principal.personId === CO_OWNER,
      canRead: async (principal: { personId: string }, task: { developerId: string }) => principal.personId === task.developerId || principal.personId === CO_OWNER || principal.personId === DEVELOPER,
    },
  } as never;
  const wiring: HostedMergeWiring = {
    projectGrantRole: async (personId, project) => (project !== "web" ? undefined : personId === MAINTAINER ? "administrator" : personId === DEVELOPER ? "developer" : undefined),
    merge: () => {
      if (options.mergeThrows === true) throw new Error("no ci mode");
      const store = options.scopeUnreadable !== true ? world.store : wrapStore(world.store, { get: async (key: { pk: string; sk: string }) => { if (key.sk === "SCOPE_QUESTION") throw new Error("unreadable"); return world.store.get(key); } });
      // `changeAfterPrepare`: the task as it reads from the second read on (the core reads it once to prepare and once more right before the merge).
      let reads = 0;
      const host = options.changeAfterPrepare === undefined ? world.deps.host : { ...world.deps.host, loadTask: async (taskId: string) => {
        const task = await world.deps.host.loadTask(taskId);
        reads += 1;
        if (task === undefined || reads < 2) return task;
        const after = options.changeAfterPrepare!;
        return "closedAt" in after ? { ...task, closedAt: after.closedAt } : { ...task, workflow: { ...task.workflow!, revision: after.workflow.revision } };
      } };
      return { ...world.deps, store, host, requirePassingCi: true };
    },
    afterMerge: async (taskId) => { woken.push(taskId); },
  };
  const call = async (method: "GET" | "POST", body?: unknown, who: { person?: string; role?: OrgRole; webApp?: boolean; raw?: string; company?: OrgId; principalCompany?: string } = {}) => {
    const company = who.company ?? ORG;
    const answer = await routeHostedMerge({
      request: { method, path: `/v1/app/tasks/${TASK_ID}/merge`, headers: {}, body: who.raw ?? (body === undefined ? undefined : JSON.stringify(body)) } as never,
      path: `/v1/app/tasks/${TASK_ID}/merge`,
      principal: { companyId: who.principalCompany ?? company, personId: who.person ?? OWNER, displayName: "P", roles: [], provider: "rovara" },
      companyId: company, role: who.role ?? "member", flow: company === ORG ? flow : { ...(flow as object), companyId: company } as never,
      wiring: options.wiring === false ? undefined : wiring, audit, now: () => world.now.value, webApp: who.webApp ?? true,
    });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Body };
  };
  return { world, call, merges, refuse, audited, woken };
}
const press = (requestId: string = randomUUID()) => ({ requestId });
const lockOf = (world: MergeWorld) => world.store.get({ pk: `ORG#${ORG}#HOSTED_MERGE`, sk: `${TASK_ID}#LOCK` });

describe("hosted Merge button: paths", () => {
  it("serves GET and POST on /v1/app/tasks/<uuid>/merge only", () => {
    expect(isHostedMergePath(`/v1/app/tasks/${TASK_ID}/merge`, "POST")).toBe(true);
    expect(isHostedMergePath(`/v1/app/tasks/${TASK_ID}/merge`, "GET")).toBe(true);
    expect(isHostedMergePath(`/v1/app/tasks/${TASK_ID}/merge`, "PUT")).toBe(false);
    expect(isHostedMergePath("/v1/app/tasks/not-a-uuid/merge", "POST")).toBe(false);
    expect(isHostedMergePath(`/v1/dev/tasks/${TASK_ID}/merge`, "POST")).toBe(false);
  });
});

describe("hosted Merge button: who may merge", () => {
  for (const [label, person, role, basis] of [["the task owner", OWNER, "member", "task-owner"], ["a People co-owner", CO_OWNER, "member", "task-owner"], ["a project admin", MAINTAINER, "member", "project-admin"], ["a company admin", ADMIN, "admin", "company-admin"], ["a company owner", ADMIN, "owner", "company-admin"]] as const) {
    it(`${label} merges through the merge core at the head Rovara checked`, async () => {
      const h = await hosted();
      const requestId = randomUUID();
      const answer = await h.call("POST", { requestId }, { person, role });
      expect(answer).toEqual({ status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "app", number: h.world.prs[0]!.number }] } });
      expect(h.merges).toEqual([{ revision: h.world.prs[0]!.head }]);
      expect(h.audited.map((event) => [event.action, event.actor.id, event.details?.["basis"], event.details?.["requestId"]])).toEqual([[MERGE_PRESSED_AUDIT, person, basis, requestId], [MERGE_RESULT_AUDIT, person, basis, requestId]]);
      expect(h.audited[0]!.eventId).not.toBe(h.audited[1]!.eventId);
      // The core's own audit fact names the person and the website press, and the tracking row is made due so the workflow records the merge.
      expect(h.world.audit.events.some((event: AuditEvent) => event.action === "pull_request.merge_requested" && event.actor.id === person && event.details?.["approvedBy"] === "rovara-website-press")).toBe(true);
      expect(h.woken).toEqual([TASK_ID]);
      expect(await lockOf(h.world)).toBeUndefined();
    });
  }

  it("a developer who may read the task is refused in fixed words, and nothing is sent", async () => {
    const h = await hosted();
    expect(await h.call("POST", press(), { person: DEVELOPER })).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: HOSTED_MERGE_WORDS.notAllowed } } });
    expect(h.merges).toEqual([]);
    expect(h.audited).toEqual([]);
  });

  it("someone who may not read the task reads 'no such task', exactly as a missing task", async () => {
    const h = await hosted();
    const stranger = await h.call("POST", press(), { person: STRANGER });
    await h.world.store.delete({ key: taskRecordKey(TASK_ID) });
    expect(stranger).toEqual({ status: 404, body: { error: { code: "TASK_NOT_FOUND", message: "no such task" } } });
    expect(await h.call("POST", press())).toEqual(stranger);
    expect(h.merges).toEqual([]);
  });

  it("another company's member, even its admin, reads 'no such task'; nothing is sent", async () => {
    const h = await hosted();
    for (const request of [() => h.call("POST", press(), { company: OTHER_COMPANY, role: "admin", person: ADMIN }), () => h.call("GET", undefined, { company: OTHER_COMPANY, role: "admin", person: ADMIN }), () => h.call("POST", press(), { principalCompany: OTHER_COMPANY, role: "admin" })]) {
      expect((await request()).body).toEqual({ error: { code: "TASK_NOT_FOUND", message: "no such task" } });
    }
    expect(h.merges).toEqual([]);
  });
});

describe("hosted Merge button: website only", () => {
  it("a press from the CLI or an AI tool is refused with the website words before anything is read", async () => {
    const h = await hosted();
    expect(await h.call("POST", press(), { webApp: false, role: "owner" })).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: ON_THE_WEBSITE_MESSAGE } } });
    expect(h.merges).toEqual([]);
    expect(h.audited).toEqual([]);
  });

  it("reading whether it would merge works from any client", async () => {
    const h = await hosted();
    const view = await h.call("GET", undefined, { webApp: false });
    expect(view.body).toMatchObject({ mayMerge: true, ready: true, pullRequests: [{ repositoryId: "app" }] });
    expect(h.merges).toEqual([]);
  });
});

describe("hosted Merge button: every merge-core gate holds (H1)", () => {
  const refusedBy = async (h: Awaited<ReturnType<typeof hosted>>, words: string) => {
    const answer = await h.call("POST", press());
    expect(answer.status).toBe(409);
    expect((answer.body as ErrorBody).error).toEqual({ code: "MERGE_NOT_READY", message: words });
    expect(h.merges).toEqual([]);
    expect(await lockOf(h.world)).toBeUndefined();
  };

  it("self-approval off: the requester's own approval is not enough (the project's rule)", async () => {
    const h = await hosted({ allowSelfApproval: false });
    await h.world.seedTracking({ review: "none", approval: undefined } as never);
    const answer = await h.call("POST", press());
    expect(answer.status).toBe(409);
    expect(h.merges).toEqual([]);
    expect((await h.call("GET")).body).toMatchObject({ mayMerge: true, ready: false });
  });

  it("no CI at all never merges (checks must have passed)", async () => {
    const h = await hosted();
    await h.world.seedTracking({ ci: "none" });
    await refusedBy(h, M.checks);
    expect((await h.call("GET")).body).toMatchObject({ mayMerge: true, ready: false, message: M.checks });
  });

  it("red checks never merge", async () => {
    const h = await hosted();
    await h.world.seedTracking({ ci: "failing", failingChecks: ["unit"] });
    await refusedBy(h, M.checks);
  });

  it("a closed task never merges", async () => {
    const h = await hosted();
    await h.world.store.update({ key: taskRecordKey(TASK_ID), ops: [change.set(["closedAt"], new Date(h.world.now.value).toISOString())] });
    await refusedBy(h, M.taskClosed);
    expect((await h.call("GET")).body).toMatchObject({ ready: false, message: M.taskClosed });
  });

  it("a task still being changed never merges", async () => {
    const h = await hosted();
    await h.world.setWorkflow({ stage: "REVIEW", state: "RUNNING" });
    await refusedBy(h, M.changing);
  });

  it("a pull request retargeted to another base with the same head never merges", async () => {
    const h = await hosted();
    (h.world.models.get("app")!.getChangeRequest(String(h.world.prs[0]!.number)) as unknown as { targetBranch: string }).targetBranch = "release";
    await h.world.seedTracking({ baseBranch: "release" });
    const answer = await h.call("POST", press());
    expect(answer.status).toBe(409);
    expect((answer.body as ErrorBody).error.message).toBe(M.baseChanged("release"));
    expect(h.merges).toEqual([]);
  });

  it("a pull request whose head moved after Rovara's checks never merges", async () => {
    const h = await hosted();
    const model = h.world.models.get("app")!;
    model.commit(model.getChangeRequest(String(h.world.prs[0]!.number)).sourceBranch, { "src/b.ts": "export const b = 2;\n" });
    const answer = await h.call("POST", press());
    expect(answer.status).toBe(409);
    expect(h.merges).toEqual([]);
  });

  it("a held scope never merges (planning skipped and the scope question cannot be read: the core holds)", async () => {
    const h = await hosted({ scopeUnreadable: true });
    const task = await h.world.task();
    await h.world.setWorkflow({ flow: { ...(task.workflow as unknown as { flow: object }).flow, skippedSteps: ["PLAN"] } });
    expect((await h.call("GET")).body).toMatchObject({ mayMerge: true, ready: false, message: SCOPE_HELD });
    const answer = await h.call("POST", press());
    expect((answer.body as ErrorBody).error).toEqual({ code: "MERGE_NOT_READY", message: SCOPE_HELD });
    expect(h.merges).toEqual([]);
  });

  it("a refused press sent again with the same request id records a second, distinct pressed event", async () => {
    const h = await hosted();
    h.refuse.value = true;
    const body = press();
    await h.call("POST", body);
    await h.call("POST", body);
    const pressed = h.audited.filter((event) => event.action === MERGE_PRESSED_AUDIT);
    expect(pressed).toHaveLength(2);
    expect(new Set(pressed.map((event) => event.eventId)).size).toBe(2);
  });

  it("the task read again after the merge was prepared: a new revision or a close in between merges nothing", async () => {
    for (const change of [{ workflow: { revision: 10 } }, { closedAt: "2026-11-09T10:00:01.000Z" }] as const) {
      const h = await hosted({ changeAfterPrepare: change });
      const answer = await h.call("POST", press());
      expect(answer.status).toBe(409);
      expect(h.merges).toEqual([]);
    }
  });

  it("a refusal from GitHub is told in the core's words and the lock is given back", async () => {
    const h = await hosted();
    h.refuse.value = true;
    const answer = await h.call("POST", press());
    expect(answer.status).toBe(409);
    expect(h.merges).toHaveLength(1);
    expect(h.audited.map((event) => [event.action, event.details?.["outcome"]])).toEqual([[MERGE_PRESSED_AUDIT, undefined], [MERGE_RESULT_AUDIT, "MERGE_NOT_READY"]]);
    expect(await lockOf(h.world)).toBeUndefined();
  });
});

describe("hosted Merge button: one merge, one answer per request", () => {
  it("the same request id again answers the stored result without asking GitHub", async () => {
    const h = await hosted();
    const body = press();
    const first = await h.call("POST", body);
    expect(await h.call("POST", body)).toEqual(first);
    expect(h.merges).toHaveLength(1);
    expect(h.audited.filter((event) => event.action === MERGE_PRESSED_AUDIT)).toHaveLength(1);
  });

  it("a request id another person used is refused, and nothing is sent", async () => {
    const h = await hosted();
    const body = press();
    await h.call("POST", body);
    expect(await h.call("POST", body, { person: MAINTAINER })).toEqual({ status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: HOSTED_MERGE_WORDS.requestReused } } });
    expect(h.merges).toHaveLength(1);
  });

  it("a press while another holds the task's lock is refused; a lock that ran out is taken", async () => {
    const h = await hosted();
    await h.world.store.put({ item: { pk: `ORG#${ORG}#HOSTED_MERGE`, sk: `${TASK_ID}#LOCK`, requestId: randomUUID(), personId: CO_OWNER, until: h.world.now.value + 1 } });
    expect(await h.call("POST", press())).toEqual({ status: 409, body: { error: { code: "MERGE_NOT_READY", message: HOSTED_MERGE_WORDS.inProgress } } });
    expect(h.merges).toEqual([]);
    await h.world.store.put({ item: { pk: `ORG#${ORG}#HOSTED_MERGE`, sk: `${TASK_ID}#LOCK`, requestId: randomUUID(), personId: CO_OWNER, until: h.world.now.value - 1 } });
    expect((await h.call("POST", press())).status).toBe(200);
  });

  it("the lock outlasts the longest merge (32 pull requests at 15 s each)", () => {
    expect(MERGE_LOCK_MS).toBeGreaterThan(32 * 15_000);
  });

  it("no audit record, no merge", async () => {
    const h = await hosted({ audit: "fail" });
    expect(await h.call("POST", press())).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: HOSTED_MERGE_WORDS.unavailable } } });
    expect(h.merges).toEqual([]);
    expect(await lockOf(h.world)).toBeUndefined();
  });

  it("a body with anything but a UUID request id is refused in fixed words", async () => {
    for (const raw of ['{"requestId":"x"}', `{"requestId":"${randomUUID()}","force":true}`, "not json", "[]"]) {
      const h = await hosted();
      expect(await h.call("POST", undefined, { raw })).toEqual({ status: 400, body: { error: { code: "CONFIG_INVALID", message: HOSTED_MERGE_WORDS.body } } });
      expect(h.merges).toEqual([]);
    }
  });

  it("an install without the wiring, or that cannot build the core's seams, says merging is not set up", async () => {
    expect((await (await hosted({ wiring: false })).call("POST", press())).body).toEqual({ error: { code: "NOT_FOUND", message: HOSTED_MERGE_WORDS.notSetUp } });
    const broken = await hosted({ mergeThrows: true });
    expect((await broken.call("POST", press())).body).toEqual({ error: { code: "NOT_FOUND", message: HOSTED_MERGE_WORDS.notSetUp } });
    expect(broken.merges).toEqual([]);
  });

  it("a reader who may not merge is told so without any read of the merge core", async () => {
    const h = await hosted({ mergeThrows: true });
    expect((await h.call("GET", undefined, { person: DEVELOPER })).body).toMatchObject({ mayMerge: false, ready: false });
  });
});
