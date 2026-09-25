import { describe, expect, it, vi } from "vitest";
import { EMPTY_TURN_OBSERVATION, type TurnRecord } from "../../packages/contracts/src/turns.js";
import { TurnRecordExport, dynamoTurnRecordSource, workspaceProjectReader, type TurnRecordSource, type TurnRecordStartKey } from "../../packages/broker/src/aws/turns.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const now = Date.parse("2026-09-24T12:00:00.000Z");
const workspaceId = "11111111-1111-4111-8111-111111111111";

function stored(eventId: string, receivedAt: string, extra: Partial<TurnRecord> = {}) {
  const record: TurnRecord = {
    ...EMPTY_TURN_OBSERVATION, eventId, subject: "T0123456789/C0123456789/1695500000.000001", receivedAt,
    requestedBy: { teamId: "T0123456789", userId: "U0123456789" }, disposition: "answered", workspaceId,
    startedAt: receivedAt, finishedAt: receivedAt, durationMs: 0, requestText: "list issues", responseText: "none", ...extra,
  };
  return {
    pk: `THREAD#${record.subject}`, sk: `TURN#${receivedAt}#${eventId}`, exportPk: "TURNS", exportSk: `${receivedAt}#${eventId}`,
    expiresAt: Math.floor(Date.parse(receivedAt) / 1000) + 30 * 86_400, ...record,
  };
}

function keyOf(item: ReturnType<typeof stored>): TurnRecordStartKey {
  return { pk: item.pk, sk: item.sk, exportPk: item.exportPk, exportSk: item.exportSk };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function exporter(source: TurnRecordSource, projectOf = vi.fn(async (): Promise<string | undefined> => "payments"), log = vi.fn()) {
  return { exporter: new TurnRecordExport({ source, projectOf, now: () => now, log }), projectOf, log };
}

describe("turn record export", () => {
  it("asks for 100 records since the given time, strips storage keys, adds the project, and returns an opaque cursor", async () => {
    const lastEvaluatedKey = keyOf(stored("EvTURN00001", "2026-09-24T10:00:00.000Z"));
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({
      items: [stored("EvTURN00002", "2026-09-24T11:00:00.000Z"), stored("EvTURN00001", "2026-09-24T10:00:00.000Z")], lastEvaluatedKey,
    }));
    const { exporter: turns, projectOf, log } = exporter({ page });
    const first = await turns.page(new URLSearchParams({ since: "2026-09-17T12:00:00Z" }));
    expect(page).toHaveBeenCalledWith({ since: "2026-09-17T12:00:00.000Z", limit: 100, nowSeconds: now / 1000 });
    expect(first.turns.map((turn) => [turn.eventId, turn.project])).toEqual([["EvTURN00002", "payments"], ["EvTURN00001", "payments"]]);
    expect(first.turns[0]).not.toHaveProperty("pk");
    expect(first.turns[0]).not.toHaveProperty("sk");
    expect(first.turns[0]).not.toHaveProperty("exportPk");
    expect(first.turns[0]).not.toHaveProperty("exportSk");
    expect(first.turns[0]).not.toHaveProperty("expiresAt");
    expect(first.turns[0]?.requestText).toBe("list issues");
    expect(projectOf).toHaveBeenCalledTimes(1);
    expect(first.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    await turns.page(new URLSearchParams({ since: "2026-09-17T12:00:00Z", cursor: first.cursor! }));
    expect(page).toHaveBeenLastCalledWith({ since: "2026-09-17T12:00:00.000Z", limit: 100, nowSeconds: now / 1000, exclusiveStartKey: lastEvaluatedKey });
    expect(log).not.toHaveBeenCalled();
  });

  it("returns stored recording errors and usage errors as they are", async () => {
    const item = stored("EvTURN00010", "2026-09-24T08:00:00.000Z", { recordingErrors: ["observer_failed"], usageError: "usage_unavailable" });
    const { exporter: turns } = exporter({ page: async () => ({ items: [item] }) });
    const [turn] = (await turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z" }))).turns;
    expect(turn?.recordingErrors).toEqual(["observer_failed"]);
    expect(turn?.usageError).toBe("usage_unavailable");
  });

  it("skips a malformed item and an expired one still waiting for DynamoDB's TTL, logging the count and key but no contents", async () => {
    const expired = { ...stored("EvTURN00003", "2026-08-20T10:00:00.000Z"), expiresAt: now / 1000 - 1 };
    const malformed = { ...stored("EvTURN00004", "2026-09-24T09:00:00.000Z"), disposition: "unheard-of" };
    const { exporter: turns, log } = exporter({ page: async () => ({ items: [expired, malformed, stored("EvTURN00005", "2026-09-24T08:00:00.000Z")] }) });
    const result = await turns.page(new URLSearchParams({ since: "2026-08-01T00:00:00Z" }));
    expect(result.turns.map((turn) => turn.eventId)).toEqual(["EvTURN00005"]);
    expect(result).not.toHaveProperty("cursor");
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toEqual({
      component: "broker", event: "turn_record.invalid", count: 1,
      keys: ["TURN#2026-09-24T09:00:00.000Z#EvTURN00004"], fields: ["disposition"],
    });
    expect(String(log.mock.calls[0]?.[0])).not.toContain("list issues");
    expect(String(log.mock.calls[0]?.[0])).not.toContain("unheard-of");
  });

  it("logs every malformed item on a page in one line with their count", async () => {
    const items = [
      { ...stored("EvTURN00011", "2026-09-24T09:00:00.000Z"), requestText: 42 },
      { ...stored("EvTURN00012", "2026-09-24T08:00:00.000Z"), secretField: "hunter2" },
      { ...stored("EvTURN00013", "2026-09-24T07:00:00.000Z"), sk: 7, durationMs: -1 },
    ];
    const { exporter: turns, log } = exporter({ page: async () => ({ items }) });
    expect((await turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z" }))).turns).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    const text = String(log.mock.calls[0]?.[0]);
    const line = JSON.parse(text) as { count: number; keys: string[]; fields: string[] };
    expect(line.count).toBe(3);
    expect(line.keys).toEqual(["TURN#2026-09-24T09:00:00.000Z#EvTURN00011", "TURN#2026-09-24T08:00:00.000Z#EvTURN00012", "unknown"]);
    expect(line.fields).toEqual(["requestText", "(root)", "durationMs"]);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("secretField");
    expect(text).not.toContain("list issues");
  });

  it("refuses a missing or malformed since and a tampered cursor", async () => {
    const { exporter: turns } = exporter({ page: async () => ({ items: [] }) });
    await expect(turns.page(new URLSearchParams())).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(turns.page(new URLSearchParams({ since: "last week" }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const forged = Buffer.from(JSON.stringify({ pk: "WORKSPACE#x", sk: "META", exportPk: "OTHER", exportSk: "z" })).toString("base64url");
    await expect(turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z", cursor: forged }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z", cursor: "%%%" }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses a forged cursor that points outside the export partition or the since window, before any read", async () => {
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({ items: [] }));
    const { exporter: turns } = exporter({ page });
    const since = "2026-09-17T00:00:00Z";
    const valid = keyOf(stored("EvTURN00020", "2026-09-20T00:00:00.000Z"));
    const forgeries: unknown[] = [
      { ...valid, exportPk: "OTHER" },
      { ...valid, pk: "WORKSPACE#11111111-1111-4111-8111-111111111111" },
      { ...valid, sk: "META" },
      { ...valid, sk: "TURN#2026-09-21T00:00:00.000Z#EvTURN00020" },
      { ...valid, exportSk: "2026-09-16T23:59:59.999Z#EvTURN00020", sk: "TURN#2026-09-16T23:59:59.999Z#EvTURN00020" },
      { ...valid, extra: "x" },
      { pk: valid.pk, sk: valid.sk, exportPk: valid.exportPk },
      { ...valid, exportSk: 5 },
      [valid.pk, valid.sk, valid.exportPk, valid.exportSk],
      "TURNS",
      null,
      { ...valid, pk: `THREAD#${"x".repeat(2_000)}` },
    ];
    for (const forgery of forgeries) {
      await expect(turns.page(new URLSearchParams({ since, cursor: encode(forgery) }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    await expect(turns.page(new URLSearchParams({ since, cursor: `${encode(valid)}==` }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(turns.page(new URLSearchParams({ since, cursor: "" }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(page).not.toHaveBeenCalled();
    await turns.page(new URLSearchParams({ since, cursor: encode(valid) }));
    expect(page).toHaveBeenCalledWith(expect.objectContaining({ exclusiveStartKey: valid }));
  });

  it("reports a failed read as RUNTIME_UNAVAILABLE, logging the error class only", async () => {
    const throttled = Object.assign(new Error("slow down list issues"), { name: "ProvisionedThroughputExceededException" });
    const log = vi.fn();
    await expect(exporter({ page: async () => { throw throttled; } }, undefined, log).exporter.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z" })))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      component: "broker", event: "turn_record.read_failed", errorName: "ProvisionedThroughputExceededException",
    });
  });

  it("refuses an impossible calendar date or hour 24 that Date.parse would roll over", async () => {
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({ items: [] }));
    const { exporter: turns } = exporter({ page });
    for (const since of [
      "2026-02-31T00:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T12:00:00.000Z", "2026-02-30T23:00:00-05:00",
      "2026-09-17T24:00:00Z", "2026-09-17T24:00Z", "2026-09-17T24:00:00.000+02:00",
    ]) {
      await expect(turns.page(new URLSearchParams({ since }))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(page).not.toHaveBeenCalled();
    await turns.page(new URLSearchParams({ since: "2028-02-29T23:59:59.999-05:00" }));
    expect(page).toHaveBeenLastCalledWith(expect.objectContaining({ since: "2028-03-01T04:59:59.999Z" }));
    await turns.page(new URLSearchParams({ since: "2026-12-31T23:00:00Z" }));
    expect(page).toHaveBeenLastCalledWith(expect.objectContaining({ since: "2026-12-31T23:00:00.000Z" }));
  });

  it("looks up the projects of distinct workspaces concurrently, once each", async () => {
    const otherWorkspace = "22222222-2222-4222-8222-222222222222";
    const pending = new Map<string, (project: string) => void>();
    const projectOf = vi.fn((id: string) => new Promise<string | undefined>((resolve) => { pending.set(id, resolve); }));
    const items = [
      stored("EvTURN00040", "2026-09-24T08:00:00.000Z"),
      stored("EvTURN00041", "2026-09-24T07:00:00.000Z", { workspaceId: otherWorkspace }),
      stored("EvTURN00042", "2026-09-24T06:00:00.000Z"),
    ];
    const { exporter: turns } = exporter({ page: async () => ({ items }) }, projectOf);
    const result = turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z" }));
    await vi.waitFor(() => expect(projectOf).toHaveBeenCalledTimes(2));
    expect(projectOf.mock.calls.map(([id]) => id)).toEqual([workspaceId, otherWorkspace]);
    pending.get(otherWorkspace)?.("billing");
    pending.get(workspaceId)?.("payments");
    expect((await result).turns.map((turn) => [turn.eventId, turn.project])).toEqual([
      ["EvTURN00040", "payments"], ["EvTURN00041", "billing"], ["EvTURN00042", "payments"],
    ]);
    expect(projectOf).toHaveBeenCalledTimes(2);
  });

  it("reports a failed project lookup as a missing project, once per workspace", async () => {
    const throttled = Object.assign(new Error("slow down"), { name: "ProvisionedThroughputExceededException" });
    const projectOf = vi.fn(async (): Promise<string | undefined> => { throw throttled; });
    const items = [stored("EvTURN00006", "2026-09-24T08:00:00.000Z"), stored("EvTURN00007", "2026-09-24T07:00:00.000Z")];
    const { exporter: turns, log } = exporter({ page: async () => ({ items }) }, projectOf);
    const result = await turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z" }));
    expect(result.turns.map((turn) => turn.eventId)).toEqual(["EvTURN00006", "EvTURN00007"]);
    expect(result.turns[0]?.project).toBeUndefined();
    expect(result.turns[0]).not.toHaveProperty("project");
    expect(projectOf).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      component: "broker", event: "turn_record.project_unavailable", workspaceId, errorName: "ProvisionedThroughputExceededException",
    });
  });

  it("refuses to hand out a cursor it would not accept back", async () => {
    const log = vi.fn();
    const { exporter: turns } = exporter({ page: async () => ({ items: [], lastEvaluatedKey: { pk: "a", sk: "b", exportPk: "TURNS", exportSk: "c" } }) }, undefined, log);
    await expect(turns.page(new URLSearchParams({ since: "2026-09-17T00:00:00Z" }))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ component: "broker", event: "turn_record.cursor_unusable" });
  });

  it("queries the time index newest first and filters expired items in DynamoDB", async () => {
    const send = vi.fn(async () => ({ Items: [], LastEvaluatedKey: { pk: "a", sk: "b", exportPk: "TURNS", exportSk: "c" } }));
    const page = await dynamoTurnRecordSource({ send } as never, "turns").page({ since: "2026-09-17T00:00:00.000Z", limit: 100, nowSeconds: 5 });
    const input = (send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input;
    expect(input).toEqual({
      TableName: "turns", IndexName: "byTime",
      KeyConditionExpression: "exportPk = :partition AND exportSk >= :since",
      FilterExpression: "expiresAt > :now",
      ExpressionAttributeValues: { ":partition": "TURNS", ":since": "2026-09-17T00:00:00.000Z", ":now": 5 },
      ScanIndexForward: false, Limit: 100,
    });
    expect(page.lastEvaluatedKey).toEqual({ pk: "a", sk: "b", exportPk: "TURNS", exportSk: "c" });
  });

  it("passes the start key to DynamoDB and fails loudly on a last key it does not recognise", async () => {
    const start = keyOf(stored("EvTURN00030", "2026-09-20T00:00:00.000Z"));
    const send = vi.fn(async () => ({ Items: [stored("EvTURN00031", "2026-09-19T00:00:00.000Z")] }));
    const page = await dynamoTurnRecordSource({ send } as never, "turns").page({ since: "2026-09-17T00:00:00.000Z", limit: 100, nowSeconds: 5, exclusiveStartKey: start });
    expect((send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input.ExclusiveStartKey).toEqual(start);
    expect(page.items).toHaveLength(1);
    expect(page).not.toHaveProperty("lastEvaluatedKey");
    const odd = vi.fn(async () => ({ Items: [], LastEvaluatedKey: { pk: "a", sk: "b" } }));
    await expect(dynamoTurnRecordSource({ send: odd } as never, "turns").page({ since: "2026-09-17T00:00:00.000Z", limit: 100, nowSeconds: 5 }))
      .rejects.toThrow(/LastEvaluatedKey/);
  });

  it("reads a workspace's project name from the state table", async () => {
    const send = vi.fn(async () => ({ Item: { projectName: "payments" } }));
    expect(await workspaceProjectReader({ send } as never, "state")(workspaceId)).toBe("payments");
    expect((send.mock.calls[0] as unknown as [{ input: unknown }])[0].input).toEqual({ TableName: "state", Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" } });
    const missing = vi.fn(async () => ({}));
    expect(await workspaceProjectReader({ send: missing } as never, "state")(workspaceId)).toBeUndefined();
  });
});

describe("GET /v1/admin/turns", () => {
  const since = "2026-09-17T00:00:00.000Z";
  const log = vi.fn();
  const turnRecords = new TurnRecordExport({ source: { page: async () => ({ items: [stored("EvTURN00007", "2026-09-24T08:00:00.000Z")] }) }, projectOf: async () => "payments", now: () => now, log });

  it("serves an administrator", async () => {
    const { handler } = await createAdminBroker({ turnRecords });
    const response = await adminCall(handler, { method: "GET", path: `/v1/admin/turns?since=${since}` });
    expect(response.status).toBe(200);
    expect((response.body.turns as TurnRecord[]).map((turn) => [turn.eventId, turn.project])).toEqual([["EvTURN00007", "payments"]]);
    expect(response.body).not.toHaveProperty("cursor");
    expect(typeof response.body.requestId).toBe("string");
  });

  it("refuses a caller without the administrator claim", async () => {
    const page = vi.fn<TurnRecordSource["page"]>(async () => ({ items: [] }));
    const { handler } = await createAdminBroker({ turnRecords: new TurnRecordExport({ source: { page }, projectOf: async () => undefined }) });
    const response = await adminCall(handler, { method: "GET", path: `/v1/admin/turns?since=${since}`, admin: false });
    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(page).not.toHaveBeenCalled();
  });

  it("answers CONFIG_INVALID for a bad since or cursor", async () => {
    const { handler } = await createAdminBroker({ turnRecords });
    expect((await adminCall(handler, { method: "GET", path: "/v1/admin/turns?since=yesterday" })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    const forged = await adminCall(handler, { method: "GET", path: `/v1/admin/turns?since=${since}&cursor=${encode({ pk: "WORKSPACE#x", sk: "META", exportPk: "OTHER", exportSk: "z" })}` });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("answers RUNTIME_UNAVAILABLE when the deployment has no turn records", async () => {
    const { handler } = await createAdminBroker();
    const response = await adminCall(handler, { method: "GET", path: `/v1/admin/turns?since=${since}` });
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("serves only GET", async () => {
    const { handler } = await createAdminBroker({ turnRecords });
    const response = await adminCall(handler, { method: "POST", path: `/v1/admin/turns?since=${since}`, body: {} });
    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: "FORBIDDEN" });
  });
});
