// Private packages P2a: the install step inside the worker's preparation. The company's registries go to the install container and NOT to the project's commands (N9's path is for CodeArtifact only); the step runs after the clone and before any
// command; a read-only preparation never runs it; a leak taints the workspace.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { StoredProjectDefinitionSchema, prepareRegistriesOfCompany } from "../../packages/contracts/src/index.js";
import { prepareWorkspace, type PreparationManifest, type RepositoryMaterializer } from "../../packages/worker/src/prepare.js";
import type { PrivateInstallOptions } from "../../packages/worker/src/private-install.js";
import { REGISTRY_CONFIG_PREFIX } from "../../packages/worker/src/registry-config.js";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";

const execFileAsync = promisify(execFile);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const canary = (): string => `ghp_${randomBytes(24).toString("base64url")}`;
const LOCK = JSON.stringify({ lockfileVersion: 3, packages: { x: { resolved: "https://npm.pkg.github.com/download/@acme/x/1.0.0/abc" } } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rovara-pi-prepare-"));
  const source = join(root, "api-source");
  await mkdir(source, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", source], { env: gitEnv });
  await writeFile(join(source, "package-lock.json"), LOCK);
  await execFileAsync("git", ["-C", source, "add", "-A"], { env: gitEnv });
  await execFileAsync("git", ["-C", source, "commit", "--quiet", "-m", "init"], { env: gitEnv });
  const materializer: RepositoryMaterializer = async (_repo, target) => { await execFileAsync("git", ["clone", "--quiet", "--no-checkout", pathToFileURL(source).href, target], { env: gitEnv }); };
  const secretsRoot = await mkdtemp(join(root, "secrets-"));
  const workspace = await mkdtemp(join(root, "ws-"));
  const events: string[] = [];
  const asked: string[] = [];
  const token = canary();
  const docker: DockerCli = {
    async run(args) {
      if (args[0] === "run") events.push("install-container");
      if (args[0] === "inspect") return { exitCode: 1, stdout: "", stderr: "Error: No such object" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const privateInstall: PrivateInstallOptions = {
    docker, image: "registry.example/worker@sha256:" + "a".repeat(64), operationId: "op-p", environment: { AGENTX_RUNTIME: "ec2" }, secretsRoot, assertTmpfs: () => Promise.resolve(), log: () => undefined,
    provider: (name) => { asked.push(name); return Promise.resolve({ token }); },
  };
  const project = StoredProjectDefinitionSchema.parse({
    name: "payments", revision: 1,
    repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [{ cwd: "repo/api", executable: "sh", args: ["-c", "true"], timeoutSeconds: 60 }], readiness: [], orchestratorInstructions: "x",
  });
  return { materializer, secretsRoot, workspace, events, asked, token, privateInstall, project };
}

describe("the install step inside the preparation", () => {
  it("runs after the clone and BEFORE the first setup command; the command sees no token folder, no registry config, no token variable", async () => {
    const f = await fixture();
    const seen: { folders: string[]; env: Record<string, string | undefined> } = { folders: ["unset"], env: {} };
    const manifest = await prepareWorkspace({
      rootPath: f.workspace, project: f.project, materializer: f.materializer, registries: prepareRegistriesOfCompany([{ host: "npm.pkg.github.com", scopes: ["@acme"] }]),
      registryCredentialProvider: (name) => { f.asked.push(`n9:${name}`); return Promise.resolve({ token: f.token }); }, privateInstall: f.privateInstall,
      commandRunner: async (command) => {
        f.events.push("setup-command");
        seen.folders = await readdir(f.secretsRoot);
        seen.env = { ...command.env };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(f.events).toEqual(["install-container", "setup-command"]);
    expect(seen.folders).toEqual([]);
    expect(seen.env).toEqual({});
    // N9's project-command path is not used for the company's registries: the token was asked for once, by the step.
    expect(f.asked).toEqual(["ghnpm-1"]);
    expect((await readdir(f.workspace)).filter((name) => name.startsWith(REGISTRY_CONFIG_PREFIX))).toEqual([]);
    expect(manifest.privateInstall?.map((entry) => [entry.repo, entry.outcome])).toEqual([["api", "installed"]]);
    // The manifest on disk says so too, and holds no token.
    const onDisk = await readFile(join(f.workspace, ".agentx", "preparation-manifest.json"), "utf8");
    expect((JSON.parse(onDisk) as PreparationManifest).privateInstall).toHaveLength(1);
    expect(onDisk).not.toContain(f.token);
  });

  describe("the token is asked for right before the install, after the clone, whatever the clone took", () => {
    const GRANT_LIFE_MS = 15 * 60_000;
    const CLONE_MS = 20 * 60_000;

    async function slowClone(provider: (clock: () => number, startedAt: number) => PrivateInstallOptions["provider"]) {
      const f = await fixture();
      let clock = 1_000_000;
      const startedAt = clock;
      const cloned: number[] = [];
      const slow: RepositoryMaterializer = async (repository, destination, credential) => { await f.materializer(repository, destination, credential); clock += CLONE_MS; cloned.push(clock); };
      const manifest = await prepareWorkspace({
        rootPath: f.workspace, project: f.project, materializer: slow, registries: prepareRegistriesOfCompany([{ host: "npm.pkg.github.com", scopes: ["@acme"] }]),
        registryCredentialProvider: () => Promise.resolve({ token: f.token }),
        privateInstall: { ...f.privateInstall, now: () => clock, provider: provider(() => clock, startedAt) },
        commandRunner: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      });
      return { f, manifest, cloned, startedAt, grantEnds: startedAt + GRANT_LIFE_MS, clockNow: () => clock };
    }

    it("a clone longer than the grant's life still installs: the credential is asked for after the clone and is fresh when it is used", async () => {
      const asked: number[] = [];
      const run = await slowClone((clock) => () => { asked.push(clock()); return Promise.resolve({ token: canary(), expiresAt: new Date(clock() + GRANT_LIFE_MS).toISOString() }); });
      expect(run.cloned[0]! - run.startedAt).toBeGreaterThan(GRANT_LIFE_MS);
      expect(asked).toHaveLength(1);
      expect(asked[0]!).toBeGreaterThanOrEqual(run.cloned[0]!);
      expect(run.manifest.privateInstall?.map((entry) => entry.outcome)).toEqual(["installed"]);
    });

    it("control: a credential taken before the clone would be past its life when the install needs it, and is refused", async () => {
      const early = canary();
      const run = await slowClone((_clock, startedAt) => () => Promise.resolve({ token: early, expiresAt: new Date(startedAt + GRANT_LIFE_MS).toISOString() }));
      expect(run.clockNow()).toBeGreaterThan(run.grantEnds);
      expect(run.manifest.privateInstall?.map((entry) => entry.outcome)).toEqual(["refused_unsafe_token"]);
      expect(run.f.events).toEqual([]);
    });
  });

  it("a read-only preparation (a pull request head) never installs private packages: no token asked, no container", async () => {
    const f = await fixture();
    await prepareWorkspace({
      rootPath: f.workspace, project: f.project, materializer: f.materializer, readOnly: true, registries: prepareRegistriesOfCompany([{ host: "npm.pkg.github.com", scopes: ["@acme"] }]),
      registryCredentialProvider: (name) => { f.asked.push(name); return Promise.resolve({ token: f.token }); }, privateInstall: f.privateInstall,
    });
    expect(f.events).toEqual([]);
    expect(f.asked).toEqual([]);
  });

  it("with no install options (a laptop, a test) the preparation is what it always was", async () => {
    const f = await fixture();
    const manifest = await prepareWorkspace({ rootPath: f.workspace, project: f.project, materializer: f.materializer, commandRunner: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) });
    expect(manifest.privateInstall).toBeUndefined();
    expect(f.events).toEqual([]);
  });

  it("a token found where the agent can read it taints the workspace, and no setup command runs", async () => {
    const f = await fixture();
    const leaking: DockerCli = {
      async run(args) {
        if (args[0] === "run") await writeFile(join(f.workspace, "stray.txt"), `//npm.pkg.github.com/:_authToken=${f.token}\n`);
        if (args[0] === "inspect") return { exitCode: 1, stdout: "", stderr: "Error: No such object" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    let ran = false;
    await expect(prepareWorkspace({
      rootPath: f.workspace, project: f.project, materializer: f.materializer, registries: prepareRegistriesOfCompany([{ host: "npm.pkg.github.com", scopes: ["@acme"] }]),
      registryCredentialProvider: () => Promise.resolve({ token: f.token }), privateInstall: { ...f.privateInstall, docker: leaking },
      commandRunner: () => { ran = true; return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); },
    })).rejects.toThrow(/left a package registry token|package registry token/u);
    expect(ran).toBe(false);
    const manifest = JSON.parse(await readFile(join(f.workspace, ".agentx", "preparation-manifest.json"), "utf8")) as PreparationManifest;
    expect(manifest.tainted).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(f.token);
    expect(await readdir(f.secretsRoot)).toEqual([]);
  });
});
