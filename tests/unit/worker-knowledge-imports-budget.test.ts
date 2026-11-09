import { describe, expect, it } from "vitest";
import { applyBudget, dropOrder, fitPool } from "../../packages/worker/src/knowledge/budget.js";
import { expandImports, resolveRepositoryPath, type ImportRead } from "../../packages/worker/src/knowledge/imports.js";
import { DEFAULT_KNOWLEDGE_BUDGETS, type KnowledgeItem, type KnowledgeLayer } from "../../packages/worker/src/knowledge/model.js";

const files = (map: Record<string, string>) => async (path: string): Promise<ImportRead> => (path in map ? { kind: "file", text: map[path]! } : { kind: "missing" });

describe("resolveRepositoryPath", () => {
  it("joins and normalises, and refuses anything that leaves the repository", () => {
    expect(resolveRepositoryPath("docs", "a.md")).toBe("docs/a.md");
    expect(resolveRepositoryPath("docs/x", "../a.md")).toBe("docs/a.md");
    expect(resolveRepositoryPath("", "./a.md")).toBe("a.md");
    expect(resolveRepositoryPath("docs", "../../a.md")).toBeUndefined();
    expect(resolveRepositoryPath("", "/etc/passwd")).toBeUndefined();
    expect(resolveRepositoryPath("", "~/.ssh/id")).toBeUndefined();
    expect(resolveRepositoryPath("", "file:///x")).toBeUndefined();
    expect(resolveRepositoryPath("", "a\\b")).toBeUndefined();
  });
});

describe("imports", () => {
  it("follows Claude-style @imports from the importing file's folder, not in code", async () => {
    const result = await expandImports({
      text: "See @docs/style.md for style.\nNot `@docs/no.md` here.\n```\n@docs/fenced.md\n```\nMention @alice stays.",
      path: "CLAUDE.md", style: "claude", maxDepth: 4, budgetBytes: 10_000,
      read: files({ "docs/style.md": "STYLE", "docs/no.md": "NO", "docs/fenced.md": "FENCED" }),
    });
    expect(result.text).toContain("[Imported from docs/style.md]\nSTYLE\n[End of docs/style.md]");
    expect(result.text).not.toContain("NO\n");
    expect(result.text).toContain("`@docs/no.md`");
    expect(result.text).toContain("@docs/fenced.md");
    expect(result.text).toContain("@alice stays");
    expect(result.imported).toEqual(["docs/style.md"]);
  });

  it("follows Kiro references from the repository root, with line ranges", async () => {
    const result = await expandImports({
      text: "A #[[file:src/a.ts:2-3]] B #[[file:README.md]] C #[[file:src/a.ts:2]]",
      path: ".kiro/steering/x.md", style: "kiro", maxDepth: 4, budgetBytes: 10_000,
      read: files({ "src/a.ts": "l1\nl2\nl3\nl4", "README.md": "READ" }),
    });
    expect(result.text).toContain("[Imported from src/a.ts]\nl2\nl3\n[End of src/a.ts]");
    expect(result.text).toContain("READ");
    // A second reference to a file that is already included is not repeated.
    expect(result.text).toContain("[Already included: src/a.ts]");
    expect(result.imported).toEqual(["src/a.ts", "README.md"]);
  });

  it("lists a folder reference instead of reading it", async () => {
    const result = await expandImports({
      text: "#[[folder:docs]]", path: "a.md", style: "kiro", maxDepth: 4, budgetBytes: 10_000,
      read: files({}), listDirectory: async () => ["a.md", "b.md"],
    });
    expect(result.text).toBe("[Folder docs]\n- a.md\n- b.md\n[End of docs]");
  });

  it("stops at depth 4 and at a cycle", async () => {
    const chain = { "a1.md": "@a2.md", "a2.md": "@a3.md", "a3.md": "@a4.md", "a4.md": "@a5.md", "a5.md": "FIVE" };
    const deep = await expandImports({ text: "@a1.md", path: "root.md", style: "claude", maxDepth: 4, budgetBytes: 10_000, read: files(chain) });
    expect(deep.imported).toEqual(["a1.md", "a2.md", "a3.md", "a4.md"]);
    expect(deep.issues).toEqual([{ path: "a5.md", code: "too_deep" }]);
    expect(deep.text).not.toContain("FIVE");
    const cycle = await expandImports({ text: "@a.md", path: "root.md", style: "claude", maxDepth: 4, budgetBytes: 10_000, read: files({ "a.md": "@b.md", "b.md": "@a.md" }) });
    expect(cycle.imported).toEqual(["a.md", "b.md"]);
    expect(cycle.text).toContain("[Already included: a.md]");
  });

  it("does not repeat a file the context already holds (CLAUDE.md that imports AGENTS.md)", async () => {
    const result = await expandImports({
      text: "@AGENTS.md", path: "CLAUDE.md", style: "claude", maxDepth: 4, budgetBytes: 10_000,
      alreadyIncluded: new Set(["AGENTS.md"]), read: files({ "AGENTS.md": "AGENTS" }),
    });
    expect(result.text).toBe("[Already included: AGENTS.md]");
    expect(result.imported).toEqual([]);
  });

  it("leaves a reference that leaves the repository, is absolute or is missing as written", async () => {
    const result = await expandImports({
      text: "@../../outside.md @/etc/hosts @missing.md",
      path: "docs/CLAUDE.md", style: "claude", maxDepth: 4, budgetBytes: 10_000, read: files({}),
    });
    expect(result.text).toBe("@../../outside.md @/etc/hosts @missing.md");
    expect(result.issues.map((issue) => issue.code)).toEqual(["outside_repository", "outside_repository", "missing"]);
  });

  it("counts imported text in the budget and leaves the rest unexpanded", async () => {
    const result = await expandImports({
      text: "@one.md @two.md", path: "CLAUDE.md", style: "claude", maxDepth: 4, budgetBytes: 100,
      read: files({ "one.md": "x".repeat(60), "two.md": "y".repeat(60) }),
    });
    expect(result.imported).toEqual(["one.md"]);
    expect(result.issues).toEqual([{ path: "two.md", code: "over_budget" }]);
    expect(result.text).toContain("@two.md");
    expect(result.addedBytes).toBeLessThanOrEqual(100);
  });

  it("removes hidden characters from imported text and reports a file that is too large", async () => {
    const hidden = await expandImports({ text: "@a.md", path: "CLAUDE.md", style: "claude", maxDepth: 4, budgetBytes: 1000, read: files({ "a.md": "ok​hidden" }) });
    expect(hidden.text).toContain("okhidden");
    const large = await expandImports({ text: "@a.md", path: "CLAUDE.md", style: "claude", maxDepth: 4, budgetBytes: 1000, read: async () => ({ kind: "too_large" }) });
    expect(large.issues).toEqual([{ path: "a.md", code: "too_large" }]);
  });

  it("does nothing for a format with no imports", async () => {
    const result = await expandImports({ text: "@a.md #[[file:a.md]]", path: "AGENTS.md", style: "none", maxDepth: 4, budgetBytes: 1000, read: files({ "a.md": "A" }) });
    expect(result.text).toBe("@a.md #[[file:a.md]]");
  });

  it("bounds the references followed from one file", async () => {
    const lines = Array.from({ length: 100 }, (_unused, index) => `@f${index}.md`).join("\n");
    const result = await expandImports({ text: lines, path: "CLAUDE.md", style: "claude", maxDepth: 4, budgetBytes: 1_000_000, read: async () => ({ kind: "file", text: "x" }) });
    expect(result.imported.length).toBe(64);
    expect(result.issues.some((issue) => issue.code === "too_many")).toBe(true);
  });
});

const item = (layer: KnowledgeLayer, path: string, bytes: number, extra: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
  layer, path, scopeDir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", format: "x", activation: "always",
  bytes, digest: "d", readAt: "base", text: "", ...extra,
});

describe("budget", () => {
  it("drops folder before repo before meta, deeper first, and never a locked rule", () => {
    const items = [
      item("company", "rules/company", 40, { locked: true }),
      item("meta", "AGENTS.md", 40),
      item("repo", "AGENTS.md", 40),
      item("folder", "src/AGENTS.md", 40),
      item("folder", "src/deep/er/AGENTS.md", 40),
    ];
    expect(dropOrder(items).map((entry) => entry.path)).toEqual(["src/deep/er/AGENTS.md", "src/AGENTS.md", "AGENTS.md", "AGENTS.md"]);
    const fitted = fitPool(items, 100);
    // 200 bytes in a 100-byte pool: the deepest folder, the other folder and then the repo file go; meta and the locked rule stay.
    expect(fitted.dropped.map((entry) => `${entry.layer}:${entry.path}`)).toEqual(["repo:AGENTS.md", "folder:src/AGENTS.md", "folder:src/deep/er/AGENTS.md"]);
    expect(fitted.kept.map((entry) => entry.layer)).toEqual(["company", "meta"]);
    expect(fitted.kept.some((entry) => entry.locked === true)).toBe(true);
    expect(fitted.bytes).toBeLessThanOrEqual(100);
  });

  it("is deterministic and keeps everything that fits", () => {
    const items = [item("repo", "a", 10), item("repo", "b", 10)];
    expect(fitPool(items, 20).dropped).toEqual([]);
    expect(fitPool(items, 19).dropped.map((entry) => entry.path)).toEqual(["b"]);
  });

  it("reports locked rules that alone exceed the budget", () => {
    const fitted = fitPool([item("company", "c", 200, { locked: true }), item("repo", "r", 10)], 100);
    expect(fitted.lockedOverflow).toBe(true);
    expect(fitted.kept.map((entry) => entry.path)).toEqual(["c"]);
  });

  it("keeps the always-on pool and the additions pool apart", () => {
    const budgets = { ...DEFAULT_KNOWLEDGE_BUDGETS, alwaysOnBytes: 50, additionsBytes: 50 };
    const result = applyBudget([item("repo", "a", 50), item("repo", "m", 50, { activation: "fileMatch" }), item("folder", "f", 50, { activation: "manual" })], budgets);
    expect(result.alwaysOn.dropped).toEqual([]);
    expect(result.additions.dropped.map((entry) => entry.path)).toEqual(["f"]);
  });
});
