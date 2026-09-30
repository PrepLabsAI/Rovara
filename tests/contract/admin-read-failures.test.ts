// tests/contract/admin-read-failures.test.ts
// Spec 025 A7, US5 scenario 3: failures in a window, newest first, from the failure index.
import { describe, expect, it } from "vitest";
import { readFailures, timeWindow, type AdminReadDependencies } from "../../packages/broker/src/aws/admin-reads.js";
import { failureIndexKey } from "../../packages/contracts/src/index.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const failure = (endedAt: string, n: number, extra: Record<string, unknown> = {}) => {
  const operationId = `1111111${n}-1111-4111-8111-111111111111`;
  return {
    ...failureIndexKey(endedAt, operationId), entityType: "FAILURE_INDEX", operationId, workspaceId: "22222222-2222-4222-8222-222222222222",
    project: "payments", origin: "slack", requester: { kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, kind: "task",
    status: "FAILED", category: "task_failed", error: "npm test exited 1", endedAt, thread: "T0BSHLLUGBD/C0123456789/1695500000.000100", ...extra,
  };
};

describe("GET /v1/admin/failures (FR-038, A7)", () => {
  it("answers the last 24 hours by default, newest first, across two days, with each field US5 names", async () => {
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    const { db, admin } = await createAdminReadBroker();
    for (const entry of [failure(at(1), 1), failure(at(20), 2, { origin: "ai_tool", category: "setup_failed", kind: "prepare", taskId: "33333333-3333-4333-8333-333333333333" }), failure(at(30), 3)]) db.set(entry);
    const answer = await admin("GET", "/v1/admin/failures");
    expect(answer.status).toBe(200);
    const failures = answer.body.failures as Array<Record<string, unknown>>;
    expect(failures.map((entry) => entry.endedAt)).toEqual([at(1), at(20)]);
    expect(failures[1]).toEqual({
      operationId: "11111112-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", project: "payments",
      origin: "ai_tool", requester: { kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, kind: "prepare", status: "FAILED",
      category: "setup_failed", error: "npm test exited 1", endedAt: at(20), thread: "T0BSHLLUGBD/C0123456789/1695500000.000100",
      taskId: "33333333-3333-4333-8333-333333333333",
    });
    expect(failures[0]).not.toHaveProperty("pk");
  });

  it("filters by project and window, and honours limit", async () => {
    // Today's date (UTC), so the window stays inside the index's 30 days whenever the suite runs.
    const day = new Date().toISOString().slice(0, 10);
    const { db, admin } = await createAdminReadBroker();
    db.set(failure(`${day}T08:00:00.000Z`, 1));
    db.set(failure(`${day}T09:00:00.000Z`, 2, { project: "ledger" }));
    db.set(failure(`${day}T10:00:00.000Z`, 3));
    const window = `since=${day}T00:00:00.000Z&until=${day}T23:00:00.000Z`;
    expect((await admin("GET", `/v1/admin/failures?${window}&project=payments`)).body.failures).toHaveLength(2);
    expect(((await admin("GET", `/v1/admin/failures?${window}&limit=1`)).body.failures as Array<{ endedAt: string }>)[0]?.endedAt).toBe(`${day}T10:00:00.000Z`);
  });

  it("refuses a window over 30 days, since after until, a bad limit and a bad project", async () => {
    const { admin } = await createAdminReadBroker();
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    for (const query of [`since=${old}`, "since=2026-09-30T10:00:00.000Z&until=2026-09-30T09:00:00.000Z", "limit=0", "limit=101", "project=%3Cscript%3E", "since=yesterday", `since=${new Date(Date.now() - 86_400_000).toISOString()}&until=2999-01-01T00:00:00.000Z`]) {
      expect((await admin("GET", `/v1/admin/failures?${query}`)).body.error, query).toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  // Final review, item 6: a date that does not exist is refused, never rolled over to the next month.
  it("refuses a time that does not exist, such as February 31 or hour 24", () => {
    const now = Date.parse("2026-03-05T00:00:00.000Z");
    for (const [name, value] of [["until", "2026-02-31T00:00:00.000Z"], ["since", "2026-02-30T08:00:00.000Z"], ["until", "2026-03-03T24:00:00.000Z"]] as const) {
      expect(() => timeWindow(new URL(`https://agentx.example/v1/admin/failures?${name}=${value}`), now, 24), value).toThrow(`${name} must be an ISO 8601 time such as 2026-09-30T00:00:00.000Z`);
    }
    expect(timeWindow(new URL("https://agentx.example/v1/admin/failures?until=2026-02-28T23:59:59.999Z"), now, 24).until).toBe("2026-02-28T23:59:59.999Z");
  });

  it("says the index keeps 30 days when since is older than that", async () => {
    const { admin } = await createAdminReadBroker();
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    expect((await admin("GET", `/v1/admin/failures?since=${old}`)).body.error).toEqual({
      code: "CONFIG_INVALID", message: "AgentX keeps these records 30 days; ask for at most the last 30 days",
    });
  });

  it("reads only the asked category when readFailures is given one (Task 12's latest dispatch failure)", async () => {
    const db = new FakeDynamoDb();
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    db.set(failure(at(1), 1));
    db.set(failure(at(2), 2, { category: "worker_unavailable" }));
    const deps = { documentClient: db, tableName: "state", limitDefaults: { member: 1, organization: 1 }, now: () => Date.now(), log: () => undefined } as unknown as AdminReadDependencies;
    const answer = await readFailures(deps, { since: at(24), until: at(0) }, { limit: 10, category: "worker_unavailable" });
    expect(answer.failures.map((entry) => entry.operationId)).toEqual(["11111112-1111-4111-8111-111111111111"]);
    expect(answer.skipped).toBe(0);
  });

  it("never shows an item past its indexExpiresAt, which TTL deletes up to 48 hours late (A6)", async () => {
    const { db, admin } = await createAdminReadBroker();
    const at = new Date(Date.now() - 3_600_000).toISOString();
    db.set({ ...failure(at, 1), indexExpiresAt: Math.floor(Date.now() / 1000) - 1 });
    expect((await admin("GET", "/v1/admin/failures")).body.failures).toEqual([]);
  });

  it("leaves out an item that no longer parses, and counts it", async () => {
    const { db, admin } = await createAdminReadBroker();
    const at = new Date(Date.now() - 3_600_000).toISOString();
    db.set({ ...failure(at, 1), category: "cosmic_rays" });
    expect((await admin("GET", "/v1/admin/failures")).body).toMatchObject({ failures: [], skipped: 1 });
  });
});
