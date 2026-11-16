// TE-MR2b: what selection needs to know beyond the edges: did the derivation finish, and which repositories' dependencies are not fully known (so nothing may be skipped "because it does not depend on that one").
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveRepositoryEdges, deriveRepositoryFacts, type EdgeRepository } from "../../packages/worker/src/multi-repo-edges.js";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd, env: isolatedGitEnvironment(cwd), encoding: "utf8" }).trim();
async function fixture(manifests: Array<Record<string, string>>) {
  const root = realpathSync.native(await mkdtemp(join(process.env.TMPDIR ?? join(process.cwd(), "node_modules"), "mr2b-facts-"))); roots.push(root);
  const repos: EdgeRepository[] = [];
  for (const [i, files] of manifests.entries()) {
    const name = `repo${i}`; const directory = join(root, name); await mkdir(directory);
    git(directory, "init", "-q"); await writeFile(join(directory, "keep"), "base");
    for (const [path, text] of Object.entries(files)) await writeFile(join(directory, path), text);
    git(directory, "add", "."); git(directory, "commit", "-qm", "base");
    repos.push({ name, directory, baseCommit: git(directory, "rev-parse", "HEAD") });
  }
  const budget = () => ({ signal: new AbortController().signal, remainingMs: () => 30_000 });
  return { root, repos, facts: () => deriveRepositoryFacts(repos, budget()), edges: () => deriveRepositoryEdges(repos, budget()), put: (i: number, name: string, text: string) => writeFile(join(repos[i]!.directory, name), text) };
}
const pkg = (name: string, fields = {}) => ({ "package.json": JSON.stringify({ name, ...fields }) });

describe("repository facts for selection", () => {
  it("the edges are exactly what deriveRepositoryEdges returns, and the facts say they are complete", async () => {
    const f = await fixture([pkg("app", { dependencies: { lib: "*" } }), pkg("lib")]);
    const facts = await f.facts();
    expect({ edges: facts.edges, notes: facts.notes }).toEqual(await f.edges());
    expect(JSON.stringify(Object.keys(await f.edges()))).toBe(JSON.stringify(["edges", "notes"]));
    expect(facts).toMatchObject({ complete: true, unknown: [] });
    expect(facts.edges).toHaveLength(1);
  });
  it("a Maven or Gradle manifest, in the base or in the candidate, makes that repository unknown even when an edge was found elsewhere", async () => {
    const f = await fixture([pkg("app", { dependencies: { lib: "*" } }), pkg("lib"), { "pom.xml": "<project/>" }, { "build.gradle.kts": "" }, pkg("late")]);
    const facts = await f.facts();
    expect(facts.edges).toHaveLength(1);
    expect(facts.unknown).toEqual(["repo2", "repo3"]);
    // Added by the candidate only: still unknown (the union).
    await f.put(4, "pom.xml", "<project/>");
    expect((await f.facts()).unknown).toEqual(["repo2", "repo3", "repo4"]);
  });
  it("a repository with no manifest of a supported language is unknown", async () => {
    const f = await fixture([pkg("app"), { "README.md": "docs" }]);
    expect((await f.facts()).unknown).toEqual(["repo1"]);
    // A manifest that only the base had (the candidate removed it) still counts as known: the union.
    const g = await fixture([pkg("app"), pkg("lib")]);
    await rm(join(g.repos[1]!.directory, "package.json"));
    expect((await g.facts()).unknown).toEqual([]);
  });
  it("an ambiguous, unreadable or over-limit derivation is incomplete, with the same fixed note", async () => {
    const ambiguous = await fixture([pkg("same"), pkg("same")]);
    expect(await ambiguous.facts()).toMatchObject({ complete: false, edges: [], notes: ["ambiguous"], unknown: [] });
    const unreadable = await fixture([{ "package.json": "{not json" }, pkg("lib")]);
    expect(await unreadable.facts()).toMatchObject({ complete: false, notes: ["dependency manifest unreadable"] });
  });
  it("an abort is not turned into a finished derivation", async () => {
    const f = await fixture([pkg("app"), pkg("lib")]);
    const stop = new AbortController(); stop.abort();
    await expect(deriveRepositoryFacts(f.repos, { signal: stop.signal, remainingMs: () => 30_000 })).rejects.toThrow("aborted");
  });
});
