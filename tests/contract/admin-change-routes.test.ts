// tests/contract/admin-change-routes.test.ts
// Spec 025 FR-039 to FR-041, FR-051, FR-052, SC-005 and SC-011 at the routes: a change is planned,
// stored and audited, and applies at most once, only after a valid confirmation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminChangePendingRecordSchema, type ChannelInfoRequest, type ChannelMembersRequest } from "@agentx/contracts";
import { ADMIN_SLACK, ADMIN_TOKEN, TRACE, createAdminChangeBroker } from "../support/admin-change-broker.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import { unbindChannel } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const BIND = { kind: "bind_channel" as const, channel: "#ledger-dev", project: "payments" };
const binding = (db: { get(pk: string, sk: string): unknown }) => db.get(`SLACK_BINDING#${SLACK_TEAM}`, "CHANNEL#C0LEDGER01") as { projectName?: string } | undefined;
const changeId = (answer: { body: Record<string, unknown> }) => (answer.body.change as { changeId: string }).changeId;
const PLANTED = `ghp_${"P".repeat(36)}`;
let lines: string[] = [];
beforeEach(() => { lines = []; vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(String(line)); }); });
afterEach(() => vi.restoreAllMocks());
const logged = (event: string) => lines.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } }).filter((entry) => entry.event === event);

describe("planning a change (FR-039)", () => {
  it("stores a pending change and its audit record, and changes nothing", async () => {
    const broker = await createAdminChangeBroker();
    const answer = await broker.propose(BIND);
    expect(answer.status).toBe(201);
    expect(answer.body.change).toMatchObject({ kind: "bind_channel", status: "pending", methodsOffered: ["elicitation"], effect: expect.stringContaining("Bind channel #ledger-dev (C0LEDGER01) to project payments.") as unknown });
    expect(binding(broker.db)).toBeUndefined();
    const id = changeId(answer);
    expect(broker.audit(id)).toMatchObject({
      status: "pending", traceId: TRACE, admin: { issuer: expect.any(String) as unknown, subject: "admin-subject", displayName: "Ada" },
      client: { cliVersion: "0.0.7", mcpClientName: "claude-code", mcpClientVersion: "2.1.0" }, methodsOffered: ["elicitation"], proposedAt: expect.any(String) as unknown,
    });
    expect(broker.audit(id)).not.toHaveProperty("outcome");
    // E2, R2: the stored change reads under the notifier's strict schema, with its TTL, and the request pointer has one too.
    expect(AdminChangePendingRecordSchema.safeParse(broker.pending(id)).success).toBe(true);
    expect(broker.pending(id)).toMatchObject({ slackUserId: ADMIN_SLACK, indexExpiresAt: expect.any(Number) as unknown });
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE_REQUEST")).toEqual([expect.objectContaining({ changeId: id, indexExpiresAt: expect.any(Number) as unknown })]);
    expect(logged("admin_change.proposed")).toEqual([expect.objectContaining({ changeId: id, traceId: TRACE, kind: "bind_channel" })]);
  });

  it("answers the same change for a repeated request ID", async () => {
    const broker = await createAdminChangeBroker();
    const first = await broker.propose(BIND, ["elicitation"], "77777777-7777-4777-8777-777777777777");
    const second = await broker.propose(BIND, ["elicitation"], "77777777-7777-4777-8777-777777777777");
    expect(second.status).toBe(200);
    expect(changeId(second)).toBe(changeId(first));
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")).toHaveLength(1);
  });

  it("offers only the methods the environment and the admin allow, and refuses when none is left (FR-041)", async () => {
    const off = await createAdminChangeBroker({ elicitation: false, slackLinked: false });
    const refused = await off.propose(BIND, ["elicitation", "slack"]);
    expect(refused.body.error).toEqual({ code: "CONFIRMATION_UNAVAILABLE", message: "no confirmation method is available: the environment does not allow the pop-up, and your admin sign-in matches no Slack user; use agentx admin commands instead" });
    const audited = off.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT");
    expect(audited).toEqual([expect.objectContaining({ status: "failed", outcome: "failed", error: expect.objectContaining({ code: "CONFIRMATION_UNAVAILABLE" }) as unknown })]);
    expect(off.db.find((item) => item.entityType === "ADMIN_CHANGE")).toEqual([]);
    const slackOnly = await createAdminChangeBroker({ elicitation: false });
    expect((await slackOnly.propose(BIND, ["elicitation", "slack"])).body.change).toMatchObject({ methodsOffered: ["slack"] });
    const noSlack = await createAdminChangeBroker({ slack: false });
    expect((await noSlack.propose(BIND, ["slack"])).body.error).toEqual({ code: "CONFIRMATION_UNAVAILABLE", message: "no confirmation method is available: Slack confirmation is not set up in this environment; use agentx admin commands instead" });
  });

  it("audits a request whose plan is refused, and stores no pending change", async () => {
    const broker = await createAdminChangeBroker();
    expect((await broker.propose({ kind: "bind_channel", channel: "C0LEDGER01", project: "ledger" })).body.error).toMatchObject({ code: "NOT_FOUND" });
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE")).toEqual([]);
    expect(broker.db.find((item) => item.entityType === "ADMIN_CHANGE_AUDIT")).toEqual([expect.objectContaining({ outcome: "failed", error: expect.objectContaining({ code: "NOT_FOUND" }) as unknown })]);
    expect(broker.metrics).toEqual(["failed"]);
  });

  it("refuses a malformed request before anything is stored", async () => {
    const broker = await createAdminChangeBroker();
    const answer = await broker.admin("POST", "/v1/admin/changes", { body: { requestId: "not-a-uuid", change: BIND, client: { cliVersion: "0.0.7" }, methods: ["elicitation"] } });
    expect(answer.body.error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("requestId") as unknown });
    expect(broker.db.find((item) => String(item.entityType).startsWith("ADMIN_CHANGE"))).toEqual([]);
  });
});

describe("confirming by the pop-up (FR-040, SC-005)", () => {
  it("applies once through the existing handler, and refuses the reused confirmation", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    const applied = await broker.apply(id);
    expect(applied.body.change).toMatchObject({ status: "applied", methodUsed: "elicitation" });
    expect(binding(broker.db)).toMatchObject({ projectName: "payments" });
    expect(broker.audit(id)).toMatchObject({ status: "applied", outcome: "confirmed", methodUsed: "elicitation", appliedAt: expect.any(String) as unknown, answeredAt: expect.any(String) as unknown });
    expect(broker.metrics).toEqual(["confirmed"]);
    const again = await broker.apply(id);
    expect(again.body.error).toMatchObject({ code: "CONFIRMATION_EXPIRED", message: expect.stringContaining(`change ${id} was already applied`) as unknown });
    expect((broker.audit(id)?.refusedAttempts as unknown[])).toEqual([expect.objectContaining({ reason: "not_pending" })]);
    expect(logged("admin_change.applied")).toEqual([expect.objectContaining({ changeId: id, traceId: TRACE })]);
    expect(AdminChangePendingRecordSchema.safeParse(broker.pending(id)).success).toBe(true);
  });

  it("applies at most once when two confirmations race", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND, ["elicitation", "cli", "slack"]));
    await broker.slack(id);
    const answers = await Promise.all([broker.apply(id), broker.apply(id, "cli"), broker.press(id, "confirm")]);
    const applied = answers.filter((answer) => "body" in answer ? (answer.body.change as { status?: string } | undefined)?.status === "applied" : answer.outcome === "applied");
    expect(applied).toHaveLength(1);
    expect(broker.db.find((item) => item.entityType === "SLACK_BINDING" && item.channelId === "C0LEDGER01")).toHaveLength(1);
    expect(broker.metrics).toEqual(["confirmed"]);
    expect(logged("admin_change.claimed")).toHaveLength(1);
    expect(broker.audit(id)).toMatchObject({ status: "applied", outcome: "confirmed" });
    expect((broker.audit(id)?.refusedAttempts as unknown[])).toHaveLength(2);
  });

  it("refuses another admin's apply, decline and Slack step, recording each, and leaves the change pending", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND, ["elicitation", "slack"]));
    expect((await broker.apply(id, "elicitation", "another-admin")).body.error).toEqual({ code: "FORBIDDEN", message: "only the admin who asked for this change can confirm or decline it" });
    expect((await broker.decline(id, "declined", "another-admin")).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect((await broker.slack(id, "another-admin")).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(binding(broker.db)).toBeUndefined();
    expect(broker.audit(id)).toMatchObject({ status: "pending", refusedAttempts: [expect.objectContaining({ reason: "another_admin" }), expect.objectContaining({ reason: "another_admin" }), expect.objectContaining({ reason: "another_admin" })] });
    // Any admin may read it.
    expect((await broker.get(id, "another-admin")).body.change).toMatchObject({ status: "pending" });
  });

  it("marks a declined change declined, and a later apply is refused", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    expect((await broker.decline(id)).body.change).toMatchObject({ status: "declined" });
    expect(broker.audit(id)).toMatchObject({ outcome: "declined", methodUsed: "elicitation" });
    expect((await broker.apply(id)).body.error).toMatchObject({ code: "CONFIRMATION_DECLINED" });
    expect(binding(broker.db)).toBeUndefined();
    expect(broker.metrics).toEqual(["declined"]);
  });

  it("expires after 10 minutes: an apply is refused, and every read shows it expired", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    broker.clock.advance(10 * 60_000 + 1);
    expect((await broker.get(id)).body.change).toMatchObject({ status: "expired" });
    expect((await broker.apply(id)).body.error).toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect(broker.audit(id)).toMatchObject({ outcome: "expired", expiredAt: expect.any(String) as unknown, refusedAttempts: [expect.objectContaining({ reason: "expired" })] });
    expect(binding(broker.db)).toBeUndefined();
    expect(broker.metrics).toEqual(["expired"]);
  });

  it("records the expiry on an apply that is the first touch after it", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    broker.clock.advance(10 * 60_000 + 1);
    expect((await broker.apply(id)).body.error).toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect(broker.audit(id)).toMatchObject({ status: "expired", outcome: "expired" });
    expect(broker.pending(id)).toMatchObject({ status: "expired" });
    expect(binding(broker.db)).toBeUndefined();
  });

  it("refuses a stale change and leaves the binding as the other admin set it", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    broker.db.set({ pk: `SLACK_BINDING#${SLACK_TEAM}`, sk: "CHANNEL#C0LEDGER01", entityType: "SLACK_BINDING", teamId: SLACK_TEAM, channelId: "C0LEDGER01", projectName: "payments-legacy", updatedAt: new Date().toISOString() });
    const answer = await broker.apply(id);
    expect(answer.body.error).toMatchObject({ code: "CHANGE_STALE", message: expect.stringContaining(`change ${id}`) as unknown });
    expect(binding(broker.db)).toMatchObject({ projectName: "payments-legacy" });
    expect(broker.audit(id)).toMatchObject({ status: "failed", outcome: "failed", error: expect.objectContaining({ code: "CHANGE_STALE" }) as unknown, refusedAttempts: [expect.objectContaining({ reason: "stale_state" })] });
  });

  it("refuses as stale, and never applies, when the re-plan itself is refused", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose({ kind: "unbind_channel", channel: SLACK_CHANNEL }));
    await unbindChannel(broker.handler, SLACK_CHANNEL);
    const answer = await broker.apply(id);
    expect(answer.body.error).toMatchObject({ code: "CHANGE_STALE", message: expect.stringMatching(new RegExp(`^what change ${id} was planned against has changed \\(.+\\); ask for the change again$`)) as unknown });
    expect(broker.db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toBeUndefined();
    expect(broker.audit(id)).toMatchObject({ status: "failed", outcome: "failed", refusedAttempts: [expect.objectContaining({ reason: "stale_state" })] });
    expect(logged("admin_change.claimed")).toEqual([]);
  });

  it("refuses the pop-up once the environment turned it off, for a change that offered it before the switch", async () => {
    const broker = await createAdminChangeBroker({ elicitation: false });
    const id = changeId(await broker.propose(BIND, ["cli"]));
    // As stored before the switch: the change offered the pop-up then.
    broker.db.set({ ...broker.pending(id)!, methodsOffered: ["elicitation", "cli"] });
    expect((await broker.apply(id, "elicitation")).body.error).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
    expect(binding(broker.db)).toBeUndefined();
    expect(broker.audit(id)).toMatchObject({ status: "pending", refusedAttempts: [expect.objectContaining({ reason: "method_not_offered" })] });
    expect((await broker.apply(id, "cli")).body.change).toMatchObject({ status: "applied", methodUsed: "cli" });
  });

  it("refuses a method the change never offered", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND, ["elicitation"]));
    expect((await broker.apply(id, "cli")).body.error).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
    expect((await broker.apply(id, "slack")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(binding(broker.db)).toBeUndefined();
    expect(broker.audit(id)).toMatchObject({ status: "pending", refusedAttempts: [expect.objectContaining({ reason: "method_not_offered" }), expect.objectContaining({ reason: "method_not_offered" })] });
  });

  it("records a handler's failure as failed, with the error's code only", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    const send = broker.db.send;
    broker.db.send = async (command) => {
      if (command.constructor.name !== "GetCommand" && command.constructor.name !== "QueryCommand" && JSON.stringify(command.input).includes("SLACK_BINDING#")) {
        throw Object.assign(new Error(`internal detail ${PLANTED}`), { name: "InternalServerError" });
      }
      return send(command);
    };
    const answer = await broker.apply(id);
    expect(answer.body.error).toEqual({ code: "RUNTIME_UNAVAILABLE", message: `change ${id} failed: the change could not be applied; check the state, then ask again` });
    expect(broker.audit(id)).toMatchObject({ status: "failed", outcome: "failed", error: { code: "RUNTIME_UNAVAILABLE", message: "the change could not be applied; check the state, then ask again" } });
    expect(logged("admin_change.failed")).toEqual([expect.objectContaining({ changeId: id, error: "RUNTIME_UNAVAILABLE" })]);
    expect(lines.join("\n")).not.toContain(PLANTED);
    expect(broker.metrics).toEqual(["failed"]);
  });
});

describe("confirming by the Slack button (FR-041, E13, E14)", () => {
  it("applies a press after the wait, once, and refuses the second press", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND, ["slack"]));
    expect((await broker.slack(id)).body.change).toMatchObject({ status: "pending" });
    expect(broker.audit(id)).toMatchObject({ confirmationRequestedAt: expect.any(String) as unknown });
    expect(broker.pending(id)).toMatchObject({ slackRequestedAt: expect.any(String) as unknown });
    // Review Focus 1: after the tool's 5-minute wait, seconds before the 10 minutes end.
    broker.clock.advance(10 * 60_000 - 5_000);
    expect(await broker.press(id, "confirm")).toMatchObject({ outcome: "applied", changeId: id, traceId: TRACE });
    expect(binding(broker.db)).toMatchObject({ projectName: "payments" });
    expect(broker.audit(id)).toMatchObject({ outcome: "confirmed", methodUsed: "slack", pressedBy: ADMIN_SLACK, answeredAt: expect.any(String) as unknown, appliedAt: expect.any(String) as unknown, confirmationRequestedAt: expect.any(String) as unknown });
    expect(await broker.press(id, "confirm")).toMatchObject({ outcome: "not_pending" });
    expect(broker.metrics).toEqual(["confirmed"]);
    expect(broker.pending(id)).toMatchObject({ status: "applied", methodUsed: "slack", pressedBy: ADMIN_SLACK });
  });

  it("refuses another person's press, a press from another team and one without a team, recording each, and stays pending", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND, ["slack"]));
    await broker.slack(id);
    expect(await broker.press(id, "confirm", "U0BOB00002")).toMatchObject({ outcome: "refused" });
    expect(await broker.press(id, "confirm", ADMIN_SLACK, "T0OTHERTEAM")).toMatchObject({ outcome: "refused" });
    expect(await broker.press(id, "cancel", ADMIN_SLACK, null)).toMatchObject({ outcome: "refused" });
    expect(binding(broker.db)).toBeUndefined();
    expect(broker.audit(id)).toMatchObject({
      status: "pending",
      refusedAttempts: [expect.objectContaining({ reason: "another_person", slackUserId: "U0BOB00002" }), expect.objectContaining({ reason: "wrong_team" }), expect.objectContaining({ reason: "wrong_team" })],
    });
    expect(broker.pending(id)).toMatchObject({ status: "pending" });
  });

  it("declines on Cancel, and ignores a press before the Slack step started or after expiry", async () => {
    const broker = await createAdminChangeBroker();
    const early = changeId(await broker.propose(BIND, ["slack"]));
    expect(await broker.press(early, "confirm")).toMatchObject({ outcome: "not_pending" });
    expect(binding(broker.db)).toBeUndefined();
    await broker.slack(early);
    expect(await broker.press(early, "cancel")).toMatchObject({ outcome: "declined" });
    expect(broker.audit(early)).toMatchObject({ outcome: "declined", methodUsed: "slack", pressedBy: ADMIN_SLACK });
    expect(await broker.press(early, "confirm")).toMatchObject({ outcome: "not_pending" });
    expect(binding(broker.db)).toBeUndefined();
    const late = changeId(await broker.propose({ kind: "unbind_channel", channel: SLACK_CHANNEL }, ["slack"]));
    await broker.slack(late);
    broker.clock.advance(10 * 60_000 + 1);
    expect(await broker.press(late, "confirm")).toMatchObject({ outcome: "expired" });
    expect(broker.audit(late)).toMatchObject({ outcome: "expired", expiredAt: expect.any(String) as unknown });
    expect(broker.db.get(`SLACK_BINDING#${SLACK_TEAM}`, `CHANNEL#${SLACK_CHANNEL}`)).toBeDefined();
  });

  it("answers stale for a press on a change whose state moved, and applies nothing", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND, ["slack"]));
    await broker.slack(id);
    broker.db.set({ pk: `SLACK_BINDING#${SLACK_TEAM}`, sk: "CHANNEL#C0LEDGER01", entityType: "SLACK_BINDING", teamId: SLACK_TEAM, channelId: "C0LEDGER01", projectName: "payments-legacy", updatedAt: new Date().toISOString() });
    expect(await broker.press(id, "confirm")).toMatchObject({ outcome: "stale", changeId: id });
    expect(binding(broker.db)).toMatchObject({ projectName: "payments-legacy" });
    expect(broker.audit(id)).toMatchObject({ status: "failed", outcome: "failed", methodUsed: "slack", refusedAttempts: [expect.objectContaining({ reason: "stale_state", slackUserId: ADMIN_SLACK })] });
  });

  it("answers not_found for a press on a change that does not exist", async () => {
    const broker = await createAdminChangeBroker();
    expect(await broker.press("77777777-7777-4777-8777-777777777777", "confirm")).toMatchObject({ outcome: "not_found", changeId: "77777777-7777-4777-8777-777777777777" });
  });

  it("refuses the Slack step when it was not offered", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND, ["elicitation"]));
    expect((await broker.slack(id)).body.error).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
    expect(broker.pending(id)).not.toHaveProperty("slackRequestedAt");
    // B4 stores the linked Slack user, but a press still needs the Slack method offered and started.
    expect(await broker.press(id, "confirm")).toMatchObject({ outcome: "refused" });
    expect(binding(broker.db)).toBeUndefined();
    expect(broker.audit(id)).toMatchObject({ status: "pending", refusedAttempts: [expect.objectContaining({ reason: "method_not_offered" }), expect.objectContaining({ reason: "method_not_offered", slackUserId: ADMIN_SLACK })] });
  });
});

describe("a private channel in the confirmation (B4, R4, Q7)", () => {
  const channelInfo = async (request: ChannelInfoRequest) => ({ ok: true as const, channels: request.channelIds.map((channelId) => ({ channelId, name: channelId === "C0PRIVATE01" ? "secret-launch" : "payments-dev", isPrivate: channelId === "C0PRIVATE01" })) });
  const channelMembers = async (request: ChannelMembersRequest) => ({ ok: true as const, memberOf: request.slackUserId === ADMIN_SLACK ? request.channelIds.filter((id) => id === "C0PRIVATE01") : [] });

  it("names it to the member planning admin only; another admin, the list and the audit see its ID", async () => {
    const broker = await createAdminChangeBroker({ channelInfo, channelMembers });
    const answer = await broker.propose({ kind: "bind_channel", channel: "C0PRIVATE01", project: "payments" });
    expect((answer.body.change as { effect: string }).effect).toContain("#secret-launch (C0PRIVATE01, a private channel)");
    const id = changeId(answer);
    expect(((await broker.get(id)).body.change as { effect: string }).effect).toContain("#secret-launch");
    const other = await broker.get(id, "another-admin");
    expect((other.body.change as { effect: string }).effect).toContain("C0PRIVATE01 (a private channel)");
    expect(JSON.stringify(other.body)).not.toContain("secret-launch");
    expect(JSON.stringify(broker.audit(id))).not.toContain("secret-launch");
    expect(JSON.stringify((await broker.list()).body)).not.toContain("secret-launch");
    expect(broker.pending(id)).toMatchObject({ confirmationEffect: expect.stringContaining("#secret-launch") as unknown, effect: expect.not.stringContaining("secret-launch") as unknown });
    const applied = await broker.apply(id);
    expect((applied.body.change as { effect: string }).effect).toContain("#secret-launch");
    expect(JSON.stringify(broker.audit(id))).not.toContain("secret-launch");
  });
});

describe("secrets and tokens (FR-051, SC-004)", () => {
  it("keeps a planted secret out of every answer, log line and audit record, and the admin token out of all of them", async () => {
    const broker = await createAdminChangeBroker();
    const definition = {
      name: "payments", revision: 2,
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: `Delegate work; the token is ${PLANTED}.`,
    };
    const proposed = await broker.propose({ kind: "register_project_revision", definition });
    expect(proposed.status).toBe(201);
    const id = changeId(proposed);
    const applied = await broker.apply(id);
    expect(applied.body.change).toMatchObject({ status: "applied" });
    const listed = await broker.list();
    for (const shown of [proposed.body, applied.body, listed.body, broker.audit(id), lines]) {
      expect(JSON.stringify(shown)).not.toContain(PLANTED);
      expect(JSON.stringify(shown)).not.toContain(ADMIN_TOKEN.slice("Bearer ".length));
    }
    expect(JSON.stringify(broker.audit(id))).toContain("[REDACTED]");
    expect(lines.join("\n")).not.toContain("ada@example.com");
  });
});

describe("reading the records (FR-052)", () => {
  it("lists records newest first, filters them, and shows an expired one as expired", async () => {
    const broker = await createAdminChangeBroker();
    const applied = changeId(await broker.propose(BIND));
    await broker.apply(applied);
    broker.clock.advance(1_000);
    const waiting = changeId(await broker.propose({ kind: "unbind_channel", channel: SLACK_CHANNEL }));
    broker.clock.advance(10 * 60_000 + 1);
    const since = encodeURIComponent(new Date(broker.clock.now() - 3_600_000).toISOString());
    const list = await broker.list(`?since=${since}`);
    expect((list.body.changes as Array<{ changeId: string; outcome?: string }>).map((change) => [change.changeId, change.outcome])).toEqual([[waiting, "expired"], [applied, "confirmed"]]);
    expect(broker.audit(waiting)).toMatchObject({ outcome: "expired" });
    expect((await broker.list(`?outcome=confirmed&since=${since}`)).body.changes).toHaveLength(1);
    expect((await broker.list(`?limit=1&since=${since}`)).body).toMatchObject({ changes: [expect.objectContaining({ changeId: waiting })], cursor: expect.any(String) as unknown });
  });

  it("refuses a bad query with what to send instead", async () => {
    const broker = await createAdminChangeBroker();
    expect((await broker.list("?since=2026-02-31T00:00:00.000Z")).body.error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("since must be an ISO 8601 time") as unknown });
    expect((await broker.list("?limit=0")).body.error).toMatchObject({ code: "CONFIG_INVALID", message: "limit must be a whole number from 1 to 100" });
    expect((await broker.list("?outcome=maybe")).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses every change route without the admin claim", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    for (const [method, path] of [["GET", "/v1/admin/changes"], ["POST", "/v1/admin/changes"], ["GET", `/v1/admin/changes/${id}`], ["POST", `/v1/admin/changes/${id}/apply`], ["POST", `/v1/admin/changes/${id}/decline`], ["POST", `/v1/admin/changes/${id}/slack`]] as const) {
      expect((await broker.admin(method, path, { admin: false, body: { method: "cli", reason: "declined" } })).body.error).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(binding(broker.db)).toBeUndefined();
    expect(broker.pending(id)).toMatchObject({ status: "pending" });
  });

  it("answers NOT_FOUND for an unknown change and an unknown change route", async () => {
    const broker = await createAdminChangeBroker();
    expect((await broker.get("77777777-7777-4777-8777-777777777777")).body.error).toEqual({ code: "NOT_FOUND", message: "no change 77777777-7777-4777-8777-777777777777; list the changes with agentx admin changes" });
    expect((await broker.admin("POST", "/v1/admin/changes/77777777-7777-4777-8777-777777777777/other", { body: {} })).body.error).toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads a change stuck applying for over 2 minutes as failed", async () => {
    const broker = await createAdminChangeBroker();
    const id = changeId(await broker.propose(BIND));
    const pending = broker.db.get(`ADMIN_CHANGE#${id}`, "META")!;
    broker.db.set({ ...pending, status: "applying", claimedAt: new Date(broker.clock.now()).toISOString() });
    broker.clock.advance(2 * 60_000 + 1);
    expect((await broker.get(id)).body.change).toMatchObject({ status: "failed", error: { code: "RUNTIME_UNAVAILABLE", message: "the apply did not finish; check the state, then ask again" } });
    expect(broker.audit(id)).toMatchObject({ status: "failed", outcome: "failed" });
    expect(AdminChangePendingRecordSchema.safeParse(broker.pending(id)).success).toBe(true);
  });
});

describe("the legacy deployment", () => {
  it("answers NOT_FOUND for the change routes", async () => {
    const { handler } = await createAdminBroker();
    expect((await adminCall(handler, { method: "GET", path: "/v1/admin/changes" })).body.error).toEqual({ code: "NOT_FOUND", message: "admin changes are not set up in this deployment" });
    const press = await handler({ source: "agentx.slack-ingress", action: "admin-change-press", changeId: "77777777-7777-4777-8777-777777777777", click: "confirm", slackUserId: ADMIN_SLACK, teamId: SLACK_TEAM });
    expect(JSON.parse(press.body)).toMatchObject({ error: { code: "NOT_FOUND", message: "admin changes are not set up in this deployment" } });
  });
});
