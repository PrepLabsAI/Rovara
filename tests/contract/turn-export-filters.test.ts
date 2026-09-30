// tests/contract/turn-export-filters.test.ts
// Spec 025 A8: GET /v1/admin/turns filters by time, origin, project, thread and task.
import { describe, expect, it, vi } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { EMPTY_TURN_OBSERVATION } from "../../packages/contracts/src/turns.js";
import { TurnRecordExport, dynamoTurnRecordSource, type TurnRecordSource } from "../../packages/broker/src/aws/turns.js";

const now = Date.parse("2026-09-30T12:00:00.000Z");
const TASK = "33333333-3333-4333-8333-333333333333";
const SUBJECT = "T0BSHLLUGBD/C0123456789/1695500000.000100";
const slack = (eventId: string, receivedAt: string, extra: Record<string, unknown> = {}) => ({
  ...EMPTY_TURN_OBSERVATION, pk: `THREAD#${SUBJECT}`, sk: `TURN#${receivedAt}#${eventId}`, exportPk: "TURNS", exportSk: `${receivedAt}#${eventId}`,
  expiresAt: Math.floor(now / 1000) + 86_400, eventId, subject: SUBJECT, receivedAt, requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" },
  disposition: "answered", startedAt: receivedAt, finishedAt: receivedAt, durationMs: 0, requestText: "run the linter", responseText: "done", ...extra,
});

describe("the admin turn filters (A8)", () => {
  it("sends the export's own query unchanged when no filter is asked for", async () => {
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({ items: [] }));
    await new TurnRecordExport({ source: { page }, projectOf: async () => "payments", now: () => now }).page(new URLSearchParams({ since: "2026-09-29T00:00:00Z" }));
    expect(page).toHaveBeenCalledWith({ since: "2026-09-29T00:00:00.000Z", limit: 100, nowSeconds: now / 1000 });
  });

  it("passes until, origin, thread and task to the source, and a smaller limit", async () => {
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({ items: [] }));
    const turns = new TurnRecordExport({ source: { page }, projectOf: async () => "payments", now: () => now });
    await turns.page(new URLSearchParams({ since: "2026-09-29T00:00:00Z", until: "2026-09-30T00:00:00Z", origin: "ai_tool", task: TASK, limit: "5" }));
    expect(page).toHaveBeenCalledWith({ since: "2026-09-29T00:00:00.000Z", until: "2026-09-30T00:00:00.000Z", limit: 5, nowSeconds: now / 1000, filter: { origin: "ai_tool", task: TASK } });
  });

  it("matches a task's AI-tool records and its channel turns, and stops after ten pages", async () => {
    const channelTurn = slack("EvCHAN000001", "2026-09-30T10:00:00.000Z", { taskId: TASK });
    let calls = 0;
    const page = vi.fn<TurnRecordSource["page"]>(async () => {
      calls += 1;
      return { items: calls === 2 ? [channelTurn] : [], lastEvaluatedKey: { pk: channelTurn.pk, sk: channelTurn.sk, exportPk: "TURNS", exportSk: channelTurn.exportSk } };
    });
    const answer = await new TurnRecordExport({ source: { page }, projectOf: async () => "payments", now: () => now }).page(new URLSearchParams({ since: "2026-09-29T00:00:00Z", task: TASK, limit: "3" }));
    expect(page).toHaveBeenCalledTimes(10);
    expect(answer.turns).toHaveLength(1);
    expect(answer.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("filters by project after the workspace lookup", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({ items: [slack("EvONE0000001", "2026-09-30T10:00:00.000Z", { workspaceId }), slack("EvTWO0000002", "2026-09-30T09:00:00.000Z")] }));
    const answer = await new TurnRecordExport({ source: { page }, projectOf: async () => "ledger", now: () => now }).page(new URLSearchParams({ since: "2026-09-29T00:00:00Z", project: "ledger" }));
    expect(answer.turns.map((turn) => (turn as { eventId?: string }).eventId)).toEqual(["EvONE0000001"]);
  });

  it("refuses a malformed filter, and a cursor past until", async () => {
    const turns = new TurnRecordExport({ source: { page: async () => ({ items: [] }) }, projectOf: async () => undefined, now: () => now });
    for (const query of [{ origin: "email" }, { task: "nope" }, { thread: "C0123/nope" }, { limit: "0" }, { project: "<b>" }, { until: "2026-09-28T00:00:00Z" }]) {
      await expect(turns.page(new URLSearchParams({ since: "2026-09-29T00:00:00Z", ...query })), JSON.stringify(query)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    const late = Buffer.from(JSON.stringify({ pk: `THREAD#${SUBJECT}`, sk: "TURN#2026-09-30T11:00:00.000Z#EvX", exportPk: "TURNS", exportSk: "2026-09-30T11:00:00.000Z#EvX" })).toString("base64url");
    await expect(turns.page(new URLSearchParams({ since: "2026-09-29T00:00:00Z", until: "2026-09-30T10:00:00Z", cursor: late }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("builds the byTime query with BETWEEN and filter expressions", async () => {
    const send = vi.fn(async () => ({ Items: [] }));
    await dynamoTurnRecordSource({ send } as never, "turns").page({ since: "2026-09-29T00:00:00.000Z", until: "2026-09-30T00:00:00.000Z", limit: 50, nowSeconds: 5, filter: { origin: "slack", thread: SUBJECT, task: TASK } });
    expect((send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input).toMatchObject({
      IndexName: "byTime",
      KeyConditionExpression: "exportPk = :partition AND exportSk BETWEEN :since AND :until",
      FilterExpression: "expiresAt > :now AND (attribute_not_exists(origin) OR origin = :origin) AND subject = :subject AND taskId = :task",
      ExpressionAttributeValues: { ":partition": "TURNS", ":since": "2026-09-29T00:00:00.000Z", ":until": "2026-09-30T00:00:00.000Z\uffff", ":now": 5, ":origin": "slack", ":subject": SUBJECT, ":task": TASK },
      Limit: 50,
    });
  });

  it("pages filtered records through the byTime index once each, cutting a page at limit", async () => {
    const db = new FakeDynamoDb();
    const at = (hour: number) => `2026-09-30T0${hour}:00:00.000Z`;
    db.set(slack("EvE0000000", at(0)));
    db.set(slack("EvE0000001", at(1), { taskId: TASK }));
    db.set(slack("EvE0000002", at(2), { taskId: TASK }));
    db.set(slack("EvE0000003", at(3), { taskId: TASK, origin: "slack" }));
    db.set(slack("EvE0000004", at(4), { taskId: TASK, expiresAt: Math.floor(now / 1000) - 1 }));
    db.set(slack("EvE0000005", at(5), { taskId: TASK }));
    db.set(slack("EvE0000006", at(6), { taskId: TASK }));
    const turns = new TurnRecordExport({ source: dynamoTurnRecordSource(db as never, "turns"), projectOf: async () => undefined, now: () => now });
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const answer = await turns.page(new URLSearchParams({ since: at(0), until: at(5), origin: "slack", task: TASK, limit: "2", ...(cursor === undefined ? {} : { cursor }) }));
      pages.push(answer.turns.map((turn) => (turn as { eventId: string }).eventId));
      cursor = answer.cursor;
    } while (cursor !== undefined && pages.length < 10);
    expect(pages.flat()).toEqual(["EvE0000005", "EvE0000003", "EvE0000002", "EvE0000001"]);
    expect(pages[0]).toEqual(["EvE0000005", "EvE0000003"]);
  });
});
