import { describe, expect, it } from "vitest";
import { isStopCommand } from "../../packages/contracts/src/index.js";

describe("the Slack stop command (#126)", () => {
  it.each(["stop"])(
    "matches %j", (text) => { expect(isStopCommand(text)).toBe(true); });

});
