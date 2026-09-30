// tests/contract/admin-change-interactivity.test.ts
// Spec 025 E14: a Confirm or Cancel press in a direct message is handed to the broker, and the
// presser hears at once that it was received; every other button keeps today's handling.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_CHANGE_CANCEL_RECEIVED_TEXT,
  ADMIN_CHANGE_RECEIVED_TEXT,
  UNKNOWN_BUTTON_TEXT,
  createSlackInteractivityHandler,
  type SlackActionHandler,
} from "../../packages/broker/src/aws/slack-interactivity.js";

const SIGNING = "s".repeat(32);
const CHANGE = "55555555-5555-4555-8555-555555555555";
const BOT_TOKEN = "xoxb-planted-token-9f8e7d";
function event(actionId: string, value = CHANGE, now = Date.now(), channel = "D0ADMINDM1") {
  const payload = { type: "block_actions", user: { id: "U0ADA00001", team_id: "T0BSHLLUGBD" }, team: { id: "T0BSHLLUGBD" }, container: { type: "message", channel_id: channel, message_ts: "1696237200.000100" },
    message: { ts: "1696237200.000100", text: "AgentX needs your confirmation" }, response_url: "https://hooks.slack.com/actions/T/1/abc", actions: [{ action_id: actionId, value }] };
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(now / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { version: "2.0", rawPath: "/v1/slack/interactions", body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, requestContext: { http: { method: "POST" } } };
}

describe("an admin change press (E14)", () => {
  it("hands a Confirm press to the broker, answers the presser, and logs the change's trace ID", async () => {
    const press = vi.fn(async () => undefined);
    const respondEphemeral = vi.fn(async () => undefined);
    const log = vi.fn();
    const handler = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: "xoxb-1" }), handlers: [], respondEphemeral, log, adminChange: { press, traceOf: async () => "trace-7" } });
    expect((await handler(event("agentx_admin_change_confirm") as never)).statusCode).toBe(200);
    expect(press).toHaveBeenCalledWith({ changeId: CHANGE, click: "confirm", slackUserId: "U0ADA00001", teamId: "T0BSHLLUGBD" });
    expect(respondEphemeral).toHaveBeenCalledWith("https://hooks.slack.com/actions/T/1/abc", ADMIN_CHANGE_RECEIVED_TEXT);
    expect(log).toHaveBeenCalledWith("admin_change.press_received", { changeId: CHANGE, traceId: "trace-7", click: "confirm" });
  });

  it("tells the presser to try again when the hand-over fails, and ignores a press with no change ID", async () => {
    const respondEphemeral = vi.fn(async () => undefined);
    const handler = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: "xoxb-1" }), handlers: [], respondEphemeral, adminChange: { press: async () => { throw new Error("throttled"); } } });
    await handler(event("agentx_admin_change_cancel"));
    expect(respondEphemeral).toHaveBeenLastCalledWith(expect.any(String), "I couldn't take that press. Press the button again.");
    const press = vi.fn();
    const strict = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: "xoxb-1" }), handlers: [], respondEphemeral, adminChange: { press } });
    await strict(event("agentx_admin_change_confirm", "not-a-change"));
    expect(press).not.toHaveBeenCalled();
  });

  it("refuses an unsigned press as every interaction is refused", async () => {
    const press = vi.fn();
    const handler = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: "other".repeat(8), botToken: "xoxb-1" }), handlers: [], adminChange: { press } });
    expect((await handler(event("agentx_admin_change_confirm") as never)).statusCode).toBe(401);
    expect(press).not.toHaveBeenCalled();
  });

  it("hands a Cancel press over with the cancel click and answers with the cancel text, without a trace reader", async () => {
    const press = vi.fn(async () => undefined);
    const respondEphemeral = vi.fn(async () => undefined);
    const log = vi.fn();
    const handler = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: "xoxb-1" }), handlers: [], respondEphemeral, log, adminChange: { press } });
    expect((await handler(event("agentx_admin_change_cancel") as never)).statusCode).toBe(200);
    expect(press).toHaveBeenCalledWith({ changeId: CHANGE, click: "cancel", slackUserId: "U0ADA00001", teamId: "T0BSHLLUGBD" });
    expect(respondEphemeral).toHaveBeenCalledWith("https://hooks.slack.com/actions/T/1/abc", ADMIN_CHANGE_CANCEL_RECEIVED_TEXT);
    expect(log).toHaveBeenCalledWith("admin_change.press_received", { changeId: CHANGE, click: "cancel" });
  });

  it("still hands the press over when the trace reader fails", async () => {
    const press = vi.fn(async () => undefined);
    const log = vi.fn();
    const handler = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: "xoxb-1" }), handlers: [], log, adminChange: { press, traceOf: async () => { throw new Error("denied"); } } });
    expect((await handler(event("agentx_admin_change_confirm") as never)).statusCode).toBe(200);
    expect(press).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("admin_change.press_received", { changeId: CHANGE, click: "confirm" });
  });

  it("C14: without the adminChange dependency (the legacy deployment) a press keeps today's parsing", async () => {
    const respondEphemeral = vi.fn(async () => undefined);
    const log = vi.fn();
    const handler = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: "xoxb-1" }), handlers: [], respondEphemeral, log });
    expect((await handler(event("agentx_admin_change_confirm") as never)).statusCode).toBe(200);
    expect(log.mock.calls).toEqual([["interaction.ignored", { reason: "malformed_action" }]]);
    expect(respondEphemeral).not.toHaveBeenCalled();
  });

  it("FR-042: any other button in a direct message keeps today's parsing, and no handler runs", async () => {
    const press = vi.fn();
    const handle = vi.fn(async () => undefined);
    const other: SlackActionHandler = { matches: () => true, handle };
    const respondEphemeral = vi.fn(async () => undefined);
    const log = vi.fn();
    const handler = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: "xoxb-1" }), handlers: [other], respondEphemeral, log, adminChange: { press } });
    await handler(event("agentx_confirm_approve", "44444444-4444-5444-8444-444444444444"));
    expect(log.mock.calls).toEqual([["interaction.ignored", { reason: "malformed_action" }]]);
    expect(press).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
    expect(respondEphemeral).not.toHaveBeenCalled();
    expect(respondEphemeral).not.toHaveBeenCalledWith(expect.anything(), UNKNOWN_BUTTON_TEXT);
  });

  it("never logs or echoes the Slack token, signature or payload, and its answers carry no em dash", async () => {
    const lines: string[] = [];
    const answers: string[] = [];
    const log = (name: string, fields: Record<string, unknown>) => { lines.push(JSON.stringify({ name, fields })); };
    const respondEphemeral = async (_url: string, text: string) => { answers.push(text); };
    const request = event("agentx_admin_change_confirm");
    const ok = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: BOT_TOKEN }), handlers: [], respondEphemeral, log, adminChange: { press: async () => undefined, traceOf: async () => "trace-7" } });
    await ok(request);
    const failing = createSlackInteractivityHandler({ secrets: async () => ({ signingSecret: SIGNING, botToken: BOT_TOKEN }), handlers: [], respondEphemeral, log, adminChange: { press: async () => { throw new Error(`boom ${BOT_TOKEN}`); } } });
    await failing(event("agentx_admin_change_cancel"));
    const everything = [...lines, ...answers].join("\n");
    for (const planted of [BOT_TOKEN, SIGNING, request.headers["x-slack-signature"], "hooks.slack.com", "AgentX needs your confirmation", "boom"]) expect(everything).not.toContain(planted);
    expect(lines).toContainEqual(JSON.stringify({ name: "admin_change.press_failed", fields: { changeId: CHANGE, errorName: "Error" } }));
    for (const text of [...answers, ADMIN_CHANGE_RECEIVED_TEXT, ADMIN_CHANGE_CANCEL_RECEIVED_TEXT]) expect(text).not.toContain("—");
  });
});
