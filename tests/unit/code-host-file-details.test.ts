import { describe, expect, it } from "vitest";
import * as contracts from "../../packages/contracts/src/plugins/code-host.js";
import * as plugins from "../../packages/contracts/src/plugins/index.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { assertTwoCompanyIsolation, attempt, TWO_COMPANIES } from "../../packages/testing/src/isolation/two-company.js";
import { routeByCompany } from "../../packages/testing/src/isolation/company-router.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";

const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" } as const;
const repository = { url: "https://host.example.test/example/app" };
const baseFile = { path: "a", status: "modified", additions: 1, deletions: 1 };

describe("file entry contract", () => {
  it("accepts old stored values unchanged, accepts all types and rejects guessed or extra fields", () => {
    expect(contracts.ChangeRequestFileSchema.parse(baseFile)).toEqual(baseFile);
    for (const type of ["file", "executable", "symlink", "submodule", "none"]) {
      expect(contracts.ChangeRequestFileSchema.safeParse({ ...baseFile, entry: { head: type, base: type } }).success).toBe(true);
    }
    for (const entry of [{ head: "dir", base: "file" }, { head: "file" }, { head: "file", base: "file", extra: true }]) {
      expect(contracts.ChangeRequestFileSchema.safeParse({ ...baseFile, entry }).success).toBe(false);
    }
  });
});

describe("instruction path matching", () => {
  it.each(["AGENTS.md", "nested/AGENTS.override.md", "AGENT.md", "Claude.md", "CLAUDE.local.md", "GEMINI.md", "WARP.md", "SKILL.md", ".cursorrules", ".windsurfrules", ".clinerules", ".goosehints", "pkg/.github/copilot-instructions.md", "./packages/api/AGENTS.md", "apps/web/.cursor/rules/x.mdc", ".github/instructions/a.md", ".github/prompts/a.md", ".github/chatmodes/a.md", ...[".cursor", ".claude", ".windsurf", ".clinerules", ".continue", ".agents", ".codex", ".openhands", ".kilocode", ".amazonq", ".kiro", ".gemini", ".roo", ".cline", ".trae", ".junie", ".rovara"].map(folder => `nested/${folder}/deep/file`)])("matches %s", path => {
    expect(plugins.isAiInstructionPath?.(path)).toBe(true);
  });
  it.each(["AGENTS.md.bak", "docs/agents.md.txt", "my.cursor/rule", "cursor/rules.md", "copilot-instructions.md", ".githubx/copilot-instructions.md", "notes.md", "foo\\AGENTS.md", ".cursor", ".github/instructions", "../AGENTS.md", "a//AGENTS.md", ".cursor\\x/AGENTS.md"])("rejects %s", path => {
    expect(plugins.isAiInstructionPath?.(path)).toBe(false);
  });
});

describe("fake file details", () => {
  it("uses the merge base, preserves types across edits and reports mode-only and type changes", async () => {
    const model = new FakeHostModel({ ...repository, id: "1", fullName: "example/app", initialFiles: { plain: "old", mode: "same", edit: "old", link: "old", gone: "old", rename: "unique" } });
    const host = new FakeCodeHost(model);
    model.commit("feature", { plain: "new", gone: null });
    model.commitExecutable("feature", "mode", "same");
    model.commitExecutable("feature", "edit", "new");
    model.commitSymlink("feature", "link");
    model.commitSubmodule("feature", "module", "a".repeat(40));
    model.commitRename("feature", "rename", "renamed");
    model.commit("main", { mode: "tip changed", unrelated: "tip only" });
    const { cr } = model.reconcile({ sourceBranch: "feature", targetBranch: "main", title: "types" });
    const page = await host.changedFiles({ repository, id: cr.id, url: model.crUrl(cr.id) }, 1, scope);
    expect(page.files.map(f => [f.path, f.entry])).toEqual(expect.arrayContaining([
      ["plain", { base: "file", head: "file" }], ["mode", { base: "file", head: "executable" }], ["edit", { base: "file", head: "executable" }],
      ["link", { base: "file", head: "symlink" }], ["module", { base: "none", head: "submodule" }], ["gone", { base: "file", head: "none" }], ["renamed", { base: "file", head: "file" }],
    ]));
    expect(page.files.some(f => f.path === "unrelated")).toBe(false);
    expect(page.files.find(f => f.path === "renamed")?.previousPath).toBe("rename");
    expect(page.files.every(f => f.patch === undefined)).toBe(true);
    model.commit("feature", { mode: "edited later" });
    expect(model.revision(model.headOf("feature")).entries.get("mode")).toBe("executable");
  });
  it("lists types with bounded, incomplete and failed reads", async () => {
    const model = new FakeHostModel({ ...repository, id: "1", fullName: "example/app", initialFiles: { "packages/AGENTS.md": "a", "AGENTS.md.bak": "b" } });
    const host = new FakeCodeHost(model);
    model.commitSymlink("main", ".cursor/link");
    const revision = model.commitSubmodule("main", ".agents/module", "a".repeat(40));
    expect(await host.instructionFiles(repository, revision, scope)).toEqual({ files: [
      { path: ".agents/module", type: "submodule" }, { path: ".cursor/link", type: "symlink" }, { path: "packages/AGENTS.md", type: "file" },
    ], complete: true });
    const capped = await host.instructionFiles(repository, revision, scope, { max: 2 });
    expect(capped.complete).toBe(false);
    expect(capped.files).toHaveLength(2);
    expect((await host.instructionFiles(repository, revision, scope, { max: 0 })).files).toEqual([]);
    model.incompleteTrees.add(revision);
    expect((await host.instructionFiles(repository, revision, scope)).complete).toBe(false);
    await expect(host.instructionFiles(repository, "f".repeat(40), scope)).rejects.toBeDefined();
    await expect(host.instructionFiles(repository, revision, scope, { max: NaN })).rejects.toBeDefined();
  });
});

it("keeps fake instruction and changed-file reads isolated through the two-company kit", async () => {
  const hosts = new Map(TWO_COMPANIES.map(company => [company.orgId, new FakeCodeHost(new FakeHostModel({ ...repository, id: "1", fullName: "example/app" }))]));
  const router = routeByCompany(hosts);
  await assertTwoCompanyIsolation({ surfaces: [{
    kind: "list", name: "instruction files and changed file entries",
    async plant(company) {
      const model = hosts.get(company.orgId)!.model;
      const revision = model.commit("feature", { [`${company.canary}/AGENTS.md`]: company.canary });
      const { ref } = await router.reconcileChangeRequest({ repository, sourceBranch: "feature", targetBranch: "main", title: "instructions" }, company.scope);
      return { handle: { revision, ref } };
    },
    async observe(company, planted) {
      const own = planted.own as { revision: string; ref: contracts.ChangeRequestRef };
      const other = planted.other as typeof own;
      const changed = await router.changedFiles(own.ref, 1, company.scope);
      expect(changed.files[0]?.entry).toEqual({ head: "file", base: "none" });
      return { changed, own: await router.instructionFiles(repository, own.revision, company.scope), other: await attempt(() => router.instructionFiles(repository, other.revision, company.scope)) };
    },
  }] });
});

it("replaces and deletes symlinks without leaving a stale entry type", async () => {
  const model = new FakeHostModel({ ...repository, id: "1", fullName: "example/app" });
  model.commitSymlink("main", "AGENTS.md");
  const replaced = model.commit("main", { "AGENTS.md": "text" });
  expect(model.revision(replaced).entries.get("AGENTS.md")).toBe("file");
  const deleted = model.commit("main", { "AGENTS.md": null });
  expect(model.revision(deleted).entries.has("AGENTS.md")).toBe(false);
});

it("omits fake metadata when a path becomes a directory on either side", async () => {
  const model = new FakeHostModel({ ...repository, id: "1", fullName: "example/app", initialFiles: { "old": "a", "folder/child": "b" } });
  const host = new FakeCodeHost(model);
  model.commit("feature", { "old": null, "old/child": "new", "folder/child": null, folder: "file" });
  const { cr } = model.reconcile({ sourceBranch: "feature", targetBranch: "main", title: "directory replacement" });
  const files = (await host.changedFiles({ repository, id: cr.id, url: model.crUrl(cr.id) }, 1, scope)).files;
  expect(files.find(f => f.path === "old")?.entry).toBeUndefined();
  expect(files.find(f => f.path === "folder")?.entry).toBeUndefined();
});

it("checks fake scope, registration, rate limits and incomplete changed-file sides", async () => {
  const model = new FakeHostModel({ ...repository, id: "1", fullName: "example/app" });
  const host = new FakeCodeHost(model);
  const revision = model.commit("feature", { "AGENTS.md": "text" });
  await expect(host.instructionFiles(repository, revision, {} as never)).rejects.toBeDefined();
  await expect(host.instructionFiles({ url: "https://host.example.test/other/app" }, revision, scope)).rejects.toBeDefined();
  const { cr } = model.reconcile({ sourceBranch: "feature", targetBranch: "main", title: "incomplete" });
  model.incompleteTrees.add(revision);
  expect((await host.changedFiles({ repository, id: cr.id, url: model.crUrl(cr.id) }, 1, scope)).files[0]?.entry).toBeUndefined();
  model.rateLimitedUntil = Date.parse("2026-10-30T11:00:00Z");
  await expect(host.instructionFiles(repository, revision, scope)).rejects.toMatchObject({ retryAt: model.rateLimitedUntil });
});

it("uses the best common ancestor when a merge has a shortcut to an older ancestor", () => {
  const model = new FakeHostModel({ ...repository, id: "1", fullName: "example/app" });
  const old = model.headOf("main");
  const newer = model.commit("main", { later: "new" });
  const merged = model.makeRevision([old, newer], model.revision(newer).files);
  expect(model.mergeBase(merged.sha, newer)).toBe(newer);
});

it("refuses a merge base when two histories have no shared ancestor", () => {
  const model = new FakeHostModel({ ...repository, id: "1", fullName: "example/app" });
  const unrelated = model.makeRevision([], new Map());
  expect(() => model.mergeBase(model.headOf("main"), unrelated.sha)).toThrow();
});

it("refuses renaming an absent fake entry", () => {
  const model = new FakeHostModel({ ...repository, id: "1", fullName: "example/app" });
  expect(() => model.commitRename("main", "missing", "new")).toThrow();
});
