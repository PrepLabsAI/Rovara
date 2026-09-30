// tests/contract/admin-change-audit.test.ts
// Spec 025 E3, FR-051, FR-052: one audit record per change request, written once and then only
// stepped forward; its outcome is set once and counted once.
import { describe, expect, it, vi } from "vitest";
import { listAudit, logChangeStep, outcomeMetric, readAudit, recordAuditStep, recordRefusedAttempt, writeProposal, type AuditStore } from "../../packages/broker/src/aws/admin-change-audit.js";
import type { AdminChangeAuditRecord } from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const PROPOSED = "2026-10-02T09:00:00.000Z";
const PLANTED = `ghp_${"C".repeat(36)}`;
const record = (changeId = CHANGE, proposedAt = PROPOSED, extra: Partial<AdminChangeAuditRecord> = {}): AdminChangeAuditRecord => ({
  changeId, kind: "bind_channel", traceId: "trace-1", status: "pending",
  admin: { issuer: "https://identity.example.test", subject: "admin-subject", displayName: "Ada" }, client: { cliVersion: "0.0.7", mcpClientName: "claude-code", mcpClientVersion: "2.1.0" },
  change: { kind: "bind_channel", channel: "C0123456789", project: "ledger" }, effect: "Bind channel C0123456789 to project ledger.",
  methodsOffered: ["elicitation"], proposedAt, ...extra,
});

function store(): AuditStore & { db: FakeDynamoDb; metrics: string[]; logs: Array<Record<string, unknown>> } {
  const db = new FakeDynamoDb();
  const metrics: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  return { db, metrics, logs, documentClient: db, tableName: "turns", now: () => Date.parse("2026-10-02T09:05:00.000Z"), log: (entry) => logs.push(entry), metric: (outcome) => metrics.push(outcome) };
}

describe("the audit record (E3)", () => {
  it("is written once, keyed for the CHANGES export, and redacted", async () => {
    const audit = store();
    await writeProposal(audit, record(CHANGE, PROPOSED, { change: { kind: "register_credential", ref: "linear", note: PLANTED } }));
    const stored = audit.db.get(`CHANGE#${CHANGE}`, "AUDIT")!;
    expect(stored).toMatchObject({ exportPk: "CHANGES", exportSk: `${PROPOSED}#${CHANGE}`, status: "pending" });
    expect(JSON.stringify(stored)).not.toContain(PLANTED);
    await expect(writeProposal(audit, record())).rejects.toThrow();
    const settled = store();
    await writeProposal(settled, record(CHANGE, PROPOSED, { status: "declined", answeredAt: "2026-10-02T09:00:05.000Z" }));
    expect(await readAudit(settled, CHANGE)).toMatchObject({ status: "declined", outcome: "declined" });
    expect(settled.metrics).toEqual(["declined"]);
  });

  it("steps forward, sets the outcome once, and counts it once", async () => {
    const audit = store();
    await writeProposal(audit, record());
    await recordAuditStep(audit, CHANGE, PROPOSED, { confirmationRequestedAt: "2026-10-02T09:00:01.000Z" });
    await recordAuditStep(audit, CHANGE, PROPOSED, { status: "applied", methodUsed: "elicitation", answeredAt: "2026-10-02T09:01:00.000Z", appliedAt: "2026-10-02T09:01:00.500Z", result: { ok: true } });
    await recordAuditStep(audit, CHANGE, PROPOSED, { status: "failed", failedAt: "2026-10-02T09:02:00.000Z" });
    expect(await readAudit(audit, CHANGE)).toMatchObject({ status: "applied", outcome: "confirmed", methodUsed: "elicitation", confirmationRequestedAt: "2026-10-02T09:00:01.000Z" });
    expect(audit.metrics).toEqual(["confirmed"]);
  });

  it("keeps at most 20 refused attempts", async () => {
    const audit = store();
    await writeProposal(audit, record());
    for (let n = 0; n < 25; n += 1) await recordRefusedAttempt(audit, CHANGE, { at: "2026-10-02T09:00:30.000Z", reason: "another_person", slackUserId: "U0BOB00002" });
    expect((await readAudit(audit, CHANGE))?.refusedAttempts).toHaveLength(20);
  });

  it("still reads a record that holds more than 20 refused attempts, keeping the last 20 (C1)", async () => {
    const audit = store();
    await writeProposal(audit, record());
    const stored = audit.db.get(`CHANGE#${CHANGE}`, "AUDIT")!;
    const attempts = Array.from({ length: 23 }, (_, n) => ({ at: `2026-10-02T09:00:${String(n + 10)}.000Z`, reason: "another_person", slackUserId: "U0BOB00002" }));
    audit.db.set({ ...stored, refusedAttempts: attempts });
    const read = await readAudit(audit, CHANGE);
    expect(read?.refusedAttempts).toHaveLength(20);
    expect(read?.refusedAttempts?.[0]?.at).toBe("2026-10-02T09:00:13.000Z");
    expect(read?.refusedAttempts?.[19]?.at).toBe("2026-10-02T09:00:32.000Z");
    expect((await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 10 })).changes).toHaveLength(1);
  });

  it("lists newest first, filters by admin and outcome, and pages with a cursor", async () => {
    const audit = store();
    for (let n = 0; n < 3; n += 1) await writeProposal(audit, record(`5555555${n}-5555-4555-8555-555555555555`, `2026-10-02T09:0${n}:00.000Z`));
    await recordAuditStep(audit, "55555551-5555-4555-8555-555555555555", "2026-10-02T09:01:00.000Z", { status: "declined", answeredAt: "2026-10-02T09:01:30.000Z" });
    const first = await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 2 });
    expect(first.changes.map((change) => change.proposedAt)).toEqual(["2026-10-02T09:02:00.000Z", "2026-10-02T09:01:00.000Z"]);
    const rest = await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 2, cursor: first.cursor! });
    expect(rest.changes.map((change) => change.proposedAt)).toEqual(["2026-10-02T09:00:00.000Z"]);
    expect((await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 10, outcome: "declined" })).changes).toHaveLength(1);
    expect((await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 10, admin: "someone-else" })).changes).toHaveLength(0);
    await expect(listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 2, cursor: "bm90LWEta2V5" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("redacts a step's result and error, and refuses a step or attempt the record could not read back", async () => {
    const audit = store();
    await writeProposal(audit, record(CHANGE, PROPOSED, { effect: `Bind with ${PLANTED}.` }));
    await recordAuditStep(audit, CHANGE, PROPOSED, { status: "failed", failedAt: "2026-10-02T09:02:00.000Z", error: { code: "INTERNAL", message: `the token ${PLANTED} was refused` }, result: { token: PLANTED } });
    const stored = audit.db.get(`CHANGE#${CHANGE}`, "AUDIT")!;
    expect(JSON.stringify(stored)).not.toContain(PLANTED);
    expect(await readAudit(audit, CHANGE)).toMatchObject({ status: "failed", outcome: "failed" });
    expect(audit.metrics).toEqual(["failed"]);
    const other = store();
    await writeProposal(other, record());
    await expect(recordAuditStep(other, CHANGE, PROPOSED, { pressedBy: "not-a-slack-user" })).rejects.toThrow();
    await expect(recordRefusedAttempt(other, CHANGE, { at: "2026-10-02T09:00:30.000Z", reason: "another_person", slackUserId: "not-a-slack-user" })).rejects.toThrow();
    expect(await readAudit(other, CHANGE)).toMatchObject({ status: "pending" });
    expect((await readAudit(other, CHANGE))?.refusedAttempts).toBeUndefined();
  });

  it("logs a stored record it cannot read, by change ID only", async () => {
    const audit = store();
    await writeProposal(audit, record());
    audit.db.set({ ...audit.db.get(`CHANGE#${CHANGE}`, "AUDIT")!, status: "unknown-status" });
    expect(await readAudit(audit, CHANGE)).toBeUndefined();
    expect(audit.logs).toContainEqual({ event: "admin_change.audit_unreadable", changeId: CHANGE });
    audit.logs.length = 0;
    expect((await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 10 })).changes).toHaveLength(0);
    expect(audit.logs).toEqual([{ event: "admin_change.audit_unreadable", changeId: CHANGE }]);
  });

  it("hands back a cursor when a filter leaves every read page empty, so nothing is silently cut off", async () => {
    const audit = store();
    for (let n = 0; n < 12; n += 1) await writeProposal(audit, record(`5555555${String(n).padStart(2, "0").slice(-1)}-5555-4555-8555-5555555555${String(n).padStart(2, "0")}`, `2026-10-02T09:${String(n + 10)}:00.000Z`));
    await writeProposal(audit, record("66666666-5555-4555-8555-555555555555", "2026-10-02T08:00:00.000Z", { admin: { issuer: "https://identity.example.test", subject: "someone-else" } }));
    const first = await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 1, admin: "someone-else" });
    expect(first.changes).toHaveLength(0);
    expect(first.cursor).toBeDefined();
    let cursor = first.cursor;
    const found: string[] = [];
    for (let pages = 0; cursor !== undefined && pages < 5; pages += 1) {
      const page = await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 1, admin: "someone-else", cursor });
      found.push(...page.changes.map((change) => change.changeId));
      cursor = page.cursor;
    }
    expect(found).toEqual(["66666666-5555-4555-8555-555555555555"]);
  });

  it("logs one line per step with the change and trace IDs, and writes an EMF metric per outcome", () => {
    const log = vi.fn();
    logChangeStep(log, "applied", { changeId: CHANGE, traceId: "trace-1", kind: "bind_channel", outcome: "confirmed" });
    expect(log).toHaveBeenCalledWith({ event: "admin_change.applied", changeId: CHANGE, traceId: "trace-1", kind: "bind_channel", outcome: "confirmed" });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
    outcomeMetric("AgentX/live25e")("declined");
    spy.mockRestore();
    expect(JSON.parse(lines[0]!)).toMatchObject({ _aws: { CloudWatchMetrics: [{ Namespace: "AgentX/live25e", Dimensions: [["Outcome"]], Metrics: [{ Name: "AdminChangeOutcome", Unit: "Count" }] }] }, Outcome: "declined", AdminChangeOutcome: 1 });
  });
});
