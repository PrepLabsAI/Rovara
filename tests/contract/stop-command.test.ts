import { describe, expect, it } from "vitest";
import { isStopCommand } from "../../packages/contracts/src/index.js";

describe("the Slack stop command (#126)", () => {
  it.each(["stop", "Stop", "STOP!", "abort", "halt", "stop it", "cancel that", "stop now", "stop working",
    "please stop", "stop please", "please cancel the task", "stop the current task", "cancel the running task.", "  stop   it  "])(
    "matches %j", (text) => { expect(isStopCommand(text)).toBe(true); });

  // A bare "cancel" declines a pending confirmation, so it is not a stop.
  it.each(["cancel", "Cancel.", "stop using tabs", "cancel the subscription feature", "don't stop", "can you stop the server in dev?", "stopwatch",
    "stop it and then fix the footer", "", "please", "abort mission control page"])(
    "does not match %j", (text) => { expect(isStopCommand(text)).toBe(false); });
});
