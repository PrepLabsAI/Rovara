import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectDefinitionSchema, type ProjectDefinition, type WorkerInvocation } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  devcontainerBashOperations,
  devcontainerTarget,
  ensureDevcontainer,
  preparedDevcontainerTarget,
  runDevcontainerCommand,
  type DevcontainerCli,
  type DevcontainerProcess,
} from "../../packages/worker/src/devcontainer.js";
import { TIMEOUT_KILL_GRACE_MS, runCollected, tailCollector } from "../../packages/worker/src/collected-process.js";
import type { PiSessionAdapter, PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

const run = promisify(execFile);
const UP_OUTPUT = [
  "{\"type\":\"text\",\"level\":2,\"text\":\"Resolving Remote\"}",
  "{\"outcome\":\"success\",\"containerId\":\"f832494aef96\",\"remoteUser\":\"node\",\"remoteWorkspaceFolder\":\"/workspaces/sample\"}",
].join("\n");

/** A fake `devcontainer` CLI: `up` succeeds, and `exec` answers with `execResult`. */
function fakeCli(execResult: (args: readonly string[]) => DevcontainerProcess = () => ({ exitCode: 0, stdout: "", stderr: "" })) {
  const calls: string[][] = [];
  const options: Array<Parameters<DevcontainerCli["run"]>[1]> = [];
  const cli: DevcontainerCli = {
    run: (args, runOptions) => {
      calls.push([...args]);
      options.push(runOptions);
      return Promise.resolve(args[0] === "up" ? { exitCode: 0, stdout: UP_OUTPUT, stderr: "" } : execResult(args));
    },
  };
  return { cli, calls, options };
}

describe("project definitions with a devcontainer", () => {
  it("accept a devcontainer on a registered repository, and refuse an unknown one or an escaping path", () => {
    const base = sampleProject("https://github.com/PrepLabsAI/Sample-Project-A.git");
    expect(ProjectDefinitionSchema.parse(base).devcontainer).toEqual({ repository: "sample" });
    expect(() => ProjectDefinitionSchema.parse({ ...base, devcontainer: { repository: "other" } })).toThrow(/unregistered repository other/);
    expect(() => ProjectDefinitionSchema.parse({ ...base, devcontainer: { repository: "sample", configPath: "../x.json" } })).toThrow();
    expect(() => ProjectDefinitionSchema.parse({ ...base, devcontainer: { repository: "sample", image: "x" } })).toThrow();
  });
});

describe("the devcontainer CLI seam", () => {
  const target = { rootPath: "/mnt/workspace", workspaceFolder: "/mnt/workspace/repo/sample", configPath: "/mnt/workspace/repo/sample/.devcontainer/devcontainer.json" };

  it("targets the repository and its config, defaulting the config path, and refuses paths outside them", () => {
    expect(devcontainerTarget("/mnt/workspace", sampleProject("https://github.com/o/r.git"))).toEqual(target);
    expect(devcontainerTarget("/mnt/workspace", { ...sampleProject("https://github.com/o/r.git"), devcontainer: undefined })).toBeUndefined();
    expect(() => preparedDevcontainerTarget("/mnt/workspace", {
      devcontainer: { repository: "sample", configPath: "../etc/devcontainer.json" },
      repositories: [{ name: "sample", path: "repo/sample" }],
    })).toThrow(/escapes/);
  });

  it("starts the devcontainer with the whole workspace mounted at the same path, and reports a failed start", async () => {
    const { cli, calls } = fakeCli();
    await expect(ensureDevcontainer(cli, target)).resolves.toEqual({ containerId: "f832494aef96", remoteUser: "node", remoteWorkspaceFolder: "/workspaces/sample" });
    expect(calls[0]).toEqual([
      "up", "--workspace-folder", target.workspaceFolder, "--config", target.configPath,
      "--mount", "type=bind,source=/mnt/workspace,target=/mnt/workspace", "--log-format", "json",
    ]);
    const failing: DevcontainerCli = {
      run: async () => ({ exitCode: 1, stdout: "{\"outcome\":\"error\",\"message\":\"Command failed\",\"description\":\"image not found\"}", stderr: "" }),
    };
    await expect(ensureDevcontainer(failing, target)).rejects.toThrow("devcontainer did not start: Command failed: image not found");
  });

  it("says a devcontainer start timed out, and after how long (#154 review)", async () => {
    const stuck: DevcontainerCli = { run: async () => ({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" }) };
    await expect(ensureDevcontainer(stuck, target)).rejects.toThrow("devcontainer did not start: timed out after 20 min");
  });

  it("runs a project command in its directory inside the devcontainer", async () => {
    const { cli, calls, options } = fakeCli(() => ({ exitCode: 3, stdout: "out", stderr: "err" }));
    const result = await runDevcontainerCommand(cli, target, { cwd: "repo/sample/apps", executable: "npm", args: ["run", "test"], timeoutSeconds: 60 });
    expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
    expect(calls[0]).toEqual([
      "exec", "--workspace-folder", target.workspaceFolder, "--config", target.configPath,
      "sh", "-c", 'cd -- "$1" && shift && exec "$@"', "sh", "/mnt/workspace/repo/sample/apps", "npm", "run", "test",
    ]);
    expect(options[0]).toEqual({ timeoutMs: 60_000 });
    await expect(runDevcontainerCommand(cli, target, { cwd: "../outside", executable: "true", args: [], timeoutSeconds: 1 })).rejects.toThrow(/escapes/);
  });

  it("passes a project command's env into the devcontainer as --remote-env (#54)", async () => {
    const { cli, calls } = fakeCli();
    await runDevcontainerCommand(cli, target, {
      cwd: "repo/sample", executable: "npm", args: ["ci"], timeoutSeconds: 60, env: { NODE_ENV: "test", JAVA_OPTS: "-Xmx2g -Da=b=c", EMPTY_OK: "" },
    });
    expect(calls[0]).toEqual([
      "exec", "--workspace-folder", target.workspaceFolder, "--config", target.configPath,
      "--remote-env", "NODE_ENV=test", "--remote-env", "JAVA_OPTS=-Xmx2g -Da=b=c", "--remote-env", "EMPTY_OK=",
      "sh", "-c", 'cd -- "$1" && shift && exec "$@"', "sh", "/mnt/workspace/repo/sample", "npm", "ci",
    ]);
  });

  it("reports a project command its timeout stopped, and the signal that ended it (#154)", async () => {
    const { cli } = fakeCli(() => ({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" }));
    const result = await runDevcontainerCommand(cli, target, { cwd: "repo/sample", executable: "sleep", args: ["4200"], timeoutSeconds: 1000 });
    expect(result).toEqual({ exitCode: -1, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" });
  });

  it("streams the agent's shell, forwards pi's session variables, and stops the command's process group on timeout", async () => {
    const calls: Array<readonly string[]> = [];
    const cli: DevcontainerCli = {
      run: (args, options) => {
        calls.push(args);
        if (args.includes("kill -TERM -- \"-$(cat \"$1\")\" 2>/dev/null; rm -f \"$1\"")) return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        options.onStdout?.(Buffer.from("hello\n"));
        // A long command: it ends when the operations abort their client.
        return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "" })));
      },
    };
    const output: string[] = [];
    const operations = devcontainerBashOperations(cli, target);
    await expect(operations.exec("sleep 60", "/mnt/workspace/repo/sample", {
      onData: (data) => output.push(data.toString()), timeout: 0.05, env: { PI_SESSION_ID: "s1", HOME: "/home/node" },
    })).rejects.toThrow("timeout:0.05");
    expect(output).toEqual(["hello\n"]);
    const shell = calls[0]!;
    expect(shell).toEqual(expect.arrayContaining(["--remote-env", "PI_SESSION_ID=s1", "bash", "-c", "/mnt/workspace/repo/sample", "sleep 60"]));
    expect(shell).not.toContain("HOME=/home/node");
    // The stop runs under bash (dash's kill refuses a negative process group) with the same group file.
    const groupFile = shell.at(-1);
    expect(groupFile).toMatch(/^\/tmp\/agentx-shell-[0-9a-f-]+\.pgid$/);
    expect(calls[1]!.slice(-5)).toEqual(["bash", "-c", "kill -TERM -- \"-$(cat \"$1\")\" 2>/dev/null; rm -f \"$1\"", "bash", groupFile]);

    const aborted = new AbortController();
    aborted.abort();
    await expect(operations.exec("true", "/mnt/workspace", { onData: () => undefined, signal: aborted.signal })).rejects.toThrow("aborted");
  });
});

describe("preparing a workspace with a devcontainer", () => {
  it("starts the devcontainer after cloning, runs setup and readiness in it, and records it", async () => {
    const { root, project, materializer } = await fixture();
    const { cli, calls } = fakeCli();
    const manifest = await prepareWorkspace({ rootPath: root, project, materializer, devcontainerCli: cli });
    const canonical = await realpath(root);

    expect(manifest.complete).toBe(true);
    expect(manifest.devcontainer).toMatchObject({ repository: "sample", configPath: "repo/sample/.devcontainer/devcontainer.json", containerId: "f832494aef96" });
    expect(calls.map((args) => args[0])).toEqual(["up", "exec", "exec"]);
    expect(calls[1]).toEqual(expect.arrayContaining(["npm", "ci"]));
    expect(calls[2]).toEqual(expect.arrayContaining([join(canonical, "repo/sample"), "npm", "run", "typecheck"]));
  });

  it("runs setup and readiness in the devcontainer with their own env (#54)", async () => {
    const { root, project, materializer } = await fixture();
    const withEnv = {
      ...project,
      setup: [{ ...project.setup[0]!, env: { SETUP_ONLY: "1" } }],
      readiness: [{ ...project.readiness[0]!, env: { CHECK_ONLY: "2" } }],
    };
    const { cli, calls } = fakeCli();
    await expect(prepareWorkspace({ rootPath: root, project: withEnv, materializer, devcontainerCli: cli })).resolves.toMatchObject({ complete: true });
    expect(calls[1]).toEqual(expect.arrayContaining(["--remote-env", "SETUP_ONLY=1"]));
    expect(calls[1]).not.toContain("CHECK_ONLY=2");
    expect(calls[2]).toEqual(expect.arrayContaining(["--remote-env", "CHECK_ONLY=2"]));
    expect(calls[2]).not.toContain("SETUP_ONLY=1");
  });

  it("starts the devcontainer again when a failed preparation resumes", async () => {
    const { root, project, materializer } = await fixture();
    let failSetup = true;
    const { cli, calls } = fakeCli(() => {
      if (failSetup) { failSetup = false; return { exitCode: 1, stdout: "", stderr: "npm ci failed" }; }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await expect(prepareWorkspace({ rootPath: root, project, materializer, devcontainerCli: cli })).rejects.toThrow(/npm ci failed/);
    const manifest = await prepareWorkspace({ rootPath: root, project, materializer, devcontainerCli: cli });
    expect(manifest.complete).toBe(true);
    expect(calls.filter((args) => args[0] === "up")).toHaveLength(2);
  });

  it("says which setup step timed out in the devcontainer, and after how long (#154)", async () => {
    const { root, project, materializer } = await fixture();
    const { cli } = fakeCli(() => ({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" }));
    await expect(prepareWorkspace({ rootPath: root, project, materializer, devcontainerCli: cli }))
      .rejects.toThrow(`setup step 0 (npm ci in ${project.setup[0]!.cwd}) timed out after ${project.setup[0]!.timeoutSeconds} s`);
  });

  it("skips Docker's data root on the workspace volume, which is root's and holds links outside the workspace", async () => {
    const { root, project, materializer } = await fixture();
    const docker = join(root, ".docker");
    await mkdir(docker);
    await symlink("/var/lib", join(docker, "outside"));
    await chmod(docker, 0o000);
    try {
      const { cli } = fakeCli();
      await expect(prepareWorkspace({ rootPath: root, project, materializer, devcontainerCli: cli })).resolves.toMatchObject({ complete: true });
    } finally {
      await chmod(docker, 0o700);
    }
  });
});

describe("a task in a workspace with a devcontainer", () => {
  it("starts the devcontainer first and gives pi the devcontainer's shell", async () => {
    const { root, project, materializer } = await fixture();
    const prepared = fakeCli();
    await prepareWorkspace({ rootPath: root, project, materializer, devcontainerCli: prepared.cli });

    const { cli, calls } = fakeCli();
    const inputs: PiSessionInput[] = [];
    const adapter: PiSessionAdapter = {
      async create(input) {
        inputs.push(input);
        const sessionFile = join(input.sessionDirectory, "session.jsonl");
        await writeFile(sessionFile, "");
        return {
          conversationId: "c", sessionFile,
          prompt: async () => undefined, abort: async () => undefined,
          getModel: () => ({ provider: "fixture", modelId: "m" }),
          getSessionStats: () => ({ sessionFile, sessionId: "c", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
          subscribe: () => () => undefined, dispose: () => undefined,
        };
      },
    };
    await runTaskInvocation(taskInvocation(), {
      rootPath: root, model: { provider: "fixture", modelId: "m" }, piAdapter: adapter, devcontainerCli: cli,
      eventSink: async () => undefined, artifactSink: async () => undefined,
    });

    expect(calls[0]?.[0]).toBe("up");
    expect(inputs[0]?.bashOperations).toBeDefined();
    // The fake CLI reports the repository at /workspaces/sample in the container (#128).
    expect(inputs[0]?.devcontainerPaths).toEqual({ hostFolder: join(await realpath(root), "repo/sample"), containerFolder: "/workspaces/sample" });
    expect(inputs[0]?.contextFiles.map((file) => file.path)).toContain("AgentX devcontainer");
    await inputs[0]!.bashOperations!.exec("npm test", join(await realpath(root), "repo/sample"), { onData: () => undefined });
    expect(calls.at(-1)).toEqual(expect.arrayContaining(["exec", "npm test"]));
  });
});

function sampleProject(url: string): ProjectDefinition {
  return {
    name: "sample",
    revision: 1,
    repositories: [{ name: "sample", url, path: "repo/sample", defaultBranch: "main", credentialRef: "sample-readwrite" }],
    setup: [{ cwd: "repo/sample", executable: "npm", args: ["ci"], timeoutSeconds: 600 }],
    readiness: [{ cwd: "repo/sample", executable: "npm", args: ["run", "typecheck"], timeoutSeconds: 300 }],
    devcontainer: { repository: "sample" },
    orchestratorInstructions: "Delegate all code changes to the remote worker.",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentx-devcontainer-"));
  const source = await mkdtemp(join(tmpdir(), "agentx-devcontainer-source-"));
  await run("git", ["init", "--quiet", "--initial-branch=main", source]);
  await mkdir(join(source, ".devcontainer"));
  await writeFile(join(source, ".devcontainer/devcontainer.json"), "{\"image\":\"node:22\"}\n");
  await run("git", ["-C", source, "add", "."]);
  await run("git", ["-C", source, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  const project = sampleProject("http://127.0.0.1/sample.git");
  const materializer = async (_repository: unknown, destination: string) => {
    await run("git", ["clone", "--quiet", source, destination]);
  };
  expect(await readFile(join(source, ".devcontainer/devcontainer.json"), "utf8")).toContain("node:22");
  return { root, project, materializer };
}

function taskInvocation(): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1,
    kind: "task",
    operationId: randomUUID(),
    workspaceId: randomUUID(),
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "run the tests" },
  };
}

describe("the collected process under the devcontainer CLI (#154)", () => {
  it("stops a process at its timeout with SIGTERM and says so", async () => {
    const result = await runCollected(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { timeoutMs: 200 });
    expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: true });
  });

  it("does not call a process timed out when it exited before its timeout, while a child held its output open (#154 review)", async () => {
    const result = await runCollected("sh", ["-c", "sleep 2 & exit 4"], { timeoutMs: 300 });
    expect(result.exitCode).toBe(4);
    expect(result).not.toHaveProperty("timedOut");
    expect(result).not.toHaveProperty("signal");
  });

  it("stops waiting at the timeout for a child that holds the output open after the process exited (#154 review)", async () => {
    const started = Date.now();
    const result = await runCollected("sh", ["-c", "sleep 5 & exit 4"], { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.exitCode).toBe(4);
    expect(result).not.toHaveProperty("timedOut");
  });

  it("kills a process that ignores SIGTERM once the grace period after its timeout ends (#170)", async () => {
    const started = Date.now();
    const script = "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000); console.log('ready')";
    // The timeout leaves Node time to install its SIGTERM handler, even on a loaded machine.
    const result = await runCollected(process.execPath, ["-e", script], { timeoutMs: 1_500, killGraceMs: 300 });
    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: true });
    expect(result.stdout).toBe("ready\n");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("signals the whole process group at a timeout, so a grandchild stops too (#170)", async () => {
    // The shell prints its background child's process ID, then waits for it. The grandchild holds
    // the output open, so the result comes back early only when it was stopped too.
    const started = Date.now();
    const result = await runCollected("sh", ["-c", "sleep 30 & echo $!; wait"], { timeoutMs: 300, killGraceMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
    const grandchild = Number.parseInt(result.stdout.trim(), 10);
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    await expectGone(grandchild);
  });

  it("still kills a group member that ignores SIGTERM after the process itself has exited (#170 review)", async () => {
    // The shell dies on SIGTERM, but its background child ignores SIGTERM and does not hold the
    // output, so the result comes back before the grace period ends.
    const result = await runCollected("sh", ["-c", "(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $!; wait"], { timeoutMs: 500, killGraceMs: 300 });
    expect(result.timedOut).toBe(true);
    await expectGone(Number.parseInt(result.stdout.trim(), 10));
  });

  it("stops the whole process group on an abort, with SIGKILL after the grace period (#170 review)", async () => {
    const controller = new AbortController();
    let output = "";
    const running = runCollected("sh", ["-c", "trap '' TERM; (trap '' TERM; exec sleep 30) & echo $!; wait"], {
      signal: controller.signal,
      killGraceMs: 300,
      onStdout: (data) => {
        output += data.toString("utf8");
        if (output.includes("\n")) controller.abort();
      },
    });
    const result = await running;
    expect(result.exitCode).toBeNull();
    const grandchild = Number.parseInt(output.trim(), 10);
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    await expectGone(grandchild);
  });

  it("does not start a process for an already aborted signal (#170 review)", async () => {
    const controller = new AbortController();
    controller.abort();
    const marker = join(tmpdir(), `agentx-170-${randomUUID()}`);
    const result = await runCollected("sh", ["-c", `touch ${marker}`], { signal: controller.signal });
    expect(result.exitCode).toBeNull();
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    await expect(stat(marker)).rejects.toThrow(/ENOENT/);
  });

  it("waits 5 seconds after SIGTERM before SIGKILL by default (#170)", () => {
    expect(TIMEOUT_KILL_GRACE_MS).toBe(5_000);
  });

  it("rejects when the executable does not exist", async () => {
    await expect(runCollected("agentx-no-such-command-154", [])).rejects.toThrow(/ENOENT/);
  });

  it("starts cut output at a whole line, so no fragment of a line split by the cut is kept (#170)", async () => {
    const script = "process.stdout.write(\"0123456789abcdef\\n\".repeat(200000)); process.stdout.write(\"END\\n\");";
    const result = await runCollected(process.execPath, ["-e", script]);
    expect(result.stdout.length).toBeLessThanOrEqual(1_048_576);
    expect(result.stdout.startsWith("0123456789abcdef\n")).toBe(true);
    expect(result.stdout.endsWith("\nEND\n")).toBe(true);
  });

  it("redacts a token that the 1 MiB cut splits, in output with no line break (#170 review)", async () => {
    const token = `ghp_${"S1t2R3a4D5".repeat(4)}`;
    // The last 1 MiB starts 21 characters before the token's end.
    const script = [
      `const tail = " y".repeat(${(1_048_576 - 22) / 2});`,
      "process.stdout.write(\"x\".repeat(2 * 1048576));",
      `process.stdout.write(${JSON.stringify(token)} + " " + tail);`,
    ].join("\n");
    const result = await runCollected(process.execPath, ["-e", script]);
    expect(result.stdout.length).toBeLessThanOrEqual(1_048_576);
    expect(result.stdout.endsWith(" y y y")).toBe(true);
    expect(result.stdout).not.toContain(token.slice(-20));
  });

  it("redacts a private key that the 1 MiB cut splits (#170 review)", async () => {
    // About half the key's 25 KiB falls inside the last 1 MiB.
    const script = [
      "const body = Array.from({ length: 400 }, (_, index) => \"KEYLINE\" + String(index).padStart(4, \"0\") + \"q\".repeat(53));",
      "const pem = [\"-----BEGIN OPENSSH PRIVATE KEY-----\", ...body, \"-----END OPENSSH PRIVATE KEY-----\"].join(\"\\n\");",
      "process.stdout.write(\"before\\n\".repeat(300000));",
      "process.stdout.write(pem + \"\\n\");",
      "process.stdout.write(\"after the key\\n\".repeat(Math.floor((1048576 - 12000) / 14)));",
    ].join("\n");
    const result = await runCollected(process.execPath, ["-e", script]);
    expect(result.stdout.length).toBeLessThanOrEqual(1_048_576);
    expect(result.stdout).not.toContain("KEYLINE");
    expect(result.stdout.endsWith("after the key\n")).toBe(true);
  });

  it("redacts a private key that the cut splits in output of multi-byte characters (#170 review)", () => {
    // Each filler line is 3 bytes a character, so a cut counted in characters would keep the key's
    // end without its BEGIN line.
    const collector = tailCollector(200, 60);
    collector.add(Buffer.from("日本語日本語日本語\n".repeat(20)));
    collector.add(Buffer.from("-----BEGIN RSA PRIVATE KEY-----\nKEYBODY1\nKEYBODY2\n-----END RSA PRIVATE KEY-----\n"));
    // The last 260 bytes kept start inside the key, after its BEGIN line.
    collector.add(Buffer.from("日本語日本語日本語\n".repeat(7)));
    const text = collector.text();
    expect(text).not.toContain("KEYBODY");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200);
    expect(text.endsWith("日本語日本語日本語\n")).toBe(true);
  });

  it("keeps no fragment of a token when the last write is larger than twice the limit (#170 review)", () => {
    const collector = tailCollector(20, 0);
    collector.add(Buffer.from("line1\nSECRET_ghp_abcdefghijklmnopqrstuvwxyz\nend\n"));
    expect(collector.text()).toBe("end\n");
    const margined = tailCollector(20);
    margined.add(Buffer.from("line1\nSECRET_ghp_abcdefghijklmnopqrstuvwxyz\nend\n"));
    expect(margined.text()).toBe("end\n");
  });

  it("keeps the last 1 MiB of output, not the first", async () => {
    const script = "process.stderr.write(\"x\".repeat(3 * 1048576)); process.stderr.write(\"END-OF-OUTPUT\");";
    const result = await runCollected(process.execPath, ["-e", script]);
    expect(result.exitCode).toBe(0);
    expect(result).not.toHaveProperty("timedOut");
    expect(result.stderr.length).toBe(1_048_576);
    expect(result.stderr.endsWith("END-OF-OUTPUT")).toBe(true);
  });
});

/** Waits up to 3 s for a process to be gone. */
async function expectGone(pid: number): Promise<void> {
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 3_000, interval: 50 });
}
