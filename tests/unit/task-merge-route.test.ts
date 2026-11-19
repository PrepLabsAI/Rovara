// Lane W (contract v0 tasks.merge): pressing Merge goes through the merge core only. The route refuses earlier (company, owner, body; DEC 254zzz73: no step-up), never later, and adds no rule of its own.
import { describe, expect, it, vi } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, type ApprovalProof } from "../../packages/contracts/src/index.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyRouteHarness, PERSON, TASK, TIME } from "../support/company-route-harness.js";
import { MERGE_BODY, MERGE_NOT_SET_UP, pressTaskMerge, routeTaskMerge, type TaskMergeWiring } from "../../packages/broker/src/aws/task-merge.js";
import { ORG, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const NOW = Date.parse("2026-11-09T10:00:00.000Z");
const REQUEST = "0b9f1c3e-7a51-4c1e-9d55-0f3a4b6c7d8e";

function wiring(world: MergeWorld, proof?: (prepared: Parameters<TaskMergeWiring["proofOf"]>[0]) => ApprovalProof) {
  const merge = vi.fn(() => world.deps);
  const view = vi.fn(async (_company: string, taskId: string) => ({ taskId, stage: "MERGED" }));
  return { merge, view, proofOf: (prepared: Parameters<TaskMergeWiring["proofOf"]>[0]) => (proof ?? ((p) => world.proofFor(p)))(prepared) } satisfies TaskMergeWiring;
}
const press = (overrides: Partial<Parameters<typeof pressTaskMerge>[1]> = {}) => ({ companyId: ORG, taskId: TASK_ID, requestId: REQUEST, presserPersonId: "owner-1", ...overrides });
const rejects = async (run: () => Promise<unknown>) => {
  try { await run(); } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message.replace(/^[A-Z_]+: /, "") }; }
  throw new Error("expected a refusal");
};

describe("a merge press through the merge core", () => {
  it("merges a ready task's own pull request and answers the task view", async () => {
    const world = await mergeWorld(); await world.seedTracking();
    const w = wiring(world);
    expect(await pressTaskMerge(w, press())).toEqual({ task: { taskId: TASK_ID, stage: "MERGED" }, merged: true });
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("merged");
    expect(w.merge).toHaveBeenCalledWith(ORG);
  });

  it("keeps every merge rule of the core: red checks, a review asking for changes and a lost approval each refuse, and nothing merges", async () => {
    for (const [name, change, words] of [
      ["red checks", (w: MergeWorld) => w.prs[0]!.model.setChecks(w.prs[0]!.head, [{ name: "unit", state: "completed", conclusion: "failure", required: false, url: "" }]), M.checks],
      ["changes requested", (w: MergeWorld) => w.prs[0]!.model.addReview(String(w.prs[0]!.number), { login: "priya", state: "CHANGES_REQUESTED" }), M.changesRequested],
      ["approval dismissed", (w: MergeWorld) => w.prs[0]!.model.addReview(String(w.prs[0]!.number), { login: "priya", state: "DISMISSED" }), M.needsWriteApproval("app")],
    ] as const) {
      const world = await mergeWorld(); await world.seedTracking();
      change(world);
      const refusal = await rejects(() => pressTaskMerge(wiring(world), press()));
      expect(refusal.code, name).toBe("MERGE_NOT_READY");
      expect(refusal.message, name).toBe(words);
      expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state, name).toBe("open");
    }
  });

  it("refuses a proof the core's approvers do not accept (no bypass by the route)", async () => {
    const world = await mergeWorld(); await world.seedTracking();
    const refusal = await rejects(() => pressTaskMerge(wiring(world, (p) => world.proofFor(p, { token: "not-the-owner-session" })), press()));
    expect(refusal.code).toBe("FORBIDDEN");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });

  it("answers another company's task, someone else's task and a missing task alike, before the core reads anything else", async () => {
    const world = await mergeWorld(); await world.seedTracking();
    const answers = [];
    for (const overrides of [{ companyId: COMPANY_B.orgId }, { presserPersonId: "someone-else" }, { taskId: "99999999-9999-4999-8999-999999999999" }]) {
      const w = wiring(world);
      answers.push(await rejects(() => pressTaskMerge(w, press(overrides))));
      expect(w.view).not.toHaveBeenCalled();
    }
    expect(answers).toEqual([{ code: "TASK_NOT_FOUND", message: "task not found" }, { code: "TASK_NOT_FOUND", message: "task not found" }, { code: "TASK_NOT_FOUND", message: "task not found" }]);
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });

  it("refuses when the risk the person was shown is not the risk now", async () => {
    const world = await mergeWorld(); await world.seedTracking();
    const prepared = await world.prepare();
    const other = (["low", "medium", "high"] as const).find((level) => level !== prepared.risk.level)!;
    expect(await rejects(() => pressTaskMerge(wiring(world), press({ risk: other })))).toEqual({ code: "MERGE_NOT_READY", message: M.changedAfterConfirm });
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });
});

describe("the merge route", () => {
  const route = (w: TaskMergeWiring | undefined, overrides: Partial<Parameters<typeof routeTaskMerge>[0]> = {}) =>
    routeTaskMerge({ wiring: w, companyId: ORG, taskId: TASK_ID, personId: "owner-1", body: { requestId: REQUEST }, now: NOW, ...overrides });

  it("is a fixed 'not set up' where the deployment has not wired the merge core", async () => {
    expect(await rejects(() => route(undefined))).toEqual({ code: "NOT_FOUND", message: MERGE_NOT_SET_UP });
  });

  it("DEC 254zzz73: merges with no step-up for the task's owner; another person and another company still get 'task not found' and nothing merges", async () => {
    const world = await mergeWorld(); await world.seedTracking();
    for (const overrides of [{ personId: "someone-else" }, { companyId: COMPANY_B.orgId }]) {
      expect(await rejects(() => route(wiring(world), overrides))).toEqual({ code: "TASK_NOT_FOUND", message: "task not found" });
    }
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
    expect(await route(wiring(world))).toMatchObject({ merged: true });
  });

  it("validates the id and the body at runtime without echoing them", async () => {
    const world = await mergeWorld();
    const w = wiring(world);
    expect(await rejects(() => route(w, { taskId: "leak-canary" }))).toEqual({ code: "TASK_NOT_FOUND", message: "task not found" });
    for (const body of [{}, { requestId: "leak-canary" }, { requestId: REQUEST, risk: "leak-canary" }, { requestId: REQUEST, bypass: true }, null, []]) {
      expect(await rejects(() => route(w, { body }))).toEqual({ code: "CONFIG_INVALID", message: MERGE_BODY });
    }
    expect(w.merge).not.toHaveBeenCalled();
  });
});

const errorOf = (body: string) => (JSON.parse(body) as { error?: unknown }).error;

describe("the merge route on the developer API", () => {
  const MERGE_PATH = `/v1/dev/tasks/${TASK}/merge`;
  function wired(h: ReturnType<typeof companyRouteHarness>) {
    const seen: Array<{ company: string; taskId: string }> = [];
    const loadTask = vi.fn(async () => undefined);
    h.deps.taskMerge = {
      merge: () => ({ host: { loadTask } }) as never,
      proofOf: () => { throw new Error("not reached"); },
      view: async (company, taskId) => { seen.push({ company, taskId }); return {}; },
    };
    return { loadTask, seen };
  }

  it("answers the fixed 'not set up' when nothing is wired, as before for any deployment", async () => {
    const h = companyRouteHarness();
    expect(errorOf((await h.read(MERGE_PATH, { method: "POST", body: JSON.stringify({ requestId: REQUEST }) })).body)).toEqual({ code: "NOT_FOUND", message: MERGE_NOT_SET_UP });
  });

  it("takes the company only from membership (DEC 254zzz73: no step-up)", async () => {
    const h = companyRouteHarness();
    const { loadTask } = wired(h);
    // A full-access sign-in client and its session (spec 066), so the person's token goes through the client path.
    h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), fullAccess: true, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "admin" });
    h.db.set({ pk: "SESSION#web", sk: "META", sessionId: "web", developerId: PERSON, amr: "slack", clientId: "web-app", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 3600 });
    Object.assign(h.claims, { azp: "web-app", sid: "web" });
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const press = () => h.read(`${MERGE_PATH}?companyId=${COMPANY_B.orgId}`, {
      method: "POST", headers: { authorization: `Bearer ${part({ alg: "none" })}.${part(h.claims)}.sig`, "x-company": COMPANY_B.orgId }, body: JSON.stringify({ requestId: REQUEST, companyId: COMPANY_B.orgId }),
    });
    const pressPlain = () => h.read(MERGE_PATH, { method: "POST", headers: { authorization: `Bearer ${part({ alg: "none" })}.${part(h.claims)}.sig`, "x-company": COMPANY_B.orgId }, body: JSON.stringify({ requestId: REQUEST }) });
    // A company named in the body is never read: the strict body refuses it.
    expect(errorOf((await press()).body)).toEqual({ code: "CONFIG_INVALID", message: MERGE_BODY });
    const companies: string[] = [];
    h.deps.taskMerge!.merge = (company: string) => { companies.push(company); return { host: { loadTask } } as never; };
    h.claims.companyId = COMPANY_B.orgId;
    h.deps.companies = { companyOf: async () => COMPANY_A.orgId };
    // The fake core has no such task: the press reads it in the MEMBERSHIP company and answers not found.
    expect(errorOf((await pressPlain()).body)).toEqual({ code: "TASK_NOT_FOUND", message: "task not found" });
    expect(companies).toEqual([COMPANY_A.orgId]);
    expect(loadTask).toHaveBeenCalledTimes(1);
    h.deps.companies = { companyOf: async () => undefined };
    expect((await pressPlain()).statusCode).toBe(401);
  });
});
