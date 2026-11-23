// Private packages P2a: the install step, end to end with a fake Docker. A canary token (built at run time, never a literal) is PLANTED in every case that says "never appears", and each of those cases also shows the token was really in play
// (the file the container is given, the scan that finds a copy), so a test that passes cannot be one that never looked.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { e2eSecretSpellings, prepareRegistriesOfCompany, type PrepareRegistry } from "../../packages/contracts/src/index.js";
import { assertNoInstallSecrets } from "../../packages/worker/src/install-secrets.js";
import { PACKAGE_CACHE_DIRECTORY, PACKAGE_CACHE_MARKER, packageCacheEnvironment } from "../../packages/worker/src/package-cache.js";
import { privateInstallApplies, runPrivateInstallStep, splitRegistries, type PrivateInstallEntry, type PrivateInstallInput, type PrivateInstallOptions } from "../../packages/worker/src/private-install.js";
import { RegistryTokenLeakError } from "../../packages/worker/src/registry-guard.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const execFileAsync = promisify(execFile);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const canary = (): string => `ghp_${randomBytes(24).toString("base64url")}`;
const LOCK_WITH_HOST = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/@acme/x": { version: "1.0.0", resolved: "https://npm.pkg.github.com/download/@acme/x/1.0.0/abc" } } }, null, 2);
const registries = (): PrepareRegistry[] => prepareRegistriesOfCompany([{ host: "npm.pkg.github.com", scopes: ["@acme"] }]);
const EC2 = { AGENTX_RUNTIME: "ec2" } as const;
const NO_SUCH = { exitCode: 1, stdout: "", stderr: "Error: No such object: x" };
const ok = { exitCode: 0, stdout: "", stderr: "" };

async function workspace(files: Record<string, string>, repoPath = "repo/web"): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rovara-private-install-")));
  const repo = join(root, repoPath);
  await mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repo], { env: gitEnv });
  for (const [name, text] of Object.entries(files)) await writeFile(join(repo, name), text);
  await execFileAsync("git", ["-C", repo, "add", "-A"], { env: gitEnv });
  await execFileAsync("git", ["-C", repo, "commit", "--quiet", "-m", "init"], { env: gitEnv });
  return { root, repo };
}

type RunReply = { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean };
interface RunContext { args: string[]; secretsDirectory: string; calls: number }
type RunInput = Omit<Partial<PrivateInstallInput>, "options"> & { options?: Partial<PrivateInstallOptions> };
interface Harness {
  calls: string[][];
  runs: RunContext[];
  logs: Array<Record<string, unknown>>;
  diagnostics: string[];
  asked: string[];
  sleeps: number[];
  secretsRoot: string;
  run(input?: RunInput): Promise<{ privateInstall?: PrivateInstallEntry[] }>;
}

async function harness(workspaceRoot: string, behaviour: {
  onRun?: (context: RunContext) => Promise<RunReply> | RunReply;
  ps?: string;
  networkCreate?: (attempt: number) => RunReply;
  inspect?: RunReply;
  token?: string;
  tokenError?: boolean;
} = {}): Promise<Harness> {
  const secretsRoot = await mkdtemp(join(tmpdir(), "rovara-install-root-"));
  const calls: string[][] = [];
  const runs: RunContext[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const diagnostics: string[] = [];
  const asked: string[] = [];
  const sleeps: number[] = [];
  let creates = 0;
  const docker: DockerCli = {
    async run(args) {
      calls.push([...args]);
      if (args[0] === "ps") return { ...ok, stdout: behaviour.ps ?? "" };
      if (args[0] === "network" && args[1] === "create") return { ...ok, ...(behaviour.networkCreate?.(creates++) ?? {}) };
      if (args[0] === "inspect") return behaviour.inspect ?? NO_SUCH;
      if (args[0] === "run") {
        const mount = args.find((value) => value.endsWith(":/run/rovara-install:ro"));
        const context: RunContext = { args: [...args], secretsDirectory: mount!.slice(0, -":/run/rovara-install:ro".length), calls: runs.length + 1 };
        runs.push(context);
        return { ...(await (behaviour.onRun?.(context) ?? ok)) };
      }
      return ok;
    },
  };
  const token = behaviour.token ?? canary();
  return {
    calls, runs, logs, diagnostics, asked, sleeps, secretsRoot,
    async run(input = {}) {
      const { options: extraOptions, ...rest } = input;
      const options: PrivateInstallOptions = {
        docker, image: "registry.example/worker@sha256:" + "a".repeat(64), operationId: "op-1", environment: EC2, secretsRoot, assertTmpfs: () => Promise.resolve(), hostCpus: 4, hostMemoryBytes: 8 * 1024 ** 3,
        provider: (name) => { asked.push(name); return behaviour.tokenError === true ? Promise.reject(new Error("no")) : Promise.resolve({ token }); },
        sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, log: (event) => { logs.push(event); }, ...extraOptions,
      };
      return runPrivateInstallStep({ options, readOnly: false, rootPath: workspaceRoot, repositories: [{ name: "web", path: "repo/web" }], registries: registries(), hasDevcontainer: false, previous: undefined, onDiagnostic: (message) => { diagnostics.push(message); }, ...rest });
    },
  };
}

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
async function filesCarrying(root: string, token: string): Promise<string[]> {
  const forms = e2eSecretSpellings(token).filter((form) => form.length >= 6);
  const found: string[] = [];
  for await (const path of walk(root)) {
    const text = (await readFile(path)).toString("latin1");
    if (forms.some((form) => text.includes(form))) found.push(path);
  }
  return found;
}

describe("when the step does nothing", () => {
  it("a repository that does not name the company's registry is left alone: no token fetched, no Docker call, no entry", async () => {
    const { root } = await workspace({ "package-lock.json": JSON.stringify({ packages: { x: { resolved: "https://registry.npmjs.org/x" } } }) });
    const h = await harness(root);
    expect(await h.run()).toEqual({});
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("no options (a laptop, a test) and a read-only preparation (a pull request head) never install; a saved-environment rebuild does", async () => {
    expect(privateInstallApplies(false, undefined)).toBe(false);
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root);
    expect(await runPrivateInstallStep({ options: undefined, readOnly: false, rootPath: root, repositories: [{ name: "web", path: "repo/web" }], registries: registries(), hasDevcontainer: false, previous: undefined, onDiagnostic: () => undefined })).toEqual({});
    expect(await h.run({ readOnly: true })).toEqual({});
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(privateInstallApplies(true, { savedEnvBuild: true } as PrivateInstallOptions)).toBe(true);
    const rebuilt = await h.run({ readOnly: true, options: { savedEnvBuild: true } });
    expect(rebuilt.privateInstall?.[0]?.outcome).toBe("installed");
  });

  it("a repository that needs a token the company has not set is 'untested: missing' at once: nothing is fetched or run", async () => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root);
    const result = await h.run({ registries: [] });
    expect(result.privateInstall).toEqual([{ repo: "web", host: "npm.pkg.github.com", manager: "npm", lockfileSha256: result.privateInstall![0]!.lockfileSha256, outcome: "untested_missing" }]);
    expect(result.privateInstall![0]!.lockfileSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.diagnostics).toEqual(["web: the company has no package token for this registry"]);
  });
});

describe("refusals are decided before any token is fetched", () => {
  const refusals: Array<[string, Record<string, string>, RunInput, string]> = [
    ["a devcontainer", { "package-lock.json": LOCK_WITH_HOST }, { hasDevcontainer: true }, "refused_devcontainer"],
    ["a laptop (not an EC2 worker)", { "package-lock.json": LOCK_WITH_HOST }, { options: { environment: {} } }, "refused_not_ec2"],
    ["no sandbox image", { "package-lock.json": LOCK_WITH_HOST }, { options: { image: "" } }, "refused_not_ec2"],
    ["pnpm", { "pnpm-lock.yaml": "host: npm.pkg.github.com" }, {}, "refused_manager_not_in_image"],
    ["Yarn Berry", { "yarn.lock": "__metadata:\n  version: 8\nx: npm.pkg.github.com\n" }, {}, "refused_manager_not_in_image"],
    ["two lockfiles", { "package-lock.json": LOCK_WITH_HOST, "yarn.lock": "x" }, {}, "refused_ambiguous_lockfile"],
    ["no lockfile", { ".npmrc": "@acme:registry=https://npm.pkg.github.com/\n" }, {}, "refused_no_lockfile"],
    ["an .npmrc that sets script-shell", { "package-lock.json": LOCK_WITH_HOST, ".npmrc": "script-shell=/tmp/evil.sh\n" }, {}, "refused_npmrc_key"],
    ["an .npmrc that reroutes the scope to another host", { "package-lock.json": LOCK_WITH_HOST, ".npmrc": "@acme:registry=https://registry.npmjs.org/\n" }, {}, "refused_npmrc_key"],
  ];
  it.each(refusals)("%s", async (_label, files, input, outcome) => {
    const { root } = await workspace(files);
    const h = await harness(root);
    const result = await h.run(input);
    expect(result.privateInstall?.[0]?.outcome).toBe(outcome);
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(await readdir(h.secretsRoot)).toEqual([]);
  });

  it("names the refused KEY and never its value", async () => {
    const value = canary();
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST, ".npmrc": `node-options=${value}\n` });
    const h = await harness(root);
    const result = await h.run();
    expect(result.privateInstall?.[0]).toMatchObject({ outcome: "refused_npmrc_key", detail: "node-options" });
    expect(JSON.stringify([result, h.diagnostics, h.logs])).not.toContain(value);
  });

  it("an .npmrc that is a link is refused, never read through", async () => {
    const { root, repo } = await workspace({ "package-lock.json": LOCK_WITH_HOST, "real": "loglevel=warn\n" });
    await symlink(join(repo, "real"), join(repo, ".npmrc"));
    const h = await harness(root);
    expect((await h.run()).privateInstall?.[0]?.outcome).toBe("refused_npmrc_key");
  });

  it("the machine has no private memory-only folder: refused, and no token is fetched", async () => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root);
    const result = await h.run({ options: { assertTmpfs: () => Promise.reject(new Error("not tmpfs")) } });
    expect(result.privateInstall?.[0]?.outcome).toBe("refused_no_secure_tmpfs");
    expect(h.asked).toEqual([]);
    expect(h.runs).toEqual([]);
  });

  it("a sandbox of this workspace that is already running stops the step before anything is made", async () => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root, { ps: "agentx-task-abc\n" });
    await expect(h.run()).rejects.toThrow(/sandbox of this workspace is already running/u);
    expect(h.asked).toEqual([]);
    expect(h.calls.every((call) => call[0] === "ps")).toBe(true);
  });
});

describe("the happy path, in order", () => {
  it("fetches the token once, writes it to the host folder, runs the container, removes the folder, then returns; the token is on disk ONLY during the run", async () => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    let during: { files: string[]; npmrc: string; guard: string } | undefined;
    const h = await harness(root, {
      async onRun(context) {
        const guard = await assertNoInstallSecrets(h.secretsRoot).then(() => "allowed", (error: Error) => error.message);
        during = { files: (await readdir(context.secretsDirectory)).sort(), npmrc: await readFile(join(context.secretsDirectory, "npmrc"), "utf8"), guard };
        return ok;
      },
    });
    const result = await h.run();
    const token = during!.npmrc.trim().split("=").at(-1)!;
    // The token really was in play.
    expect(token).toMatch(/^ghp_/u);
    expect(during!.files).toEqual(["empty", "npmrc", "yarnrc"]);
    expect(during!.npmrc).toBe(`@acme:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${token}\n`);
    // Every sandbox start path is refused while it is there (the central guard), and allowed again after.
    expect(during!.guard).toMatch(/package token file is still on this machine/u);
    await expect(assertNoInstallSecrets(h.secretsRoot)).resolves.toBeUndefined();
    expect(await readdir(h.secretsRoot)).toEqual([]);
    // The order of docker calls: look for sandboxes, make the bridge, run, confirm the container is gone, remove the bridge.
    expect(h.calls.map((call) => call.slice(0, 2).join(" ")).filter((word) => !word.startsWith("kill") && !word.startsWith("rm "))).toEqual(["ps --quiet", "network create", "run --rm", "inspect --format", "inspect --format", "network rm"]);
    expect(h.asked).toEqual(["ghnpm-1"]);
    expect(result.privateInstall).toEqual([{ repo: "web", host: "npm.pkg.github.com", manager: "npm", lockfileSha256: result.privateInstall![0]!.lockfileSha256, outcome: "installed" }]);
    expect(result.privateInstall![0]!.lockfileSha256).toMatch(/^[0-9a-f]{64}$/u);
    // The cache folder is there with no authentication in it, and the sandbox's commands now know it.
    expect((await readFile(join(root, PACKAGE_CACHE_DIRECTORY, ".gitignore"), "utf8")).trim()).toBe("*");
    expect((await stat(join(root, PACKAGE_CACHE_DIRECTORY, "npm"))).isDirectory()).toBe(true);
    expect(await readFile(join(root, PACKAGE_CACHE_DIRECTORY, PACKAGE_CACHE_MARKER), "utf8")).toBe("installed\n");
    expect(packageCacheEnvironment(root)).toEqual({ npm_config_cache: join(root, PACKAGE_CACHE_DIRECTORY, "npm"), npm_config_prefer_offline: "true", YARN_CACHE_FOLDER: join(root, PACKAGE_CACHE_DIRECTORY, "yarn1") });
    // The token is anywhere the agent can read: nowhere. Not in the workspace, the entries, the logs, the diagnostics, any docker argument.
    expect(await filesCarrying(root, token)).toEqual([]);
    expect(JSON.stringify([result, h.logs, h.diagnostics, h.calls])).not.toContain(token);
  });

  it("a workspace with no install has no cache variables: the sandbox's commands are unchanged", async () => {
    const { root } = await workspace({ "package-lock.json": "{}" });
    expect(packageCacheEnvironment(root)).toEqual({});
  });

  it("yarn 1 gets its rc (scopes and the one token line) and the repository's rc is not read", async () => {
    const { root } = await workspace({ "yarn.lock": "# yarn lockfile v1\n\n\"@acme/x@^1\":\n  resolved \"https://npm.pkg.github.com/download/@acme/x/1.0.0/abc\"\n" });
    let yarnrc = "";
    const h = await harness(root, { async onRun(context) { yarnrc = await readFile(join(context.secretsDirectory, "yarnrc"), "utf8"); return ok; } });
    const result = await h.run();
    expect(result.privateInstall?.[0]).toMatchObject({ manager: "yarn1", outcome: "installed" });
    const args = h.runs[0]!.args;
    expect(args).toContain("--no-default-rc");
    expect(args).toContain("--use-yarnrc");
    expect(args.join(" ")).toContain("/usr/local/bin/yarn install --frozen-lockfile --ignore-scripts");
    expect(yarnrc).toMatch(/^"@acme:registry" "https:\/\/npm\.pkg\.github\.com\/"\n"\/\/npm\.pkg\.github\.com\/:_authToken" "ghp_/u);
    expect(args.some((value) => value.endsWith("/.npmrc:ro"))).toBe(false);
  });

  it("a repository .npmrc with a ${NPM_TOKEN} auth line gets a DERIVED copy mounted over it, inside the container only; the host file is untouched", async () => {
    const original = "@acme:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=${NPM_TOKEN}\nengine-strict=true\n";
    const { root, repo } = await workspace({ "package-lock.json": LOCK_WITH_HOST, ".npmrc": original });
    let derived = "";
    let files: string[] = [];
    const h = await harness(root, { async onRun(context) { files = (await readdir(context.secretsDirectory)).sort(); derived = await readFile(join(context.secretsDirectory, files.find((name) => name.endsWith(".npmrc"))!), "utf8"); return ok; } });
    const result = await h.run();
    expect(result.privateInstall?.[0]?.outcome).toBe("installed");
    expect(await readFile(join(repo, ".npmrc"), "utf8")).toBe(original);
    expect(derived.match(/_authToken=/gu)).toHaveLength(1);
    expect(derived).not.toContain("${");
    expect(derived).toContain("engine-strict=true");
    expect(h.runs[0]!.args.some((value) => value === `${join(h.runs[0]!.secretsDirectory, files.find((name) => name.endsWith(".npmrc"))!)}:${join(repo, ".npmrc")}:ro`)).toBe(true);
  });
});

describe("what the registry answers decides the outcome, with no retry on the private signal", () => {
  const cases: Array<[string, RunReply[], string, number, number]> = [
    ["E401 from the host: the token was not accepted, once", [{ exitCode: 1, stdout: "", stderr: "npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/@acme%2fx" }], "untested_refused", 1, 0],
    ["E403 the same", [{ exitCode: 1, stdout: "", stderr: "npm error code E403\nnpm error 403 Forbidden - GET https://npm.pkg.github.com/@acme%2fx" }], "untested_refused", 1, 0],
    ["a host that is not on the install's egress list", [{ exitCode: 1, stdout: "", stderr: "npm error code ENOTFOUND\nnpm error getaddrinfo ENOTFOUND npm.pkg.github.com" }], "registry_unreachable", 1, 0],
    ["a network fault, retried ONCE", [{ exitCode: 1, stdout: "", stderr: "npm error code ETIMEDOUT" }, { exitCode: 1, stdout: "", stderr: "npm error code ETIMEDOUT" }], "failed_network", 2, 1],
    ["a network fault that the retry cures", [{ exitCode: 1, stdout: "", stderr: "npm error code ECONNRESET" }, ok], "installed", 2, 1],
    ["a container that ran out of time", [{ exitCode: null, stdout: "", stderr: "", timedOut: true }], "failed_timeout", 1, 0],
    ["a public registry's 401", [{ exitCode: 1, stdout: "", stderr: "npm error code E401\nnpm error 401 Unauthorized - GET https://registry.npmjs.org/x" }], "failed_public_registry", 1, 0],
  ];
  it.each(cases)("%s", async (_label, replies, outcome, runs, sleeps) => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root, { onRun: (context) => replies[context.calls - 1] ?? replies.at(-1)! });
    const result = await h.run();
    expect(result.privateInstall?.[0]?.outcome).toBe(outcome);
    expect(h.runs).toHaveLength(runs);
    expect(h.sleeps).toEqual(sleeps === 0 ? [] : [10_000]);
    // A per-repository outcome is recorded and never thrown; the token is gone whatever the outcome.
    expect(await readdir(h.secretsRoot)).toEqual([]);
  });

  it("a registry that echoes the Authorization header in its error body: the output is scrubbed before anything reads it", async () => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root, {
      onRun: async (context) => {
        const token = (await readFile(join(context.secretsDirectory, "npmrc"), "utf8")).trim().split("=").at(-1)!;
        return { exitCode: 1, stdout: "", stderr: `npm error 401 Unauthorized - GET https://npm.pkg.github.com/x - {"authorization":"Bearer ${token}","again":"${Buffer.from(token).toString("base64")}"}` };
      },
    });
    const result = await h.run();
    expect(result.privateInstall?.[0]?.outcome).toBe("untested_refused");
    expect(h.runs[0]!.args.join(" ")).not.toMatch(/ghp_/u);
    expect(JSON.stringify([result, h.logs, h.diagnostics])).not.toMatch(/ghp_|Bearer/u);
  });

  it("the broker would not give the token, or gave one the step cannot write safely: a fixed outcome, nothing run", async () => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const failing = await harness(root, { tokenError: true });
    expect((await failing.run()).privateInstall?.[0]?.outcome).toBe("failed_token_unavailable");
    for (const bad of ["ghp_ has a space inside it", "short", "ghp_\nsecond-line-setting=1"]) {
      const h = await harness(root, { token: bad });
      expect((await h.run()).privateInstall?.[0]?.outcome).toBe("refused_unsafe_token");
      expect(h.runs).toEqual([]);
    }
  });

  it("an expired token is refused", async () => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root);
    const result = await h.run({ options: { provider: () => Promise.resolve({ token: canary(), expiresAt: new Date(Date.now() - 1_000).toISOString() }) } });
    expect(result.privateInstall?.[0]?.outcome).toBe("refused_unsafe_token");
  });

  it("the bridge's /24 is retried at the next slot when another run holds it", async () => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root, { networkCreate: (attempt) => (attempt === 0 ? { exitCode: 1, stdout: "", stderr: "Error response from daemon: Pool overlaps with other one on this address space" } : ok) });
    expect((await h.run()).privateInstall?.[0]?.outcome).toBe("installed");
    expect(h.calls.filter((call) => call[0] === "network" && call[1] === "create")).toHaveLength(2);
  });
});

describe("the fail-closed cases throw and taint; the token is gone anyway", () => {
  const plant = async (path: string, token: string): Promise<void> => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, `//npm.pkg.github.com/:_authToken=${token}\n`); };
  async function leakCase(where: (root: string, repo: string) => string): Promise<{ error: unknown; h: Harness }> {
    const { root, repo } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root, { async onRun(context) { await plant(where(root, repo), (await readFile(join(context.secretsDirectory, "npmrc"), "utf8")).trim().split("=").at(-1)!); return ok; } });
    const error = await h.run().then(() => undefined, (caught: unknown) => caught);
    return { error, h };
  }

  it.each([
    ["a copy in node_modules (a package's own .npmrc)", (_root: string, repo: string) => join(repo, "node_modules", "@acme", "x", ".npmrc")],
    ["a copy in the package cache", (root: string) => join(root, PACKAGE_CACHE_DIRECTORY, "npm", "_cacache", "index-v5", "ab")],
    ["a copy at the workspace root", (root: string) => join(root, "stray.txt")],
    ["a copy in an ignored file of the repository", (_root: string, repo: string) => join(repo, ".env.local")],
  ])("%s: RegistryTokenLeakError, the folder and the bridge are removed", async (_label, where) => {
    const { error, h } = await leakCase(where);
    expect(error).toBeInstanceOf(RegistryTokenLeakError);
    expect(await readdir(h.secretsRoot)).toEqual([]);
    expect(h.calls.some((call) => call[0] === "network" && call[1] === "rm")).toBe(true);
    expect((error as Error).message).not.toMatch(/ghp_/u);
  });

  it("a tracked file the install changed: failed, tainted", async () => {
    const { root, repo } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root, { async onRun() { await writeFile(join(repo, "package-lock.json"), `${LOCK_WITH_HOST}\n`); return ok; } });
    await expect(h.run()).rejects.toBeInstanceOf(RegistryTokenLeakError);
    expect(await readdir(h.secretsRoot)).toEqual([]);
  });

  it("a commit the install made: tainted", async () => {
    const { root, repo } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root, { async onRun() { await execFileAsync("git", ["-C", repo, "commit", "--quiet", "--allow-empty", "-m", "x"], { env: gitEnv }); return ok; } });
    await expect(h.run()).rejects.toBeInstanceOf(RegistryTokenLeakError);
  });

  it("a container that cannot be confirmed gone: tainted (it may still hold the token and write the workspace)", async () => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root, { inspect: { exitCode: 0, stdout: "abc123\n", stderr: "" } });
    await expect(h.run()).rejects.toBeInstanceOf(RegistryTokenLeakError);
    expect(await readdir(h.secretsRoot)).toEqual([]);
  });

  it("a docker run that throws still removes the folder first", async () => {
    const { root } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const h = await harness(root, { onRun: () => { throw new Error("daemon went away"); } });
    const result = await h.run();
    expect(result.privateInstall?.[0]?.outcome).toBe("failed_unknown");
    expect(await readdir(h.secretsRoot)).toEqual([]);
  });
});

describe("a resumed preparation", () => {
  it("does not install again a repository that is installed at the same lockfile; a changed lockfile or a missing node_modules installs again", async () => {
    const { root, repo } = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const first = await harness(root);
    const done = (await first.run()).privateInstall!;
    await mkdir(join(repo, "node_modules"), { recursive: true });
    const again = await harness(root);
    const resumed = await again.run({ previous: done });
    expect(resumed.privateInstall).toEqual(done);
    expect(again.asked).toEqual([]);
    expect(again.calls).toEqual([]);
    const changedLockfile = await harness(root);
    expect((await changedLockfile.run({ previous: [{ ...done[0]!, lockfileSha256: "0".repeat(64) }] })).privateInstall?.[0]?.outcome).toBe("installed");
    expect(changedLockfile.runs).toHaveLength(1);
    const noModules = await workspace({ "package-lock.json": LOCK_WITH_HOST });
    const missing = await harness(noModules.root);
    await missing.run({ previous: done });
    expect(missing.runs).toHaveLength(1);
  });
});

describe("the registries are split by who holds the credential", () => {
  it("GitHub Packages entries are the install step's; CodeArtifact keeps N9's project-command path; none is lost", () => {
    const company = registries();
    const codeartifact: PrepareRegistry = { name: "internal-npm", kind: "codeartifact", format: "npm", url: "https://acme-123456789012.d.codeartifact.us-west-2.amazonaws.com/npm/shared/" };
    const split = splitRegistries([...company, codeartifact]);
    expect(split.company).toEqual(company);
    expect(split.others).toEqual([codeartifact]);
    expect(splitRegistries(undefined)).toEqual({ company: [], others: [] });
  });
});

describe("the worker says it has the install step only when the step is wired", () => {
  const source = async (path: string): Promise<string> => readFile(new URL(`../../packages/worker/src/${path}`, import.meta.url), "utf8");

  it("lists prepare.registries.companyInstallStep.v1 (exactly that name) and the invocation schema knows it", async () => {
    const { WORKER_IMPLEMENTED_FEATURES } = await import("../../packages/worker/src/implemented-features.js");
    const { WORKER_INVOCATION_FEATURES } = await import("../../packages/contracts/src/index.js");
    expect(WORKER_IMPLEMENTED_FEATURES as readonly string[]).toContain("prepare.registries.companyInstallStep.v1");
    expect(WORKER_INVOCATION_FEATURES as readonly string[]).toContain("prepare.registries.companyInstallStep.v1");
  });

  it("the feature is backed by wiring: main.ts hands every prepare the install options, and prepare runs the step before any devcontainer, test service or project command", async () => {
    const main = await source("main.ts");
    expect(main).toContain("privateInstall: privateInstallOptionsFor(");
    const prepare = await source("prepare.ts");
    const step = prepare.indexOf("await runPrivateInstallStep(");
    expect(step).toBeGreaterThan(0);
    for (const later of ["await ensureDevcontainer(", "await startPrepareTestServices(", "await run(command, index, canonicalRoot)", "await evaluateReadiness("]) {
      expect(prepare.indexOf(later), later).toBeGreaterThan(step);
    }
    // The company's registries never reach N9's project-command path.
    expect(prepare).toContain("registries: projectRegistries");
    expect(prepare).not.toMatch(/registries:\s*options\.registries/u);
  });

  it("every sandbox start path calls the central guard", async () => {
    for (const file of ["task-sandbox.ts", "devcontainer.ts", "setup-network.ts", "test-services-run.ts"]) {
      expect(await source(file), file).toContain("assertNoInstallSecrets(");
    }
  });
});
