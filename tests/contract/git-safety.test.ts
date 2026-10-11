import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentXError } from "@agentx/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishWorkspaceDiff, repositoriesFingerprint } from "../../packages/worker/src/artifacts.js";
import { gitHardenedEnvironment, HARDENED_GIT_CONFIG, projectCommandEnvironment } from "../../packages/worker/src/git.js";
import {
  assertCredentialFreeRemote,
  assertNonForceGitArguments,
  runGitWithCredential,
} from "../../packages/worker/src/git-auth.js";

const execFile = promisify(execFileCallback);
const directories: string[] = [];
/** A host that cannot resolve: no test here may reach, or ask a credential for, a real one. */
const FAKE_HOST = "agentx.invalid";

// No real credential helper, global or system config, or HOME may take part in these tests.
beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "agentx-git-home-"));
  directories.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentx-git-hardening-"));
  directories.push(directory);
  await execFile("git", ["-C", directory, "init", "--quiet"]);
  return directory;
}

async function setConfig(directory: string, entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
  for (const [key, value] of entries) await execFile("git", ["-C", directory, "config", "--add", key, value]);
}

/** A config key as `git config --name-only` prints it: section and variable lowercased, subsection as written. */
function canonicalKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === last) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

function settingsOf(environment: NodeJS.ProcessEnv): Array<[string | undefined, string | undefined]> {
  return Array.from({ length: Number(environment.GIT_CONFIG_COUNT) }, (_, index) =>
    [environment[`GIT_CONFIG_KEY_${index}`], environment[`GIT_CONFIG_VALUE_${index}`]]);
}

describe("workspace Git mount safety", () => {
  it("scopes safe.directory to the repository, forces the hardened settings and drops the worker's Git redirections", async () => {
    vi.stubEnv("GIT_DIR", "/elsewhere/.git");
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'core.fsmonitor'='touch /tmp/x'");
    vi.stubEnv("GIT_SSH_COMMAND", "touch /tmp/x");
    vi.stubEnv("GIT_ALLOW_PROTOCOL", "file:ext");
    // A clone destination that does not exist yet has no repository config: the static hardening alone.
    const directory = join(tmpdir(), `agentx-missing-${randomUUID()}`, "repo");
    const environment = await gitHardenedEnvironment(directory, { STEP: "1", GIT_CONFIG_GLOBAL: "/home/user/.gitconfig" });
    for (const name of ["GIT_DIR", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND", "GIT_ALLOW_PROTOCOL", "GIT_WORK_TREE"]) {
      expect(environment[name]).toBeUndefined();
    }
    expect(environment).toMatchObject({ STEP: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
    expect(settingsOf(environment)).toEqual([["safe.directory", directory], ...HARDENED_GIT_CONFIG]);
  });

  it("gives a project command the worker's own Git settings with only the safe directory added", () => {
    vi.stubEnv("GIT_SSH_COMMAND", "ssh -i /keys/deploy");
    vi.stubEnv("GIT_ASKPASS", "/usr/local/bin/askpass");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/home/worker/.gitconfig");
    const environment = projectCommandEnvironment("/mnt/workspace/repo/example", { STEP: "1" });
    expect(environment).toMatchObject({
      STEP: "1",
      GIT_SSH_COMMAND: "ssh -i /keys/deploy",
      GIT_ASKPASS: "/usr/local/bin/askpass",
      GIT_CONFIG_GLOBAL: "/home/worker/.gitconfig",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/mnt/workspace/repo/example",
    });
  });

  it("overrides every driver, hook, signing program and transport the repository configures", async () => {
    const directory = await repository();
    const evil = "touch /tmp/agentx-evil";
    await setConfig(directory, [
      ["filter.evil.clean", evil], ["filter.evil.required", "true"], ["filter.two.part.smudge", evil], ["filter.lfs.clean", evil],
      ["merge.evil.driver", evil], ["diff.tc.textconv", evil], ["diff.tc.command", evil],
      ["protocol.ext.allow", "always"], ["protocol.file.allow", "always"],
      ["core.fsmonitor", evil], ["core.hooksPath", ".githooks"], ["credential.helper", `!${evil}`], ["core.sshCommand", evil],
      ["commit.gpgSign", "true"], ["gpg.program", evil], ["gpg.ssh.program", evil], ["gc.auto", "1"], ["submodule.recurse", "true"],
    ]);
    const env = await gitHardenedEnvironment(directory);
    // `--get` prints the last value, the one Git uses.
    const effective = async (key: string): Promise<string> =>
      (await execFile("git", ["-C", directory, "config", "--get", key], { env, encoding: "utf8" })).stdout.replace(/\n$/u, "");
    expect(await effective("filter.evil.clean")).toBe("");
    expect(await effective("filter.evil.required")).toBe("false");
    expect(await effective("filter.two.part.smudge")).toBe("");
    expect(await effective("filter.two.part.process")).toBe("");
    expect(await effective("filter.lfs.clean")).toBe("git-lfs clean -- %f");
    expect(await effective("filter.lfs.required")).toBe("true");
    expect(await effective("merge.evil.driver")).toBe("git merge-file --marker-size=%L %A %O %B");
    expect(await effective("diff.tc.textconv")).toBe("");
    expect(await effective("diff.tc.command")).toBe("");
    expect(await effective("protocol.ext.allow")).toBe("never");
    expect(await effective("protocol.file.allow")).toBe("never");
    expect(await effective("core.fsmonitor")).toBe("false");
    expect(await effective("core.hooksPath")).toBe("/dev/null");
    expect(await effective("credential.helper")).toBe("");
    expect(await effective("core.sshCommand")).toBe("false");
    expect(await effective("commit.gpgSign")).toBe("false");
    expect(await effective("gpg.program")).toBe("/dev/null");
    expect(await effective("gpg.ssh.program")).toBe("/dev/null");
    expect(await effective("gc.auto")).toBe("0");
    expect(await effective("submodule.recurse")).toBe("false");
    expect(env.GIT_WORK_TREE).toBe(directory);
  });

  it("never asks the repository's credential helpers, generic or URL-scoped, for a credential", async () => {
    // Only the repository's helpers could answer (HOME and system config are isolated above), for a host that does not exist.
    const directory = await repository();
    const marker = join(directory, "..", `agentx-credential-${randomUUID()}`);
    await setConfig(directory, [
      ["credential.helper", `!touch ${marker}.generic; echo password=stolen #`],
      [`credential.https://${FAKE_HOST}.helper`, `!touch ${marker}.scoped; echo password=stolen #`],
    ]);
    const env = await gitHardenedEnvironment(directory);
    // What Git does before it sends a password: ask every configured helper, then prompt (off here).
    const fill = spawnSync("git", ["-C", directory, "credential", "fill"], { env, input: `protocol=https\nhost=${FAKE_HOST}\n\n`, encoding: "utf8" });
    expect(fill.stdout).not.toContain("stolen");
    for (const suffix of [".generic", ".scoped"]) await expect(access(`${marker}${suffix}`)).rejects.toThrow();
  });

  const registered = `https://${FAKE_HOST}/example/repo.git`;
  it.each([
    ["url.https://attacker.invalid/.insteadOf", `https://${FAKE_HOST}/`],
    ["url.https://attacker.invalid/.pushInsteadOf", `https://${FAKE_HOST}/`],
    [`http.https://${FAKE_HOST}/.proxy`, "http://attacker.invalid:8080"],
    ["http.sslVerify", "false"],
    // Git treats any URL as a possible remote name, so these redirect a fetch or push to the registered URL.
    [`remote.${registered}.pushurl`, "https://attacker.invalid/repo.git"],
    [`remote.${registered}.url`, "https://attacker.invalid/repo.git"],
    [`remote.${registered}.proxy`, "http://attacker.invalid:8080"],
    ["remote.origin.pushurl", "https://attacker.invalid/repo.git"],
    // A partial clone fetches missing objects lazily from its promisor remote, with the token.
    ["extensions.partialClone", "origin"],
    ["remote.origin.promisor", "true"],
  ] as const)("refuses a network call, naming %s to unset, when the repository's config could redirect it", async (key, value) => {
    const directory = await repository();
    await setConfig(directory, [["remote.origin.url", registered], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], [key, value]]);
    const refusal = await runGitWithCredential({
      directory,
      args: ["-C", directory, "ls-remote", registered],
      credential: { token: "push-token" },
    }).then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(AgentXError);
    expect((refusal as AgentXError).code).toBe("CONFIG_INVALID");
    expect((refusal as AgentXError).message).toContain(canonicalKey(key));
    expect((refusal as AgentXError).message).toMatch(/Unset them/);
  });

  it("accepts the remote settings a clone AgentX made has", async () => {
    const directory = await repository();
    await setConfig(directory, [["remote.origin.url", "https://example.invalid/repo.git"], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]]);
    await expect(gitHardenedEnvironment(directory, {}, { network: true })).resolves.toMatchObject({ GIT_WORK_TREE: directory });
  });
});

describe("AgentX's reads of the agent's repository after each turn", () => {
  it("runs none of the repository's filters, textconv or diff commands, nor a nested repository's filters", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-turn-diff-"));
    directories.push(root);
    const directory = join(root, "repo", "demo");
    await mkdir(directory, { recursive: true });
    const run = (cwd: string, ...args: string[]) => execFile("git", ["-C", cwd, "-c", "user.email=a@example.invalid", "-c", "user.name=A", ...args]);
    await run(directory, "init", "--quiet");
    await writeFile(join(directory, "notes.txt"), "1\n");
    const nested = join(directory, "nested");
    await mkdir(nested);
    await run(nested, "init", "--quiet");
    await writeFile(join(nested, "inner.txt"), "s\n");
    await run(nested, "add", "inner.txt");
    await run(nested, "commit", "--quiet", "-m", "inner");
    await run(directory, "add", "notes.txt", "nested");
    await run(directory, "commit", "--quiet", "-m", "base");
    const resolvedCommit = (await execFile("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();

    const marker = join(root, `agentx-ran-${randomUUID()}`);
    await setConfig(directory, [
      ["filter.evil.clean", `sh -c 'touch ${marker}.clean; cat'`],
      ["diff.tc.textconv", `sh -c 'touch ${marker}.textconv; cat "$0"'`],
      ["diff.tc.command", `sh -c 'touch ${marker}.command'`],
      ["core.fsmonitor", `sh -c 'touch ${marker}.fsmonitor'`],
    ]);
    await writeFile(join(directory, ".gitattributes"), "notes.txt filter=evil diff=tc\n");
    // The same size as before, so Git must hash each file (through any filter) to see that it changed.
    await writeFile(join(directory, "notes.txt"), "2\n");
    await setConfig(nested, [["filter.inner.clean", `sh -c 'touch ${marker}.nested; cat'`]]);
    await writeFile(join(nested, ".gitattributes"), "*.txt filter=inner\n");
    await writeFile(join(nested, "inner.txt"), "t\n");

    await repositoriesFingerprint([{ name: "demo", directory }]);
    await mkdir(join(root, ".agentx"));
    await writeFile(join(root, ".agentx", "preparation-manifest.json"), JSON.stringify({
      repositories: [{ name: "demo", path: "repo/demo", resolvedCommit }],
    }));
    const artifacts: string[] = [];
    const { changed } = await publishWorkspaceDiff(root, async (artifact) => { artifacts.push(String(artifact.content)); });

    expect(changed).toBe(true);
    expect(artifacts[0]).toContain("+2");
    const ran = (await readdir(root)).filter((name) => name.startsWith("agentx-ran-"));
    expect(ran).toEqual([]);
  });
});

describe("credential-safe Git execution", () => {
  it("rejects credential-bearing remotes", () => {
    expect(() => assertCredentialFreeRemote("https://token@github.com/example/repo.git")).toThrow(
      /must not contain credentials/,
    );
  });

  it("does not require credentials for local Git commands", async () => {
    const result = await runGitWithCredential({
      directory: await repository(),
      args: ["--version"],
    });
    expect(result.stdout).toMatch(/^git version /);
  });

  it("rejects incomplete HTTP credentials before invoking Git", async () => {
    await expect(runGitWithCredential({
      directory: process.cwd(),
      args: ["--version"],
      credential: { username: "x-access-token" },
    })).rejects.toThrow(/both username and password/);
  });

  it("rejects every force-like push argument and refspec", () => {
    for (const args of [
      ["push", "--force", "origin", "HEAD:refs/heads/agentx/example"],
      ["push", "--force-with-lease", "origin", "HEAD:refs/heads/agentx/example"],
      ["push", "-f", "origin", "HEAD:refs/heads/agentx/example"],
      ["push", "origin", "+HEAD:refs/heads/agentx/example"],
      ["push", "origin", "HEAD:+refs/heads/agentx/example"],
      ["-C", "/mnt/workspace/repo/example", "push", "--force", "origin", "HEAD:refs/heads/agentx/example"],
    ]) {
      expect(() => assertNonForceGitArguments(args)).toThrow(/force push/i);
    }
    expect(() => assertNonForceGitArguments([
      "push",
      "--porcelain",
      "origin",
      "HEAD:refs/heads/agentx/example",
    ])).not.toThrow();
  });
});
