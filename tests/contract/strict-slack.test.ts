import { describe, expect, it } from "vitest";
import { SlackPostError } from "../../packages/broker/src/aws/slack-web.js";
import { StrictSlackWeb, visibleSlackText } from "../support/strict-slack.js";

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const button = (text: string, value = "{}") => ({ type: "button", action_id: "agentx_test", text: { type: "plain_text", text }, value });
const code = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof SlackPostError ? error.slackError : "other"; } return "ok"; };
const codeAsync = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { return error instanceof SlackPostError ? error.slackError : "other"; } return "ok"; };

describe("StrictSlackWeb refuses what Slack refuses", () => {
  it("enforces message text, section text and block count limits", () => {
    const slack = new StrictSlackWeb();
    expect(code(() => slack.post({ channel: "C0123456789", text: "x".repeat(40_001) }))).toBe("msg_too_long");
    expect(code(() => slack.post({ channel: "C0123456789", text: "t", blocks: [section("x".repeat(3_001))] }))).toBe("invalid_blocks");
    expect(code(() => slack.post({ channel: "C0123456789", text: "t", blocks: Array.from({ length: 51 }, () => section("x")) }))).toBe("invalid_blocks");
    expect(code(() => slack.post({ channel: "C0123456789", text: "t", blocks: [{ type: "actions", elements: [button("x".repeat(76))] }] }))).toBe("invalid_blocks");
    expect(code(() => slack.post({ channel: "C0123456789", text: "ok", blocks: [section("ok"), { type: "actions", elements: [button("Approve")] }] }))).toBe("ok");
    expect(slack.posts).toHaveLength(1);
  });

  it("enforces modal limits: metadata, title, block count, checkbox options and option text", async () => {
    const slack = new StrictSlackWeb();
    const modal = (overrides: Record<string, unknown>) => ({ type: "modal", callback_id: "c", title: { type: "plain_text", text: "Approve coding plan" }, blocks: [section("x")], ...overrides });
    const options = (count: number, text = "check") => Array.from({ length: count }, (_, index) => ({ text: { type: "plain_text", text }, value: `check-${index}` }));
    const input = (element: Record<string, unknown>) => ({ type: "input", block_id: "b", label: { type: "plain_text", text: "Checks" }, element });
    expect(await codeAsync(() => slack.openView("1.2.3", modal({ private_metadata: "x".repeat(3_001) })))).toBe("invalid_arguments");
    expect(await codeAsync(() => slack.openView("1.2.3", modal({ title: { type: "plain_text", text: "x".repeat(25) } })))).toBe("invalid_arguments");
    expect(await codeAsync(() => slack.openView("1.2.3", modal({ blocks: Array.from({ length: 101 }, () => section("x")) })))).toBe("invalid_blocks");
    expect(await codeAsync(() => slack.openView("1.2.3", modal({ blocks: [input({ type: "checkboxes", action_id: "selected_options", options: options(11) })] })))).toBe("invalid_blocks");
    expect(await codeAsync(() => slack.openView("1.2.3", modal({ blocks: [input({ type: "multi_static_select", action_id: "selected_options", options: options(2, "x".repeat(76)) })] })))).toBe("invalid_blocks");
    expect(await codeAsync(() => slack.openView("", modal({})))).toBe("invalid_trigger");
    expect(await codeAsync(() => slack.openView("1.2.3", modal({ blocks: [input({ type: "multi_static_select", action_id: "selected_options", options: options(14) })] })))).toBe("ok");
  });

  it("enforces the project's brief limit only on thread posts and counts link labels, not URLs", () => {
    const slack = new StrictSlackWeb({ briefLimit: 40 });
    expect(visibleSlackText("Read <https://example.test/very/long/path|the plan>")).toBe("Read the plan");
    expect(code(() => slack.post({ channel: "C0123456789", threadTs: "1695500000.000001", text: `Read <https://example.test/${"p".repeat(200)}|the plan>` }))).toBe("ok");
    expect(code(() => slack.post({ channel: "C0123456789", threadTs: "1695500000.000001", text: "x".repeat(41) }))).toBe("agentx_brief_limit");
    expect(code(() => slack.post({ channel: "C0123456789", text: "x".repeat(41) }))).toBe("ok");
  });

  it("counts what blocks show toward the brief limit too: section, header and context text, fields and button labels", () => {
    const slack = new StrictSlackWeb({ briefLimit: 40 });
    const thread = { channel: "C0123456789", threadTs: "1695500000.000001" };
    // A short fallback with long blocks is still a long message.
    expect(code(() => slack.post({ ...thread, text: "Short.", blocks: [section("x".repeat(41))] }))).toBe("agentx_brief_limit");
    expect(code(() => slack.post({ ...thread, text: "Short.", blocks: [{ type: "header", text: { type: "plain_text", text: "h".repeat(41) } }] }))).toBe("agentx_brief_limit");
    expect(code(() => slack.post({ ...thread, text: "Short.", blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: "c".repeat(41) }] }] }))).toBe("agentx_brief_limit");
    expect(code(() => slack.post({ ...thread, text: "Short.", blocks: [{ type: "section", fields: [{ type: "mrkdwn", text: "f".repeat(41) }] }] }))).toBe("agentx_brief_limit");
    // Text plus button labels: 30 + 11 = 41.
    expect(code(() => slack.post({ ...thread, text: "t".repeat(30), blocks: [section("t".repeat(30)), { type: "actions", elements: [button("b".repeat(11))] }] }))).toBe("agentx_brief_limit");
    // A section that repeats the fallback text is counted once, and link targets are not counted.
    expect(code(() => slack.post({ ...thread, text: "t".repeat(30), blocks: [section("t".repeat(30)), { type: "actions", elements: [button("b".repeat(10))] }] }))).toBe("ok");
    expect(code(() => slack.post({ ...thread, text: "See it", blocks: [section(`<https://example.test/${"p".repeat(200)}|the plan>`)] }))).toBe("ok");
  });

  it("holds an edit of a thread message, and a private reply in a thread, to the brief limit too", () => {
    const slack = new StrictSlackWeb({ briefLimit: 40 });
    const inThread = slack.post({ channel: "C0123456789", threadTs: "1695500000.000001", text: "Short." });
    const topLevel = slack.post({ channel: "C0123456789", text: "Short." });
    expect(code(() => slack.update({ channel: "C0123456789", ts: inThread.ts, text: "x".repeat(41), blocks: [] }))).toBe("agentx_brief_limit");
    expect(code(() => slack.update({ channel: "C0123456789", ts: inThread.ts, text: "Short", blocks: [section("y".repeat(41))] }))).toBe("agentx_brief_limit");
    expect(code(() => slack.update({ channel: "C0123456789", ts: inThread.ts, text: "x".repeat(40), blocks: [] }))).toBe("ok");
    expect(code(() => slack.update({ channel: "C0123456789", ts: topLevel.ts, text: "x".repeat(41), blocks: [] }))).toBe("ok");
    expect(code(() => slack.postEphemeral({ channel: "C0123456789", threadTs: "1695500000.000001", user: "U0123456789", text: "x".repeat(41) }))).toBe("agentx_brief_limit");
    expect(code(() => slack.postEphemeral({ channel: "C0123456789", user: "U0123456789", text: "x".repeat(41) }))).toBe("ok");
    expect(slack.updates).toHaveLength(2);
  });

  it("holds a button's private answer (response_url) to the brief limit, as it answers a thread's button", async () => {
    const slack = new StrictSlackWeb({ briefLimit: 40 });
    const url = "https://hooks.slack.com/actions/T0/1/x";
    expect(await codeAsync(() => slack.respondEphemeral(url, "x".repeat(41)))).toBe("agentx_brief_limit");
    expect(await codeAsync(() => slack.respondEphemeral(url, `See <https://example.test/${"p".repeat(200)}|it>`))).toBe("ok");
    expect(await codeAsync(() => new StrictSlackWeb().respondEphemeral(url, "x".repeat(41)))).toBe("ok");
    expect(slack.responses).toHaveLength(1);
  });

  it("answers the Web API over fetch with Slack's ok:false shape and honours failNext", async () => {
    const slack = new StrictSlackWeb();
    slack.failNext("chat.postMessage", "ratelimited");
    const call = async (method: string, body: unknown) => (await slack.fetch(`https://slack.com/api/${method}`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
    expect(await call("chat.postMessage", { channel: "C0123456789", text: "hi" })).toEqual({ ok: false, error: "ratelimited" });
    expect(await call("chat.postMessage", { channel: "C0123456789", text: "hi" })).toMatchObject({ ok: true, channel: "C0123456789" });
    expect(await call("views.open", { trigger_id: "1.2.3", view: { type: "modal", title: { type: "plain_text", text: "x".repeat(30) }, blocks: [] } })).toEqual({ ok: false, error: "invalid_arguments" });
  });
});
