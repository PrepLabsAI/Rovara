import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, companyMembershipFromStore, readTaskLegacyProject } from "../../packages/broker/src/aws/company-check.js";
import { companyRouteHarness, COMPANY_CHECKED_ROUTES, PERSON, TASK, TIME } from "../support/company-route-harness.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";

const bodyOf = (text: string) => JSON.parse(text) as { tasks: Array<{ title: string; taskId: string }>; projects: unknown[]; nextCursor?: string; error: unknown };
const paths = [`/v1/dev/tasks/${TASK}`, "/v1/dev/tasks", "/v1/dev/projects"];
const member = (companyId: unknown = COMPANY_A.orgId) => ({ pk: `COMPANY_MEMBER#${PERSON}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: PERSON, companyId, role: "member", joinedAt: TIME });

describe("membership checked developer reads", () => {
  it("retains the original three protected routes", () => expect(COMPANY_CHECKED_ROUTES.slice(0, 3)).toEqual(["GET /v1/dev/tasks/{taskId}", "GET /v1/dev/tasks", "GET /v1/dev/projects"]));
  it.each([ ""])("refuses malformed stored company %j instead of treating it as implicit", async (company) => {
    const h = companyRouteHarness(); h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
    const absent = await h.read(paths[0]!);
    h.task(TASK, company, COMPANY_A.canary); h.project(company);
    expect(await h.read(paths[0]!)).toEqual(absent);
    expect(bodyOf((await h.read(paths[1]!)).body).tasks).toEqual([]);
    expect(bodyOf((await h.read(paths[2]!)).body).projects).toEqual([]);
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

import { boundedCompanyReads } from "../../packages/broker/src/aws/company-check.js";

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


// D1-2 (DEC 254zzz502): "paginates an ordinary fifty-task list with forty operations each" and "refuses an individually oversized task and hard byte failures with fixed words" drove the retired
// workflow list, whose rows each read their task view and workspace operations through the company budget. A core task's row reads its mark and its task only, so those budgets are exercised
// where they are now reached: tests/unit/list-old-tasks-company-mode.test.ts (the 512-command, 8 MB and 10 s limits end a page with a cursor through the route's whole-call check).

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
