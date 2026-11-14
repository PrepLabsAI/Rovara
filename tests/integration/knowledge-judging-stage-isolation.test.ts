// K1 C3 safety claim, end to end: a judging session (review, plan check) has no `read_knowledge` tool, no knowledge extension and no mid-run
// loading, so what a diff touches can never change which rules its reviewer sees. Built through createWorkspacePiSession with Pi's real
// session (default adapter) on the scripted faux model, with real git repositories. A build session is the positive control: the same repository,
// the same read, and there the tool and the mid-run rules ARE present.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createDefaultPiSessionAdapter, createWorkspacePiSession, type PiWorkflowMode } from "../../packages/worker/src/pi-session.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { encoding: "utf8" }).trim();

const FILES: Record<string, string> = {
  "AGENTS.md": "root rules",
  "src/ui/AGENTS.md": "NESTED UI RULES",
  ".cursor/rules/ui.mdc": "---\nglobs: src/ui/**\n---\nUI PATTERN RULES",
  ".kiro/steering/oncall.md": "---\ninclusion: manual\n---\nONCALL RUNBOOK",
  ".kiro/steering/api.md": "---\ninclusion: auto\nname: api-design\ndescription: REST rules\n---\nAPI DESIGN TEXT",
  "src/ui/a.tsx": "export const a = 1;\n",
};

async function workspace(): Promise<{ root: string; commit: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-judging-")));
  const directory = join(root, "repo/engine");
  await mkdir(directory, { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main");
  for (const [name, content] of Object.entries(FILES)) {
    await mkdir(join(directory, name, ".."), { recursive: true });
    await writeFile(join(directory, name), content);
  }
  git(directory, "add", ".");
  git(directory, "commit", "--quiet", "-m", "base");
  const commit = git(directory, "rev-parse", "HEAD");
  const now = new Date().toISOString();
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "p", projectRevision: 1,
    repositories: [{ name: "engine", path: "repo/engine", defaultBranch: "main", resolvedCommit: commit, resolvedAt: now, completedAt: now }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now,
  }));
  return { root, commit };
}

interface Seen { tools: string[]; systemPrompt: string; lastToolResult: string }

/** One session, one scripted turn: the model reads a file under src/ui, then answers. Returns what the model saw after the read. */
async function runTurn(options: { mode: PiWorkflowMode; at: "working-tree" | "base-commit" }): Promise<Seen & { loadedStage: string | undefined }> {
  const { root, commit } = await workspace();
  const { modelRuntime, faux } = await fauxModelRuntime();
  let seen: Seen | undefined;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: "repo/engine/src/ui/a.tsx" }, { id: "call-read-1" })], { stopReason: "toolUse" }),
    (context: Context) => {
      const last = context.messages.at(-1) as { content?: Array<{ type: string; text?: string }> };
      seen = {
        tools: getCurrentTools(context.messages).map((tool) => tool.name),
        systemPrompt: getCurrentSystemPrompt(context.messages),
        lastToolResult: (last.content ?? []).map((part) => part.text ?? "").join("\n"),
      };
      return fauxAssistantMessage("Done.");
    },
  ]);
  const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const handle = await createWorkspacePiSession({
    rootPath: root, model: FAUX_MODEL, workflowMode: options.mode, localFileTools: true, contextFilesAt: options.at,
    ...(options.at === "base-commit" ? { baseCommits: [{ repositoryId: "engine", baseCommitSha: commit }] } : {}),
  }, adapter);
  try {
    await handle.prompt("go");
    return { ...seen!, loadedStage: handle.loadedKnowledge?.().stage };
  } finally {
    handle.dispose();
  }
}

describe("judging stages have no read_knowledge, no knowledge extension and no mid-run loading", () => {
  for (const [label, mode, stage] of [["review", "REVIEW", "review"], ["plan check (PLAN_CRITIQUE)", "PLAN", "plan_check"]] as const) {
    it(`${label}: the tool is absent, the read result is the file alone, and the stage is ${stage}`, async () => {
      const seen = await runTurn({ mode, at: "base-commit" });
      expect(seen.loadedStage).toBe(stage);
      expect(seen.tools).toEqual(expect.arrayContaining(["read"]));
      expect(seen.tools).not.toContain("read_knowledge");
      expect(seen.systemPrompt).not.toContain("read_knowledge");
      expect(seen.lastToolResult).toContain("export const a = 1;");
      // Nothing was appended to the read: no rule text, no "team rules that apply" frame.
      expect(seen.lastToolResult).not.toMatch(/team rules that apply|NESTED UI RULES|UI PATTERN RULES/u);
    });
  }

  it("the same session as a build is different: the tool is offered and the nested and pattern rules are appended to the read (positive control)", async () => {
    const seen = await runTurn({ mode: "IMPLEMENT", at: "working-tree" });
    expect(seen.loadedStage).toBe("build");
    expect(seen.tools).toContain("read_knowledge");
    expect(seen.systemPrompt).toContain("read_knowledge");
    expect(seen.lastToolResult).toContain("team rules that apply to repo/engine/src/ui/a.tsx");
    expect(seen.lastToolResult).toContain("NESTED UI RULES");
    expect(seen.lastToolResult).toContain("UI PATTERN RULES");
  });
});
