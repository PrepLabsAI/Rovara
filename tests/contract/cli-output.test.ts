import { AgentXError } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { formatError, formatSuccess } from "../../packages/cli/src/output.js";
import { formatWorkspaceStatus } from "../../packages/cli/src/status.js";

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

  it("shows project, instance and actionable readiness without internal routing data", () => {
    const text = formatWorkspaceStatus({
      id: "013bff7e-2135-42de-b75e-a590689f2794",
      projectName: "payments",
      projectRevision: 3,
      deploymentMode: "demo-microvm",
      status: "PREPARATION_FAILED",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:01:00.000Z",
    });
    expect(text).toContain("payments");
    expect(text).toContain("PREPARATION_FAILED");
    expect(text).toContain("Storage mode: demo-microvm");
    expect(text).toContain("cannot accept coding tasks");
    expect(text).not.toContain("runtimeSessionId");
  });
});
