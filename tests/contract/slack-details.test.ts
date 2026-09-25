// tests/contract/slack-details.test.ts
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DETAILS_ACTION,
  TURN_DETAILS_ATTRIBUTES,
  TurnRecordSchema,
  turnRecordKeys,
  type TurnRecord,
} from "../../packages/contracts/src/index.js";
import {
  DETAILS_NOT_FOUND,
  DETAILS_NOT_SAVED,
  DETAILS_OPEN_FAILED,
  DETAILS_SAVING,
  DETAILS_UNAVAILABLE,
  DETAILS_UNREADABLE,
  detailsActionHandler,
  detailsExpiredText,
  dynamoTurnDetailsReader,
} from "../../packages/broker/src/aws/slack-details.js";
import type { SlackModalView } from "../../packages/broker/src/aws/slack-details-view.js";
import { CLICK_FAILED_TEXT, createSlackInteractivityHandler } from "../../packages/broker/src/aws/slack-interactivity.js";

const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
const requester = "U0123456789";
const other = "U0456789012";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const subject = `${thread.teamId}/${thread.channelId}/${thread.threadTs}`;
const receivedAt = "2026-09-24T10:00:00.000Z";
const value = `${receivedAt}#EvTURN00001`;
const replyTs = "1790244060.000200"; // the reply, posted at 10:01:00Z
const repliedAt = 1_790_244_060_000;
const day = 86_400_000;

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return TurnRecordSchema.parse({
    eventId: "EvTURN00001", subject, receivedAt, requestedBy: { teamId: thread.teamId, userId: requester },
    disposition: "answered", startedAt: receivedAt, finishedAt: "2026-09-24T10:00:12.300Z", durationMs: 12_300,
    requestText: "close TRK-9, the secret plan", responseText: "Closed TRK-9, private answer",
    model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
    offeredTools: [{ name: "tracker__close_item", descriptionHash: "a".repeat(64) }],
    calls: [{ name: "tracker__close_item", connector: "tracker", arguments: "{\"id\":\"TRK-9\"}", argumentsFingerprint: "b".repeat(32), validation: "ok", outcome: "SUCCEEDED", durationMs: 800 }],
    emptyResponse: false, workerOperations: [], workspaceId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  });
}

function stored(record: TurnRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...turnRecordKeys(record), ...record, ...extra };
}

function payload(options: { user?: string; value?: string; userTeam?: string } = {}) {
  return {
    type: "block_actions",
    team: { id: thread.teamId },
    user: { id: options.user ?? requester, team_id: options.userTeam ?? thread.teamId },
    container: { type: "message", message_ts: replyTs, channel_id: thread.channelId, thread_ts: thread.threadTs },
    message: { ts: replyTs, thread_ts: thread.threadTs, text: "Closed TRK-9." },
    response_url: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc",
    trigger_id: "1.2.3",
    actions: [{ action_id: DETAILS_ACTION, value: options.value ?? value, block_id: "agentx_details" }],
  };
}

function signed(body: unknown, nowMs: number, signature?: string) {
  const raw = `payload=${encodeURIComponent(JSON.stringify(body))}`;
  const timestamp = String(Math.floor(nowMs / 1_000));
  return {
    rawPath: "/v1/slack/interactions",
    body: raw,
    headers: {
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature ?? `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
  };
}

/** A table that answers GetItem as DynamoDB does: only the projected attributes come back. */
function table(items: Array<Record<string, unknown>>, fail?: Error) {
  const commands: Array<Record<string, unknown>> = [];
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      commands.push(command.input);
      if (fail) throw fail;
      const key = command.input.Key as { pk: string; sk: string };
      const item = items.find((entry) => entry.pk === key.pk && entry.sk === key.sk);
      if (item === undefined) return {};
      const names = command.input.ExpressionAttributeNames as Record<string, string>;
      const wanted = new Set(String(command.input.ProjectionExpression).split(", ").map((alias) => names[alias]));
      return { Item: Object.fromEntries(Object.entries(item).filter(([name]) => wanted.has(name))) };
    },
  };
  return { reader: dynamoTurnDetailsReader(client as never, "turns"), commands };
}

function harness(options: { items?: Array<Record<string, unknown>>; now?: number; failRead?: Error; failOpen?: Error; failRespond?: Error } = {}) {
  const now = options.now ?? repliedAt + 3_600_000;
  const views: Array<{ triggerId: string; view: SlackModalView }> = [];
  const ephemeral: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => { logs.push({ event, fields }); };
  const { reader, commands } = table(options.items ?? [stored(turn())], options.failRead);
  const handler = createSlackInteractivityHandler({
    secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
    now: () => now,
    log,
    // The endpoint's own fallback, so a Details throw that escaped would show up here as CLICK_FAILED_TEXT.
    respondEphemeral: async (_url, text) => { ephemeral.push(text); },
    handlers: [detailsActionHandler({
      readDetails: reader,
      openView: async (triggerId, view) => { if (options.failOpen) throw options.failOpen; views.push({ triggerId, view }); },
      respondEphemeral: async (_url, text) => { if (options.failRespond) throw options.failRespond; ephemeral.push(text); },
      now: () => now,
      log,
    })],
  });
  const click = (body: unknown = payload()) => handler(signed(body, now));
  return { handler, click, views, ephemeral, logs, commands, now };
}

const shown = (view: SlackModalView | undefined) => JSON.stringify(view ?? {});

describe("the Details view (spec 014 FR-024, FR-025)", () => {
  it("refuses a Details click whose Slack signature does not verify, before reading anything", async () => {
    const { handler, commands, views, now } = harness();
    expect((await handler(signed(payload(), now, "v0=bad"))).statusCode).toBe(401);
    expect(commands).toHaveLength(0);
    expect(views).toHaveLength(0);
  });

  it("opens the turn's details for the requester who clicked, and posts nothing to the thread", async () => {
    const { click, views, ephemeral, logs } = harness();
    expect((await click()).statusCode).toBe(200);
    expect(views).toHaveLength(1);
    expect(views[0]!.triggerId).toBe("1.2.3");
    expect(views[0]!.view.title.text).toBe("Turn details");
    expect(shown(views[0]!.view)).toContain("tracker__close_item");
    expect(shown(views[0]!.view)).toContain("TRK-9");
    expect(ephemeral).toEqual([]);
    expect(logs).toContainEqual({ event: "interaction.details_opened", fields: { eventId: "EvTURN00001", viewerId: requester, viewer: "requester" } });
  });

  it("lets another member who can see the reply open it, never shows the request or response text, and logs who looked", async () => {
    const { click, views, logs, commands } = harness();
    await click(payload({ user: other }));
    expect(views).toHaveLength(1);
    expect(shown(views[0]!.view)).not.toContain("secret plan");
    expect(shown(views[0]!.view)).not.toContain("private answer");
    const names = Object.values(commands[0]!.ExpressionAttributeNames as Record<string, string>);
    expect(names).not.toContain("requestText");
    expect(names).not.toContain("responseText");
    expect(logs).toContainEqual({ event: "interaction.details_opened", fields: { eventId: "EvTURN00001", viewerId: other, viewer: "member" } });
  });

  it("reads only from the thread of the clicked message, so a forged value cannot reach another thread's turn", async () => {
    const elsewhere = turn({ eventId: "EvOTHER0001", subject: "T0BSHLLUGBD/C0999999999/1695500000.000009", requestText: "other thread secret" });
    const { click, views, commands } = harness({ items: [stored(turn()), stored(elsewhere)] });
    await click(payload({ value: `${receivedAt}#EvOTHER0001` }));
    expect(commands[0]!.Key).toEqual({ pk: `THREAD#${subject}`, sk: `TURN#${receivedAt}#EvOTHER0001` });
    expect(shown(views[0]!.view)).toContain(DETAILS_NOT_SAVED);
    expect(shown(views[0]!.view)).not.toContain("other thread secret");
  });

  it("refuses a malformed value without reading, and a record that disagrees with its key, with the same answer", async () => {
    for (const forged of ["", "THREAD#T0BSHLLUGBD/C0999999999/1695500000.000009", `${value}#TURN#x`, "x".repeat(2_000)]) {
      const { click, views, commands, logs } = harness();
      await click(payload({ value: forged }));
      expect(commands).toHaveLength(0);
      expect(shown(views[0]!.view)).toContain(DETAILS_NOT_FOUND);
      expect(logs.at(-1)).toMatchObject({ event: "interaction.details_refused", fields: { reason: "malformed_value" } });
    }
    const tampered = { ...stored(turn()), subject: "T0BSHLLUGBD/C0999999999/1695500000.000009" };
    const { click, views, logs } = harness({ items: [tampered] });
    await click();
    expect(shown(views[0]!.view)).toContain(DETAILS_NOT_FOUND);
    expect(logs.at(-1)).toMatchObject({ event: "interaction.details_refused", fields: { reason: "mismatch" } });
  });

  it("says the details are no longer kept after 30 days without reading, also before DynamoDB deletes the record, and opens them the day before", async () => {
    const late = harness({ now: Date.parse(receivedAt) + 30 * day });
    await late.click();
    expect(late.commands).toHaveLength(0);
    expect(shown(late.views[0]!.view)).toContain(detailsExpiredText(receivedAt));
    const lagging = harness({ items: [stored(turn(), { expiresAt: Math.floor((repliedAt + day) / 1_000) - 1 })], now: repliedAt + day });
    await lagging.click();
    expect(shown(lagging.views[0]!.view)).toContain(detailsExpiredText(receivedAt));
    const dayBefore = harness({ now: Date.parse(receivedAt) + 29 * day });
    await dayBefore.click();
    expect(shown(dayBefore.views[0]!.view)).toContain("tracker__close_item");
  });

  it("asks a member who clicks before the record is saved to try again, and says when it was never saved", async () => {
    const early = harness({ items: [], now: repliedAt + 10_000 });
    await early.click();
    expect(shown(early.views[0]!.view)).toContain(DETAILS_SAVING);
    expect(early.logs.at(-1)).toMatchObject({ event: "interaction.details_refused", fields: { reason: "not_saved_yet" } });
    const lost = harness({ items: [], now: repliedAt + 10 * 60_000 });
    await lost.click();
    expect(shown(lost.views[0]!.view)).toContain(DETAILS_NOT_SAVED);
    expect(lost.logs.at(-1)).toMatchObject({ event: "interaction.details_refused", fields: { reason: "not_found" } });
  });

  it("says so when the record cannot be read or parsed, and logs field names only", async () => {
    const down = harness({ failRead: Object.assign(new Error("slow down"), { name: "ProvisionedThroughputExceededException" }) });
    await down.click();
    expect(shown(down.views[0]!.view)).toContain(DETAILS_UNAVAILABLE);
    expect(down.logs).toContainEqual({ event: "interaction.details_read_failed", fields: { errorName: "ProvisionedThroughputExceededException" } });
    const broken = harness({ items: [stored(turn(), { calls: "not a list", usageError: "the secret plan" })] });
    await broken.click();
    expect(shown(broken.views[0]!.view)).toContain(DETAILS_UNREADABLE);
    expect(broken.logs).toContainEqual({ event: "interaction.details_invalid", fields: { eventId: "EvTURN00001", fields: "calls" } });
    expect(JSON.stringify(broken.logs)).not.toContain("secret plan");
  });

  it("answers privately through response_url when the modal cannot open, such as after Slack's 3-second trigger window", async () => {
    const { click, ephemeral, logs } = harness({ failOpen: new Error("Slack views.open failed: expired_trigger_id") });
    await click();
    expect(ephemeral).toEqual([DETAILS_OPEN_FAILED]);
    expect(logs).toContainEqual({ event: "interaction.details_open_failed", fields: { errorName: "Error", slackError: "expired_trigger_id" } });
  });

  it("reads one record by its key, consistently, asking only for the attributes the view shows", async () => {
    const { click, commands } = harness();
    await click();
    expect(commands).toEqual([expect.objectContaining({
      TableName: "turns", Key: { pk: `THREAD#${subject}`, sk: `TURN#${value}` }, ConsistentRead: true,
    })]);
    const names = commands[0]!.ExpressionAttributeNames as Record<string, string>;
    expect(String(commands[0]!.ProjectionExpression).split(", ").map((alias) => names[alias])).toEqual([...TURN_DETAILS_ATTRIBUTES]);
  });

  it("answers a member from another workspace (Slack Connect) privately that there are no details, without reading", async () => {
    const { click, views, commands, logs } = harness();
    await click(payload({ user: "U0EXTERNAL1", userTeam: "T0EXTERNAL1" }));
    expect(commands).toHaveLength(0);
    expect(views).toHaveLength(1);
    expect(shown(views[0]!.view)).toContain(DETAILS_NOT_FOUND);
    expect(shown(views[0]!.view)).not.toContain("tracker__close_item");
    expect(logs.at(-1)).toMatchObject({ event: "interaction.details_refused", fields: { reason: "external_member", viewerId: "U0EXTERNAL1" } });
  });

  it("refuses a record whose event, receivedAt or requesting team disagrees with the clicked reference, never showing it", async () => {
    const tampered = [
      { ...stored(turn()), eventId: "EvOTHER0001" },
      { ...stored(turn()), receivedAt: "2026-09-24T09:00:00.000Z" },
      { ...stored(turn()), requestedBy: { teamId: "T0EXTERNAL1", userId: requester } },
    ];
    for (const item of tampered) {
      const { click, views, logs } = harness({ items: [item] });
      await click();
      expect(shown(views[0]!.view)).toContain(DETAILS_NOT_FOUND);
      expect(shown(views[0]!.view)).not.toContain("tracker__close_item");
      expect(logs.at(-1)).toMatchObject({ event: "interaction.details_refused", fields: { reason: "mismatch" } });
    }
  });

  it("puts no record text into the message modals it opens", async () => {
    const broken = harness({ items: [stored(turn(), { calls: "not a list", usageError: "the secret plan" })] });
    await broken.click();
    expect(shown(broken.views[0]!.view)).not.toContain("secret plan");
    const tampered = harness({ items: [{ ...stored(turn()), subject: "T0BSHLLUGBD/C0999999999/1695500000.000009", usageError: "the secret plan" }] });
    await tampered.click();
    expect(shown(tampered.views[0]!.view)).not.toContain("secret plan");
  });

  it("logs a failed private answer when neither the modal nor response_url works, and never falls back to the confirmation wording", async () => {
    const { click, ephemeral, logs } = harness({
      failOpen: new Error("Slack views.open failed: expired_trigger_id"),
      failRespond: Object.assign(new Error("gone"), { name: "TimeoutError" }),
    });
    expect((await click()).statusCode).toBe(200);
    expect(logs).toContainEqual({ event: "interaction.respond_failed", fields: { errorName: "TimeoutError" } });
    expect(ephemeral).not.toContain(CLICK_FAILED_TEXT);
    expect(logs.map((entry) => entry.event)).not.toContain("interaction.failed");
  });

  it("says the details are unavailable when something unexpected throws, rather than the confirmation wording", async () => {
    // A nested value whose read throws: the table hands it back untouched, and parsing it throws.
    const requestedBy = { userId: requester };
    Object.defineProperty(requestedBy, "teamId", { enumerable: true, get: () => { throw new TypeError("poisoned record"); } });
    const poisoned = { ...stored(turn()), requestedBy };
    const { click, views, ephemeral, logs } = harness({ items: [poisoned] });
    await click();
    expect(shown(views.at(-1)?.view)).toContain(DETAILS_UNAVAILABLE);
    expect(ephemeral).not.toContain(CLICK_FAILED_TEXT);
    expect(logs).toContainEqual({ event: "interaction.details_failed", fields: { errorName: "TypeError" } });
    expect(JSON.stringify(logs)).not.toContain("poisoned record");
  });

  it("is registered on the ingress Lambda's interactivity endpoint with the turn record table and views.open", () => {
    const source = readFileSync("packages/broker/src/aws/slack-interactivity.ts", "utf8");
    expect(source).toContain("detailsActionHandler({");
    expect(source).toContain('requiredEnvironment("TURN_RECORDS_TABLE_NAME")');
    expect(source).toContain('"views.open"');
  });
});
