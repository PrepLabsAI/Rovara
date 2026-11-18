// L4-EVW2 (DEC 254zzz20 D2): the setup agent is told to propose a wrapper (never to ask the customer for an adapter), what shapes it may name, and that a custom wrapper must write the one fixed report path.
import { describe, expect, it } from "vitest";
import { EVAL_WRAPPER_REPORT_PATH } from "@agentx/contracts";
import { SETUP_AGENT_EVAL_LINES } from "../../packages/worker/src/setup-agent-prompt.js";

describe("the setup agent's eval lines", () => {
  const text = SETUP_AGENT_EVAL_LINES.join("\n");
  it("names the readable shapes, the rows shape and the custom wrapper, and says the customer is not asked for an adapter", () => {
    for (const word of ["\"junit\"", "\"promptfoo\"", "\"measures\"", "\"rows\"", "\"jsonl\"", "\"custom\"", "ROVARA_EVAL_IDS", "do not ask the customer for an adapter", "pull request"]) expect(text, word).toContain(word);
    expect(text).toContain(EVAL_WRAPPER_REPORT_PATH);
    expect(text).toContain("Do not run the eval");
  });
});
