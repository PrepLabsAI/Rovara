// A dev container on a laptop's worker: an image that is ready to run, started with the workspace mounted at its own path through the dev container tool's override config, which the Docker socket guard serves.
// A cloud worker (no sandbox network in its environment) is started exactly as before.
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDevcontainer, runDevcontainerCommand, type DevcontainerCli, type DevcontainerTarget } from "../../packages/worker/src/devcontainer.js";
import { containerProblems, localDevcontainerRefusal } from "../../packages/worker/src/devcontainer-policy.js";

const LOCAL = { AGENTX_SANDBOX_NETWORK: "rovara-snet-0123456789abcdef" } as const;

async function workspace(config: string): Promise<DevcontainerTarget> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-local-dc-")));
  await mkdir(join(root, "repo/sample/.devcontainer"), { recursive: true });
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, "repo/sample/.devcontainer/devcontainer.json"), config, "utf8");
  return { rootPath: root, workspaceFolder: join(root, "repo/sample"), configPath: join(root, "repo/sample/.devcontainer/devcontainer.json") };
}

function fakeCli() {
  const calls: string[][] = [];
  const overrideAtRead: Array<string | undefined> = [];
  let target: DevcontainerTarget | undefined;
  const cli: DevcontainerCli = {
    run: async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: args[0] === "up" ? '{"outcome":"success","containerId":"id-1","remoteUser":"node","remoteWorkspaceFolder":"/ws"}' : "ok", stderr: "" };
    },
    checks: {
      fullConfiguration: async () => { overrideAtRead.push(target?.overrideConfigPath); return { configuration: {}, mergedConfiguration: {} }; },
      inspect: async () => ({ Mounts: [] }),
      remove: async () => undefined,
    },
  };
  return { cli, calls, overrideAtRead, watch: (value: DevcontainerTarget) => { target = value; } };
}

describe("what a dev container may be on a laptop", () => {
  it.each([
    ["an image", { image: "node:22" }, undefined],
    ["an image with settings", { image: "node:22", postCreateCommand: "npm ci", remoteUser: "node" }, undefined],
    ["a build section", { build: { dockerfile: "Dockerfile" } }, "build"], ["a Dockerfile", { dockerFile: "Dockerfile" }, "dockerFile"], ["a build context", { image: "x", context: ".." }, "dockerFile"],
    ["features", { image: "node:22", features: { "ghcr.io/devcontainers/features/git:1": {} } }, "features"], ["no features, written empty", { image: "node:22", features: {} }, undefined],
    ["an empty build section", { image: "node:22", build: {} }, undefined],
  ])("%s", (_what, config, refusal) => {
    expect(localDevcontainerRefusal(config)).toBe(refusal);
  });

  it("is refused with a fixed sentence before anything starts, only on a laptop", async () => {
    const target = await workspace('{ "image": "node:22", "features": { "ghcr.io/devcontainers/features/git:1": {} } }');
    const { cli, calls } = fakeCli();
    await expect(ensureDevcontainer(cli, target, { environment: LOCAL })).rejects.toThrow(/needs an image build.*ready to run/su);
    expect(calls).toEqual([]);
    // A cloud worker builds it, as before.
    await expect(ensureDevcontainer(cli, target, { environment: { AGENTX_RUNTIME: "ec2" } })).resolves.toMatchObject({ containerId: "id-1" });
    expect(calls[0]![0]).toBe("up");
  });
});

describe("the start on a laptop", () => {
  it("gives the tool the project's config with the workspace and the repository at their own paths, and no second mount of the workspace", async () => {
    const target = await workspace('// the project\'s own\n{ "image": "node:22", "postCreateCommand": "npm ci", "remoteUser": "node", "workspaceFolder": "/elsewhere" }\n');
    const harness = fakeCli();
    harness.watch(target);
    await ensureDevcontainer(harness.cli, target, { environment: LOCAL });
    // The checks read the project's own config, as the tool would without the override.
    expect(harness.overrideAtRead).toEqual([undefined]);
    expect(target.overrideConfigPath).toBeTypeOf("string");
    const written = JSON.parse(await readFile(target.overrideConfigPath!, "utf8")) as Record<string, unknown>;
    expect(written).toEqual({ image: "node:22", postCreateCommand: "npm ci", remoteUser: "node", workspaceMount: `type=bind,source=${target.rootPath},target=${target.rootPath}`, workspaceFolder: target.workspaceFolder });
    expect(target.overrideConfigPath!.startsWith(join(target.rootPath, ".agentx"))).toBe(true);
    expect((await stat(target.overrideConfigPath!)).mode & 0o777).toBe(0o600);
    const up = harness.calls.find((args) => args[0] === "up")!;
    expect(up).toContain("--override-config");
    expect(up[up.indexOf("--override-config") + 1]).toBe(target.overrideConfigPath);
    expect(up.filter((arg) => arg.startsWith("type=bind,"))).toEqual([]);
    // Every later call for this target carries the override, so the tool finds the same container and the same folders.
    await runDevcontainerCommand(harness.cli, target, { cwd: "repo/sample", executable: "ls", args: [], timeoutSeconds: 5 });
    const exec = harness.calls.find((args) => args[0] === "exec")!;
    expect(exec).toContain("--override-config");
  });

  it("still refuses a workspace mount of the project's that reaches outside the workspace, before the override is made", async () => {
    const target = await workspace('{ "image": "node:22", "workspaceMount": "type=bind,source=/etc,target=/x" }');
    const harness = fakeCli();
    await expect(ensureDevcontainer(harness.cli, target, { environment: LOCAL })).rejects.toThrow(/workspaceMount/u);
    expect(target.overrideConfigPath).toBeUndefined();
    expect(harness.calls).toEqual([]);
  });

  it("starts a cloud worker as it always did: the config as the project wrote it, and the workspace mounted beside the tool's own", async () => {
    const target = await workspace('{ "image": "node:22" }');
    const harness = fakeCli();
    await ensureDevcontainer(harness.cli, target, { environment: { AGENTX_RUNTIME: "ec2", ...LOCAL } });
    expect(target.overrideConfigPath).toBeUndefined();
    const up = harness.calls.find((args) => args[0] === "up")!;
    expect(up).not.toContain("--override-config");
    expect(up).toContain(`type=bind,source=${target.rootPath},target=${target.rootPath}`);
    const bare = await workspace('{ "image": "node:22" }');
    const other = fakeCli();
    await ensureDevcontainer(other.cli, bare, { environment: {} });
    expect(bare.overrideConfigPath).toBeUndefined();
  });
});

describe("the worker's check of a started dev container", () => {
  const check = (SecurityOpt?: string[]) => containerProblems({ HostConfig: SecurityOpt === undefined ? {} : { SecurityOpt }, Mounts: [] }, { rootPath: "/work" });
  it("accepts no-new-privileges, the option the Docker guard forces, and refuses every other security option", () => {
    expect(check()).toEqual([]);
    expect(check(["no-new-privileges"])).toEqual([]);
    expect(check(["no-new-privileges:true"])).toEqual([]);
    expect(check(["no-new-privileges=true"])).toEqual([]);
    expect(check(["seccomp=unconfined"])).toEqual(["--security-opt"]);
    expect(check(["no-new-privileges", "apparmor=unconfined"])).toEqual(["--security-opt"]);
    expect(check(["no-new-privileges:false"])).toEqual(["--security-opt"]);
  });
});
