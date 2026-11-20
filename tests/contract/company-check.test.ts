import { describe, expect, it, vi } from "vitest";
import { agentXError, IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, companyMembershipFromStore, readTaskLegacyProject } from "../../packages/broker/src/aws/company-check.js";
import { companyRouteHarness, COMPANY_CHECKED_ROUTES, PERSON, TASK, TIME } from "../support/company-route-harness.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";

const bodyOf = (text: string) => JSON.parse(text) as { tasks: Array<{ title: string; taskId: string }>; projects: unknown[]; nextCursor?: string; error: unknown };
const paths = [`/v1/dev/tasks/${TASK}`, "/v1/dev/tasks", "/v1/dev/projects"];
const member = (companyId: unknown = COMPANY_A.orgId) => ({ pk: `COMPANY_MEMBER#${PERSON}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: PERSON, companyId, role: "member", joinedAt: TIME });

describe("membership checked developer reads", () => {
  it("retains the original three protected routes", () => expect(COMPANY_CHECKED_ROUTES.slice(0, 3)).toEqual(["GET /v1/dev/tasks/{taskId}", "GET /v1/dev/tasks", "GET /v1/dev/projects"]));
  it.each(["member"] as const)("reuses the checked %s role for every task's money and refreshes it next request", async (role) => {
    const h = companyRouteHarness();
    const other = "22222222-2222-4222-8222-222222222222";
    for (const id of [TASK, other]) h.db.set({ ...h.task(id, COMPANY_A.orgId), spentUsd: 7.31, spentRuns: 1 });
    const reader = companyMembershipFromDynamo(h.db, "State");
    const membershipOf = vi.fn((personId: string) => reader.membershipOf!(personId));
    const companyOf = vi.fn((personId: string) => reader.companyOf(personId));
    h.deps.companies = { membershipOf, companyOf };
    h.db.set({ ...member(), role });
    for (const path of [paths[0]!, "/v1/dev/tasks?detail=1"]) {
      const response = await h.read(path);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("7.31");
    }
    expect(membershipOf.mock.calls).toEqual([[PERSON], [PERSON]]);
    expect(companyOf).not.toHaveBeenCalled();
    h.db.set({ ...member(), revokedAt: TIME });
    expect((await h.read(paths[0]!)).statusCode).toBe(401);
    expect(membershipOf).toHaveBeenCalledTimes(3);
  });
  it.each(["member"] as const)("checks another stored owner's money and one membership read per route for role %s", async (role) => {
    const h = companyRouteHarness();
    const storedOwner = "e".repeat(64);
    const designReview = {
      status: "done", spentUsd: 2.83, capUsd: 17.43, estimateUsd: 3.91,
      rounds: [{ reviewers: [{ costUsd: 0.87 }] }],
      approvals: [{ kind: "spend", approvedUsd: 5.67 }, { kind: "raise_cap", fromUsd: 9.73, capUsd: 18.61 }],
      earlierReviews: [{ spentUsd: 1.81 }],
    };
    const task = { ...h.task(TASK, COMPANY_A.orgId), developerId: storedOwner, ownerKey: storedOwner,
      developerName: "Other Person", spentUsd: 28.4812, spentRuns: 1,
      workflow: { path: "FULL", decisions: [], artifacts: [], reviews: [], designReview },
    };
    h.db.set(task);
    h.project(COMPANY_A.orgId);
    h.db.set({ pk: `DEVTASK#${TASK}`, sk: `READER#${PERSON}`, schemaVersion: 1,
      developerId: PERSON, role: "viewer", grantedBy: storedOwner, grantedAt: TIME });
    const reader = companyMembershipFromDynamo(h.db, "State");
    const membershipOf = vi.fn((personId: string) => reader.membershipOf!(personId));
    const companyOf = vi.fn((personId: string) => reader.companyOf(personId));
    h.deps.companies = { membershipOf, companyOf };
    // Inspect every nested money field, including archived design reviews and approval history.
    const moneyNumbers = (value: unknown, path: string[] = []): Record<string, number> => {
      if (typeof value === "number") return path.some((key) => /money|runEstimate|cost|spent|designReview|usd/i.test(key)) ? { [path.join(".")]: value } : {};
      if (value === null || typeof value !== "object") return {};
      return Object.assign({}, ...Object.entries(value).map(([key, field]) => moneyNumbers(field, [...path, key]))) as Record<string, number>;
    };
    expect(task.developerId).not.toBe(PERSON);
    for (const companyId of [COMPANY_A.orgId, COMPANY_B.orgId]) {
      h.db.set({ ...member(companyId), role });
      for (const path of [paths[0]!, "/v1/dev/tasks?detail=1"]) {
        membershipOf.mockClear(); companyOf.mockClear();
        const response = await h.read(path);
        const body = JSON.parse(response.body) as { task?: { owner?: { developerId: string } }; tasks?: unknown[] };
        const figures = moneyNumbers(body);
        const detailList = path.includes("?detail=1");
        if (detailList) {
          // The ordinary list is owner-only, even with a stale index in this caller's partition.
          expect(response.statusCode).toBe(200);
          expect(body.tasks).toEqual([]);
          expect(figures).toEqual({});
        } else if (companyId === COMPANY_B.orgId) {
          expect(response.statusCode).toBe(404);
          expect(figures).toEqual({});
        } else {
          expect(response.statusCode).toBe(200);
          expect(body.task?.owner?.developerId).toBe(storedOwner);
          if (role === "member") expect(figures).toEqual({});
          else expect(figures).toEqual({
            "task.spent.usd": 28.4812, "task.spent.runs": 1,
            "task.spent.inputTokens": 0, "task.spent.outputTokens": 0, "task.spent.unpricedRuns": 0,
            "task.workflow.designReview.spentUsd": 2.83,
            "task.workflow.designReview.capUsd": 17.43,
            "task.workflow.designReview.estimateUsd": 3.91,
            "task.workflow.designReview.rounds.0.reviewers.0.costUsd": 0.87,
            "task.workflow.designReview.approvals.0.approvedUsd": 5.67,
            "task.workflow.designReview.approvals.1.fromUsd": 9.73,
            "task.workflow.designReview.approvals.1.capUsd": 18.61,
            "task.workflow.designReview.earlierReviews.0.spentUsd": 1.81,
          });
        }
        expect.soft(membershipOf.mock.calls, path).toEqual([[PERSON]]);
        // The long-standing reader-grant check also reads the caller's company on a same-company non-owner GET.
        // De-duplicating that read is a logged follow-up; list paths and foreign-task refusals skip it.
        expect.soft(companyOf.mock.calls, path).toEqual(!detailList && companyId === COMPANY_A.orgId ? [[PERSON]] : []);
      }
    }
  });
  it("returns byte-identical not-found for foreign and missing tasks; list and catalog are empty", async () => {
    const h = companyRouteHarness(); h.deps.companies = { companyOf: async () => COMPANY_B.orgId };
    const absent = await h.read(paths[0]!);
    h.task(TASK, COMPANY_A.orgId, COMPANY_A.canary); h.project(COMPANY_A.orgId);
    expect(await h.read(paths[0]!)).toEqual(absent);
    expect(bodyOf((await h.read(paths[1]!)).body).tasks).toEqual([]);
    expect(bodyOf((await h.read(paths[2]!)).body).projects).toEqual([]);
    for (const path of paths) {
      const response = await h.read(path);
      expect(JSON.stringify(response)).not.toContain(COMPANY_A.canary);
      expect(JSON.stringify(response)).not.toContain(COMPANY_A.orgId);
      expect(JSON.stringify(response)).not.toContain(COMPANY_B.orgId);
    }
    // Same raw keys, now holding B's own records, are visible to B.
    h.task(TASK, COMPANY_B.orgId, COMPANY_B.canary); h.project(COMPANY_B.orgId);
    expect((await h.read(paths[0]!)).body).toContain(COMPANY_B.canary);
    expect((await h.read(paths[1]!)).body).toContain(COMPANY_B.canary);
    expect(bodyOf((await h.read(paths[2]!)).body).projects).toHaveLength(1);
  });
  it.each([ ""])("refuses malformed stored company %j instead of treating it as implicit", async (company) => {
    const h = companyRouteHarness(); h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
    const absent = await h.read(paths[0]!);
    h.task(TASK, company, COMPANY_A.canary); h.project(company);
    expect(await h.read(paths[0]!)).toEqual(absent);
    expect(bodyOf((await h.read(paths[1]!)).body).tasks).toEqual([]);
    expect(bodyOf((await h.read(paths[2]!)).body).projects).toEqual([]);
  });
  it("old records belong only to the implicit company, including closed list rows", async () => {
    const h = companyRouteHarness(); const row = h.task(); h.project();
    const index = h.db.get(`DEVELOPER#${PERSON}`, `TASK#${TIME}#${TASK}`)!;
    h.db.set({ ...index, status: "CLOSED" }); h.db.set({ ...row, closedAt: TIME });
    h.deps.companies = { companyOf: async () => COMPANY_B.orgId };
    expect((await h.read(paths[0]!)).statusCode).toBe(404);
    expect(bodyOf((await h.read(paths[1]!)).body).tasks).toEqual([]);
    expect(bodyOf((await h.read(paths[2]!)).body).projects).toEqual([]);
    h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
    expect((await h.read(paths[0]!)).statusCode).toBe(200);
    expect(bodyOf((await h.read(paths[1]!)).body).tasks).toHaveLength(1);
    expect(bodyOf((await h.read(paths[2]!)).body).projects).toHaveLength(1);
  });
});

it("membership adapters validate the approved stand-in shape at runtime", async () => {
  const h = companyRouteHarness(); const world = dynamoWorld();
  const readers = [companyMembershipFromDynamo(h.db, "State"), companyMembershipFromStore(world.store)];
  const plant = async (row: ReturnType<typeof member>) => { h.db.set(row); await world.store.put({ item: row as never }); };
  await plant(member());
  for (const reader of readers) expect(await reader.companyOf(PERSON)).toBe(COMPANY_A.orgId);
  for (const patch of [{ personId: "other" }, { role: "root" }, { joinedAt: 1 }, { entityType: "OTHER" }, { companyId: {} }]) {
    await plant({ ...member(), ...patch } as ReturnType<typeof member>);
    for (const reader of readers) expect(await reader.companyOf(PERSON)).toBeUndefined();
  }
});

import { boundedCompanyReads, COMPANY_READ_LIMITS } from "../../packages/broker/src/aws/company-check.js";

it("rejects invalid runtime readers and invalid member keys without leaking input", async () => {
  const h = companyRouteHarness();
  for (const reader of [null, {}, { companyOf: 3 }]) {
    h.deps.companies = reader as never;
    for (const path of paths) expect((await h.read(path)).statusCode).toBe(401);
  }
  const store = { get: vi.fn(async () => undefined) };
  const reader = companyMembershipFromStore(store);
  for (const person of [undefined, 7, "", "secret#canary", "secret canary", "x".repeat(257)]) expect(await reader.companyOf(person as string)).toBeUndefined();
  expect(store.get).not.toHaveBeenCalled();
});

it("membership adapters sanitize read failures before exposing them to a caller", async () => {
  const fail = async (): Promise<never> => { throw new Error(COMPANY_A.canary); };
  for (const reader of [companyMembershipFromStore({ get: fail }), companyMembershipFromDynamo({ send: fail }, "State")]) {
    await expect(reader.companyOf(PERSON)).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: "AUTH_REQUIRED: your AgentX sign-in has ended; run agentx login <url> again" });
  }
});


it("paginates an ordinary fifty-task list with forty operations each", async () => {
  const h = companyRouteHarness();
  const ids = Array.from({ length: 50 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  for (const id of ids) h.db.set({ ...h.task(id), workspaceId: `ws-${id}` });
  h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
  h.deps.tasks!.operations = async () => Array.from({ length: 40 }, (_, i) => ({ id: String(i), kind: "task", status: "SUCCEEDED", createdAt: TIME, fence: i }) as never);
  const first = await h.read("/v1/dev/tasks?limit=50");
  expect(first.statusCode).toBe(200);
  const page = bodyOf(first.body);
  expect(page.tasks.length).toBeGreaterThan(0); expect(page.tasks.length).toBeLessThan(50);
  expect(page.nextCursor).toEqual(expect.any(String));
  const second = await h.read(`/v1/dev/tasks?limit=50&cursor=${page.nextCursor!}`);
  expect(second.statusCode).toBe(200);
  const rest = bodyOf(second.body);
  expect(rest.nextCursor).toBeUndefined();
  expect([...page.tasks, ...rest.tasks].map((task) => task.taskId).sort()).toEqual(ids);
});

it("refuses an individually oversized task and hard byte failures with fixed words", async () => {
  for (const mode of ["single", "bytes", "unrelated"] as const) {
    const h = companyRouteHarness(); h.task();
    const newer = h.task("22222222-2222-4222-8222-222222222222"); h.db.set({ ...newer, workspaceId: "newer" });
    h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
    h.deps.tasks!.operations = async (workspaceId) => {
      if (mode !== "single" && workspaceId === "newer") return [];
      if (mode === "unrelated") throw agentXError("CONFIG_INVALID", "company read limit exceeded");
      return Array.from({ length: mode === "single" ? 2_001 : 1 }, () => ({ canary: mode === "bytes" ? "x".repeat(COMPANY_READ_LIMITS.bytes + 1) : COMPANY_A.canary })) as never;
    };
    const result = await h.read("/v1/dev/tasks");
    expect(result.statusCode).toBe(400);
    expect(bodyOf(result.body).error).toEqual({ code: "CONFIG_INVALID", message: "company read limit exceeded" });
    expect(result.body).not.toContain(COMPANY_A.canary);
  }
});

it("starts no further reads after the item budget and counts the crossing response bytes", async () => {
  const send = vi.fn(async () => ({ Items: Array.from({ length: 2_001 }, () => ({})) }));
  const scope = boundedCompanyReads({ send });
  await expect(scope.client.send({})).rejects.toThrow("company read limit exceeded");
  await expect(scope.client.send({})).rejects.toThrow("company read limit exceeded");
  expect(send).toHaveBeenCalledTimes(1);
  // A byte failure must not be mistaken for a pageable item-bound signal.
  const oversized = boundedCompanyReads({ send: async () => ({ Items: Array.from({ length: 2_001 }, () => ({ text: "x".repeat(4_000) })) }) });
  await expect(oversized.client.send({})).rejects.toThrow("company read limit exceeded");
  expect(() => oversized.check()).toThrow("company read limit exceeded");
});

it("does not hide an item overflow swallowed by an optional detail reader", async () => {
  const scope = boundedCompanyReads({ send: async () => ({}) });
  await scope.read(async () => Array.from({ length: 2_001 }, () => COMPANY_A.canary)).catch(() => undefined);
  expect(() => scope.check()).toThrow("company read limit exceeded");
});


describe("legacy task project ownership", () => {
  it.each([null])("refuses malformed task company %j before any read", async (companyId) => {
    const read = vi.fn(async () => ({ companyId: IMPLICIT_COMPANY_ID }));
    await expect(readTaskLegacyProject({ companyId }, read)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(read).not.toHaveBeenCalled();
  });
  it("keeps two named companies distinct while allowing the task's own row", async () => {
    const task = { companyId: COMPANY_A.orgId };
    const own = { companyId: COMPANY_A.orgId };
    expect(await readTaskLegacyProject(task, async () => own)).toBe(own);
    for (const row of [{}, { companyId: COMPANY_B.orgId }, { companyId: null }]) {
      await expect(readTaskLegacyProject(task, async () => row)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(readTaskLegacyProject({}, async () => own)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
