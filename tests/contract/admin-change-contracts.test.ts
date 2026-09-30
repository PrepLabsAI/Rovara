// tests/contract/admin-change-contracts.test.ts
// Spec 025 phase 25e, Task 1: the shapes of a change request, its pending record and its audit record.
import { describe, expect, it } from "vitest";
import {
  ADMIN_API_VERSION,
  ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX,
  ADMIN_CHANGE_RETENTION_DAYS,
  ADMIN_CHANGE_TTL_MS,
  AdminChangeAuditRecordSchema,
  AdminChangeAuditRecordWireSchema,
  AdminChangeClientSchema,
  AdminChangeInputSchema,
  AdminChangeKindSchema,
  AdminChangePendingRecordSchema,
  AdminChangeRequestRecordSchema,
  AdminChangeResponseSchema,
  AdminChangeResponseWireSchema,
  AdminChangeViewSchema,
  AdminChangeViewWireSchema,
  AdminChangesResponseSchema,
  AdminChangesResponseWireSchema,
  AgentXConfigurationConfirmSchema,
  ApplyAdminChangeRequestSchema,
  DeclineAdminChangeRequestSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  ProposeAdminChangeRequestSchema,
  adminChangeAuditKeys,
  adminChangeItemExpiresAt,
  adminChangeKey,
  adminChangeRequestKey,
  agentXError,
  isAdminChangePressEvent,
  outcomeOfStatus,
  type PendingChange,
} from "../../packages/contracts/src/index.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const REQUEST = "66666666-6666-4666-8666-666666666666";
const PROPOSED = "2026-10-02T09:00:00.000Z";
const THIRTY_DAYS = Math.floor(Date.parse(PROPOSED) / 1000) + 30 * 86_400;
const omit = (value: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

describe("change requests (E1)", () => {
  it("names FR-030's nine change kinds", () => {
    expect(AdminChangeKindSchema.options).toEqual([
      "register_project_revision", "bind_channel", "unbind_channel", "register_credential", "stop_workspace",
      "grant_project_access", "revoke_project_access", "revoke_signin", "set_workspace_limits",
    ]);
  });

  it("takes each kind's own input, and refuses a field of another kind", () => {
    expect(AdminChangeInputSchema.parse({ kind: "bind_channel", channel: "#ledger-dev", project: "ledger" })).toMatchObject({ kind: "bind_channel" });
    expect(AdminChangeInputSchema.parse({ kind: "set_workspace_limits", perPerson: 5 })).toEqual({ kind: "set_workspace_limits", perPerson: 5 });
    expect(AdminChangeInputSchema.safeParse({ kind: "set_workspace_limits", perPerson: 51 }).success).toBe(false);
    expect(AdminChangeInputSchema.safeParse({ kind: "unbind_channel", channel: "C0123456789", project: "ledger" }).success).toBe(false);
    expect(AdminChangeInputSchema.safeParse({ kind: "grant_project_access", project: "<b>", developer: "U0ADA00001" }).success).toBe(false);
  });

  it("needs a request ID, the client and at least one method", () => {
    const request = { requestId: REQUEST, change: { kind: "unbind_channel", channel: "C0123456789" }, client: { cliVersion: "0.0.7", mcpClient: { name: "claude-code", version: "2.1.0" } }, methods: ["elicitation", "slack"] };
    expect(ProposeAdminChangeRequestSchema.parse(request)).toMatchObject({ methods: ["elicitation", "slack"] });
    expect(ProposeAdminChangeRequestSchema.safeParse({ ...request, methods: [] }).success).toBe(false);
    expect(ProposeAdminChangeRequestSchema.safeParse({ ...request, methods: ["email"] }).success).toBe(false);
  });

  it("takes only the client's own fields, and the MCP client's (FR-051)", () => {
    expect(AdminChangeClientSchema.parse({ cliVersion: "0.0.7" })).toEqual({ cliVersion: "0.0.7" });
    expect(AdminChangeClientSchema.safeParse({ cliVersion: "0.0.7", os: "darwin" }).success).toBe(false);
    expect(AdminChangeClientSchema.safeParse({ cliVersion: "0.0.7", mcpClient: { name: "claude-code", build: 1 } }).success).toBe(false);
    expect(AdminChangeClientSchema.safeParse({ cliVersion: "" }).success).toBe(false);
  });

  it("declines by elicitation or the CLI, with a reason, never by a Slack press through the route (E4)", () => {
    expect(DeclineAdminChangeRequestSchema.parse({ method: "cli", reason: "declined" })).toEqual({ method: "cli", reason: "declined" });
    expect(DeclineAdminChangeRequestSchema.parse({ method: "elicitation", reason: "cancelled", answeredAt: PROPOSED })).toMatchObject({ reason: "cancelled" });
    expect(DeclineAdminChangeRequestSchema.safeParse({ method: "slack", reason: "declined" }).success).toBe(false);
    expect(DeclineAdminChangeRequestSchema.safeParse({ method: "cli" }).success).toBe(false);
    expect(DeclineAdminChangeRequestSchema.safeParse({ method: "cli", reason: "bored" }).success).toBe(false);
    expect(DeclineAdminChangeRequestSchema.safeParse({ method: "cli", reason: "declined", extra: 1 }).success).toBe(false);
  });

  it("reports the environment's confirmation methods as two booleans (E16)", () => {
    expect(AgentXConfigurationConfirmSchema.parse({ elicitation: true, slack: false })).toEqual({ elicitation: true, slack: false });
    expect(AgentXConfigurationConfirmSchema.safeParse({ elicitation: "enabled", slack: false }).success).toBe(false);
    expect(AgentXConfigurationConfirmSchema.safeParse({ elicitation: true }).success).toBe(false);
  });

  it("applies only by elicitation or the CLI through the route: a Slack press has its own path (E4)", () => {
    expect(ApplyAdminChangeRequestSchema.parse({ method: "elicitation" })).toEqual({ method: "elicitation" });
    expect(ApplyAdminChangeRequestSchema.safeParse({ method: "slack" }).success).toBe(false);
  });
});

const auditRecord = {
  changeId: CHANGE, kind: "bind_channel", traceId: "trace-1", status: "applied", outcome: "confirmed",
  admin: { issuer: "https://identity.example.test", subject: "admin-subject", displayName: "Ada" },
  client: { cliVersion: "0.0.7", mcpClientName: "claude-code", mcpClientVersion: "2.1.0" },
  change: { kind: "bind_channel", channel: "C0123456789", project: "ledger" }, effect: "Bind channel #ledger-dev (C0123456789) to project ledger.",
  methodsOffered: ["elicitation", "slack"], methodUsed: "slack", pressedBy: "U0ADA00001",
  proposedAt: PROPOSED, confirmationRequestedAt: "2026-10-02T09:00:01.000Z", answeredAt: "2026-10-02T09:01:00.000Z", appliedAt: "2026-10-02T09:01:00.500Z",
  result: { binding: { channelId: "C0123456789" } }, refusedAttempts: [{ at: "2026-10-02T09:00:30.000Z", reason: "another_person", slackUserId: "U0BOB00002" }],
};

const pendingRecord = {
  ...adminChangeKey(CHANGE), entityType: "ADMIN_CHANGE", changeId: CHANGE, kind: "unbind_channel",
  input: { kind: "unbind_channel", channel: "C0123456789" }, effect: "Unbind channel C0123456789 from project ledger.", details: { project: "ledger" },
  stateHash: "a".repeat(64), admin: { issuer: "https://identity.example.test", subject: "admin-subject", ownerKey: "owner-1", displayName: "Ada" },
  slackUserId: "U0ADA00001", methodsOffered: ["elicitation", "slack"], status: "pending",
  createdAt: PROPOSED, proposedAt: PROPOSED, expiresAt: "2026-10-02T09:10:00.000Z", traceId: "trace-1",
  [INDEX_EXPIRY_ATTRIBUTE]: THIRTY_DAYS,
};

describe("records (E2, E3)", () => {
  it("keys the pending change in the State table and the audit record under its own export partition", () => {
    expect(adminChangeKey(CHANGE)).toEqual({ pk: `ADMIN_CHANGE#${CHANGE}`, sk: "META" });
    expect(adminChangeRequestKey("owner-1", REQUEST)).toEqual({ pk: "ADMIN_CHANGE_REQUEST#owner-1", sk: REQUEST });
    const keys = adminChangeAuditKeys(CHANGE, PROPOSED);
    expect(keys).toMatchObject({ pk: `CHANGE#${CHANGE}`, sk: "AUDIT", exportPk: "CHANGES", exportSk: `${PROPOSED}#${CHANGE}` });
    expect(keys.expiresAt).toBe(THIRTY_DAYS);
    expect(ADMIN_CHANGE_RETENTION_DAYS).toBe(30);
  });

  it("gives the pending items the State table's TTL attribute, 30 days after the proposal (R2, D29)", () => {
    expect(INDEX_EXPIRY_ATTRIBUTE).toBe("indexExpiresAt");
    expect(adminChangeItemExpiresAt(PROPOSED)).toBe(THIRTY_DAYS);
    expect(adminChangeItemExpiresAt(PROPOSED)).toBe(adminChangeAuditKeys(CHANGE, PROPOSED).expiresAt);
  });

  it("reads a stored pending change strictly, with its TTL (E2, C13)", () => {
    const parsed: PendingChange = AdminChangePendingRecordSchema.parse(pendingRecord);
    expect(parsed).toEqual(pendingRecord);
    expect(AdminChangePendingRecordSchema.parse({ ...pendingRecord, status: "applied", methodUsed: "slack", pressedBy: "U0ADA00001", slackRequestedAt: PROPOSED, claimedAt: PROPOSED, dm: { channel: "D0123456789", ts: "1.2", postedAt: PROPOSED }, result: { ok: true } })).toMatchObject({ status: "applied" });
    expect(AdminChangePendingRecordSchema.safeParse(omit(pendingRecord, INDEX_EXPIRY_ATTRIBUTE)).success).toBe(false);
    // R4 (B4): a member planning admin's confirmation text is stored beside the ID-only effect.
    expect(AdminChangePendingRecordSchema.parse({ ...pendingRecord, confirmationEffect: "Bind channel #secret-launch (C0PRIVATE01, a private channel)." })).toMatchObject({ confirmationEffect: expect.stringContaining("#secret-launch") as unknown });
    expect(AdminChangePendingRecordSchema.safeParse({ ...pendingRecord, confirmationEffect: "x".repeat(4_001) }).success).toBe(false);
    expect(AdminChangePendingRecordSchema.safeParse({ ...pendingRecord, surprise: 1 }).success).toBe(false);
    expect(AdminChangePendingRecordSchema.safeParse({ ...pendingRecord, status: "archived" }).success).toBe(false);
    expect(AdminChangePendingRecordSchema.safeParse({ ...pendingRecord, input: { kind: "bind_channel", channel: "C0123456789" } }).success).toBe(false);
    expect(AdminChangePendingRecordSchema.safeParse({ ...pendingRecord, pk: `CHANGE#${CHANGE}` }).success).toBe(false);
    expect(AdminChangePendingRecordSchema.safeParse({ ...pendingRecord, pk: "ADMIN_CHANGE#77777777-7777-4777-8777-777777777777" }).success).toBe(false);
    // E13 (Task 8): the notifier's claim and edit times stay readable by the broker.
    expect(AdminChangePendingRecordSchema.parse({ ...pendingRecord, dmClaimedAt: PROPOSED, dm: { channel: "D0123456789", ts: "1.2", postedAt: PROPOSED }, dmEditedAt: PROPOSED })).toMatchObject({ dmClaimedAt: PROPOSED, dmEditedAt: PROPOSED });
    expect(AdminChangePendingRecordSchema.safeParse({ ...pendingRecord, dmEditedAt: "yesterday" }).success).toBe(false);
  });

  it("reads a stored request ID's item strictly, with its TTL", () => {
    const item = { ...adminChangeRequestKey("owner-1", REQUEST), entityType: "ADMIN_CHANGE_REQUEST", changeId: CHANGE, [INDEX_EXPIRY_ATTRIBUTE]: THIRTY_DAYS };
    expect(AdminChangeRequestRecordSchema.parse(item)).toEqual(item);
    expect(AdminChangeRequestRecordSchema.safeParse({ ...item, extra: true }).success).toBe(false);
    expect(AdminChangeRequestRecordSchema.safeParse(omit(item, INDEX_EXPIRY_ATTRIBUTE)).success).toBe(false);
  });

  it("maps statuses to FR-051's outcomes", () => {
    expect(["pending", "applying", "applied", "declined", "expired", "failed"].map((status) => outcomeOfStatus(status as never))).toEqual([undefined, undefined, "confirmed", "declined", "expired", "failed"]);
  });

  it("reads an audit record with every FR-051 field, and one still pending", () => {
    expect(AdminChangeAuditRecordSchema.parse(auditRecord)).toMatchObject({ outcome: "confirmed" });
    const pending = omit(auditRecord, "outcome", "appliedAt", "answeredAt", "methodUsed", "pressedBy", "result");
    expect(AdminChangeAuditRecordSchema.parse({ ...pending, status: "pending" })).not.toHaveProperty("outcome");
    expect(AdminChangeAuditRecordSchema.parse(omit(auditRecord, "refusedAttempts"))).not.toHaveProperty("refusedAttempts");
    expect(AdminChangeAuditRecordSchema.safeParse({ ...auditRecord, surprise: 1 }).success).toBe(false);
  });

  it("keeps a record with more than 20 refused attempts readable, holding the last 20 (C1)", () => {
    const attempts = Array.from({ length: 25 }, (_, index) => ({ at: new Date(Date.parse(PROPOSED) + index * 1_000).toISOString(), reason: "another_person", slackUserId: "U0BOB00002" }));
    const parsed = AdminChangeAuditRecordSchema.parse({ ...auditRecord, refusedAttempts: attempts });
    expect(ADMIN_CHANGE_REFUSED_ATTEMPTS_MAX).toBe(20);
    expect(parsed.refusedAttempts).toEqual(attempts.slice(-20));
    expect(AdminChangeAuditRecordSchema.parse({ ...auditRecord, refusedAttempts: attempts.slice(0, 20) }).refusedAttempts).toHaveLength(20);
    expect(AdminChangeAuditRecordSchema.safeParse({ ...auditRecord, refusedAttempts: [{ at: PROPOSED, reason: "bored" }] }).success).toBe(false);
    const wire = AdminChangeAuditRecordWireSchema.parse({ ...auditRecord, refusedAttempts: attempts });
    expect(wire.refusedAttempts).toEqual(attempts.slice(-20));
  });
});

describe("wire answers (R1, R23)", () => {
  const view = { changeId: CHANGE, kind: "bind_channel", status: "pending", effect: "Bind.", methodsOffered: ["elicitation"], createdAt: PROPOSED, expiresAt: "2026-10-02T09:10:00.000Z" };
  const future = { kind: "rename_project", status: "queued", methodUsed: "passkey", methodsOffered: ["passkey"] };

  it("reads an unknown future kind, status or method on the wire, which the strict schema refuses", () => {
    expect(AdminChangeViewSchema.safeParse({ ...view, ...future }).success).toBe(false);
    expect(AdminChangeViewWireSchema.parse({ ...view, ...future, later: 1 })).toMatchObject({ ...future, later: 1 });
    expect(AdminChangeResponseSchema.safeParse({ change: { ...view, ...future } }).success).toBe(false);
    expect(AdminChangeResponseWireSchema.parse({ change: { ...view, ...future }, later: 1 })).toMatchObject({ change: future, later: 1 });
  });

  it("reads a newer control plane's longer or reshaped strings on the wire, which the strict schemas refuse (R23)", () => {
    const long = "x".repeat(5_000);
    expect(AdminChangeViewSchema.safeParse({ ...view, effect: long }).success).toBe(false);
    expect(AdminChangeViewWireSchema.parse({ ...view, effect: long, createdAt: "tomorrow", expiresAt: "later", error: { code: "C".repeat(100), message: long } })).toMatchObject({ effect: long, createdAt: "tomorrow" });
    const record = { ...auditRecord, effect: long, traceId: long, proposedAt: "2026-10-02", appliedAt: "soon", error: { code: "X", message: long }, client: { cliVersion: long, mcpClientName: long, mcpClientVersion: long }, refusedAttempts: [{ at: "earlier", reason: "another_person" }] };
    expect(AdminChangeAuditRecordSchema.safeParse({ ...auditRecord, effect: long }).success).toBe(false);
    expect(AdminChangeAuditRecordSchema.safeParse(record).success).toBe(false);
    expect(AdminChangeAuditRecordWireSchema.parse(record)).toMatchObject({ effect: long, traceId: long, proposedAt: "2026-10-02", client: { cliVersion: long } });
  });

  it("reads an unknown future outcome and refusal reason in the listed audit records, loose all the way down", () => {
    const record = { ...auditRecord, ...future, outcome: "abandoned", refusedAttempts: [{ at: PROPOSED, reason: "robot", later: true }], admin: { ...auditRecord.admin, later: 1 }, later: 1 };
    expect(AdminChangeAuditRecordSchema.safeParse(record).success).toBe(false);
    expect(AdminChangeAuditRecordWireSchema.parse(record)).toMatchObject({ outcome: "abandoned", later: 1, admin: { later: 1 }, refusedAttempts: [{ reason: "robot", later: true }] });
    expect(AdminChangesResponseSchema.safeParse({ changes: [record] }).success).toBe(false);
    expect(AdminChangesResponseWireSchema.parse({ changes: [record], cursor: "c", later: 1 })).toMatchObject({ changes: [{ kind: "rename_project" }], cursor: "c", later: 1 });
  });
});

describe("the press and the codes (E14, E18)", () => {
  it("recognizes the ingress's press event only without an API Gateway context", () => {
    const press = { source: "agentx.slack-ingress", action: "admin-change-press", changeId: CHANGE, click: "confirm", slackUserId: "U0ADA00001", teamId: "T0BSHLLUGBD" };
    expect(isAdminChangePressEvent(press)).toBe(true);
    expect(isAdminChangePressEvent({ ...press, requestContext: {} })).toBe(false);
    expect(isAdminChangePressEvent({ ...press, click: "maybe" })).toBe(false);
  });

  it("adds the four confirmation codes as 409s, and moves the admin API to 1.1", () => {
    for (const code of ["CONFIRMATION_UNAVAILABLE", "CONFIRMATION_DECLINED", "CONFIRMATION_EXPIRED", "CHANGE_STALE"] as const) expect(agentXError(code, "x").statusCode).toBe(409);
    expect(ADMIN_API_VERSION).toBe("1.1");
    expect(ADMIN_CHANGE_TTL_MS).toBe(600_000);
  });
});
