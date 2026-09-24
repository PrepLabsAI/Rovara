import { AgentXError } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { formatError, formatSuccess } from "../../packages/cli/src/output.js";

describe("CLI output contract", () => {
  it("emits stable JSON envelopes and documented error exit codes", () => {
    expect(JSON.parse(formatSuccess({ status: "READY" }, true))).toEqual({
      ok: true,
      data: { status: "READY" },
    });
    const failure = formatError(new AgentXError("WORKSPACE_NOT_READY", "prepare it first", 409), true);
    expect(JSON.parse(failure.text)).toEqual({
      ok: false,
      error: { code: "WORKSPACE_NOT_READY", message: "prepare it first" },
    });
    expect(failure.exitCode).toBe(5);
  });
});
