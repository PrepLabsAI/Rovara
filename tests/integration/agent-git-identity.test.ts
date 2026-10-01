import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containerBashOperations, type ContainerExec } from "../../packages/worker/src/devcontainer.js";
import { agentShellTool } from "../../packages/worker/src/pi-session.js";

const run = promisify(execFile);
const IDENTITY = {
  GIT_AUTHOR_NAME: "AgentX",
  GIT_AUTHOR_EMAIL: "agentx@noreply.local",
  GIT_COMMITTER_NAME: "AgentX",
  GIT_COMMITTER_EMAIL: "agentx@noreply.local",
};

describe("the agent's shell has AgentX's git identity (#208)", () => {
  const saved: Record<string, string | undefined> = {};
  const isolated = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", ...Object.keys(IDENTITY)];

  beforeEach(async () => {
    for (const name of isolated) saved[name] = process.env[name];
    for (const name of Object.keys(IDENTITY)) delete process.env[name];
    // No identity in git's global or system config, as on a worker host, and no guessing one from
    // the user and host names: without the shell's identity, a commit fails.
    const global = join(await mkdtemp(join(tmpdir(), "agentx-gitconfig-")), "gitconfig");
    await writeFile(global, "[user]\n\tuseConfigOnly = true\n");
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  });

  afterEach(() => {
    for (const name of isolated) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("a commit in the agent's shell works and is authored and committed by AgentX", async () => {
    const repository = await mkdtemp(join(tmpdir(), "agentx-identity-"));
    await run("git", ["init", "--quiet", "--initial-branch=main", repository]);
    await writeFile(join(repository, "README.md"), "live test\n");

    const tool = agentShellTool(repository);
    await tool.execute("call-1", { command: "git add README.md && git commit --quiet -m 'add line'" }, undefined, undefined, undefined as never);

    const { stdout } = await run("git", ["-C", repository, "log", "-1", "--format=%an <%ae>|%cn <%ce>"]);
    expect(stdout.trim()).toBe("AgentX <agentx@noreply.local>|AgentX <agentx@noreply.local>");
  });

  it("a container shell (devcontainer) receives the same identity", async () => {
    let received: Record<string, string> | undefined;
    const exec: ContainerExec = async (_command, options) => {
      received = options.env;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const tool = agentShellTool("/mnt/workspace", containerBashOperations(exec));
    await tool.execute("call-1", { command: "git commit -am x" }, undefined, undefined, undefined as never);
    expect(received).toEqual(expect.objectContaining(IDENTITY));
    expect(received).not.toHaveProperty("HOME");
  });
});
