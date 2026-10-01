import { describe, expect, it } from "vitest";
import {
  ChannelInfoRequestSchema,
  DEVELOPER_API_VERSION,
  DeveloperProjectSchema,
  DeveloperTaskViewSchema,
  StartDeveloperTaskRequestSchema,
  cleanClientName,
  diffStat,
  taskTitle,
} from "../../packages/contracts/src/index.js";
// F1: imported from the package, not the src path, so this is the same module instance the
// orchestrator's re-export resolves to (both resolve through @agentx/contracts's dist build).
import { lastAssistantResponse } from "@agentx/contracts";
import { lastAssistantResponse as orchestratorCopy } from "../../packages/orchestrator/src/control-plane-api.js";

const requestId = "33333333-3333-4333-8333-333333333333";

describe("the start request", () => {
  it("accepts the tool's fields, and the sharing fields 25c will use", () => {
    const parsed = StartDeveloperTaskRequestSchema.parse({
      requestId, project: "payments", instructions: "Fix the flaky retry test", client: "Claude Code",
      shareToChannel: false, shareMode: "view", channel: "C0123456789",
    });
    expect(parsed.instructions).toBe("Fix the flaky retry test");
  });

  it("counts the instruction limit in UTF-8 bytes, not characters", () => {
    const euros = "€".repeat(21_846); // 65,538 bytes in 21,846 characters
    const result = StartDeveloperTaskRequestSchema.safeParse({ requestId, project: "payments", instructions: euros });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("65536");
    expect(StartDeveloperTaskRequestSchema.safeParse({ requestId, project: "payments", instructions: "a".repeat(65_536) }).success).toBe(true);
  });

  it("refuses unknown fields and empty instructions", () => {
    expect(StartDeveloperTaskRequestSchema.safeParse({ requestId, project: "payments", instructions: "x", model: "big" }).success).toBe(false);
    expect(StartDeveloperTaskRequestSchema.safeParse({ requestId, project: "payments", instructions: "" }).success).toBe(false);
  });
});

describe("client names (FR-033, R25)", () => {
  it("maps the known clientInfo names, after cleaning them like a Slack display name", () => {
    expect(cleanClientName("claude-code")).toBe("Claude Code");
    expect(cleanClientName("Claude Code")).toBe("Claude Code");
    expect(cleanClientName("  codex-mcp-client​\n")).toBe("Codex");
    expect(cleanClientName("cursor-vscode")).toBe("Cursor");
  });

  it("says 'an AI tool' for any other name, so a client cannot choose the text of a footer", () => {
    expect(cleanClientName(undefined)).toBe("an AI tool");
    expect(cleanClientName("​ \n")).toBe("an AI tool");
    expect(cleanClientName("@everyone please review")).toBe("an AI tool");
    expect(cleanClientName("x".repeat(60))).toBe("an AI tool");
  });
});

describe("task titles", () => {
  it("uses the given title, else the first non-empty line, cut to 120 characters", () => {
    expect(taskTitle("Fix it\nmore detail", "Retry test")).toBe("Retry test");
    expect(taskTitle("\n\n  Fix the flaky retry test  \nThe test is in retry.test.ts")).toBe("Fix the flaky retry test");
    expect(taskTitle(`${"a".repeat(150)}\n`)).toBe("a".repeat(120));
    expect(taskTitle("\u0007\n")).toBe("Untitled task");
  });
});

describe("the summary (R18)", () => {
  it("is the last assistant message's text, and the orchestrator uses the same function", () => {
    const events = [
      { payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "First try failed." }] } } },
      { payload: { type: "tool_execution_end" } },
      { payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<thinking>x</thinking>All tests pass." }] } } },
    ];
    expect(lastAssistantResponse(events)).toBe("All tests pass.");
    expect(orchestratorCopy).toBe(lastAssistantResponse);
  });
});

describe("changed files from the workspace diff (R18)", () => {
  it("counts added and removed lines per file, per repository, and lists untracked files", () => {
    const diff = [
      "## demo", "", "### status", " M src/retry.ts", "?? notes/new.md", "### diff",
      "diff --git a/src/retry.ts b/src/retry.ts", "index 1..2 100644", "--- a/src/retry.ts", "+++ b/src/retry.ts",
      "@@ -1,3 +1,4 @@", " keep", "-old", "+new", "+added", "--- a removed line that starts with two dashes",
      "## docs", "", "### status", " M README.md", "### diff",
      "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-a", "+b",
    ].join("\n");
    expect(diffStat(diff)).toEqual([
      { repository: "demo", path: "src/retry.ts", added: 2, removed: 2 },
      { repository: "demo", path: "notes/new.md", added: 0, removed: 0 },
      { repository: "docs", path: "README.md", added: 1, removed: 1 },
    ]);
  });

  it("stops at the limit", () => {
    const one = (index: number) => [`diff --git a/f${index} b/f${index}`, "@@ -0,0 +1 @@", "+x"].join("\n");
    const diff = ["## demo", "### diff", ...Array.from({ length: 5 }, (_, index) => one(index))].join("\n");
    expect(diffStat(diff, 3)).toHaveLength(3);
  });
});

describe("the task view", () => {
  it("parses a view with extra fields a newer control plane may add", () => {
    const view = {
      taskId: requestId, title: "Fix", project: "payments", status: "RUNNING", startingRevision: 7, client: "Claude Code", shared: false,
      createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:05.000Z", events: [], futureField: 1,
    };
    expect(DeveloperTaskViewSchema.parse(view).status).toBe("RUNNING");
  });
});

describe("the task view's failure stage (#154)", () => {
  const view = {
    taskId: requestId, title: "Fix", project: "payments", status: "FAILED", startingRevision: 7, client: "Claude Code", shared: false,
    createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:05.000Z", events: [],
  };

  it("carries stage setup when the failure happened while the workspace was set up", () => {
    const failure = { category: "worker_unavailable", stage: "setup", message: "workspace compute was lost during setup; close this task and start a new one" };
    expect(DeveloperTaskViewSchema.parse({ ...view, failure }).failure).toEqual(failure);
  });

  it("still parses a failure without a stage, from a control plane that predates it", () => {
    expect(DeveloperTaskViewSchema.parse({ ...view, failure: { category: "task_failed", message: "x" } }).failure).toEqual({ category: "task_failed", message: "x" });
  });

  it("drops a stage this release does not know, rather than refusing the view", () => {
    const parsed = DeveloperTaskViewSchema.parse({ ...view, failure: { category: "task_failed", stage: "a-future-stage", message: "x" } });
    expect(parsed.failure).toEqual({ category: "task_failed", message: "x" });
  });
});

describe("developer API 1.2 (R23, Q7)", () => {
  it("reports 1.2 and adds the project's task policy and channel names", () => {
    expect(DEVELOPER_API_VERSION).toBe("1.2");
    const project = DeveloperProjectSchema.parse({
      name: "payments", latestRevision: 7, access: "channel",
      channels: [{ channelId: "C0123456789", name: "payments-dev", isPrivate: false }],
      tasks: { enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true },
    });
    expect(project.channels[0]?.name).toBe("payments-dev");
  });

  it("names the channel-info request DeveloperIdentity answers", () => {
    expect(ChannelInfoRequestSchema.parse({ kind: "channel-info", channelIds: ["C0123456789"] })).toEqual({ kind: "channel-info", channelIds: ["C0123456789"] });
    expect(ChannelInfoRequestSchema.safeParse({ kind: "channel-info", channelIds: Array.from({ length: 51 }, () => "C0123456789") }).success).toBe(false);
  });

  it("F6: a newer control plane's task policy field parses, at the top level and nested inside shareMode", () => {
    const withTopLevelField = DeveloperProjectSchema.safeParse({
      name: "payments", latestRevision: 7, access: "channel",
      channels: [{ channelId: "C0123456789" }],
      tasks: {
        enabled: true, share: "optional",
        shareMode: { default: "view", allowContinue: true },
        channelMembersMayUse: true,
        futureTopLevelField: true,
      },
    });
    expect(withTopLevelField.success).toBe(true);

    const withNestedField = DeveloperProjectSchema.safeParse({
      name: "payments", latestRevision: 7, access: "channel",
      channels: [{ channelId: "C0123456789" }],
      tasks: {
        enabled: true, share: "optional",
        shareMode: { default: "view", allowContinue: true, futureNestedField: 1 },
        channelMembersMayUse: true,
      },
    });
    expect(withNestedField.success).toBe(true);
  });
});
