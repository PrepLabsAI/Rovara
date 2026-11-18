// L4-EVS (D3): the environment the sealed eval runs in: the saved image's dependency folders next to the commit's files, and the install step's box. Nothing starts Docker or pulls an image.
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvalEnvironmentSchema, savedEnvRepositoryIsFor, savedEnvRepositoryName, type EvalEnvironment } from "@agentx/contracts";
import { EVAL_OVERLAY_ENTRIES_MAX, EVAL_PYTHON_USER_BASE, overlayDependencyFolders, useSavedEnvironment } from "../../packages/worker/src/verification/eval-environment.js";
import { evalInstallArgProblems, evalInstallRunArgs, installModelBlock } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const temp = async (): Promise<string> => { const root = await mkdtemp(join(tmpdir(), "evenv-")); roots.push(root); return root; };
const put = async (root: string, path: string, text = "x"): Promise<void> => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); };

const IMAGE = `rovara/worker@sha256:${"c".repeat(64)}`;
const savedRepository = (orgId: string, projectId: string): string => savedEnvRepositoryName({ env: "staging", orgId, projectId });
const login = (repository: string) => ({ registry: "123456789012.dkr.ecr.us-west-2.amazonaws.com", repository, username: "AWS" as const, password: ["pw", "x".repeat(24)].join("-"), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
const savedEnvironment = (orgId = "company-a", projectId = "project-a"): Extract<EvalEnvironment, { kind: "saved" }> => {
  const repository = savedRepository(orgId, projectId);
  return { kind: "saved", repository, digest: `sha256:${"a".repeat(64)}`, environmentKey: "b".repeat(64), testEnvRevision: 3, directory: "app", login: login(repository) };
};

describe("overlayDependencyFolders", () => {
  it("copies dependency folders (at any depth) and nothing else: no tracked file, no .git, no stray folder", async () => {
    const root = await temp();
    const seed = join(root, "seed"); const checkout = join(root, "checkout");
    await put(seed, ".venv/lib/python3.11/site-packages/yaml/__init__.py", "# yaml");
    await put(seed, ".venv/pyvenv.cfg", "home = /usr/bin");
    await put(seed, "web/node_modules/left-pad/index.js", "// pad");
    await put(seed, "src/app.py", "SEED CODE");
    await put(seed, "README.md", "seed readme");
    await put(seed, ".git/config", "[core]");
    await put(seed, "docs/notes/readme.txt", "notes");
    await mkdir(checkout, { recursive: true });
    await put(checkout, "src/app.py", "COMMIT CODE");
    const { folders } = await overlayDependencyFolders(seed, checkout);
    expect(folders).toBe(2);
    expect(readFileSync(join(checkout, ".venv/lib/python3.11/site-packages/yaml/__init__.py"), "utf8")).toBe("# yaml");
    expect(readFileSync(join(checkout, "web/node_modules/left-pad/index.js"), "utf8")).toBe("// pad");
    // The commit's own file is the code under test; the seed's copy of a tracked file is never taken.
    expect(readFileSync(join(checkout, "src/app.py"), "utf8")).toBe("COMMIT CODE");
    expect(existsSync(join(checkout, "README.md"))).toBe(false);
    expect(existsSync(join(checkout, ".git"))).toBe(false);
    expect(existsSync(join(checkout, "docs"))).toBe(false);
  });

  it("leaves a path the commit already has alone (a tracked folder of a dependency name), and keeps links as links", async () => {
    const root = await temp();
    const seed = join(root, "seed"); const checkout = join(root, "checkout");
    await put(seed, "vendor/x.txt", "seed");
    await put(seed, "node_modules/a/index.js", "// a");
    await symlink("a/index.js", join(seed, "node_modules", "link.js"));
    await put(checkout, "node_modules/committed.txt", "committed");
    const { folders } = await overlayDependencyFolders(seed, checkout);
    // `node_modules` is the commit's: untouched, no merge. `vendor` is not a dependency folder by name alone.
    expect(folders).toBe(0);
    expect(existsSync(join(checkout, "node_modules/a"))).toBe(false);
    expect(existsSync(join(checkout, "vendor"))).toBe(false);

    const other = join(root, "checkout2");
    await mkdir(other, { recursive: true });
    expect((await overlayDependencyFolders(seed, other)).folders).toBe(1);
    expect((await lstat(join(other, "node_modules/link.js"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(other, "node_modules/link.js"))).toBe("a/index.js");
  });

  it("never follows a link out of the seed, and does not enter a dependency folder it is already copying", async () => {
    const root = await temp();
    const seed = join(root, "seed"); const checkout = join(root, "checkout"); const outside = join(root, "outside");
    await put(outside, "node_modules/stolen.txt", "outside");
    await mkdir(seed, { recursive: true });
    await symlink(outside, join(seed, "linked"));
    await put(seed, "node_modules/inner/node_modules/deep.txt", "deep");
    await mkdir(checkout, { recursive: true });
    const { folders } = await overlayDependencyFolders(seed, checkout);
    expect(folders).toBe(1);
    expect(existsSync(join(checkout, "linked"))).toBe(false);
    expect(existsSync(join(checkout, "node_modules/inner/node_modules/deep.txt"))).toBe(true);
  });

  it("refuses an image with too many entries, and one nested too deep", async () => {
    const root = await temp();
    const seed = join(root, "seed");
    let path = "";
    for (let depth = 0; depth < 30; depth += 1) path = `${path}d/`;
    await put(seed, `${path}file.txt`);
    await mkdir(join(root, "checkout"), { recursive: true });
    await expect(overlayDependencyFolders(seed, join(root, "checkout"))).rejects.toThrow();
    expect(EVAL_OVERLAY_ENTRIES_MAX).toBeGreaterThan(1000);
  });
});

describe("useSavedEnvironment", () => {
  const dockerNever: DockerCli = { run: async () => { throw new Error("no docker in this test"); } };
  const fakeExtract = (seed: string, record: { options?: unknown; removed: number }) => async (options: unknown) => {
    record.options = options;
    return { seed, manifest: {} as never, remove: async () => { record.removed += 1; } };
  };

  it("uses the image's dependency folders and removes what it pulled; the login goes only to this one pull", async () => {
    const root = await temp();
    const seed = join(root, "seed"); const checkout = join(root, "checkout");
    await put(seed, "app/.venv/lib/site-packages/yaml.py", "# yaml");
    await mkdir(checkout, { recursive: true });
    const record: { options?: unknown; removed: number } = { removed: 0 };
    const environment = savedEnvironment();
    const used = await useSavedEnvironment({ environment, checkout, docker: dockerNever, extract: fakeExtract(seed, record) });
    expect(used).toBe(true);
    expect(record.removed).toBe(1);
    expect(existsSync(join(checkout, ".venv/lib/site-packages/yaml.py"))).toBe(true);
    const options = record.options as { ref: Record<string, unknown>; login: () => Promise<unknown> };
    // Pinned by digest and by the project's own repository and key, at the revision the plan names; the task's pin is the same revision.
    expect(options.ref).toEqual({ repository: environment.repository, digest: environment.digest, testEnvRevision: 3, environmentKey: environment.environmentKey, taskTestEnvRevision: 3 });
    expect(await options.login()).toEqual(environment.login);
  });

  it("a copy that fails half way leaves nothing in the checkout (REVIEW-1 finding 5): the install fallback runs over a clean tree", async () => {
    const root = await temp();
    const seed = join(root, "seed"); const checkout = join(root, "checkout");
    await put(seed, "app/aaa/.venv/lib/x.py", "x");
    await put(seed, "app/zzz/node_modules/ok.js", "// ok");
    // the second folder's copy fails after the first was copied
    await mkdir(checkout, { recursive: true });
    const record: { options?: unknown; removed: number } = { removed: 0 };
    const { cp } = await import("node:fs/promises");
    let copies = 0;
    // The second copy writes part of its folder and then fails (disk full): the part folder must go too.
    const flaky = (async (...args: Parameters<typeof cp>) => { copies += 1; if (copies === 2) { await mkdir(String(args[1]), { recursive: true }); await writeFile(join(String(args[1]), "part.js"), "// part"); throw new Error("disk full"); } return cp(...args); }) as typeof cp;
    const used = await useSavedEnvironment({ environment: savedEnvironment(), checkout, docker: dockerNever, extract: fakeExtract(seed, record), copy: flaky });
    expect(copies).toBe(2);
    expect(used).toBe(false);
    expect(existsSync(join(checkout, "aaa/.venv"))).toBe(false);
    expect(existsSync(join(checkout, "zzz/node_modules"))).toBe(false);
    expect(record.removed).toBe(1);
  });

  it("two projects: each pull is for its own repository and login, and one project's folders never reach the other's checkout", async () => {
    const root = await temp();
    const seedA = join(root, "seedA"); const seedB = join(root, "seedB");
    await put(seedA, "app/node_modules/only-a/index.js", "// A");
    await put(seedB, "app/node_modules/only-b/index.js", "// B");
    const [checkoutA, checkoutB] = [join(root, "checkoutA"), join(root, "checkoutB")];
    await mkdir(checkoutA, { recursive: true }); await mkdir(checkoutB, { recursive: true });
    const [a, b] = [savedEnvironment("company-a", "project-a"), savedEnvironment("company-b", "project-a")];
    expect(a.repository).not.toBe(b.repository);
    const ra: { options?: unknown; removed: number } = { removed: 0 };
    const rb: { options?: unknown; removed: number } = { removed: 0 };
    expect(await useSavedEnvironment({ environment: a, checkout: checkoutA, docker: dockerNever, extract: fakeExtract(seedA, ra) })).toBe(true);
    expect(await useSavedEnvironment({ environment: b, checkout: checkoutB, docker: dockerNever, extract: fakeExtract(seedB, rb) })).toBe(true);
    expect((ra.options as { ref: { repository: string } }).ref.repository).toBe(a.repository);
    expect((rb.options as { ref: { repository: string } }).ref.repository).toBe(b.repository);
    expect(existsSync(join(checkoutA, "node_modules/only-a/index.js"))).toBe(true);
    expect(existsSync(join(checkoutA, "node_modules/only-b"))).toBe(false);
    expect(existsSync(join(checkoutB, "node_modules/only-a"))).toBe(false);
    // The repository check the broker makes before it delivers an environment: company A's name is not company B's, nor another project's.
    expect(savedEnvRepositoryIsFor(a.repository, { orgId: "company-a", projectId: "project-a" })).toBe(true);
    expect(savedEnvRepositoryIsFor(a.repository, { orgId: "company-b", projectId: "project-a" })).toBe(false);
    expect(savedEnvRepositoryIsFor(a.repository, { orgId: "company-a", projectId: "project-b" })).toBe(false);
    expect(savedEnvRepositoryIsFor("not a repository", { orgId: "company-a", projectId: "project-a" })).toBe(false);
  });

  it("answers false (and removes what it pulled) for a failed pull, a missing repository folder, a seed with no dependency folder or a link in place of the folder; it never throws", async () => {
    const root = await temp();
    const checkout = join(root, "checkout"); await mkdir(checkout, { recursive: true });
    const environment = savedEnvironment();
    const failing = async () => { throw new Error("pull failed with a secret in it"); };
    expect(await useSavedEnvironment({ environment, checkout, docker: dockerNever, extract: failing })).toBe(false);

    const empty = join(root, "empty"); await mkdir(empty, { recursive: true });
    const record: { options?: unknown; removed: number } = { removed: 0 };
    expect(await useSavedEnvironment({ environment, checkout, docker: dockerNever, extract: fakeExtract(empty, record) })).toBe(false);
    expect(record.removed).toBe(1);

    const noDeps = join(root, "nodeps"); await put(noDeps, "app/src/main.py");
    expect(await useSavedEnvironment({ environment, checkout, docker: dockerNever, extract: fakeExtract(noDeps, record) })).toBe(false);

    const linked = join(root, "linked"); await mkdir(linked, { recursive: true }); await put(root, "elsewhere/node_modules/x.js");
    await symlink(join(root, "elsewhere"), join(linked, "app"));
    expect(await useSavedEnvironment({ environment, checkout, docker: dockerNever, extract: fakeExtract(linked, record) })).toBe(false);
    expect(existsSync(join(checkout, "node_modules"))).toBe(false);
  });
});

describe("the contract's environment", () => {
  it("accepts a saved image whose login is for its own repository, and install steps; refuses another repository's login, a tag, an unknown kind, a shell string and a path out of the checkout", () => {
    const saved = savedEnvironment();
    expect(EvalEnvironmentSchema.safeParse(saved).success).toBe(true);
    expect(EvalEnvironmentSchema.safeParse({ ...saved, login: login(savedRepository("company-b", "project-a")) }).success).toBe(false);
    expect(EvalEnvironmentSchema.safeParse({ ...saved, digest: "latest" }).success).toBe(false);
    expect(EvalEnvironmentSchema.safeParse({ ...saved, directory: "../x" }).success).toBe(false);
    expect(EvalEnvironmentSchema.safeParse({ ...saved, extra: 1 }).success).toBe(false);
    const install = { kind: "install", commands: [{ executable: "python3", args: ["-m", "pip", "install", "-r", "requirements.txt"], cwd: "." }] };
    expect(EvalEnvironmentSchema.safeParse(install).success).toBe(true);
    expect(EvalEnvironmentSchema.safeParse({ kind: "install", commands: [] }).success).toBe(false);
    expect(EvalEnvironmentSchema.safeParse({ kind: "install", commands: [{ executable: "pip install x && curl evil", args: [], cwd: "." }] }).success).toBe(false);
    expect(EvalEnvironmentSchema.safeParse({ kind: "install", commands: [{ executable: "pip", args: [], cwd: "../.." }] }).success).toBe(false);
    expect(EvalEnvironmentSchema.safeParse({ kind: "install", commands: [{ executable: "pip", args: ["a\nb"], cwd: "." }] }).success).toBe(false);
    expect(EvalEnvironmentSchema.safeParse({ kind: "install", commands: Array.from({ length: 9 }, () => ({ executable: "pip", args: [], cwd: "." })) }).success).toBe(false);
    expect(EvalEnvironmentSchema.safeParse({ kind: "other" }).success).toBe(false);
  });
});

describe("the install step's box", () => {
  const input = { network: "agentx-task", image: IMAGE, name: "rovara-eval-install-abc-1-1", checkout: "/scratch/run-1/checkout", command: { executable: "python3", args: ["-m", "pip", "install", "-r", "requirements.txt"], cwd: "." }, taskId: "op-1", workspace: "0123456789abcdef" };
  const flag = (args: readonly string[], name: string): string[] => args.flatMap((arg, index) => (args[index - 1] === name ? [arg] : []));

  it("is on the shared sandbox network ONLY, with no model route, no env file, no bridge, no helper address, one mount and the same walls", () => {
    const args = evalInstallRunArgs(input);
    expect(evalInstallArgProblems(args, input)).toEqual([]);
    expect(flag(args, "--network")).toEqual(["agentx-task"]);
    for (const absent of ["--env-file", "--ip", "--dns", "--publish", "-p", "--device", "--privileged", "--cap-add", "--volumes-from", "--mount"]) expect(args).not.toContain(absent);
    expect(flag(args, "--volume")).toEqual(["/scratch/run-1/checkout:/workspace:rw"]);
    expect(flag(args, "--user")).toEqual(["1000:1000"]);
    expect(flag(args, "--cap-drop")).toEqual(["ALL"]);
    expect(flag(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(args).toContain("--read-only");
    // Every model name goes to the dropped address; nothing points at a helper and the helper's own name is absent.
    const hosts = flag(args, "--add-host");
    expect(hosts.length).toBeGreaterThan(5);
    for (const host of hosts) expect(host.endsWith(":10.255.255.1")).toBe(true);
    expect(hosts.some(host => host.startsWith("rovara-models:"))).toBe(false);
    expect(installModelBlock().target).toBe("blackhole");
    // The only variables are two constants: nothing a run could carry a token in.
    expect(flag(args, "--env").sort()).toEqual(["HOME=/tmp", `PYTHONUSERBASE=${EVAL_PYTHON_USER_BASE}`]);
    expect(args.slice(args.indexOf(IMAGE))).toEqual([IMAGE, "--", "python3", "-m", "pip", "install", "-r", "requirements.txt"]);
    expect(flag(args, "--log-driver")).toEqual(["json-file"]);
    expect(flag(args, "--label").map(label => label.split("=")[0]).sort()).toEqual(["agentx.task", "agentx.workspace"]);
  });

  it("refuses (fixed sentence, nothing echoed) anything that would widen it", () => {
    const base = evalInstallRunArgs(input);
    const sneak = (extra: string[]): string[] => { const at = base.indexOf("--workdir"); return [...base.slice(0, at), ...extra, ...base.slice(at)]; };
    for (const extra of [["--env-file", "/x/env"], ["--network", "rvi-round"], ["--add-host", "api.example.com:10.0.0.1"], ["--add-host", "rovara-models:172.30.1.9"], ["--volume", "/etc:/etc:ro"], ["--cap-add", "NET_ADMIN"], ["--dns", "8.8.8.8"], ["--env", "TOKEN=abc"], ["--ip", "172.30.1.4"], ["--privileged"]]) {
      expect(evalInstallArgProblems(sneak(extra), input).length, extra.join(" ")).toBeGreaterThan(0);
    }
    expect(evalInstallArgProblems(base, { ...input, network: "other-net" }).length).toBeGreaterThan(0);
    expect(() => evalInstallRunArgs({ ...input, image: "rovara/worker:latest" })).toThrow("the eval install step's arguments are unsound");
    expect(() => evalInstallRunArgs({ ...input, network: "bad net" })).toThrow();
    expect(() => evalInstallRunArgs({ ...input, command: { executable: "pip", args: [], cwd: "../x" } })).toThrow();
  });

  it("works in the command's folder inside the checkout", () => {
    expect(flag(evalInstallRunArgs({ ...input, command: { ...input.command, cwd: "web" } }), "--workdir")).toEqual(["/workspace/web"]);
    expect(flag(evalInstallRunArgs(input), "--workdir")).toEqual(["/workspace"]);
  });
});
