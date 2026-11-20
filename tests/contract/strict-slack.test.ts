import { describe, expect, it } from "vitest";
import { SlackPostError } from "../../packages/broker/src/aws/slack-web.js";
import { StrictSlackWeb } from "../support/strict-slack.js";

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const codeAsync = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { return error instanceof SlackPostError ? error.slackError : "other"; } return "ok"; };

describe("StrictSlackWeb refuses what Slack refuses", () => {

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
    expect(await codeAsync(() => slack.openView("1.2.3", modal({ blocks: [input({ type: "users_select", action_id: "person", options: options(1) })] })))).toBe("invalid_blocks");
    expect(await codeAsync(() => slack.openView("1.2.3", modal({ blocks: [input({ type: "users_select", action_id: "person" })] })))).toBe("ok");
    expect(await codeAsync(() => slack.openView("", modal({})))).toBe("invalid_trigger");
    expect(await codeAsync(() => slack.openView("1.2.3", modal({ blocks: [input({ type: "multi_static_select", action_id: "selected_options", options: options(14) })] })))).toBe("ok");
  });

});
