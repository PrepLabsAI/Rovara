// tests/contract/admin-change-audit.test.ts
// Spec 025 E3, FR-051, FR-052: one audit record per change request, written once and then only
// stepped forward; its outcome is set once and counted once.
import { describe, expect, it, vi } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { auditStepItem, listAudit, logChangeStep, outcomeMetric, readAudit, recordRefusedAttempt, writeProposal, type AuditStep, type AuditStore } from "../../packages/broker/src/aws/admin-change-audit.js";
import { outcomeOfStatus, type AdminChangeAuditRecord } from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const PROPOSED = "2026-10-02T09:00:00.000Z";
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
  return { db, metrics, logs, documentClient: db, tableName: "turns", log: (entry) => logs.push(entry), metric: (outcome) => metrics.push(outcome) };
}

/**
 * One audit step as the broker's transition writes it (final review M9 dropped recordAuditStep):
 * auditStepItem in a transaction, a refused condition ignored, and the outcome counted on commit.
 */
async function step(audit: AuditStore, changeId: string, forward: AuditStep): Promise<void> {
  try {
    await audit.documentClient.send(new TransactWriteCommand({ TransactItems: [auditStepItem(audit.tableName, changeId, forward)] }));
  } catch (error) {
    if (error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException")) return;
    throw error;
  }
  const outcome = forward.status === undefined ? undefined : outcomeOfStatus(forward.status);
  if (outcome !== undefined) audit.metric(outcome);
}

describe("the audit record (E3)", () => {

  it("keeps at most 20 refused attempts", async () => {
    const audit = store();
    await writeProposal(audit, record());
    for (let n = 0; n < 25; n += 1) await recordRefusedAttempt(audit, CHANGE, { at: "2026-10-02T09:00:30.000Z", reason: "another_person", slackUserId: "U0BOB00002" });
    expect((await readAudit(audit, CHANGE))?.refusedAttempts).toHaveLength(20);
  });

  it("lists newest first, filters by admin and outcome, and pages with a cursor", async () => {
    const audit = store();
    for (let n = 0; n < 3; n += 1) await writeProposal(audit, record(`5555555${n}-5555-4555-8555-555555555555`, `2026-10-02T09:0${n}:00.000Z`));
    await step(audit, "55555551-5555-4555-8555-555555555555", { status: "declined", answeredAt: "2026-10-02T09:01:30.000Z" });
    const first = await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 2 });
    expect(first.changes.map((change) => change.proposedAt)).toEqual(["2026-10-02T09:02:00.000Z", "2026-10-02T09:01:00.000Z"]);
    const rest = await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 2, cursor: first.cursor! });
    expect(rest.changes.map((change) => change.proposedAt)).toEqual(["2026-10-02T09:00:00.000Z"]);
    expect((await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 10, outcome: "declined" })).changes).toHaveLength(1);
    expect((await listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 10, admin: "someone-else" })).changes).toHaveLength(0);
    await expect(listAudit(audit, { since: "2026-10-01T00:00:00.000Z", limit: 2, cursor: "bm90LWEta2V5" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
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
