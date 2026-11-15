import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as candidateFs from "../../packages/worker/src/candidate-fs.js";
import { deriveRepositoryEdges, type EdgeRepository } from "../../packages/worker/src/multi-repo-edges.js";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import { wireMultiRepoDependencies } from "../../packages/worker/src/multi-repo-wiring.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Codex", "-c", "user.email=noreply@openai.com", ...args], { cwd, env: isolatedGitEnvironment(cwd), encoding: "utf8" }).trim();
async function fixture(manifests: Array<Record<string, string>>) {
  const root = realpathSync.native(await mkdtemp(join(process.env.TMPDIR ?? join(process.cwd(), "node_modules"), "mr2-edges-"))); roots.push(root);
  const repos: EdgeRepository[] = [];
  for (const [i, files] of manifests.entries()) {
    const name = `repo${i}`; const directory = join(root, name); await mkdir(directory);
    git(directory, "init", "-q"); await writeFile(join(directory, ".gitignore"), "node_modules/\n"); await writeFile(join(directory, "keep"), "base");
    for (const [path, text] of Object.entries(files)) await writeFile(join(directory, path), text);
    git(directory, "add", "."); git(directory, "commit", "-qm", "base");
    repos.push({ name, directory, baseCommit: git(directory, "rev-parse", "HEAD") });
  }
  const derive = () => deriveRepositoryEdges(repos, { signal: new AbortController().signal, remainingMs: () => 30_000 });
  return { root, repos, derive, put: (i: number, name: string, text: string) => writeFile(join(repos[i]!.directory, name), text) };
}
const pkg = (name: string, fields = {}) => ({ "package.json": JSON.stringify({ name, ...fields }) });
const edge = (source = "both", language = "node", consumer = "repo0", provider = "repo1") => ({ consumer, provider, language, source });

describe("repository edge facts", () => {
  it.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])("exact scoped node name in %s, source golden and wireable", async (field) => {
    const f = await fixture([pkg("app", { [field]: { "@acme/lib": "*" } }), pkg("@acme/lib")]);
    const result = await f.derive(); expect(JSON.stringify(result)).toBe(JSON.stringify({ edges: [edge()], notes: [] }));
    const wiring = await wireMultiRepoDependencies({ rootPath: f.root, repositories: f.repos.map(r => ({ repositoryId: r.name, path: r.name, baseCommit: r.baseCommit })), dependencies: result.edges, setup: [] }, f.root);
    await wiring.link(); expect(wiring.notes).toEqual([]);
  });
  it("base removal cannot hide an edge; source base/candidate/both golden", async () => {
    const f = await fixture([pkg("app", { dependencies: { lib: "1" } }), pkg("lib")]);
    await f.put(0, "package.json", JSON.stringify({ name: "app" }));
    expect(await f.derive()).toEqual({ edges: [edge("base")], notes: [] });
    await f.put(1, "package.json", JSON.stringify({ name: "lib", dependencies: { app: "2" } }));
    expect(await f.derive()).toEqual({ edges: [edge("base"), edge("candidate", "node", "repo1", "repo0")], notes: [] });
  });
  it("candidate added dependency counts and ordering is deterministic", async () => {
    const f = await fixture([pkg("app"), pkg("lib")]);
    await f.put(0, "package.json", JSON.stringify({ name: "app", dependencies: { lib: "*" } }));
    expect(await f.derive()).toEqual({ edges: [edge("candidate")], notes: [] });
    f.repos.reverse(); expect(await f.derive()).toEqual({ edges: [edge("candidate")], notes: [] });
  });
  it("no prefix, self, prose, nested or lockfile edges; cycles are facts for MR3", async () => {
    const f = await fixture([pkg("app", { dependencies: { "lib-old": "*", app: "*" } }), pkg("lib")]);
    await mkdir(join(f.repos[0]!.directory, "nested")); await f.put(0, "nested/package.json", JSON.stringify({ dependencies: { lib: "*" } }));
    await f.put(0, "package-lock.json", JSON.stringify({ dependencies: { lib: "*" } }));
    expect(await f.derive()).toEqual({ edges: [], notes: [] });
    await f.put(0, "package.json", JSON.stringify({ name: "app", dependencies: { lib: "*" } }));
    await f.put(1, "package.json", JSON.stringify({ name: "lib", dependencies: { app: "*" } }));
    expect((await f.derive()).edges).toEqual([edge("candidate"), edge("candidate", "node", "repo1", "repo0")]);
  });
  it("ambiguous providers refuse the whole derivation", async () => {
    const f = await fixture([pkg("app", { dependencies: { lib: "*" } }), pkg("lib"), pkg("lib")]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["ambiguous"] });
  });
  it.each(["require example.com/lib v1.0.0", "require (\n example.com/lib v2.0.0 // indirect\n)"])("Go declarations and wiring: %s", async require => {
    const f = await fixture([{ "go.mod": `module example.com/app\n${require}\n` }, { "go.mod": "module example.com/lib\n" }]);
    const result = await f.derive(); expect(result.edges).toEqual([edge("both", "go")]);
    const wiring = await wireMultiRepoDependencies({ rootPath: f.root, repositories: f.repos.map(r => ({ repositoryId: r.name, path: r.name, baseCommit: r.baseCommit })), dependencies: result.edges, setup: [] }, f.root);
    expect(wiring.setup[0]?.args).toEqual(["mod", "edit", "-replace=example.com/lib=../repo1"]);
  });
  it.each([
    { "pyproject.toml": '[project]\nname = "my-lib"\ndependencies = []\n' },
    { "setup.cfg": '[metadata]\nname = my_lib\n' },
    { "setup.py": 'from setuptools import setup\nsetup(name="my_lib", version="1")\n' },
  ])("Python declared names normalize, multiline dependencies and path requirements wire", async provider => {
    const f = await fixture([{ "pyproject.toml": '[project]\nname = "app"\ndependencies = [\n "My_Lib>=1",\n]\n', "requirements.txt": "-e ../repo1\n" }, provider]);
    const result = await f.derive(); expect(result.edges).toEqual([edge("both", "python")]);
    const wiring = await wireMultiRepoDependencies({ rootPath: f.root, repositories: f.repos.map(r => ({ repositoryId: r.name, path: r.name, baseCommit: r.baseCommit })), dependencies: result.edges, setup: [] }, f.root);
    expect(wiring.setup[0]?.args).toContain("../repo1");
  });
  it.each([
    { "package.json": '{"name":"app","dependencies":{"lib":"*"},"devDependencies":false}' },
    { "go.mod": "module app\nrequire (\nexample.com/lib v1\n" },
    { "pyproject.toml": '[project]\nname="app"\ndependencies=["lib", dependency]\n' },
    { "setup.py": 'from setuptools import setup as s\ns(name="lib")\n' },
    { "setup.py": 'from setuptools import setup\nsetup(name="lib")\nopen("EXECUTED", "w").write("bad")\n' },
    { "requirements.txt": "lib\n-r hidden.txt\n" },
  ])("unsupported forms never produce partial facts or execute Python: %j", async malformed => {
    const f = await fixture([malformed, pkg("lib")]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
  });
  it("hostile content and unreadable links never leak", async () => {
    const secret = `ghp_${"aB1".repeat(12)}`;
    const f = await fixture([{ "package.json": JSON.stringify({ name: `${secret}\n\u202e/path`, dependencies: { lib: "*" }, __proto__: {} }) }, pkg("lib")]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
    await rm(join(f.repos[0]!.directory, "package.json")); await symlink(join(f.repos[1]!.directory, "package.json"), join(f.repos[0]!.directory, "package.json"));
    expect(await f.derive()).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
  });
  it("one total 2 MiB budget across base and candidate, and bounded large input", async () => {
    const f = await fixture([pkg("app", { padding: "x".repeat(520_000), dependencies: { lib: "*" } }), pkg("lib", { padding: "x".repeat(520_000) })]);
    const start = performance.now(); expect((await f.derive()).edges).toEqual([edge()]); expect(performance.now() - start).toBeLessThan(10_000);
    await f.put(0, "package.json", JSON.stringify({ name: "app", padding: "x".repeat(600_000) }));
    expect(await f.derive()).toEqual({ edges: [], notes: ["too many repositories or dependencies; tested separately"] });
  });
  it("32 repositories and 64 edges work; 33 or 65 refuse", async () => {
    const files = Array.from({ length: 32 }, (_, i) => pkg(`pkg${i}`, i < 2 ? { dependencies: Object.fromEntries(Array.from({ length: 30 }, (_, j) => [`pkg${j + 2}`, "*"])) } : {}));
    files[2] = pkg("pkg2", { dependencies: { pkg3: "*", pkg4: "*", pkg5: "*", pkg6: "*" } });
    const f = await fixture(files); expect((await f.derive()).edges).toHaveLength(64);
    await f.put(2, "package.json", JSON.stringify({ name: "pkg2", dependencies: { pkg3: "*", pkg4: "*", pkg5: "*", pkg6: "*", pkg7: "*" } }));
    expect(await f.derive()).toEqual({ edges: [], notes: ["too many repositories or dependencies; tested separately"] });
    f.repos.push({ ...f.repos[0]!, name: "extra" }); expect(await f.derive()).toEqual({ edges: [], notes: ["too many repositories or dependencies; tested separately"] });
  });
  it("missing and unsupported-language notes are fixed", async () => {
    const f = await fixture([{ "pom.xml": "hostile" }, { "pom.xml": "hostile" }]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["tested separately: no cross-repo wiring for maven"] });
  });
  it("runtime shapes and expired budgets refuse without echoing input", async () => {
    for (const input of [null, {}, [null], [{ name: "bad\n", directory: "/secret", baseCommit: "bad" }]]) {
      expect(await deriveRepositoryEdges(input as never, { signal: new AbortController().signal, remainingMs: () => 1000 })).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
    }
    const f = await fixture([pkg("app"), pkg("lib")]);
    await expect(deriveRepositoryEdges(f.repos, { signal: new AbortController().signal, remainingMs: () => 0 })).rejects.toEqual(new Error("aborted"));
  });
});

describe("lazy repository check supplier", () => {
  it("single repo, nightly, and non-local keep the exact runners", async () => {
    const f = await fixture([pkg("app"), pkg("lib")]);
    const { createRepositoryCheckSupplier } = await import("../../packages/worker/src/multi-repo-supplier.js");
    const { createCheckRunners } = await import("../../packages/worker/src/verification/checks.js");
    const repositories = f.repos.map(r => ({ repositoryId: r.name, path: r.name, baseCommit: r.baseCommit }));
    const base = createCheckRunners({ rootPath: f.root, local: true });
    expect(createRepositoryCheckSupplier({ rootPath: f.root, repositories: repositories.slice(0, 1) }).scope(base)).toBe(base);
    expect(createRepositoryCheckSupplier({ rootPath: f.root, repositories, nightly: true }).scope(base)).toBe(base);
    for (const kind of ["sandbox", "sealed", "devcontainer"] as const) { const runner = { ...base, kind }; expect(createRepositoryCheckSupplier({ rootPath: f.root, repositories }).scope(runner)).toBe(runner); }
  });
  it("derives after construction once; candidate added edge wires detached repositories", async () => {
    const f = await fixture([pkg("app"), pkg("lib")]);
    const { createRepositoryCheckSupplier } = await import("../../packages/worker/src/multi-repo-supplier.js");
    const { createCheckRunners, runChecks } = await import("../../packages/worker/src/verification/checks.js");
    const supplier = createRepositoryCheckSupplier({ rootPath: f.root, repositories: f.repos.map(r => ({ repositoryId: r.name, path: r.name, baseCommit: r.baseCommit })) });
    const runner = supplier.scope(createCheckRunners({ rootPath: f.root, local: true }));
    await f.put(0, "package.json", JSON.stringify({ name: "app", dependencies: { lib: "*" } }));
    const plan = { source: "project" as const, readiness: [{ executable: process.execPath, args: ["-e", "console.log(require('lib/package.json').name)"], cwd: "repo0", timeoutSeconds: 10 }] };
    const result = await runChecks(plan, runner, { signal: new AbortController().signal, budgetMs: 30_000 });
    expect(result.entries[0]).toMatchObject({ after: "passed", output: "lib\n" });
    expect(supplier.evidence()).toEqual({ edges: [edge("candidate")], notes: [] });
    await f.put(0, "package.json", JSON.stringify({ name: "app" }));
    expect((await runChecks(plan, runner, { signal: new AbortController().signal, budgetMs: 30_000 })).entries[0]?.after).toBe("passed");
    expect(supplier.evidence()?.edges).toEqual([edge("candidate")]);
  });
  it("no edge: unchanged output, no reports or roots, no evidence field", async () => {
    const f = await fixture([pkg("app"), pkg("lib")]);
    const { createRepositoryCheckSupplier } = await import("../../packages/worker/src/multi-repo-supplier.js");
    const { createCheckRunners, runChecks } = await import("../../packages/worker/src/verification/checks.js");
    const { readdir } = await import("node:fs/promises");
    const supplier = createRepositoryCheckSupplier({ rootPath: f.root, repositories: f.repos.map(r => ({ repositoryId: r.name, path: r.name, baseCommit: r.baseCommit })) });
    const base = createCheckRunners({ rootPath: f.root, local: true });
    const plan = { source: "project" as const, readiness: [{ executable: process.execPath, args: ["-e", "console.log('same')"], cwd: "repo0", timeoutSeconds: 10 }] };
    const options = { signal: new AbortController().signal, budgetMs: 30_000, now: () => 0 };
    const control = await runChecks(plan, base, options); expect(control.entries[0]?.after).toBe("passed");
    expect(JSON.stringify(await runChecks(plan, supplier.scope(base), options))).toBe(JSON.stringify(control));
    expect(supplier.evidence()).toBeUndefined(); expect(await readdir(f.root)).toEqual(["repo0", "repo1"]);
  });
});


describe("MR2 deadline and syntax guards", () => {
  it("derivation consumes the round budget before any check starts", async () => {
    const f = await fixture([pkg("app", { dependencies: { lib: "*" } }), pkg("lib")]);
    const { createRepositoryCheckSupplier } = await import("../../packages/worker/src/multi-repo-supplier.js");
    const { createCheckRunners, runChecks } = await import("../../packages/worker/src/verification/checks.js");
    const original = candidateFs.readFileIn;
    let charged = false;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.spyOn(candidateFs, "readFileIn").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!charged && args[1] === "package.json") { charged = true; await vi.advanceTimersByTimeAsync(1_000); }
      return result;
    });
    const supplier = createRepositoryCheckSupplier({ rootPath: f.root, repositories: f.repos.map(r => ({ repositoryId: r.name, path: r.name, baseCommit: r.baseCommit })) });
    const plan = { source: "project" as const, readiness: [{ executable: process.execPath, args: ["-e", "throw Error('must not run')"], cwd: "repo0", timeoutSeconds: 10 }] };
    const result = await runChecks(plan, supplier.scope(createCheckRunners({ rootPath: f.root, local: true })), { signal: new AbortController().signal, budgetMs: 1_000 });
    expect(charged).toBe(true);
    expect(result.entries[0]).toMatchObject({ after: "not_run", output: "AgentX did not run this check: the time budget for checks ran out." });
    expect(supplier.evidence()).toBeUndefined();
  });
  it("a derivation that ran out of one round's budget is derived again by the next round", async () => {
    const f = await fixture([pkg("app", { dependencies: { lib: "*" } }), pkg("lib")]);
    const { createRepositoryCheckSupplier } = await import("../../packages/worker/src/multi-repo-supplier.js");
    const { createCheckRunners, runChecks } = await import("../../packages/worker/src/verification/checks.js");
    const original = candidateFs.readFileIn;
    let charged = false;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const spy = vi.spyOn(candidateFs, "readFileIn").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!charged && args[1] === "package.json") { charged = true; await vi.advanceTimersByTimeAsync(1_000); }
      return result;
    });
    const supplier = createRepositoryCheckSupplier({ rootPath: f.root, repositories: f.repos.map(r => ({ repositoryId: r.name, path: r.name, baseCommit: r.baseCommit })) });
    const runners = supplier.scope(createCheckRunners({ rootPath: f.root, local: true }));
    const first = await runChecks({ source: "project", readiness: [{ executable: process.execPath, args: ["-e", "throw Error('must not run')"], cwd: "repo0", timeoutSeconds: 10 }] }, runners, { signal: new AbortController().signal, budgetMs: 1_000 });
    expect(charged).toBe(true);
    expect(first.entries[0]?.after).toBe("not_run");
    spy.mockRestore(); vi.useRealTimers();
    const second = await runChecks({ source: "project", readiness: [{ executable: process.execPath, args: ["-e", "console.log('second round')"], cwd: "repo0", timeoutSeconds: 10 }] }, runners, { signal: new AbortController().signal, budgetMs: 30_000 });
    expect(second.entries[0]).toMatchObject({ after: "passed", output: "second round\n" });
    expect(supplier.evidence()?.edges).toEqual([{ consumer: "repo0", provider: "repo1", language: "node", source: "both" }]);
  });
  it("rejects malformed project headers instead of silently ignoring a dependency", async () => {
    const f = await fixture([{ "pyproject.toml": '[project\nname="app"\ndependencies=["lib"]\n' }, { "setup.cfg": "[metadata]\nname=lib\n" }]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
  });
  it("a large multiline dependency array is processed in bounded time", async () => {
    const f = await fixture([{ "pyproject.toml": '[project]\nname="app"\ndependencies=[\n' + ' "lib",\n'.repeat(16000) + ']\n' }, { "setup.cfg": "[metadata]\nname=lib\n" }]);
    const started = performance.now(); expect((await f.derive()).edges).toEqual([edge("both", "python")]); expect(performance.now() - started).toBeLessThan(10_000);
  });
});


describe("MR2 additional refusal controls", () => {
  it.each(["__proto__", "constructor", "prototype"])("refuses the own dependency key %s without publishing it", async key => {
    const f = await fixture([pkg("app", { dependencies: Object.fromEntries([[key, "*"]]) }), pkg("lib")]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
  });
  it("caps all dependency items across base and candidate", async () => {
    const f = await fixture([{ "requirements.txt": "lib\n".repeat(16385) }, { "setup.cfg": "[metadata]\nname=lib\n" }]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["too many repositories or dependencies; tested separately"] });
  });
});

describe("MR2 wireability refusals", () => {
  it.each([
    "[options.extras_require]\nextra = hidden\n",
    "[options]\ninstall-requires = hidden\n",
    "[options]\ninstall_requires = hidden\n",
  ])("refuses unsupported or duplicate setup.cfg declarations without partial facts: %s", async extra => {
    const f = await fixture([{ "setup.cfg": `[metadata]\nname=app\n[options]\ninstall_requires=lib\n${extra}` }, { "setup.cfg": "[metadata]\nname=lib\n" }]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
  });
  it.each(["module example.com/lib // comment\n", " module example.com/lib\n"])("refuses a Go provider spelling MR1 cannot wire: %s", async declaration => {
    const f = await fixture([{ "go.mod": "module example.com/app\nrequire example.com/lib v1.0.0\n" }, { "go.mod": declaration }]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
  });
  it("does not accept an unparsed Go block alongside a valid require", async () => {
    const f = await fixture([{ "go.mod": "module example.com/app\nrequire example.com/lib v1.0.0\nreplace (\nnot a declaration\n)\n" }, { "go.mod": "module example.com/lib\n" }]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
  });
  it("local Python paths require a declared Python provider", async () => {
    const f = await fixture([{ "requirements.txt": "-e ../repo1\n" }, pkg("lib")]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
  });
});

describe("MR2 canonical ordering", () => {
  it("uses code-point ordering independent of the host locale", async () => {
    const f = await fixture([pkg("app", { dependencies: { lib: "*" } }), pkg("lib"), pkg("another", { dependencies: { lib: "*" } })]);
    f.repos[0]!.name = "x_"; f.repos[2]!.name = "x-";
    expect((await f.derive()).edges).toEqual([edge("both", "node", "x-"), edge("both", "node", "x_")]);
  });
});

describe("MR2 prepared-path boundary", () => {
  it("does not derive from repositories outside the prepared root", async () => {
    const f = await fixture([pkg("app", { dependencies: { lib: "*" } }), pkg("lib")]);
    const { createRepositoryCheckSupplier } = await import("../../packages/worker/src/multi-repo-supplier.js");
    const { createCheckRunners, runChecks } = await import("../../packages/worker/src/verification/checks.js");
    const root = join(f.root, "nested"); await mkdir(root);
    const supplier = createRepositoryCheckSupplier({ rootPath: root, repositories: f.repos.map(r => ({ repositoryId: r.name, path: `../${r.name}`, baseCommit: r.baseCommit })) });
    const base = createCheckRunners({ rootPath: root, local: true });
    const result = await runChecks({ source: "project", readiness: [{ executable: process.execPath, args: ["-e", "console.log('ordinary'); process.exitCode=1"], cwd: ".", timeoutSeconds: 10 }] }, supplier.scope(base), { signal: new AbortController().signal, budgetMs: 30_000 });
    expect(result.entries[0]).toMatchObject({ after: "failed", output: "ordinary\n" });
    expect(supplier.evidence()).toBeUndefined(); expect(supplier.notes()).toEqual(["dependency manifest unreadable"]);
  });
});

describe("MR2 exact manifest budget", () => {
  it("accepts exactly 2 MiB across manifests even when a final base listing is needed", async () => {
    const provider = JSON.stringify({ name: "lib" });
    const prefix = JSON.stringify({ name: "app", dependencies: { lib: "*" }, padding: "" });
    const app = JSON.stringify({ name: "app", dependencies: { lib: "*" }, padding: "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(provider) - Buffer.byteLength(prefix)) });
    const f = await fixture([{ "package.json": app }, { "package.json": provider }]);
    for (const repo of f.repos) await rm(join(repo.directory, "package.json"));
    expect(await f.derive()).toEqual({ edges: [edge("base")], notes: [] });
  });
});

describe("MR2 root requirements inventory", () => {
  it("reads declared root requirements files beyond the conventional three names", async () => {
    const f = await fixture([{ "requirements-production.txt": "-e ../repo1\n" }, { "setup.cfg": "[metadata]\nname=lib\n" }]);
    expect(await f.derive()).toEqual({ edges: [edge("both", "python")], notes: [] });
  });
  it("never silently ignores unsupported syntax in an additional requirements file", async () => {
    const f = await fixture([{ "requirements-production.txt": "-r hidden.txt\n", "requirements.txt": "lib\n" }, { "setup.cfg": "[metadata]\nname=lib\n" }]);
    expect(await f.derive()).toEqual({ edges: [], notes: ["dependency manifest unreadable"] });
  });
});

describe("MR2 shared inventory bounds", () => {
  it("accepts 704 manifest reads, then refuses one extra candidate file", async () => {
    const files = Object.fromEntries(Array.from({ length: 351 }, (_, i) => [`requirements-${i}.txt`, "lib\n"]));
    const f = await fixture([files, { "setup.cfg": "[metadata]\nname=lib\n" }]);
    expect((await f.derive()).edges).toEqual([edge("both", "python")]);
    await f.put(0, "requirements-extra.txt", "lib\n");
    expect(await f.derive()).toEqual({ edges: [], notes: ["too many repositories or dependencies; tested separately"] });
  });
  it("accepts 4096 total root entries, then refuses one extra entry", async () => {
    const files = Object.fromEntries(Array.from({ length: 2043 }, (_, i) => [`ordinary-${i}`, ""]));
    const f = await fixture([files, {}]);
    expect(await f.derive()).toEqual({ edges: [], notes: [] });
    await f.put(0, "extra", "");
    expect(await f.derive()).toEqual({ edges: [], notes: ["too many repositories or dependencies; tested separately"] });
  });
  it("charges directory names and manifests to one total byte budget", async () => {
    const prefix = JSON.stringify({ name: "app", padding: "" });
    const f = await fixture([{ "package.json": JSON.stringify({ name: "app", padding: "x".repeat(1024 * 1024 - Buffer.byteLength(prefix)) }) }, {}]);
    expect(await f.derive()).toEqual({ edges: [], notes: [] });
    for (let offset = 0; offset < 4000; offset += 100) await Promise.all(Array.from({ length: 100 }, (_, i) => f.put(0, `${"n".repeat(200)}${offset + i}`, "")));
    expect(await f.derive()).toEqual({ edges: [], notes: ["too many repositories or dependencies; tested separately"] });
  });
});
