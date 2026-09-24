import { describe, expect, it } from "vitest";
import { slackRequestText, splitSlackMessage } from "../../packages/contracts/src/index.js";
import { lastAssistantText } from "../../packages/orchestrator/src/orchestrator.js";

describe("Slack text helpers", () => {
  it("normalizes mentions, extracts assistant text, and bounds Slack messages", () => {
    expect(slackRequestText(" <@UAGENTX01>  do the work ", "UAGENTX01")).toBe("do the work");
    expect(slackRequestText("<@UAGENTX01> do the work")).toBe("do the work");
    expect(lastAssistantText([
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "text", text: "<thinking>hidden</thinking>Answer" }] },
    ])).toBe("Answer");
    expect(() => lastAssistantText([
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Your session has expired. Please reauthenticate.",
      },
    ])).toThrow("Your session has expired. Please reauthenticate.");
    const chunks = splitSlackMessage("word ".repeat(2_000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3_500)).toBe(true);
    expect(splitSlackMessage("   ")).toEqual(["AgentX completed the request without returning a textual response."]);
  });
});
