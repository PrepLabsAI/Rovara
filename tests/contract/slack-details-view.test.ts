import { describe, expect, it } from "vitest";
import { TurnDetailsSchema, type TurnDetails } from "../../packages/contracts/src/index.js";
import {
  CUT_MARKER,
  DETAILS_TEXT_CEILING,
  MODAL_BLOCK_LIMIT,
  SECTION_TEXT_LIMIT,
  detailsMessageView,
  turnDetailsView,
  type SlackModalView,
} from "../../packages/broker/src/aws/slack-details-view.js";

function call(overrides: Record<string, unknown> = {}) {
  return {
    name: "tracker__close_item", connector: "tracker", arguments: "{\"id\":\"TRK-9\"}", argumentsFingerprint: "b".repeat(32),
    validation: "ok", outcome: "SUCCEEDED", durationMs: 800, ...overrides,
  };
}

const base = {
  eventId: "EvTURN00001", subject: "T0BSHLLUGBD/C0123456789/1695500000.000001", receivedAt: "2026-09-24T10:00:00.000Z",
  requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0123456789" }, disposition: "answered", durationMs: 12_300,
  model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
  offeredTools: [{ name: "tracker__list_items", descriptionHash: "a".repeat(64) }, { name: "tracker__close_item", descriptionHash: "c".repeat(64) }],
  calls: [call()], emptyResponse: false,
  usage: {
    schemaVersion: 1, outcome: "SUCCEEDED", provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0", cacheRetention: "short",
    tokens: { input: 12_345, output: 678, cacheRead: 1_000, cacheWrite: 0, total: 14_023 }, cacheReadRatio: 0.07, costUsd: 0.0123,
  },
};

function details(overrides: Record<string, unknown> = {}): TurnDetails {
  return TurnDetailsSchema.parse({ ...base, ...overrides });
}

function texts(view: SlackModalView): string[] {
  return view.blocks.flatMap((block) => block.type === "section" ? [block.text.text] : block.type === "context" ? block.elements.map((element) => element.text) : []);
}

function expectWithinSlackLimits(view: SlackModalView): void {
  expect(view.title.text.length).toBeLessThanOrEqual(24);
  expect(view.close.text.length).toBeLessThanOrEqual(24);
  expect(view.blocks.length).toBeLessThanOrEqual(MODAL_BLOCK_LIMIT);
  for (const block of view.blocks) {
    if (block.type === "section") expect(block.text.text.length).toBeLessThanOrEqual(SECTION_TEXT_LIMIT);
    if (block.type === "context") expect(block.elements.length).toBeLessThanOrEqual(10);
  }
  for (const text of texts(view)) expect(text.length).toBeLessThanOrEqual(SECTION_TEXT_LIMIT);
  expect(texts(view).join("").length).toBeLessThan(DETAILS_TEXT_CEILING);
}

describe("the Details modal (spec 014 FR-024)", () => {
  it("summarizes who asked, when, the result, the model, the tools offered and usage", () => {
    const view = turnDetailsView(details());
    expectWithinSlackLimits(view);
    expect(view.title.text).toBe("Turn details");
    const all = texts(view).join("\n");
    expect(all).toContain("*Requested by* <@U0123456789>");
    expect(all).toContain("*Received* <!date^1790244000^{date_short_pretty} at {time}|2026-09-24T10:00:00.000Z>");
    expect(all).toContain("*Result* answered, in 12.3 s");
    expect(all).toContain("*Model* amazon-bedrock / amazon.nova-pro-v1:0");
    expect(all).toContain("*Tools offered* 2");
    expect(all).toContain("*Tool calls* 1");
    expect(all).toContain("*Usage* 12,345 input, 678 output, 1,000 cache-read tokens; $0.0123");
  });

  it("lists each call with its tool, connector, outcome, duration, validation, reason and redacted arguments", () => {
    const view = turnDetailsView(details({ calls: [call(), call({ name: "tracker__save_item", validation: "schema_error", outcome: "FAILED", reason: "schema_changed", durationMs: 100 })] }));
    const all = texts(view).join("\n");
    expect(all).toContain("*1.* `tracker__close_item` · tracker\nsucceeded in 0.8 s\n```{\"id\":\"TRK-9\"}```");
    expect(all).toContain("*2.* `tracker__save_item` · tracker\nfailed in 0.1 s · validation schema_error · reason schema_changed");
  });

  it("shows a gate decision when the record has one, and says so when it cannot", () => {
    const shown = texts(turnDetailsView(details({ calls: [call({ gate: { outcome: "ask", source: "rule", kind: "destructive", reason: "closing always asks" } })] }))).join("\n");
    expect(shown).toContain("Gate: ask (rule, destructive): closing always asks");
    const odd = texts(turnDetailsView(details({ calls: [call({ gate: { decided: true } })] }))).join("\n");
    expect(odd).toContain("Gate: a decision was recorded in a form this view cannot show.");
    expect(texts(turnDetailsView(details())).join("\n")).not.toContain("Gate:");
  });

  it("escapes record text so nothing in it links, mentions or notifies, and keeps each code block closed", () => {
    const hostile = JSON.stringify({ body: "<!channel> see <https://evil.example|here> & ```rm -rf```" });
    const view = turnDetailsView(details({ calls: [call({ arguments: hostile, reason: "<@U0999999999>" })] }));
    const section = texts(view).find((text) => text.includes("tracker__close_item"))!;
    expect(section).not.toContain("<!channel>");
    expect(section).not.toContain("<https://evil");
    expect(section).not.toContain("<@U0999999999>");
    expect(section).toContain("&lt;!channel&gt;");
    expect(section).toContain("&amp;");
    expect(section.split("```").length - 1).toBe(2);
    for (const block of view.blocks) {
      if (block.type === "section") expect(block.text.verbatim).toBe(true);
      if (block.type === "context") expect(block.elements.every((element) => element.verbatim)).toBe(true);
    }
  });

  it("fits the largest record there can be into one modal, lists every call, and marks what it cut", () => {
    const calls = Array.from({ length: 50 }, (_, index) => call({
      name: `${"x".repeat(120)}_${index}`, connector: "c".repeat(20), arguments: "<&`".repeat(682), reason: "r".repeat(64),
      validation: "schema_error", outcome: "FAILED", gate: { outcome: "ask", source: "classifier", reason: "<".repeat(200) },
    }));
    const view = turnDetailsView(details({
      calls, callsTruncated: true, argumentsOmitted: false, recordingErrors: Array.from({ length: 8 }, () => "<".repeat(64)),
      error: { name: "<".repeat(128), code: "&".repeat(64) },
    }));
    expectWithinSlackLimits(view);
    const all = texts(view).join("\n");
    expect(all).toContain(CUT_MARKER);
    for (let number = 1; number <= 50; number += 1) expect(all).toContain(`*${number}.*`);
  });

  it("says when calls were dropped, arguments omitted, recording failed, the turn failed or usage is missing", () => {
    const all = texts(turnDetailsView(details({
      callsTruncated: true, argumentsOmitted: true, calls: [call({ arguments: "[omitted]" })], emptyResponse: true,
      recordingErrors: ["handler_failed:tool_execution_end"], error: { name: "AgentXError", code: "RUNTIME_UNAVAILABLE" },
      usage: undefined, usageError: "stats unavailable",
    }))).join("\n");
    expect(all).toContain("*Tool calls* 1 (the turn made more; only the first 1 were kept)");
    expect(all).toContain("The turn failed: AgentXError (RUNTIME_UNAVAILABLE).");
    expect(all).toContain("The model returned no text.");
    expect(all).toContain("Every call's arguments were left out to fit the record's storage limit.");
    expect(all).toContain("Part of this turn could not be recorded: handler_failed:tool_execution_end.");
    expect(all).toContain("_Arguments left out to fit storage._");
    expect(all).toContain("*Usage* could not be read");
    expect(texts(turnDetailsView(details({ usage: undefined }))).join("\n")).toContain("*Usage* not recorded");
  });

  it("labels the action gate's dispositions in words", () => {
    const result = (disposition: string) => texts(turnDetailsView(details({ disposition, calls: [] }))).join("\n");
    expect(result("confirmation_refused")).toContain("*Result* confirmation refused, nothing ran, in 12.3 s");
    expect(result("confirmation_cancelled")).toContain("*Result* confirmation cancelled, in 12.3 s");
    expect(result("yes_to_all_granted")).toContain("*Result* yes to all granted, in 12.3 s");
  });

  it("says when the turn made no tool calls, and shows a message on its own", () => {
    expect(texts(turnDetailsView(details({ calls: [] }))).join("\n")).toContain("This turn made no tool calls.");
    const view = detailsMessageView("AgentX couldn't find the details for this reply.");
    expectWithinSlackLimits(view);
    expect(view.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "AgentX couldn't find the details for this reply.", verbatim: true } }]);
  });
});
