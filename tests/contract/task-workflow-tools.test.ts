import { describe, expect, it } from "vitest";
import { piTaskToolCapabilities } from "../../packages/worker/src/pi-session.js";

describe("worker tools for native workflow stages", () => {
  it("gives the plan stage read-only tools and no shell or custom file tools", () => {
    expect(piTaskToolCapabilities("PLAN")).toEqual({
      tools: ["read", "grep", "find", "ls"],
      customFileTools: false,
      shell: false,
    });
  });

  it("gives candidate and feedback reviewers only read tools at the runner boundary", () => {
    expect(piTaskToolCapabilities("REVIEW")).toEqual({
      tools: ["read", "grep", "find", "ls"],
      customFileTools: false,
      shell: false,
    });
  });

  it("restores coding tools only for an approved implementation stage", () => {
    expect(piTaskToolCapabilities("IMPLEMENT")).toEqual({
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      customFileTools: true,
      shell: true,
    });
  });
});
