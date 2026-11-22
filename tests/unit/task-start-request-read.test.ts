import { describe, expect, it } from "vitest";
import { serverReadWorld, READ_COMPANY, READ_OTHER, READ_PERSON } from "../support/server-read-world.js";

describe("original start recovery through the real broker", () => {
  it("recovers only acceptance under live read authority, preserves original ID and writes nothing", async () => {
    const w = await serverReadWorld();
    const people = structuredClone(w.db.get(w.task.pk, "PEOPLE"));
    const result = await w.start();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ requestId: w.requestId, operation: "start", outcome: "confirmed", checkedAt: expect.any(String) as unknown, task: { taskId: w.taskId, project: "payments", createdAt: w.task.createdAt } });
    expect(result.headers["cache-control"]).toContain("no-store");
    expect(w.db.get(w.task.pk, "PEOPLE")).toEqual(people);
    expect(w.send.mock.calls.every(([cmd]) => ["GetCommand", "QueryCommand"].includes(cmd.constructor.name))).toBe(true);
    expect(w.channelMembers).not.toHaveBeenCalled();
  });
  it("returns unknown only after a successful absent-mark read and final caller check", async () => {
    const w = await serverReadWorld();
    const result = await w.call("GET", `/v1/dev/tasks/start-requests/00000000-0000-4000-8000-000000000001`);
    expect(result.status).toBe(200); expect(result.body.outcome).toBe("unknown"); expect(result.body).not.toHaveProperty("task");
  });
  it.each(["bad", "%30%30%30", "00000000-0000-4000-8000-000000000001/extra"])("keeps invalid segment %s away from generic task dispatch", async (id) => {
    const w = await serverReadWorld(); const r = await w.call("GET", `/v1/dev/tasks/start-requests/${id}`);
    expect(r.status).toBe(400); expect(r.body).toEqual({ error: { code: "CONFIG_INVALID", message: "That start request is invalid." } });
  });
  it.each(["query", "body"])("rejects %s selectors", async (kind) => {
    const w = await serverReadWorld();
    expect((await w.call("GET", `/v1/dev/tasks/start-requests/${w.requestId}${kind === "query" ? "?actor=other" : ""}`, kind === "body" ? {} : undefined)).status).toBe(400);
  });
  it.each(["foreign", "missing"])("masks a %s task even for the original person's mark", async (kind) => {
    const w = await serverReadWorld();
    if (kind === "foreign") w.db.set({ ...w.task, companyId: READ_OTHER });
    else w.db.delete(w.task.pk, "META");
    // The missing variant uses a sound mark naming an absent task.
    if (kind === "missing") w.db.set({ pk: `IDEMPOTENCY#${READ_PERSON}#DEVTASK`, sk: `REQUEST#${w.requestId}`, entityType: "IDEMPOTENCY", taskId: "00000000-0000-4000-8000-000000000009", payloadHash: "f".repeat(64) });
    if (kind === "missing") w.db.set({ ...w.db.get(`TASK_ENGINE#${w.taskId}`, "STAMP"), pk: "TASK_ENGINE#00000000-0000-4000-8000-000000000009", taskId: "00000000-0000-4000-8000-000000000009" });
    const r = await w.start(); expect(r.status).toBe(404); expect(r.body).toEqual({ error: { code: "TASK_NOT_FOUND", message: "That task is unavailable." } });
  });
  it.each(["workflow", "company", "identity", "entity"])("refuses unsupported %s stamp before reading task rows", async (kind) => {
    const w = await serverReadWorld(); const stamp = w.db.get(`TASK_ENGINE#${w.taskId}`, "STAMP")!;
    w.db.set({ ...stamp, ...(kind === "workflow" ? { coreEngine: { engine: "workflow", areas: { flow: "workflow", build: "core", merge: "core" }, flags: "", stampedAt: w.task.createdAt } } : kind === "company" ? { orgId: READ_OTHER } : kind === "entity" ? { entityType: "other" } : { taskId: "wrong" }) });
    const r = await w.start(); expect(r.status).toBe(503);
    expect(w.send.mock.calls.some(([c]) => "input" in c && (c.input as { Key?: { pk?: string } }).Key?.pk === w.task.pk)).toBe(false);
  });
  it.each(["orphaned", "stale-owner", "denied", "missing", "malformed", "slack"])("never reconciles or initializes %s People", async (kind) => {
    const w = await serverReadWorld(); const row = w.db.get(w.task.pk, "PEOPLE")!;
    if (kind === "orphaned") w.db.set({ ...row, orphaned: true, people: [] });
    if (kind === "stale-owner") w.db.set({ ...w.db.get(`ORG#${READ_COMPANY}#MEMBER#${READ_PERSON}`, "PROJECT#payments"), role: "removed" });
    if (kind === "denied") w.db.set({ ...row, orphaned: false, people: (row.people as Record<string, unknown>[]).map(p => ({ ...p, role: "denied" })) });
    if (kind === "missing") w.db.delete(w.task.pk, "PEOPLE");
    if (kind === "malformed") w.db.set({ ...row, revision: "bad" });
    if (kind === "slack") w.db.set({ ...w.db.get(w.task.pk, `PERSON#${w.personId}`), slackUserId: "U12345678" });
    const r = await w.start(); expect([401, 404, 503]).toContain(r.status); expect(r.body).not.toHaveProperty("task");
    expect(w.send.mock.calls.every(([cmd]) => ["GetCommand", "QueryCommand"].includes(cmd.constructor.name))).toBe(true);
  });
  it("supports the original viewer after completed handover but masks a denied original actor", async () => {
    const w = await serverReadWorld(); const row = w.db.get(w.task.pk, "PEOPLE")!;
    const owner = w.addWebPerson("Successor", "owner");
    const original = (row.people as Record<string, unknown>[])[0]!;
    w.db.set({ ...row, revision: 2, people: [{ ...original, role: "viewer" }, owner] });
    expect((await w.start()).status).toBe(200);
    w.db.set({ ...row, revision: 3, people: [{ ...original, role: "denied" }, owner] });
    const denied = await w.start();
    expect(denied.status).toBe(404); expect(denied.body).not.toHaveProperty("task");
  });
  it("rejects current authority lost during an awaited proof without leaking metadata", async () => {
    const w = await serverReadWorld(); const original = w.rawSend; let peopleReads = 0;
    w.send.mockImplementation(async (command) => {
      const result = await original(command);
      const key = (command as { input: { Key?: { sk?: string } } }).input.Key;
      if (key?.sk === "PEOPLE" && ++peopleReads === 1) w.db.set({ ...w.db.get(`ORG#${READ_COMPANY}#MEMBER#${READ_PERSON}`, "PROJECT#payments"), role: "removed" });
      return result;
    });
    const r = await w.start(); expect([404, 503]).toContain(r.status); expect(r.body).not.toHaveProperty("task");
  });
});

describe("persisted core record compatibility", () => {
  it("accepts the actual core workspace counter charge shape", async () => {
    const { developerCharge } = await import("../../packages/broker/src/core/task-flow/keys.js");
    const w = await serverReadWorld();
    w.db.set({ ...w.task, charge: developerCharge({ companyId: READ_COMPANY, developerId: READ_PERSON }) });
    const r = await w.start(); expect(r.status).toBe(200); expect(r.body.outcome).toBe("confirmed");
  });
});

describe("fresh local authority boundaries", () => {
  it("rejects identity drift across the final authority pass", async () => {
    const w = await serverReadWorld(); let peopleReads = 0;
    w.send.mockImplementation(async command => {
      if ((command.input.Key as { sk?: string } | undefined)?.sk === "PEOPLE" && ++peopleReads === 2) {
        w.db.set({ ...w.db.get(w.task.pk, `PERSON#${w.personId}`), name: "Changed" });
      }
      return w.rawSend(command);
    });
    const result = await w.start(); expect(result.status).toBe(503); expect(result.body).not.toHaveProperty("task");
  });
  it("keeps built-in-company proof on the counted local sender, without workspace adapter I/O", async () => {
    const { IMPLICIT_COMPANY_ID } = await import("@agentx/contracts");
    const { routeDeveloperRequest } = await import("../../packages/broker/src/aws/developer-routes.js");
    const { vi } = await import("vitest");
    const w = await serverReadWorld(); const companyId = IMPLICIT_COMPANY_ID;
    w.setMember(READ_PERSON, companyId);
    const session = [...w.db.items.values()].find(row => typeof row.pk === "string" && row.pk.startsWith("SESSION#"))!;
    const next: Record<string, unknown> = { ...session, companyId }; delete next.installMethod; w.db.set(next);
    w.db.set({ ...w.task, companyId }); w.db.set({ ...w.db.get(`TASK_ENGINE#${w.taskId}`, "STAMP"), orgId: companyId });
    w.db.set({ ...w.db.get(`ORG#${READ_COMPANY}#MEMBER#${READ_PERSON}`, "PROJECT#payments"), pk: `MEMBER#${READ_PERSON}` });
    w.db.set({ ...w.db.get(`ORG#${READ_COMPANY}#PROJECT#payments`, "REV#000000000001"), pk: "PROJECT#payments", companyId });
    const unbounded = vi.fn(async () => { throw new Error("unbounded workspace read"); });
    const path = `/v1/dev/tasks/start-requests/${w.requestId}`;
    const companies = w.config.companies;
    if (companies === undefined) throw new Error("fixture membership is required");
    const response = await routeDeveloperRequest({ documentClient: w.db, serverReadSender: { send: command => w.rawSend(command as never) }, tableName: "state", developer: w.config, companies, now: Date.now, workspaces: { getProject: unbounded, requireCompany: vi.fn() } }, { method: "GET", path, headers: { authorization: `Bearer e30.${Buffer.from(JSON.stringify(w.claims)).toString("base64url")}.test` }, requestId: "transport" }, new URL(path, "https://api.example.test"));
    expect(response).toMatchObject({ outcome: "confirmed" }); expect(unbounded).not.toHaveBeenCalled();
  });
});

describe("final proven company denial", () => {
  it("masks a membership moved during the final authority pass", async () => {
    const w = await serverReadWorld(); let reads = 0;
    w.send.mockImplementation(async command => {
      const result = await w.rawSend(command);
      if ((command.input.Key as { sk?: string } | undefined)?.sk === "PEOPLE" && ++reads === 4) w.setMember(READ_PERSON, READ_OTHER);
      return result;
    });
    const result = await w.start();
    expect(reads).toBe(4);
    expect(result.status).toBe(404); expect(result.body).not.toHaveProperty("task");
  });
  it("masks a membership moved between the final live read and standing recheck", async () => {
    const clean = await serverReadWorld();
    expect((await clean.start()).status).toBe(200);
    const keys = clean.send.mock.calls.map(([command]) => command.input.Key as { pk?: string } | undefined);
    const memberPk = `COMPANY_MEMBER#${READ_PERSON}`;
    // Move after authentication's membership snapshot, before standing's last
    // membership reread, so authentication succeeds and the company comparison decides.
    const moveAfter = keys.filter(key => key?.pk === memberPk).length - 1;
    expect(moveAfter).toBeGreaterThan(0);
    const w = await serverReadWorld(); let reads = 0; let moved = false;
    w.send.mockImplementation(async command => {
      const result = await w.rawSend(command);
      if ((command.input.Key as { pk?: string } | undefined)?.pk === memberPk && ++reads === moveAfter) {
        w.setMember(READ_PERSON, READ_OTHER); moved = true;
      }
      return result;
    });
    const result = await w.start();
    expect(moved).toBe(true);
    expect(result.status).toBe(404); expect(result.body).not.toHaveProperty("task");
  });
  it.each(["revoked", "moved"])("masks %s caller membership during the final pass", async kind => {
    const w = await serverReadWorld(); let reads = 0;
    w.send.mockImplementation(async command => {
      if ((command.input.Key as { pk?: string } | undefined)?.pk?.startsWith("IDEMPOTENCY#") && ++reads === 2) {
        if (kind === "moved") w.setMember(READ_PERSON, READ_OTHER);
        else w.db.set({ ...w.db.get(`COMPANY_MEMBER#${READ_PERSON}`, "COMPANY"), revokedAt: w.task.createdAt });
      }
      return w.rawSend(command);
    });
    const result = await w.start(); expect(result.status).toBe(404); expect(result.body).not.toHaveProperty("task");
  });
});

it("takes the start person only from the verified token despite a person header", async () => {
  const w = await serverReadWorld();
  const other = w.addWebPerson("Other", "viewer");
  const originalPk = `IDEMPOTENCY#${READ_PERSON}#DEVTASK`;
  const otherPk = `IDEMPOTENCY#${other.developerId}#DEVTASK`;
  w.db.set({ ...w.db.get(originalPk, `REQUEST#${w.requestId}`), pk: otherPk });
  w.db.delete(originalPk, `REQUEST#${w.requestId}`);
  const result = await w.call("GET", `/v1/dev/tasks/start-requests/${w.requestId}`, undefined, undefined, { "x-agentx-person": other.developerId });
  expect(result.status).toBe(200); expect(result.body.outcome).toBe("unknown"); expect(result.body).not.toHaveProperty("task");
  const markReads = w.send.mock.calls.map(([command]) => command.input.Key as { pk?: string } | undefined).filter(key => key?.pk?.startsWith("IDEMPOTENCY#"));
  expect(markReads).toEqual([{ pk: originalPk, sk: `REQUEST#${w.requestId}` }]);
});

it("discards confirmed facts when a valid core stamp drifts on reread", async () => {
  const w = await serverReadWorld(); let reads = 0;
  w.send.mockImplementation(async command => {
    if ((command.input.Key as { pk?: string } | undefined)?.pk === `TASK_ENGINE#${w.taskId}` && ++reads === 2) {
      const stamp = w.db.get(`TASK_ENGINE#${w.taskId}`, "STAMP")!;
      w.db.set({ ...stamp, coreEngine: { ...stamp.coreEngine as object, flags: "changed", stampedAt: "2026-11-20T10:01:00.000Z" } });
    }
    return w.rawSend(command);
  });
  const result = await w.start();
  expect(reads).toBe(2);
  expect(result.status).toBe(503); expect(result.body).not.toHaveProperty("task");
});


it("discards confirmed facts when the session is revoked during the final People proof", async () => {
  const w = await serverReadWorld(); let reads = 0;
  w.send.mockImplementation(async command => {
    const result = await w.rawSend(command);
    if ((command.input.Key as { sk?: string } | undefined)?.sk === "PEOPLE" && ++reads === 2) {
      const pk = `SESSION#${w.claims.sid}`;
      w.db.set({ ...w.db.get(pk, "META"), revokedAt: "2026-11-20T11:00:00.000Z" });
    }
    return result;
  });
  const result = await w.start();
  expect(result.status).not.toBe(200); expect(result.body).not.toHaveProperty("task");
});


it("refuses a People change while fresh identity proofs are in flight", async () => {
  const w = await serverReadWorld();
  const row = w.db.get(w.task.pk, "PEOPLE")!;
  const original = (row.people as Record<string, unknown>[])[0]!;
  const successor = w.addWebPerson("Successor", "owner");
  w.db.set({ ...row, revision: 2, people: [{ ...original, role: "viewer" }, successor] });
  let reads = 0;
  w.send.mockImplementation(async command => {
    const result = await w.rawSend(command);
    if ((command.input.Key as { sk?: string } | undefined)?.sk === "PEOPLE" && ++reads === 2) {
      w.db.set({ ...row, revision: 3, people: [{ ...original, role: "denied" }, successor] });
    }
    return result;
  });
  const result = await w.start();
  expect(result.status).not.toBe(200); expect(result.body).not.toHaveProperty("task");
});
