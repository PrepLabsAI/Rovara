import { describe, expect, it } from "vitest";
import { knowledgeExtension } from "../../packages/worker/src/knowledge/extension.js";
import { MAX_MID_RUN_RESOLVES, MidRunKnowledge } from "../../packages/worker/src/knowledge/session.js";
import { resolveKnowledge, type FileInPlay, type KnowledgeSourceEntry } from "../../packages/worker/src/knowledge/resolve.js";
import { memoryKnowledgeSource } from "../../packages/worker/src/knowledge/source.js";
import { readKnowledgeTool } from "../../packages/worker/src/read-knowledge-tool.js";
import type { KnowledgeStage } from "../../packages/worker/src/knowledge/model.js";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/** The factory of the object form of an inline extension (the form `knowledgeExtension` returns). */
const factoryOf = (extension: InlineExtension) => (extension as Extract<InlineExtension, { factory: unknown }>).factory as (pi: unknown) => void;

const FILES = {
  "AGENTS.md": "root rules",
  "src/match/AGENTS.md": "nested match rules",
  "src/ui/AGENTS.md": "nested ui rules",
  ".cursor/rules/ui.mdc": "---\nglobs: src/ui/**\n---\nUI pattern rules",
  ".kiro/steering/oncall.md": "---\ninclusion: manual\n---\nOncall runbook text",
  ".kiro/steering/api.md": "---\ninclusion: auto\nname: api-design\ndescription: REST rules\n---\nAPI design text",
};

async function start(stage: KnowledgeStage, filesInPlay: FileInPlay[] = [], files: Record<string, string> = FILES) {
  let resolves = 0;
  const entries = (): KnowledgeSourceEntry[] => [{ name: "engine", path: "repo/engine", layer: "repo", source: memoryKnowledgeSource(files, "working") }];
  const initial = await resolveKnowledge({ stage, sources: entries(), filesInPlay });
  const session = new MidRunKnowledge({
    stage, initial, filesInPlay, rendering: [{ name: "engine", path: "repo/engine" }], rootPath: "/ws",
    resolveAgain: async (inPlay) => { resolves += 1; return resolveKnowledge({ stage, sources: entries(), filesInPlay: inPlay }); },
  });
  return { session, resolves: () => resolves, initial };
}

describe("mid-run knowledge", () => {
  it("appends a nested file and a matching pattern rule the first time a path under them is touched, and only once", async () => {
    const { session } = await start("build");
    const first = await session.onPathTouched("repo/engine/src/ui/button.tsx");
    expect(first).toContain("nested ui rules");
    expect(first).toContain("UI pattern rules");
    expect(first).toContain("team rules that apply to repo/engine/src/ui/button.tsx");
    expect(first).not.toContain("nested match rules");
    expect(await session.onPathTouched("repo/engine/src/ui/other.tsx")).toBeUndefined();
    expect(await session.onPathTouched("repo/engine/src/ui/button.tsx")).toBeUndefined();
    const records = session.allRecords();
    expect(records.find((record) => record.path === "src/ui/AGENTS.md")).toMatchObject({ status: "loaded", why: { kind: "matched", detail: "src/ui/button.tsx" } });
    expect(records.find((record) => record.path === ".cursor/rules/ui.mdc")).toMatchObject({ status: "loaded" });
    expect(records.filter((record) => record.path === "src/ui/AGENTS.md")).toHaveLength(1);
  });

  it("does not read the rule sources again for a path that cannot bring a rule in", async () => {
    const { session, resolves } = await start("build", [{ repo: "engine", path: "src/a.ts" }], { "AGENTS.md": "root" });
    expect(await session.onPathTouched("repo/engine/README.md")).toBeUndefined();
    expect(resolves()).toBe(0);
  });

  it("accepts workspace-absolute paths and ignores paths outside every repository", async () => {
    const { session } = await start("build");
    expect(await session.onPathTouched("/ws/repo/engine/src/match/rank.py")).toContain("nested match rules");
    expect(await session.onPathTouched("/etc/passwd")).toBeUndefined();
    expect(await session.onPathTouched("../x/AGENTS.md")).toBeUndefined();
    expect(await session.onPathTouched("repo/engine/../other/a.ts")).toBeUndefined();
    expect(session.locate("repo/enginex/a.ts")).toBeUndefined();
  });

  it("loads nothing mid-run in a judging stage, and offers no tool there", async () => {
    for (const stage of ["review", "plan_check"] as const) {
      const { session, resolves } = await start(stage);
      expect(session.allowsMidRun).toBe(false);
      expect(session.offersTool).toBe(false);
      expect(await session.onPathTouched("repo/engine/src/ui/button.tsx")).toBeUndefined();
      expect(session.readByName("oncall")).toEqual({ error: "Rules are not loaded by name in this stage." });
      expect(resolves()).toBe(0);
    }
  });

  it("stays inside the additions budget and records the refusal", async () => {
    const big = { "AGENTS.md": "root", "a/AGENTS.md": "x".repeat(60 * 1024), "b/AGENTS.md": "y".repeat(60 * 1024), "c/AGENTS.md": "z".repeat(60 * 1024) };
    const { session } = await start("build", [], big);
    await session.onPathTouched("repo/engine/a/f.ts");
    await session.onPathTouched("repo/engine/b/f.ts");
    const third = await session.onPathTouched("repo/engine/c/f.ts");
    expect(third).toBeUndefined();
    const refused = session.allRecords().filter((record) => record.status === "skipped" && record.reason === "over_budget");
    expect(refused.map((record) => record.scopeDir)).toEqual(["c"]);
  });

  it("is bounded in how often it reads the sources", async () => {
    const files: Record<string, string> = { "AGENTS.md": "root" };
    for (let index = 0; index < MAX_MID_RUN_RESOLVES + 5; index += 1) files[`d${index}/AGENTS.md`] = "n";
    const { session, resolves } = await start("build", [], files);
    for (let index = 0; index < MAX_MID_RUN_RESOLVES + 5; index += 1) await session.onPathTouched(`repo/engine/d${index}/f.ts`);
    expect(resolves()).toBe(MAX_MID_RUN_RESOLVES);
  });

  it("serialises two tool results touching the same new folder at once", async () => {
    const { session } = await start("build");
    const [a, b] = await Promise.all([session.onPathTouched("repo/engine/src/ui/a.tsx"), session.onPathTouched("repo/engine/src/ui/b.tsx")]);
    expect([a, b].filter((value) => value !== undefined)).toHaveLength(1);
  });
});

describe("mid-run failures", () => {
  it("reports a failed re-read with a fixed sentence and records it", async () => {
    const diagnostics: string[] = [];
    const entries = (): KnowledgeSourceEntry[] => [{ name: "engine", path: "repo/engine", layer: "repo", source: memoryKnowledgeSource(FILES, "working") }];
    const initial = await resolveKnowledge({ stage: "build", sources: entries() });
    const session = new MidRunKnowledge({
      stage: "build", initial, filesInPlay: [], rendering: [{ name: "engine", path: "repo/engine" }], rootPath: "/ws",
      onDiagnostic: (message) => diagnostics.push(message),
      resolveAgain: () => Promise.reject(new Error("SECRET PATH /private")),
    });
    expect(await session.onPathTouched("repo/engine/src/ui/a.tsx")).toBeUndefined();
    expect(diagnostics).toEqual(["could not re-read the rule files for a file the agent opened"]);
    expect(session.allRecords().some((record) => record.status === "skipped" && record.reason === "unreadable")).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain("SECRET");
  });
});

describe("read_knowledge", () => {
  const run = async (session: MidRunKnowledge, name: string): Promise<string> => {
    const tool = readKnowledgeTool(session);
    const result = await tool.execute("id", { name }, undefined, undefined, undefined as never);
    return (result.content[0] as { text: string }).text;
  };

  it("loads a manual or an auto rule by name, once, and records why", async () => {
    const { session } = await start("build");
    expect(session.offersTool).toBe(true);
    expect(session.names()).toEqual(["api-design", "oncall"]);
    expect(await run(session, "API-Design")).toContain("API design text");
    expect(await run(session, "oncall")).toContain("Oncall runbook text");
    expect(await run(session, "oncall")).toContain("already loaded");
    expect(session.allRecords().find((record) => record.path === ".kiro/steering/oncall.md")).toMatchObject({ status: "loaded", why: { kind: "read_by_tool" } });
  });

  it("answers an unknown name without echoing control characters, and never treats a name as a path", async () => {
    const { session } = await start("build");
    expect(await run(session, "../../etc/passwd")).toBe("No rule called ../../etc/passwd.");
    expect(await run(session, "x‮y")).not.toContain("‮");
  });
});

describe("the extension", () => {
  function install(session: MidRunKnowledge) {
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
    const extension = knowledgeExtension(session);
    (factoryOf(extension))({ on: (name: string, handler: (event: unknown) => Promise<unknown>) => { handlers.set(name, handler); return () => undefined; } });
    return handlers.get("tool_result")!;
  }

  it("appends rules to a successful read, edit or write result and leaves other results alone", async () => {
    const { session } = await start("build");
    const handler = install(session);
    const result = await handler({ toolName: "read", isError: false, input: { path: "repo/engine/src/ui/a.tsx" }, content: [{ type: "text", text: "file text" }] }) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toBe("file text");
    expect(result.content[1]!.text).toContain("nested ui rules");
    expect(await handler({ toolName: "bash", isError: false, input: { path: "repo/engine/src/match/a.py" }, content: [] })).toBeUndefined();
    expect(await handler({ toolName: "read", isError: true, input: { path: "repo/engine/src/match/a.py" }, content: [] })).toBeUndefined();
    expect(await handler({ toolName: "read", isError: false, input: {}, content: [] })).toBeUndefined();
  });

  it("reports a failure to load and leaves the result as it was", async () => {
    const { session } = await start("build");
    const diagnostics: string[] = [];
    const broken = { onPathTouched: () => Promise.reject(new Error("PRIVATE PATH /x")) } as unknown as MidRunKnowledge;
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
    (factoryOf(knowledgeExtension(broken, (message) => diagnostics.push(message))))({ on: (name: string, handler: (event: unknown) => Promise<unknown>) => { handlers.set(name, handler); return () => undefined; } });
    expect(await handlers.get("tool_result")!({ toolName: "read", isError: false, input: { path: "a" }, content: [] })).toBeUndefined();
    expect(diagnostics).toEqual(["could not load the rules for a file the agent opened"]);
    void session;
  });
});
