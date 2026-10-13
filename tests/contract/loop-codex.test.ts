// rovara loop (#359): Codex as the agent, and as the critic. Codex runs interactively in tmux in its workspace-write
// sandbox, with the loop's tools passed as -c overrides (nothing written to ~/.codex), and is resumed as the latest
// session in its worktree. As a reviewer it runs headless in its read-only sandbox.
import { afterEach, describe, expect, it } from "vitest";
import type { Exec } from "../../packages/cli/src/loop/exec.js";
import { AgentHarness, agentCommand, type SessionStart } from "../../packages/cli/src/loop/harness.js";
import { reviewerCommand } from "../../packages/cli/src/loop/reviews.js";
import { createLoopHarness, LOOP_SESSION, removeAll } from "../support/loop-harness.js";

const dirs: string[] = [];
afterEach(async () => { await removeAll(dirs); });

const PLAN = ["## Summary", "Retry the payment call on a 503.", "", "## Changes", "- src/retry.ts", "", "## Testing", "- npm test", ""].join("\n");
const START: SessionStart = {
  harness: "codex", tmux: "rovara-acme_payments-42", id: undefined, cwd: "/w/42",
  mcp: { command: "/usr/local/bin/node", args: ["/opt/rovara/cli.js", "loop", "mcp", "--repo", "acme/payments", "--issue", "42"], configPath: "/s/mcp.json" },
  writable: ["/checkouts/acme/payments/.git"], args: ["--model", "gpt-5-codex"], prompt: "Your step now: write the plan.", resume: false,
};

describe("the Codex harness (#359)", () => {
  it("starts Codex in its workspace-write sandbox with the loop's tools as overrides, and resumes the latest session in the worktree", () => {
    expect(agentCommand(START)).toEqual([
      "codex", "--sandbox", "workspace-write", "--cd", "/w/42", "--add-dir", "/checkouts/acme/payments/.git",
      "-c", 'mcp_servers.rovara-loop.command="/usr/local/bin/node"',
      "-c", 'mcp_servers.rovara-loop.args=["/opt/rovara/cli.js","loop","mcp","--repo","acme/payments","--issue","42"]',
      "--model", "gpt-5-codex", "--", "Your step now: write the plan.",
    ]);
    expect(agentCommand({ ...START, resume: true }).slice(0, 5)).toEqual(["codex", "resume", "--last", "--sandbox", "workspace-write"]);
    // Claude Code is unchanged: its own session ID, and its MCP config file.
    expect(agentCommand({ ...START, harness: "claude-code", id: "8f6f3b1e-0d7a-4a43-9b1a-2f0f1d8d6c11", args: [] }))
      .toEqual(["claude", "--session-id", "8f6f3b1e-0d7a-4a43-9b1a-2f0f1d8d6c11", "--mcp-config", "/s/mcp.json", "--", "Your step now: write the plan."]);
  });

  it("runs a Codex reviewer headless in its read-only sandbox, writing its answer to a file", () => {
    expect(reviewerCommand({ harness: "codex", cwd: "/w/42", model: "gpt-5-codex" }, "/tmp/answer.txt"))
      .toEqual(["codex", "exec", "--sandbox", "read-only", "--cd", "/w/42", "--ephemeral", "--output-last-message", "/tmp/answer.txt", "--model", "gpt-5-codex", "-"]);
    expect(reviewerCommand({ harness: "claude-code", cwd: "/w/42", model: undefined }, "").slice(0, 4)).toEqual(["claude", "-p", "--permission-mode", "plan"]);
  });

  it("sees Codex waiting for an approval on its screen", async () => {
    const screen = (text: string): Exec => async () => ({ code: 0, stdout: text, stderr: "" });
    expect(await new AgentHarness(screen("Would you like to run the following command?\n  $ npm install")).waitingForApproval("s")).toBe(true);
    expect(await new AgentHarness(screen("Would you like to make the following edits?")).waitingForApproval("s")).toBe(true);
    expect(await new AgentHarness(screen("Working (12s)")).waitingForApproval("s")).toBe(false);
  });
});

describe("the Quick loop on Codex (#359)", () => {
  it("plans, codes and publishes with Codex as the agent and the critic, and resumes Codex when its session ends", async () => {
    const h = await createLoopHarness(dirs, { config: ["harness:", "  name: codex", "  args: [--model, gpt-5-codex]", "reviews:", "  harness: codex"] });
    await h.comment("maya", "/rovara quick Retry the payment call on a 503");

    // Codex, not Claude Code, in the item's worktree, sandboxed, with the loop's tools and the repository's arguments.
    const session = h.world.sessions.get(LOOP_SESSION)!;
    expect(session.agent).toBe("codex");
    expect(session.cwd).toBe(h.worktree());
    expect(session.claude.slice(0, 6)).toEqual(["--sandbox", "workspace-write", "--cd", h.worktree(), "--add-dir", "/checkouts/acme/payments/.git"]);
    expect(session.claude).toContain("mcp_servers.rovara-loop.args=[\"/opt/rovara/cli.js\",\"loop\",\"mcp\",\"--repo\",\"acme/payments\",\"--issue\",\"42\"]");
    expect(session.claude.slice(-4, -2)).toEqual(["--model", "gpt-5-codex"]);
    expect(session.claude.at(-1)).toContain("Your step now: write the plan:");
    const state = await h.state();
    expect(state?.session).toEqual({ harness: "codex", tmux: LOOP_SESSION });

    // The same Quick path: plan, approval, code, checks, reviews (on Codex), one pull request.
    await h.write("plan", PLAN);
    expect(await h.complete("Planned it.")).toContain("Accepted");
    await h.comment("maya", "/rovara approve");
    expect(h.lastReceived()).toContain("Your step now: implement it.");
    await h.selfReview();
    expect(await h.complete("Coded it.")).toContain("Accepted");
    await h.runOwnSteps();
    expect(await h.step()).toBe("pr-open");
    expect(h.reviewerRuns.map((run) => `${run.role} on ${run.harness}`)).toEqual(["CRITIC on codex", "SECURITY on codex"]);
    expect(h.world.pullRequests).toHaveLength(1);

    // A reply after Codex's session ended resumes the latest Codex session in the worktree.
    h.world.sessions.delete(LOOP_SESSION);
    await h.comment("sam", "Log each retry.");
    const resumed = h.world.started.at(-1)!;
    expect(resumed.agent).toBe("codex");
    expect(resumed.claude.slice(0, 4)).toEqual(["resume", "--last", "--sandbox", "workspace-write"]);
    expect(resumed.claude.at(-1)).toContain("Log each retry.");
  });
});
