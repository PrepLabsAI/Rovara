import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMPANY_RULES_EXCEED_BUDGET_MESSAGE, externalRuleItem, resolveKnowledge, type KnowledgeSourceEntry, type ResolveKnowledgeInput } from "../../packages/worker/src/knowledge/resolve.js";
import { createReaderRegistry } from "../../packages/worker/src/knowledge/registry.js";
import { memoryKnowledgeSource } from "../../packages/worker/src/knowledge/source.js";
import { DEFAULT_KNOWLEDGE_BUDGETS } from "../../packages/worker/src/knowledge/model.js";

const repo = (files: Record<string, string | { symlink: true }>, extra: Partial<KnowledgeSourceEntry> = {}): KnowledgeSourceEntry => ({
  name: "SvcEngine", path: "repo/engine", layer: "repo", source: memoryKnowledgeSource(files, "base"), ...extra,
});
const meta = (files: Record<string, string>): KnowledgeSourceEntry => ({
  name: "service-meta", path: "repo/meta", layer: "meta", source: memoryKnowledgeSource(files, "knowledgeCommit"),
});
const resolve = (stage: ResolveKnowledgeInput["stage"], sources: KnowledgeSourceEntry[], extra: Partial<ResolveKnowledgeInput> = {}) => resolveKnowledge({ stage, sources, ...extra });
const paths = (result: Awaited<ReturnType<typeof resolveKnowledge>>) => result.items.map((item) => `${item.repo ?? item.layer}:${item.path ?? item.name}`);
const record = (result: Awaited<ReturnType<typeof resolveKnowledge>>, path: string) => result.records.find((entry) => entry.path === path);

const META_FILES = {
  "AGENTS.md": "meta agents",
  ".kiro/steering/product.md": "---\ninclusion: always\n---\nProduct text",
  ".kiro/steering/python-style.md": '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.py"\n---\nPython style',
  ".kiro/steering/oncall.md": "---\ninclusion: manual\n---\nOncall runbook",
  ".kiro/steering/api.md": "---\ninclusion: auto\nname: api-design\ndescription: REST rules\n---\nAPI rules",
};
const CODE_FILES = {
  "AGENTS.md": "root agents",
  "src/match/AGENTS.md": "nested agents",
  ".cursor/rules/ui.mdc": "---\nglobs: src/ui/**\n---\nUI rules",
  ".kiro/hooks/lint.json": "{}",
  "src/match/rank.py": "x",
};

describe("resolveKnowledge: the design's example", () => {
  it("loads always rules, matched fileMatch rules and nested files, and lists the rest with reasons", async () => {
    const result = await resolve("plan", [meta(META_FILES), repo(CODE_FILES)], { filesInPlay: [{ repo: "SvcEngine", path: "src/match/rank.py" }] });
    expect(paths(result)).toEqual([
      "service-meta:.kiro/steering/product.md", "service-meta:.kiro/steering/python-style.md", "service-meta:AGENTS.md",
      "SvcEngine:AGENTS.md", "SvcEngine:src/match/AGENTS.md",
    ]);
    expect(record(result, ".kiro/steering/python-style.md")).toMatchObject({ status: "loaded", why: { kind: "matched", detail: "src/match/rank.py" }, layer: "meta" });
    expect(record(result, "src/match/AGENTS.md")).toMatchObject({ status: "loaded", layer: "folder", why: { kind: "matched" } });
    expect(record(result, ".kiro/steering/oncall.md")).toMatchObject({ status: "skipped", reason: "not_requested" });
    expect(record(result, ".cursor/rules/ui.mdc")).toMatchObject({ status: "skipped", reason: "not_matched" });
    expect(record(result, ".kiro/hooks/lint.json")).toMatchObject({ status: "skipped", reason: "found_not_run" });
    expect(record(result, ".kiro/steering/api.md")).toMatchObject({ status: "available" });
    expect(result.autoCatalog).toEqual([{ name: "api-design", description: "REST rules", repo: "service-meta", path: ".kiro/steering/api.md" }]);
    expect(result.items.every((item) => /^[0-9a-f]{64}$/u.test(item.digest))).toBe(true);
    expect(result.items.find((item) => item.path === ".kiro/steering/product.md")?.readAt).toBe("knowledgeCommit");
  });

  it("finds a nested AGENTS.md only for folders on the way to a file in play", async () => {
    const none = await resolve("plan", [repo(CODE_FILES)]);
    expect(paths(none)).toEqual(["SvcEngine:AGENTS.md"]);
    const elsewhere = await resolve("plan", [repo(CODE_FILES)], { filesInPlay: [{ repo: "SvcEngine", path: "src/other/x.ts" }] });
    expect(paths(elsewhere)).toEqual(["SvcEngine:AGENTS.md"]);
  });

  it("applies a meta repo's pattern rule to every repository's files, by the path in that repository", async () => {
    const result = await resolve("build", [meta(META_FILES), repo(CODE_FILES)], { filesInPlay: [{ repo: "SvcEngine", path: "lib/a.py" }] });
    expect(record(result, ".kiro/steering/python-style.md")?.status).toBe("loaded");
    // A code repo's own pattern rule matches only its own repository's files.
    const other = await resolve("build", [repo({ ".cursor/rules/ui.mdc": "---\nglobs: src/ui/**\n---\nUI" })], { filesInPlay: [{ repo: "OtherRepo", path: "src/ui/a.tsx" }] });
    expect(record(other, ".cursor/rules/ui.mdc")?.status).toBe("skipped");
  });
});

describe("resolveKnowledge: activation modes", () => {
  it("loads a manual rule when it is named and says why", async () => {
    const result = await resolve("plan", [meta(META_FILES)], { manualNames: new Set(["oncall"]) });
    expect(record(result, ".kiro/steering/oncall.md")).toMatchObject({ status: "loaded", why: { kind: "named", detail: "oncall" } });
    expect(result.manualItems.has("oncall")).toBe(false);
  });

  it("keeps a manual rule that was not named available for later", async () => {
    const result = await resolve("plan", [meta(META_FILES)]);
    expect(result.manualItems.get("oncall")?.text).toBe("Oncall runbook");
  });

  it("lists auto rules for the model in Understand, Plan and Build; judging stages load the plan's set plus rules the diff hits", async () => {
    const build = await resolve("build", [meta(META_FILES)]);
    expect(build.autoCatalog.map((entry) => entry.name)).toEqual(["api-design"]);
    expect(build.autoItems.get("api-design")?.text).toBe("API rules");
    // The plan's set is known and does not name the rule: a judging stage does not load it (nothing in the diff hits it).
    const unplanned = await resolve("review", [meta(META_FILES)], { plannedAuto: new Set(["something-else"]) });
    expect(unplanned.autoCatalog).toEqual([]);
    expect(record(unplanned, ".kiro/steering/api.md")).toMatchObject({ status: "skipped", reason: "not_in_plan_set" });
    const reviewWithPlan = await resolve("review", [meta(META_FILES)], { plannedAuto: new Set(["api-design"]) });
    expect(record(reviewWithPlan, ".kiro/steering/api.md")).toMatchObject({ status: "loaded" });
    const checkWithPlan = await resolve("plan_check", [meta(META_FILES)], { plannedAuto: new Set(["API-Design"]) });
    expect(record(checkWithPlan, ".kiro/steering/api.md")?.status).toBe("loaded");
  });

  it("a judging stage that does not know the plan's set loads every auto rule, so a steered planner cannot hide one (meta Q9)", async () => {
    for (const stage of ["review", "plan_check"] as const) {
      const result = await resolve(stage, [meta(META_FILES)]);
      expect(record(result, ".kiro/steering/api.md")).toMatchObject({ status: "loaded" });
    }
  });

  it("leaves a Copilot rule out of the stages its excludeAgent names", async () => {
    const files = { ".github/instructions/a.instructions.md": '---\napplyTo: "**"\nexcludeAgent: "code-review"\n---\nNot for reviewers' };
    const filesInPlay = [{ repo: "SvcEngine", path: "a.ts" }];
    expect(record(await resolve("review", [repo(files)], { filesInPlay }), ".github/instructions/a.instructions.md")).toMatchObject({ status: "skipped", reason: "excluded_stage" });
    expect(record(await resolve("plan_check", [repo(files)], { filesInPlay }), ".github/instructions/a.instructions.md")?.reason).toBe("excluded_stage");
    expect(record(await resolve("build", [repo(files)], { filesInPlay }), ".github/instructions/a.instructions.md")?.status).toBe("loaded");
  });
});

describe("resolveKnowledge: AGENTS.md and CLAUDE.md", () => {
  it("lets AGENTS.override.md replace AGENTS.md and loads CLAUDE.md beside AGENTS.md", async () => {
    const result = await resolve("plan", [repo({ "AGENTS.md": "plain", "AGENTS.override.md": "override", "CLAUDE.md": "claude" })]);
    expect(result.items.map((item) => item.text)).toEqual(["override", "claude"]);
    expect(record(result, "AGENTS.md")).toMatchObject({ status: "skipped", reason: "overridden" });
  });

  it("does not repeat AGENTS.md when CLAUDE.md imports it", async () => {
    const result = await resolve("plan", [repo({ "AGENTS.md": "agents text", "CLAUDE.md": "@AGENTS.md\nmore" })]);
    const claude = result.items.find((item) => item.path === "CLAUDE.md");
    expect(claude?.text).toContain("[Already included: AGENTS.md]");
    expect(claude?.text.match(/agents text/gu)).toBeNull();
    expect(result.items.find((item) => item.path === "AGENTS.md")?.text).toBe("agents text");
  });

  it("follows Kiro file references inside the same repository and counts them in the item's size", async () => {
    const result = await resolve("plan", [repo({ ".kiro/steering/a.md": "See #[[file:docs/api.md]] now", "docs/api.md": "API DOC" })]);
    const item = result.items[0]!;
    expect(item.text).toContain("API DOC");
    expect(item.bytes).toBe(Buffer.byteLength(item.text, "utf8"));
  });
});

describe("resolveKnowledge: what is skipped and why", () => {
  it("skips a file with bad front matter, lists it, and runs the stage", async () => {
    const result = await resolve("plan", [repo({ ".kiro/steering/bad.md": "---\ninclusion: nope\n---\nx", ".kiro/steering/ok.md": "fine" })]);
    expect(record(result, ".kiro/steering/bad.md")).toMatchObject({ status: "skipped", reason: "bad_front_matter" });
    expect(paths(result)).toEqual(["SvcEngine:.kiro/steering/ok.md"]);
  });

  it("skips a symbolic link and a file over 64 KiB", async () => {
    const result = await resolve("plan", [repo({ "AGENTS.md": { symlink: true }, "CLAUDE.md": "x".repeat(65_537) })]);
    expect(record(result, "AGENTS.md")).toMatchObject({ status: "skipped", reason: "symlink" });
    expect(record(result, "CLAUDE.md")).toMatchObject({ status: "skipped", reason: "too_large" });
    expect(result.items).toEqual([]);
  });

  it("removes hidden characters before reading front matter, and from the text", async () => {
    const result = await resolve("plan", [repo({ ".kiro/steering/a.md": "​---\ninclusion: manual\n---\nHid​den" })]);
    expect(record(result, ".kiro/steering/a.md")).toMatchObject({ reason: "not_requested" });
    expect(result.manualItems.get("a")?.text).toBe("Hidden");
    expect(result.diagnostics.some((line) => line.includes("hidden characters"))).toBe(true);
  });

  it("never puts text from a file into a diagnostic or a reason", async () => {
    const result = await resolve("plan", [repo({ ".kiro/steering/SECRET-NAME.md": "---\ninclusion: nope\n---\nSECRET-BODY" })]);
    expect(JSON.stringify([result.diagnostics, result.notices])).not.toContain("SECRET");
  });

  it("bounds how many rule files and folders it reads", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 250; index += 1) files[`.kiro/steering/r${String(index).padStart(3, "0")}.md`] = "x";
    const result = await resolve("plan", [repo(files)]);
    expect(result.records.length).toBeLessThanOrEqual(200);
    expect(result.diagnostics).toContain("too many rule files: the first ones were read");
  });
});

describe("resolveKnowledge: budgets", () => {
  const big = (kind: string) => `${kind}${"x".repeat(40 * 1024)}`;

  it("drops the farthest items first and lists every drop", async () => {
    // Always-on: meta and repo files together are about 160 KiB, so the repo-level files (the farther layer) go before the meta one.
    const metaFiles = { "AGENTS.md": big("meta") };
    const files = { "AGENTS.md": big("repo"), ".kiro/steering/a.md": big("steer"), ".kiro/steering/b.md": big("steer2") };
    const result = await resolve("plan", [meta(metaFiles), repo(files)]);
    const skipped = result.records.filter((entry) => entry.status === "skipped" && entry.reason === "over_budget");
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.layer).toBe("repo");
    expect(record(result, "AGENTS.md")).toBeDefined();
    expect(result.items.some((item) => item.layer === "meta")).toBe(true);
    expect(result.budget.skipped).toBe(1);
    expect(result.budget.alwaysOnBytes).toBeLessThanOrEqual(DEFAULT_KNOWLEDGE_BUDGETS.alwaysOnBytes);
    for (const entry of skipped) expect(entry.path).toBeDefined();
  });

  it("fails closed when locked company rules alone exceed the budget", async () => {
    const company = externalRuleItem({ layer: "company", name: "Never log customer data", text: "y".repeat(130 * 1024), locked: true });
    await expect(resolve("plan", [], { external: [company] })).rejects.toThrow(COMPANY_RULES_EXCEED_BUDGET_MESSAGE);
  });

  it("never drops a locked company rule to make room", async () => {
    const company = externalRuleItem({ layer: "company", name: "Never log customer data", text: "z".repeat(100 * 1024), locked: true });
    const result = await resolve("plan", [repo({ "AGENTS.md": "w".repeat(60 * 1024) })], { external: [company] });
    expect(result.items.some((item) => item.locked === true)).toBe(true);
    expect(record(result, "AGENTS.md")).toMatchObject({ status: "skipped", reason: "over_budget" });
    expect(result.records.find((entry) => entry.locked === true)).toMatchObject({ status: "loaded", why: { kind: "required" } });
  });

  it("budgets fileMatch additions apart from always-on rules", async () => {
    const files: Record<string, string> = { "AGENTS.md": "a".repeat(60 * 1024), "CLAUDE.md": "c".repeat(60 * 1024) };
    for (let index = 0; index < 4; index += 1) files[`.claude/rules/p${index}.md`] = `---\npaths: ["**/*.ts"]\n---\n${"b".repeat(40 * 1024)}`;
    const result = await resolve("build", [repo(files)], { filesInPlay: [{ repo: "SvcEngine", path: "a.ts" }] });
    expect(record(result, "AGENTS.md")?.status).toBe("loaded");
    expect(record(result, "CLAUDE.md")?.status).toBe("loaded");
    // Four 40 KiB pattern rules do not fit the 128 KiB additions budget, whatever the always-on files use.
    expect(result.records.filter((entry) => entry.path?.startsWith(".claude/rules/") && entry.status === "skipped").length).toBe(1);
  });
});

describe("resolveKnowledge: the change under judgement edits a rule file", () => {
  it("tells a judge about an edited, added or removed rule file, and never loads the working tree's text", async () => {
    const base = memoryKnowledgeSource({ "AGENTS.md": "base rule", ".kiro/steering/old.md": "old" }, "base");
    const working = memoryKnowledgeSource({ "AGENTS.md": "EDITED rule", ".cursor/rules/new.mdc": "---\nalwaysApply: true\n---\nnew" }, "working");
    const result = await resolve("review", [{ name: "payments", path: "repo/payments", layer: "repo", source: base, compareWith: working }]);
    expect(result.items.map((item) => item.text).toSorted()).toEqual(["base rule", "old"]);
    expect(result.items.some((item) => item.text.includes("EDITED") || item.text === "new")).toBe(false);
    expect(result.notices).toEqual([
      "This change edits .cursor/rules/new.mdc of payments. Review that edit as code; the rules above are the ones from before the change.",
      "This change edits .kiro/steering/old.md of payments. Review that edit as code; the rules above are the ones from before the change.",
      "This change edits AGENTS.md of payments. Review that edit as code; the rules above are the ones from before the change.",
    ]);
  });

  it("says nothing when the rule files are unchanged", async () => {
    const files = { "AGENTS.md": "same", ".kiro/steering/a.md": "same too" };
    const result = await resolve("review", [{ name: "payments", path: "p", layer: "repo", source: memoryKnowledgeSource(files, "base"), compareWith: memoryKnowledgeSource(files, "working") }]);
    expect(result.notices).toEqual([]);
  });
});

describe("resolveKnowledge: stacking order", () => {
  it("orders company, project, meta, repo and folder, the closest last", async () => {
    const result = await resolve("plan", [meta({ "AGENTS.md": "m" }), repo({ "AGENTS.md": "r", "src/AGENTS.md": "f" })], {
      external: [externalRuleItem({ layer: "project", name: "p", text: "p" }), externalRuleItem({ layer: "company", name: "c", text: "c", locked: true })],
      filesInPlay: [{ repo: "SvcEngine", path: "src/a.ts" }],
    });
    expect(result.items.map((item) => item.layer)).toEqual(["company", "project", "meta", "repo", "folder"]);
  });
});


describe("resolveKnowledge: hidden characters in the expanded text", () => {
  it("removes zero-width and bidi characters from imported text and from folder listing names", async () => {
    const result = await resolve("plan", [repo({
      ".kiro/steering/a.md": "Docs: #[[folder:docs]]\nSee #[[file:notes.md]]",
      "docs/x\u200B\u202Eevil.md": "n", "docs/ok.md": "n", "notes.md": "Note\u200B text",
    })]);
    const text = result.items[0]!.text;
    expect(text).toContain("- ok.md");
    expect(text).toContain("- xevil.md");
    expect(text).toContain("Note text");
    expect(text).not.toMatch(/[\u200B\u202E]/u);
    expect(result.items[0]!.digest).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});

describe("resolveKnowledge: nested folders with glob characters", () => {
  it("loads a nested AGENTS.md in a folder named app/[id], (group) or {x}", async () => {
    const files = { "app/[id]/AGENTS.md": "dynamic route rules", "app/(group)/AGENTS.md": "group rules", "lib/{x}/CLAUDE.md": "brace rules", "app/i/AGENTS.md": "other" };
    const result = await resolve("build", [repo(files)], { filesInPlay: [
      { repo: "SvcEngine", path: "app/[id]/page.tsx" }, { repo: "SvcEngine", path: "app/(group)/p.tsx" }, { repo: "SvcEngine", path: "lib/{x}/a.ts" },
    ] });
    expect(result.items.map((item) => item.text).toSorted()).toEqual(["brace rules", "dynamic route rules", "group rules"]);
    // The bracket folder is a literal: it does not match the folder `app/i`.
    const other = await resolve("build", [repo(files)], { filesInPlay: [{ repo: "SvcEngine", path: "app/i/page.tsx" }] });
    expect(other.items.map((item) => item.text)).toEqual(["other"]);
  });
});

describe("resolveKnowledge: hooks come from the readers", () => {
  it("finds hooks in the folders a reader names, and nowhere else", async () => {
    const result = await resolve("plan", [repo({ ".kiro/hooks/a.json": "{}", "hooks/b.json": "{}" })]);
    expect(result.records.filter((entry) => entry.reason === "found_not_run").map((entry) => entry.path)).toEqual([".kiro/hooks/a.json"]);
  });
});

describe("resolveKnowledge: judging stages add auto rules the diff hits", () => {
  const patterned = {
    id: "patterned", discovery: { directories: ["rules"] },
    accepts: (path: string) => path.startsWith("rules/"),
    parse: (path: string, text: string) => ({ ok: true as const, value: { activation: "auto" as const, name: path.slice(6), description: "d", patterns: ["**/*.sql"], body: text, imports: "none" as const } }),
  };
  it("loads a patterned auto rule when the diff hits it even if the plan's set left it out, and not otherwise", async () => {
    const registry = createReaderRegistry([patterned]);
    const files = { "rules/sec": "security rule" };
    const hit = await resolve("review", [repo(files)], { registry, plannedAuto: new Set(), filesInPlay: [{ repo: "SvcEngine", path: "db/q.sql" }] });
    expect(record(hit, "rules/sec")).toMatchObject({ status: "loaded", why: { kind: "matched", detail: "db/q.sql" } });
    const miss = await resolve("review", [repo(files)], { registry, plannedAuto: new Set(), filesInPlay: [{ repo: "SvcEngine", path: "a.ts" }] });
    expect(record(miss, "rules/sec")).toMatchObject({ status: "skipped", reason: "not_in_plan_set" });
  });
});
