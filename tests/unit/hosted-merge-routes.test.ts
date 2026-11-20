// Owner DEC 254zzz94 / 254zzz104: the in-Rovara Merge button on the hosted install (`GET/POST /v1/app/tasks/{id}/merge`, core-host/hosted-merge-routes.ts) over the REAL merge core
// (`pressMergeAsPerson`, every gate of `pressMerge` but the approver proof) on the fake GitHub host (tests/support/merge-world.ts).
// The route decides WHERE (the website only, for a press), WHO (the task owner or co-owner, a project admin, a company admin) and the company; one merge at a time per task; one answer per request id;
// audit before the core runs. The core decides everything else: approvals and self-approval, the recorded base, the scope hold, the closed task, the checks (PASSED, never "no CI"), the head, the tier.
// Mutants are listed in the PR body with the test that kills each.
/* eslint-disable @typescript-eslint/no-explicit-any -- a JSON answer is read field by field */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, ON_THE_WEBSITE_MESSAGE, change, type AuditEvent, type CodeHost, type OrgId, type OrgRole, DEFAULT_CODE_SETTINGS, codeMilestoneKey, type Principal } from "@agentx/contracts";
import { FakeCodeHost, type FakeHostModel } from "@agentx/broker/fakes";
import { HOSTED_MERGE_WORDS, MERGE_LOCK_MS, MERGE_PRESSED_AUDIT, MERGE_RESULT_AUDIT, isHostedMergePath, routeHostedMerge, type HostedMergeWiring } from "../../packages/broker/src/core-host/hosted-merge-routes.js";
import { SCOPE_HELD, riskOfTask } from "../../packages/broker/src/core/merge/merge.js";
import { readMergeTracking, taskRecordKey, recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { ORG, TASK_ID, mergeWorld, wrapStore, type MergeWorld } from "../support/merge-world.js";
import { hostedMergeDependencies } from "../../packages/broker/src/aws/hosted-merge-deps.js";
import { createHostedBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { hostedEvidenceBlobs } from "../../packages/broker/src/core-host/hosted-evidence.js";
import { pullRequestRecordKey } from "../../packages/broker/src/core/build-step/records.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { repositoryEdgesKey } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createPolicyHookClient } from "../../packages/broker/src/core/policy-hook/client.js";
import { withPolicyHookApprovers } from "../../packages/broker/src/core/policy-hook/approvers.js";
import { host, OWNER_ID } from "../support/service-host.js";
import { fakeService, ISSUER, makeKey, settingsFor, signerOf } from "./policy-hook-fixture.js";

const OWNER = "owner-1", CO_OWNER = "co-owner-1", MAINTAINER = "maint-1", DEVELOPER = "dev-1", STRANGER = "stranger-1", ADMIN = "admin-1";
const OTHER_COMPANY = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
type Body = Record<string, any>;
type ErrorBody = { error: { code: string; message: string } };

/** The fake host, counting the merges sent to it (and able to refuse them). */
function countingHost(model: FakeHostModel, calls: Array<{ revision: string }>, refuse: { value: boolean; from?: number; lost?: boolean }): CodeHost {
  const fake = new FakeCodeHost(model);
  return Object.create(fake, {
    kind: { value: "github" },
    merge: { value: async (...args: Parameters<NonNullable<CodeHost["merge"]>>) => {
      calls.push({ revision: args[1].revision });
      if (refuse.lost === true) throw new Error("socket hang up ghs_secret");
      if (refuse.value || (refuse.from !== undefined && calls.length >= refuse.from)) return { outcome: "refused" as const, reason: "forbidden" as const, hostMessage: "Resource not accessible by integration ghs_secret" };
      return fake.merge(...args);
    } },
  }) as CodeHost;
}

interface Options { minApprovers?: number; mergeWait?: string; changeAfterPrepare?: { workflow: { revision: number } } | { closedAt: string }; scopeUnreadable?: boolean; allowSelfApproval?: boolean; wiring?: false; audit?: "fail"; mergeThrows?: boolean; pullRequests?: Array<{ repositoryId: string; number: number }> }

async function hosted(options: Options = {}) {
  const merges: Array<{ revision: string }> = [];
  const refuse: { value: boolean; from?: number; lost?: boolean } = { value: false };
  const grantAsks: Array<[string, string, string]> = [];
  const world: MergeWorld = await mergeWorld({ allowSelfApproval: options.allowSelfApproval ?? true, codeHost: (model) => countingHost(model, merges, refuse), ...(options.pullRequests === undefined ? {} : { pullRequests: options.pullRequests }) });
  await world.seedTracking();
  // The flow reads the task as the hosted core keeps it: its company and its own person.
  await world.store.update({ key: taskRecordKey(TASK_ID), ops: [change.set(["companyId"], ORG), change.set(["developerId"], OWNER)] });
  const woken: string[] = [];
  const auditsGiven: unknown[] = [];
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
    // The company-layout reader: a grant is read for the membership's company only (DEC 254zzz98).
    projectGrantRole: async (personId, project, companyId) => { grantAsks.push([personId, project, companyId]); return project !== "web" || companyId !== ORG ? undefined : personId === MAINTAINER ? "administrator" : personId === DEVELOPER ? "developer" : undefined; },
    merge: (given) => {
      auditsGiven.push(given);
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
      const approvers = options.minApprovers === undefined ? world.deps.approvers : { ...world.deps.approvers, requirement: async (request: never) => ({ ...(await world.deps.approvers.requirement(request)), minApprovers: options.minApprovers! }) };
      return { ...world.deps, store, host, approvers, requirePassingCi: true, ...(options.mergeWait === undefined ? {} : { mergeWait: () => options.mergeWait }) };
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
  // What the page shows and sends back with a press (DEC 254zzz104: required): the heads tracking holds and the task's risk level.
  const shown = { expectedHeads: world.prs.map((pr) => ({ repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head })), risk: riskOfTask((await world.task()).workflow, await readMergeTracking(world.store, TASK_ID, ORG)).level };
  const press = (requestId: string = randomUUID()) => ({ requestId, ...shown });
  return { world, call, merges, refuse, audited, woken, audit, auditsGiven, press, shown, grantAsks };
}
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
      const answer = await h.call("POST", h.press(requestId), { person, role });
      expect(answer).toEqual({ status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "app", number: h.world.prs[0]!.number }] } });
      expect(h.merges).toEqual([{ revision: h.world.prs[0]!.head }]);
      expect(h.audited.map((event) => [event.action, event.actor.id, event.details?.["basis"], event.details?.["requestId"]])).toEqual([[MERGE_PRESSED_AUDIT, person, basis, requestId], [MERGE_RESULT_AUDIT, person, basis, requestId]]);
      expect(h.audited[0]!.eventId).not.toBe(h.audited[1]!.eventId);
      // The core's own audit fact names the person and the website press, and the tracking row is made due so the workflow records the merge.
      expect(h.world.audit.events.some((event: AuditEvent) => event.action === "pull_request.merge_requested" && event.actor.id === person && event.details?.["approvedBy"] === "rovara-website-press")).toBe(true);
      expect(h.woken).toEqual([TASK_ID]);
      expect(await lockOf(h.world)).toBeUndefined();
      // The core is given this request's own audit sink (the stamped one), never another.
      expect(h.auditsGiven).toEqual([h.audit]);
    });
  }

  it("the project-admin grant is read for the membership's own company (the company-layout reader)", async () => {
    const h = await hosted();
    expect((await h.call("POST", h.press(), { person: MAINTAINER })).status).toBe(200);
    expect(h.grantAsks).toEqual([[MAINTAINER, "web", ORG]]);
  });

  it("a developer who may read the task is refused in fixed words, and nothing is sent", async () => {
    const h = await hosted();
    expect(await h.call("POST", h.press(), { person: DEVELOPER })).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: HOSTED_MERGE_WORDS.notAllowed } } });
    expect(h.merges).toEqual([]);
    expect(h.audited).toEqual([]);
  });

  it("someone who may not read the task reads 'no such task', exactly as a missing task", async () => {
    const h = await hosted();
    const stranger = await h.call("POST", h.press(), { person: STRANGER });
    await h.world.store.delete({ key: taskRecordKey(TASK_ID) });
    expect(stranger).toEqual({ status: 404, body: { error: { code: "TASK_NOT_FOUND", message: "no such task" } } });
    expect(await h.call("POST", h.press())).toEqual(stranger);
    expect(h.merges).toEqual([]);
  });

  it("another company's member, even its admin, reads 'no such task'; nothing is sent", async () => {
    const h = await hosted();
    for (const request of [() => h.call("POST", h.press(), { company: OTHER_COMPANY, role: "admin", person: ADMIN }), () => h.call("GET", undefined, { company: OTHER_COMPANY, role: "admin", person: ADMIN }), () => h.call("POST", h.press(), { principalCompany: OTHER_COMPANY, role: "admin" })]) {
      expect((await request()).body).toEqual({ error: { code: "TASK_NOT_FOUND", message: "no such task" } });
    }
    expect(h.merges).toEqual([]);
  });
});

describe("hosted Merge button: website only", () => {
  it("a press from the CLI or an AI tool is refused with the website words before anything is read", async () => {
    const h = await hosted();
    expect(await h.call("POST", h.press(), { webApp: false, role: "owner" })).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: ON_THE_WEBSITE_MESSAGE } } });
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
    const answer = await h.call("POST", h.press());
    expect(answer.status).toBe(409);
    expect((answer.body as ErrorBody).error).toEqual({ code: "MERGE_NOT_READY", message: words });
    expect(h.merges).toEqual([]);
    expect(await lockOf(h.world)).toBeUndefined();
  };

  it("self-approval off: the requester's own approval is not enough (the project's rule)", async () => {
    const h = await hosted({ allowSelfApproval: false });
    await h.world.seedTracking({ review: "none", approval: undefined } as never);
    const answer = await h.call("POST", h.press());
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
    const answer = await h.call("POST", h.press());
    expect(answer.status).toBe(409);
    expect((answer.body as ErrorBody).error.message).toBe(M.baseChanged("release"));
    expect(h.merges).toEqual([]);
  });

  it("a pull request whose head moved after Rovara's checks never merges", async () => {
    const h = await hosted();
    const model = h.world.models.get("app")!;
    model.commit(model.getChangeRequest(String(h.world.prs[0]!.number)).sourceBranch, { "src/b.ts": "export const b = 2;\n" });
    const answer = await h.call("POST", h.press());
    expect(answer.status).toBe(409);
    expect(h.merges).toEqual([]);
  });

  it("a held scope never merges (planning skipped and the scope question cannot be read: the core holds)", async () => {
    const h = await hosted({ scopeUnreadable: true });
    const task = await h.world.task();
    await h.world.setWorkflow({ flow: { ...(task.workflow as unknown as { flow: object }).flow, skippedSteps: ["PLAN"] } });
    expect((await h.call("GET")).body).toMatchObject({ mayMerge: true, ready: false, message: SCOPE_HELD });
    const answer = await h.call("POST", h.press());
    expect((answer.body as ErrorBody).error).toEqual({ code: "MERGE_NOT_READY", message: SCOPE_HELD });
    expect(h.merges).toEqual([]);
  });

  it("a refused press sent again with the same request id records a second, distinct pressed event", async () => {
    const h = await hosted();
    h.refuse.value = true;
    const body = h.press();
    await h.call("POST", body);
    await h.call("POST", body);
    const pressed = h.audited.filter((event) => event.action === MERGE_PRESSED_AUDIT);
    expect(pressed).toHaveLength(2);
    expect(new Set(pressed.map((event) => event.eventId)).size).toBe(2);
  });

  it("the task read again after the merge was prepared: a new revision or a close in between merges nothing", async () => {
    for (const change of [{ workflow: { revision: 10 } }, { closedAt: "2026-11-09T10:00:01.000Z" }] as const) {
      const h = await hosted({ changeAfterPrepare: change });
      const answer = await h.call("POST", h.press());
      expect(answer.status).toBe(409);
      expect(h.merges).toEqual([]);
    }
  });

  it("what the person was shown binds the press: the heads and risk the read gave merge; other heads or another risk merge nothing", async () => {
    const h = await hosted();
    const view = (await h.call("GET")).body as { heads: Array<{ repositoryId: string; number: number; headSha: string }>; risk: string };
    expect(view.heads).toEqual([{ repositoryId: "app", number: h.world.prs[0]!.number, headSha: h.world.prs[0]!.head }]);
    expect(["low", "medium", "high"]).toContain(view.risk);
    const other = view.risk === "high" ? "low" : "high";
    expect(((await h.call("POST", { ...h.press(), risk: other })).body as ErrorBody).error).toEqual({ code: "MERGE_NOT_READY", message: M.changedAfterConfirm });
    expect(((await h.call("POST", { ...h.press(), expectedHeads: [{ ...view.heads[0]!, headSha: "f".repeat(40) }] })).body as ErrorBody).error).toEqual({ code: "MERGE_NOT_READY", message: M.changedAfterConfirm });
    expect(h.merges).toEqual([]);
    expect((await h.call("POST", { ...h.press(), expectedHeads: view.heads, risk: view.risk })).status).toBe(200);
    expect(h.merges).toHaveLength(1);
  });

  it("a merge the approvers point says needs more than one approver is never one person's press", async () => {
    const h = await hosted({ minApprovers: 2 });
    expect(((await h.call("POST", h.press())).body as ErrorBody).error.code).toBe("FORBIDDEN");
    expect(h.merges).toEqual([]);
  });

  it("a second review that did not run waits for the owner (the merge card's wait)", async () => {
    const h = await hosted({ mergeWait: "The second review didn't run. Acknowledge it before merging." });
    expect(((await h.call("POST", h.press())).body as ErrorBody).error).toEqual({ code: "MERGE_NOT_READY", message: "The second review didn't run. Acknowledge it before merging." });
    expect((await h.call("GET")).body).toMatchObject({ ready: false, message: "The second review didn't run. Acknowledge it before merging." });
    expect(h.merges).toEqual([]);
  });

  it("a half merge (the first merged, the second refused) wakes tracking so the workflow records what merged", async () => {
    const h = await hosted({ pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "lib", number: 1 }] });
    h.refuse.from = 2;
    const answer = await h.call("POST", h.press());
    expect(answer.status).toBe(409);
    expect((answer.body as ErrorBody).error.message).toContain(" merged, but ");
    expect(h.merges).toHaveLength(2);
    expect(h.woken).toEqual([TASK_ID]);
  });

  it("a merge whose answer was lost says the outcome is not confirmed yet (never 'nothing was merged') and wakes tracking", async () => {
    const h = await hosted();
    h.refuse.lost = true;
    const answer = await h.call("POST", h.press());
    expect(answer).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: HOSTED_MERGE_WORDS.outcomeUnknown } } });
    expect(JSON.stringify(answer)).not.toContain("ghs_");
    expect(h.merges).toHaveLength(1);
    expect(h.woken).toEqual([TASK_ID]);
    expect(await lockOf(h.world)).toBeUndefined();
  });

  it("a refusal from GitHub is told in the core's words and the lock is given back", async () => {
    const h = await hosted();
    h.refuse.value = true;
    const answer = await h.call("POST", h.press());
    expect(answer.status).toBe(409);
    expect(h.merges).toHaveLength(1);
    expect(h.audited.map((event) => [event.action, event.details?.["outcome"]])).toEqual([[MERGE_PRESSED_AUDIT, undefined], [MERGE_RESULT_AUDIT, "MERGE_NOT_READY"]]);
    // A plain refusal changed nothing on GitHub: tracking is not woken for it.
    expect(h.woken).toEqual([]);
    expect(await lockOf(h.world)).toBeUndefined();
  });
});

describe("hosted Merge button: one merge, one answer per request", () => {
  it("the same request id again answers the stored result without asking GitHub", async () => {
    const h = await hosted();
    const body = h.press();
    const first = await h.call("POST", body);
    expect(await h.call("POST", body)).toEqual(first);
    expect(h.merges).toHaveLength(1);
    expect(h.audited.filter((event) => event.action === MERGE_PRESSED_AUDIT)).toHaveLength(1);
  });

  it("a request id another person used is refused, and nothing is sent", async () => {
    const h = await hosted();
    const body = h.press();
    await h.call("POST", body);
    expect(await h.call("POST", body, { person: MAINTAINER })).toEqual({ status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT", message: HOSTED_MERGE_WORDS.requestReused } } });
    expect(h.merges).toHaveLength(1);
  });

  it("a press while another holds the task's lock is refused; a lock that ran out is taken", async () => {
    const h = await hosted();
    await h.world.store.put({ item: { pk: `ORG#${ORG}#HOSTED_MERGE`, sk: `${TASK_ID}#LOCK`, requestId: randomUUID(), personId: CO_OWNER, until: h.world.now.value + 1 } });
    expect(await h.call("POST", h.press())).toEqual({ status: 409, body: { error: { code: "MERGE_NOT_READY", message: HOSTED_MERGE_WORDS.inProgress } } });
    expect(h.merges).toEqual([]);
    await h.world.store.put({ item: { pk: `ORG#${ORG}#HOSTED_MERGE`, sk: `${TASK_ID}#LOCK`, requestId: randomUUID(), personId: CO_OWNER, until: h.world.now.value - 1 } });
    expect((await h.call("POST", h.press())).status).toBe(200);
  });

  it("the lock outlasts the longest merge (32 pull requests at 15 s each)", () => {
    expect(MERGE_LOCK_MS).toBeGreaterThan(32 * 15_000);
  });

  it("no audit record, no merge", async () => {
    const h = await hosted({ audit: "fail" });
    expect(await h.call("POST", h.press())).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: HOSTED_MERGE_WORDS.notRecorded } } });
    expect(h.merges).toEqual([]);
    expect(await lockOf(h.world)).toBeUndefined();
  });

  it("a body with anything but a UUID request id is refused in fixed words", async () => {
    for (const raw of ['{"requestId":"x"}', `{"requestId":"${randomUUID()}","force":true}`, "not json", "[]", `{"requestId":"${randomUUID()}"}`, `{"requestId":"${randomUUID()}","risk":"low"}`, `{"requestId":"${randomUUID()}","expectedHeads":[{"repositoryId":"app","number":1,"headSha":"${"a".repeat(40)}"}]}`, `{"requestId":"${randomUUID()}","risk":"low","expectedHeads":[]}`]) {
      const h = await hosted();
      expect(await h.call("POST", undefined, { raw })).toEqual({ status: 400, body: { error: { code: "CONFIG_INVALID", message: HOSTED_MERGE_WORDS.body } } });
      expect(h.merges).toEqual([]);
      // Refused before the lock and the audit: neither is left behind.
      expect(h.audited).toEqual([]);
      expect(await lockOf(h.world)).toBeUndefined();
    }
  });

  it("an install without the wiring, or that cannot build the core's seams, says merging is not set up", async () => {
    const unwired = await hosted({ wiring: false });
    expect((await unwired.call("POST", unwired.press())).body).toEqual({ error: { code: "NOT_FOUND", message: HOSTED_MERGE_WORDS.notSetUp } });
    const broken = await hosted({ mergeThrows: true });
    expect((await broken.call("POST", broken.press())).body).toEqual({ error: { code: "NOT_FOUND", message: HOSTED_MERGE_WORDS.notSetUp } });
    expect(broken.merges).toEqual([]);
  });

  it("a reader who may not merge is told so without any read of the merge core", async () => {
    const h = await hosted({ mergeThrows: true });
    expect((await h.call("GET", undefined, { person: DEVELOPER })).body).toMatchObject({ mayMerge: false, ready: false });
  });
});

const CREATOR = "task-creator", PRESSER = "different-presser";

const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;

const person = (personId: string): Principal => ({ companyId: ORG, personId, displayName: personId, provider: "rovara", roles: ["admin"] });

const settings = fixedCodeSettings({ ...DEFAULT_CODE_SETTINGS, allowSelfApproval: true });

const install = makeKey("hosted-install"), hookKey = makeKey("hosted-rules");

const allow = { allow: true, minApprovers: 1, secondPerson: false, selfApproval: true };

const meta = { contentType: "application/json", metadata: {}, retention: "evidence-std" } as const;

async function hostedWorld(repositories = ["app"]) {
  const w = await host({ repositories });
  const home = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: TASK_ID };
  await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set(["ownerKey"], home.ownerKey), change.set(["developerId"], CREATOR)] });
  const workspace = workspaceKey(ORG, home.workspaceId);
  await w.h.store.put({ item: { ...workspace, entityType: "WORKSPACE", id: home.workspaceId, companyId: ORG, ownerKey: home.ownerKey } });
  for (const pr of w.world.prs) await w.h.store.put({ item: {
    ...pullRequestRecordKey(workspace, pr.repositoryId, pr.number), entityType: "PULL_REQUEST", workspaceId: home.workspaceId,
    repository: pr.repositoryId, repositoryUrl: `https://github.com/acme/${pr.repositoryId}`, number: pr.number, url: pr.model.crUrl(String(pr.number)),
    state: "open", headBranch: "rovara/test", baseBranch: "main", expectedHeadCommit: pr.head, title: "Change", body: "",
    createdByOperationId: "11111111-1111-4111-8111-111111111111", updatedAt: new Date(w.clock.ms).toISOString(),
  } });
  const merges = w.world.prs.map((pr) => vi.spyOn(pr.model, "merge"));
  return { ...w, home, merges };
}

async function hookedRoute(mode: "allow" | "deny" | "no-answer" | "unaskable" | "malformed" | "second-person" | "raised" = "allow") {
  const w = await hostedWorld();
  await w.world.seedTracking();
  const service = fakeService({ key: hookKey, now: () => w.clock.ms, answer: () => {
    if (mode === "no-answer") return new Error("offline");
    if (mode === "malformed") return { ...allow, allow: "yes" };
    return { ...allow, allow: mode !== "deny", secondPerson: mode === "second-person", minApprovers: mode === "raised" ? 2 : 1 };
  } });
  const client = createPolicyHookClient({ settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch, now: () => w.clock.ms, audit: w.h.deps.audit });
  w.registry.register("approvers", "rules", withPolicyHookApprovers(w.world.deps.approvers, mode === "unaskable" ? { ...client, prepare: async () => undefined } : client, { now: () => w.clock.ms }));
  const identities: Array<[string, string]> = [];
  const identity = { getPrincipal: vi.fn(async (companyId: string, id: string) => {
    identities.push([companyId, id]);
    return companyId === ORG && id === CREATOR ? person(CREATOR) : undefined;
  }), resolveExternalAccount: async () => undefined,
  accountsOf: async (companyId: string, id: string) => companyId === ORG && [CREATOR, PRESSER].includes(id)
    ? [{ provider: "github", tenant: "", accountId: w.world.prs[0]!.model.accounts.get("priya")!.hostUserId }] : [],
  };
  w.registry.register("identity", "test", identity as never);
  const runtime = { companyId: ORG, flow: w.h.flow, ciReporting: { honest: true, ciMode: async () => "their_ci_fix" as const } } as never;
  const shown = { expectedHeads: w.world.prs.map((pr) => ({ repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head })), risk: riskOfTask((await w.world.task()).workflow, []).level };
  const call = async (presser = PRESSER, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const path = `/v1/app/tasks/${TASK_ID}/merge`;
    const result = await routeHostedMerge({ path, request: { method: "POST", path, headers, body: JSON.stringify({ requestId: randomUUID(), ...shown, ...body }) },
      companyId: ORG, principal: person(presser), role: "admin", flow: w.h.deps, audit: w.h.deps.audit, now: () => w.clock.ms, webApp: true,
      wiring: { projectGrantRole: async () => undefined, afterMerge: async () => undefined,
        merge: (audit) => hostedMergeDependencies({ runtime, registry: w.registry, settings, defaults: DEFAULT_CODE_SETTINGS, now: () => w.clock.ms, policyHook: true, audit }) },
    });
    return { status: result.statusCode, body: JSON.parse(result.body) as Record<string, unknown> };
  };
  return { ...w, service, identity, identities, call };
}

describe("hosted route: task creator is the policy requester", () => {
  it("sends the creator as by and the authenticated other presser as per, despite spoofed headers", async () => {
    const w = await hookedRoute();
    expect(OWNER_ID).not.toBe(CREATOR);
    expect(OWNER_ID).not.toBe(PRESSER);
    expect((await w.call(PRESSER, {}, { "x-requested-by": PRESSER, "x-creator-id": PRESSER })).body).toMatchObject({ status: "MERGED" });
    expect(w.service.asked.map((q) => q.q)).toEqual([expect.objectContaining({ cid: ORG, by: CREATOR, per: PRESSER, stage: "verdict", what: "merge" })]);
    expect(w.identities).toEqual([[ORG, CREATOR]]);
    expect(w.merges[0]).toHaveBeenCalledTimes(1);
  });

  for (const field of ["requestedBy", "creatorId", "presser"] as const) it(`refuses a body-supplied ${field} before asking rules or merging`, async () => {
    const w = await hookedRoute();
    expect((await w.call(PRESSER, { [field]: person(PRESSER) })).status).toBe(400);
    expect(w.service.asked).toEqual([]);
    expect(w.merges[0]).not.toHaveBeenCalled();
  });

  for (const missing of ["creator", "identity"] as const) it(`refuses a missing ${missing} with zero merges`, async () => {
    const w = await hookedRoute();
    if (missing === "creator") await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.remove(["developerId"])] });
    else w.identity.getPrincipal.mockResolvedValue(undefined);
    expect(await w.call()).toMatchObject({ status: 403, body: { error: { message: "someone other than the requester must merge" } } });
    expect(w.service.asked).toEqual([]);
    expect(w.merges[0]).not.toHaveBeenCalled();
  });

  for (const mode of ["deny", "no-answer", "unaskable", "malformed", "raised"] as const) it(`enforces ${mode} through the hosted route with zero merges`, async () => {
    const w = await hookedRoute(mode);
    expect((await w.call()).status).toBe(403);
    expect(w.merges[0]).not.toHaveBeenCalled();
    if (mode !== "unaskable") expect(w.service.asked[0]?.q).toMatchObject({ by: CREATOR, per: PRESSER });
  });

  it("a second-person rule refuses the creator's press and permits another person's press", async () => {
    const w = await hookedRoute("second-person");
    expect(await w.call(CREATOR)).toMatchObject({ status: 403, body: { error: { message: "someone other than the requester must merge" } } });
    expect(w.merges[0]).not.toHaveBeenCalled();
    expect((await w.call(PRESSER)).body).toMatchObject({ status: "MERGED" });
    expect(w.service.asked.map((q) => [q.q["by"], q.q["per"]])).toEqual([[CREATOR, CREATOR], [CREATOR, PRESSER]]);
    expect(w.merges[0]).toHaveBeenCalledTimes(1);
  });
});

async function hostedOrderWorld() {
  const w = await hostedWorld(["app", "docs", "payments-lib"]);
  for (const pr of w.world.prs) pr.model.getChangeRequest(String(pr.number)).draft = true;
  const prOf = (id: string) => w.world.prs.find((pr) => pr.repositoryId === id)!;
  const docs = prOf("docs");
  docs.model.setChecks(docs.head, [{ name: "unit", state: "pending", required: false, url: "" }]);
  const finishChecks = () => docs.model.setChecks(docs.head, [{ name: "unit", state: "completed", conclusion: "success", required: false, url: "", runId: "11" }]);
  const mergeByHand = (id: string) => {
    const pr = prOf(id);
    pr.model.getChangeRequest(String(pr.number)).draft = false;
    expect(pr.model.merge(String(pr.number), { revision: pr.head, method: "squash" }).outcome).toBe("merged");
  };
  const digest = (await w.world.task()).workflow.candidate!.digest;
  const key = repositoryEdgesKey(w.home, digest);
  const bytes = (candidateDigest = digest) => Buffer.from(JSON.stringify({ schemaVersion: 1, candidateDigest,
    edges: ["app", "docs"].map((consumer) => ({ consumer, provider: "payments-lib", language: "node", source: "both" })),
  }));
  const services = createHostedBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, settings, people: w.people,
    ciMode: async () => "their_ci_fix" as const, now: () => new Date(w.clock.ms) });
  const pass = async () => {
    await w.h.store.put({ item: { ...recoveryRowKey(TASK_ID), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
    expect(await services["merge-tracking"].pass({ budgetMs: 10_000 })).toMatchObject({ attempted: 1, failed: 0 });
  };
  const warnings = async () => (await w.h.store.query({ pk: codeMilestoneKey(TASK_ID, "stuck", 0).pk, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#stuck#" } })).items;
  const draft = (id: string) => prOf(id).model.getChangeRequest(String(prOf(id).number)).draft;
  const blobs = hostedEvidenceBlobs({ blobs: w.registry.require("object-storage"), store: w.h.store, companyId: ORG });
  return { ...w, key, bytes, digest, blobs, pass, warnings, draft, mergeByHand, finishChecks };
}

describe("hosted jobs: persisted repository edges drive warning and hold", () => {
  it("warns for a consumer merged first, holds the other consumer, and releases it after the provider merges", async () => {
    const w = await hostedOrderWorld();
    await w.blobs.put(w.key, w.bytes(), meta);
    w.mergeByHand("app");
    await w.pass();
    expect((await w.warnings()).map((row) => row["text"])).toEqual(["app merged before payments-lib, which it depends on. Rovara keeps docs as a draft until payments-lib merges. Merge payments-lib next, or ask for a revert of app."]);
    expect((await w.world.task()).workflow.pullRequests!.find((pr) => pr.repositoryId === "app")?.state).toBe("MERGED");
    // Draft readiness runs before merge observation. Complete docs' checks after
    // that observation, so only the dependency order now holds its draft.
    w.finishChecks();
    await w.pass();
    expect(w.draft("docs")).toBe(true);
    expect(w.draft("payments-lib")).toBe(false);
    w.mergeByHand("payments-lib");
    // One pass observes the provider; the next uses the recorded merge order.
    await w.pass();
    await w.pass();
    expect(w.draft("docs")).toBe(false);
    expect(await w.warnings()).toHaveLength(1);
    expect(w.merges.map((merge) => merge.mock.calls.length)).toEqual([1, 0, 1]);
  });

  for (const facts of ["missing", "stale-key", "stale-body", "unreadable", "other-company"] as const) it(`${facts} facts do not invent an order warning or hold`, async () => {
    const w = await hostedOrderWorld();
    const otherDigest = "f".repeat(64);
    if (facts === "stale-key") await w.blobs.put(repositoryEdgesKey(w.home, otherDigest), w.bytes(otherDigest), meta);
    if (facts === "stale-body") await w.blobs.put(w.key, w.bytes(otherDigest), meta);
    if (facts === "unreadable") await w.blobs.put(w.key, Buffer.from("not json"), meta);
    if (facts === "other-company") {
      const foreignHome = { ...w.home, ownerKey: "other-owner" };
      await w.h.store.put({ item: { ...workspaceKey(B, foreignHome.workspaceId), entityType: "WORKSPACE", id: foreignHome.workspaceId, companyId: B, ownerKey: foreignHome.ownerKey } });
      await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set(["ownerKey"], foreignHome.ownerKey)] });
      await hostedEvidenceBlobs({ blobs: w.registry.require("object-storage"), store: w.h.store, companyId: B }).put(repositoryEdgesKey(foreignHome, w.digest), w.bytes(), meta);
    }
    w.mergeByHand("app");
    await w.pass();
    w.finishChecks();
    await w.pass();
    expect(await w.warnings()).toEqual([]);
    expect(w.draft("docs")).toBe(false);
    expect(w.draft("payments-lib")).toBe(false);
    // Tracking observes merges; it never performs one itself.
    expect(w.merges.map((merge) => merge.mock.calls.length)).toEqual([1, 0, 0]);
  });
});
