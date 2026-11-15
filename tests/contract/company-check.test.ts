import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, companyMembershipFromStore } from "../../packages/broker/src/aws/company-check.js";
import { companyRouteHarness, COMPANY_CHECKED_ROUTES, PERSON, TASK, TIME } from "../support/company-route-harness.js";
import { dynamoWorld } from "../support/ports/dynamodb-harness.js";

const bodyOf = (text: string) => JSON.parse(text) as { tasks: Array<{ title: string }>; projects: unknown[]; nextCursor?: string; error: unknown };
const paths = [`/v1/dev/tasks/${TASK}`, "/v1/dev/tasks", "/v1/dev/projects"];
const member = (companyId: unknown = COMPANY_A.orgId) => ({ pk: `COMPANY_MEMBER#${PERSON}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: PERSON, companyId, role: "member", joinedAt: TIME });

describe("membership checked developer reads", () => {
  it("exports exactly the three protected routes", () => expect(COMPANY_CHECKED_ROUTES).toHaveLength(3));
  it("reads membership once per route after authentication, ignores all company hints", async () => {
    const h = companyRouteHarness();
    h.task(TASK, COMPANY_A.orgId, COMPANY_A.canary); h.project(COMPANY_A.orgId);
    h.db.set(member());
    const reader = companyMembershipFromDynamo(h.db, "State");
    const companyOf = vi.fn((person: string) => reader.companyOf(person));
    h.deps.companies = { companyOf };
    h.claims.org = COMPANY_B.orgId; h.claims.companyId = COMPANY_B.orgId;
    for (const path of paths) {
      const answer = await h.read(`${path}?org=${COMPANY_B.orgId}&companyId=${COMPANY_B.orgId}`, { headers: { "x-company": COMPANY_B.orgId }, body: JSON.stringify({ companyId: COMPANY_B.orgId }), jwtClaims: { companyId: COMPANY_B.orgId } });
      expect(answer.statusCode).toBe(200);
      expect(answer.body).not.toContain(COMPANY_B.orgId);
    }
    expect(companyOf.mock.calls).toEqual([[PERSON], [PERSON], [PERSON]]);
    h.claims.sid = "missing";
    expect((await h.read(paths[0]!)).statusCode).toBe(401);
    expect(companyOf).toHaveBeenCalledTimes(3);
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
  it.each([undefined, null, 1, {}, "", "leak-canary"])("refuses invalid membership %j on every route", async (company) => {
    const h = companyRouteHarness(); h.task(); h.project();
    h.deps.companies = { companyOf: async () => company as string | undefined };
    for (const path of paths) {
      const response = await h.read(path);
      expect(response.statusCode).toBe(401);
      expect(bodyOf(response.body).error).toEqual({ code: "AUTH_REQUIRED", message: "your AgentX sign-in has ended; run agentx login <url> again" });
      expect(JSON.stringify(response)).not.toContain("leak-canary");
    }
  });
  it("refuses thrown membership errors without leaking a cause or falling back", async () => {
    const h = companyRouteHarness(); h.task(TASK, undefined, COMPANY_A.canary); h.project();
    h.deps.companies = { companyOf: async () => { throw new Error(COMPANY_A.canary); } };
    for (const path of paths) { const response = await h.read(path); expect(response.statusCode).toBe(401); expect(response.body).not.toContain(COMPANY_A.canary); }
  });
  it.each([null, 1, {}, "", "leak-canary"])("refuses malformed stored company %j instead of treating it as implicit", async (company) => {
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

it("bounded filtering keeps a continuation instead of silently shortening the list", async () => {
  const h = companyRouteHarness();
  h.task(TASK, COMPANY_A.orgId, COMPANY_A.canary);
  h.task("00000000-0000-4000-8000-000000000000", COMPANY_B.orgId, COMPANY_B.canary);
  h.deps.companies = { companyOf: async () => COMPANY_B.orgId };
  const first = bodyOf((await h.read("/v1/dev/tasks?limit=1")).body);
  expect(first.tasks).toEqual([]); expect(first.nextCursor).toEqual(expect.any(String));
  const second = bodyOf((await h.read(`/v1/dev/tasks?limit=1&cursor=${first.nextCursor!}`)).body);
  expect(second.tasks).toHaveLength(1); expect(second.tasks[0]!.title).toBe(COMPANY_B.canary);
});

it("never uses foreign index payload after an owned canonical record check", async () => {
  const h = companyRouteHarness(); h.task(TASK, COMPANY_B.orgId, COMPANY_B.canary);
  const index = h.db.get(`DEVELOPER#${PERSON}`, `TASK#${TIME}#${TASK}`)!;
  h.db.set({ ...index, title: COMPANY_A.canary, status: "CLOSED", updatedAt: COMPANY_A.canary });
  h.deps.companies = { companyOf: async () => COMPANY_B.orgId };
  const response = await h.read("/v1/dev/tasks");
  expect(response.body).toContain(COMPANY_B.canary); expect(response.body).not.toContain(COMPANY_A.canary);
});

import { boundedCompanyReads, COMPANY_READ_LIMITS } from "../../packages/broker/src/aws/company-check.js";

it("enforces total company-read item, byte, command and elapsed-time limits with fixed words", async () => {
  for (const mode of ["items", "bytes", "commands", "time"] as const) {
    let now = 0;
    const payload = mode === "bytes" ? { Item: { canary: "x".repeat(COMPANY_READ_LIMITS.bytes + 1) } }
      : mode === "items" ? { Items: Array.from({ length: COMPANY_READ_LIMITS.items + 1 }, () => ({ marker: COMPANY_A.canary })) } : {};
    const scope = boundedCompanyReads({ send: async () => payload }, () => now);
    const attempt = async () => {
      if (mode === "time") now = COMPANY_READ_LIMITS.milliseconds + 1;
      for (let i = 0; i < (mode === "commands" ? COMPANY_READ_LIMITS.commands + 1 : 1); i++) await scope.client.send({});
    };
    await expect(attempt()).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: company read limit exceeded" });
  }
});

it("accepts the stated company-read boundaries and accumulates across calls", async () => {
  const itemScope = boundedCompanyReads({ send: async () => ({ Items: Array.from({ length: 1_000 }, () => ({})) }) });
  await itemScope.client.send({}); await itemScope.client.send({});
  await expect(itemScope.client.send({})).rejects.toThrow("company read limit exceeded");
  const overhead = Buffer.byteLength(JSON.stringify({ Item: { value: "" } }));
  const byteScope = boundedCompanyReads({ send: async () => ({ Item: { value: "x".repeat(COMPANY_READ_LIMITS.bytes - overhead) } }) });
  await byteScope.client.send({});
  await expect(byteScope.client.send({})).rejects.toThrow("company read limit exceeded");
  let now = 0;
  const scope = boundedCompanyReads({ send: async () => ({}) }, () => now);
  for (let i = 0; i < COMPANY_READ_LIMITS.commands; i++) await scope.client.send({});
  now = COMPANY_READ_LIMITS.milliseconds; expect(() => scope.check()).not.toThrow();
  now++; expect(() => scope.check()).toThrow("company read limit exceeded");
});

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

it("keeps old response bytes when DynamoDB returns a cursor at an exactly full physical page", async () => {
  const h = companyRouteHarness(); h.task();
  const send = h.db.send.bind(h.db);
  h.db.send = async (command) => {
    const result = await send(command) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    const input = command.input;
    if (command.constructor.name === "QueryCommand" && result.Items !== undefined && result.Items.length === input.Limit && result.Items.length > 0) {
      const last = result.Items.at(-1)!;
      return { ...result, LastEvaluatedKey: { pk: last.pk, sk: last.sk } };
    }
    return result;
  };
  const before = await h.read("/v1/dev/tasks?limit=1");
  h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
  expect(await h.read("/v1/dev/tasks?limit=1")).toEqual(before);
});

it("keeps both companies' records present while B reads its own and cannot read A's", async () => {
  const h = companyRouteHarness(); const own = "22222222-2222-4222-8222-222222222222";
  h.deps.companies = { companyOf: async () => COMPANY_B.orgId };
  const missing = await h.read(`/v1/dev/tasks/${TASK}`);
  h.task(TASK, COMPANY_A.orgId, COMPANY_A.canary); h.task(own, COMPANY_B.orgId, COMPANY_B.canary);
  h.project(COMPANY_A.orgId); h.project(COMPANY_B.orgId, "grant", "own-project");
  expect(await h.read(`/v1/dev/tasks/${TASK}`)).toEqual(missing);
  expect((await h.read(`/v1/dev/tasks/${own}`)).body).toContain(COMPANY_B.canary);
  const list = await h.read("/v1/dev/tasks");
  expect(list.body).toContain(COMPANY_B.canary); expect(list.body).not.toContain(COMPANY_A.canary);
  const catalog = await h.read("/v1/dev/projects");
  expect(catalog.body).toContain("own-project"); expect(catalog.body).not.toContain("shared-project");
});

it("membership adapters sanitize read failures before exposing them to a caller", async () => {
  const fail = async (): Promise<never> => { throw new Error(COMPANY_A.canary); };
  for (const reader of [companyMembershipFromStore({ get: fail }), companyMembershipFromDynamo({ send: fail }, "State")]) {
    await expect(reader.companyOf(PERSON)).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: "AUTH_REQUIRED: your AgentX sign-in has ended; run agentx login <url> again" });
  }
});

it("refuses an over-time response after the awaited read without returning its payload", async () => {
  let now = 0;
  const scope = boundedCompanyReads({ send: async () => { now = COMPANY_READ_LIMITS.milliseconds + 1; return { Item: { canary: COMPANY_A.canary } }; } }, () => now);
  await expect(scope.client.send({})).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: company read limit exceeded" });
});

it("applies one total item budget to task action reads across the complete list", async () => {
  const h = companyRouteHarness(); h.task();
  const other = h.task("22222222-2222-4222-8222-222222222222"); h.db.set({ ...other, workspaceId: "other-workspace" });
  h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
  h.deps.tasks!.operations = async () => Array.from({ length: 1_100 }, (_, i) => ({ id: String(i), kind: "task", status: "SUCCEEDED", createdAt: TIME, fence: i }) as never);
  const response = await h.read("/v1/dev/tasks");
  expect(response.statusCode).toBe(400);
  expect(bodyOf(response.body).error).toEqual({ code: "CONFIG_INVALID", message: "company read limit exceeded" });
});

it("reads shared task inputs once per checked list call", async () => {
  const h = companyRouteHarness(); h.task(); h.task("22222222-2222-4222-8222-222222222222");
  h.deps.companies = { companyOf: async () => IMPLICIT_COMPANY_ID };
  const operations = vi.fn(async () => []); h.deps.tasks!.operations = operations;
  expect(bodyOf((await h.read("/v1/dev/tasks")).body).tasks).toHaveLength(2);
  expect(operations).toHaveBeenCalledTimes(1);
});

it("shares a total file budget with other company reads and accepts the exact maximum", async () => {
  const scope = boundedCompanyReads({ send: async () => ({}) });
  for (let i = 0; i < COMPANY_READ_LIMITS.files; i++) await scope.read(async () => "", 1);
  await expect(scope.read(async () => COMPANY_A.canary, 1)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: company read limit exceeded" });
});
