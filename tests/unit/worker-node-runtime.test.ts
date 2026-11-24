// Lane E (Node 24 per repo, use): a command in the task sandbox gets /opt/rovara/node/24/bin first on PATH only when the repository it runs in asks for Node 24. These tests run the real in-container
// wrapper (runContainerCommand / containerBashOperations) through bash on this machine, with a fake Node 24 folder standing in for the image's, so what they show is what `node -v` prints there.
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectCommand } from "@agentx/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containerBashOperations, runContainerCommand, type ContainerCommandOptions, type ContainerExec } from "../../packages/worker/src/devcontainer.js";
import { NODE_24_BIN, nodePathPrefixFor } from "../../packages/worker/src/node-runtime.js";
import { sandboxCommandOptions } from "../../packages/worker/src/task-sandbox.js";

let root: string;
let fakeBin: string;
/** What `node -v` prints here with nothing in front of PATH: the image's default Node, in a container. */
let baseline = "";
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentx-node24-")));
  fakeBin = join(root, "..", `fake-node24-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, "node"), "#!/bin/sh\necho v24-fake\n");
  await chmod(join(fakeBin, "node"), 0o755);
  baseline = (await runContainerCommand(local, root, command("."), undefined, {})).stdout.trim();
  expect(baseline).toMatch(/^v\d+\./u);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
});

const put = async (path: string, text: string): Promise<void> => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); };

/** A container that is this machine: the exec's `--env` values are the child's environment, the rest of the environment is ours. */
const local: ContainerExec = (command, options) => new Promise((resolve) => {
  const child = spawn(command[0]!, command.slice(1), { env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); options.onStdout?.(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); options.onStderr?.(chunk); });
  child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
});
const options = (): ContainerCommandOptions => ({ pathPrefixFor: (cwd) => nodePathPrefixFor(root, cwd, fakeBin) });
const command = (cwd: string, extra: Partial<ProjectCommand> = {}): ProjectCommand => ({ cwd, executable: "node", args: ["-v"], timeoutSeconds: 30, ...extra });
const nodeIn = async (cwd: string, extra: Partial<ProjectCommand> = {}): Promise<string> => (await runContainerCommand(local, root, command(cwd, extra), undefined, options())).stdout.trim();

describe("PATH for a project command", () => {
  it("puts Node 24 first for a repository that asks for it, and only for that repository", async () => {
    await put("wants24/.nvmrc", "24.21.0\n");
    await put("wants24/package.json", "{}");
    await put("plain/package.json", JSON.stringify({ name: "plain" }));
    await put("old/.nvmrc", "22\n");
    expect(await nodeIn("wants24")).toBe("v24-fake");
    expect(await nodeIn("plain")).toBe(baseline);
    expect(await nodeIn("old")).toBe(baseline);
  });

  it("each hint kind reaches the command", async () => {
    await put("a/.node-version", "24.1.0");
    await put("b/.tool-versions", "nodejs 24.20.0\n");
    await put("c/package.json", JSON.stringify({ volta: { node: "24.22.0" } }));
    await put("d/package.json", JSON.stringify({ engines: { node: ">=24" } }));
    await put("e/package.json", JSON.stringify({ engines: { node: ">=20" } }));
    expect(await Promise.all(["a", "b", "c", "d", "e"].map((cwd) => nodeIn(cwd)))).toEqual(["v24-fake", "v24-fake", "v24-fake", "v24-fake", baseline]);
  });

  it("a package inside the repository inherits the repository's hint, and its own hint wins", async () => {
    await put("repo/.nvmrc", "24");
    await put("repo/packages/app/package.json", JSON.stringify({ name: "app" }));
    await put("repo/packages/legacy/.nvmrc", "22");
    expect(await nodeIn("repo/packages/app")).toBe("v24-fake");
    expect(await nodeIn("repo/packages/legacy")).toBe(baseline);
    expect(await nodeIn("repo")).toBe("v24-fake");
  });

  it("a command that sets its own PATH keeps it, and the Python user site stays last on PATH", async () => {
    await put("wants24/.nvmrc", "24");
    const own = await runContainerCommand(local, root, command("wants24", { executable: "sh", args: ["-c", "echo $PATH"], env: { PATH: "/usr/bin:/bin" } }), undefined, options());
    expect(own.stdout.trim()).toBe("/usr/bin:/bin");
    const both = await runContainerCommand(local, root, command("wants24", { executable: "sh", args: ["-c", "echo $PATH"] }), undefined, { ...options(), pathSuffix: ["/suffix/bin"] });
    const parts = both.stdout.trim().split(":");
    expect(parts[0]).toBe(fakeBin);
    expect(parts.at(-1)).toBe("/suffix/bin");
  });

  it("a repository with no hint, or a hint file that is a link, or a hint no offered Node meets, gets the default", async () => {
    await put("none/README.md", "x");
    await put("outside/.nvmrc", "24");
    await mkdir(join(root, "linked"), { recursive: true });
    await symlink(join(root, "outside/.nvmrc"), join(root, "linked/.nvmrc"));
    await put("future/package.json", JSON.stringify({ engines: { node: ">=26" } }));
    expect(await Promise.all(["none", "linked", "future"].map((cwd) => nodeIn(cwd)))).toEqual([baseline, baseline, baseline]);
  });

  it("is no folders for a directory outside the workspace, and never throws", async () => {
    expect(await nodePathPrefixFor(root, tmpdir(), fakeBin)).toEqual([]);
    expect(await nodePathPrefixFor(root, join(root, "does-not-exist"), fakeBin)).toEqual([]);
    expect(await nodePathPrefixFor(join(root, "nope"), root, fakeBin)).toEqual([]);
  });
});

describe("the agent's shell and the sandbox's own options", () => {
  it("the agent's shell in a Node 24 repository gets it too", async () => {
    await put("wants24/.nvmrc", "24");
    await put("plain/x", "x");
    const ran = async (cwd: string): Promise<string> => {
      let out = "";
      await containerBashOperations(local, options()).exec("node -v", join(root, cwd), { onData: (data) => { out += data.toString(); }, env: {} });
      return out.trim();
    };
    expect(await ran("wants24")).toBe("v24-fake");
    expect(await ran("plain")).toBe(baseline);
  });

  it("sandboxCommandOptions (the working sandbox and the sealed round) asks for the image's Node 24 folder", async () => {
    await put("wants24/.nvmrc", "24");
    await put("plain/package.json", "{}");
    const shared = sandboxCommandOptions(root);
    expect(await shared.pathPrefixFor!(join(root, "wants24"))).toEqual([NODE_24_BIN]);
    expect(await shared.pathPrefixFor!(join(root, "plain"))).toEqual([]);
    expect(NODE_24_BIN).toBe("/opt/rovara/node/24/bin");
    expect(shared.pathSuffix).toEqual([join(root, ".agentx-python", "bin")]);
  });

  it("the in-container script puts the folder first, quoted", async () => {
    await put("wants24/.nvmrc", "24");
    const seen: string[][] = [];
    await runContainerCommand((argv) => { seen.push([...argv]); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); }, root, command("wants24"), undefined, sandboxCommandOptions(root));
    expect(seen[0]![2]).toContain(`export PATH='/opt/rovara/node/24/bin':"$PATH"; export PATH="$PATH":`);
  });
});
