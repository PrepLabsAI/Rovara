// Ruling R56: on an EC2 worker, task-controlled code never runs in the worker's own process, network or user. It runs
// in a sandbox container with no Docker socket, no host network, no capabilities and only the workspace mounted.
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TASK_SANDBOX_NETWORK,
  TaskSandbox,
  assertLocalTaskExecutionAllowed,
  removeLeftoverTaskSandboxes,
  sandboxCpuLimit,
  sandboxMemoryLimit,
  taskSandboxRunArgs,
  taskShellFromEnvironment,
  taskSandboxFor,
  taskShellSelection,
  workspaceKey,
} from "../../packages/worker/src/task-sandbox.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const IMAGE = "123456789012.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:" + "a".repeat(64);
const TASK = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const EC2 = { AGENTX_WORKER_PROCESS_SCOPE: "container" };

/** A fake Docker CLI that records every call and answers like a healthy daemon. */
function fakeDocker(behaviour: { networkExists?: boolean; network?: string; stale?: string[]; failRun?: string; failExec?: boolean; failRm?: number } = {}) {
  let rmFailures = behaviour.failRm ?? 0;
  const calls: string[][] = [];
  const docker: DockerCli = {
    run: async (args) => {
      calls.push([...args]);
      const [verb, noun] = args;
      if (verb === "network" && noun === "inspect") {
        return behaviour.networkExists === true || behaviour.network !== undefined
          ? { exitCode: 0, stdout: behaviour.network ?? "bridge {} false", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
      }
      if (verb === "rm" && rmFailures > 0) { rmFailures -= 1; return { exitCode: 1, stdout: "", stderr: "device or resource busy" }; }
      if (verb === "ps") return { exitCode: 0, stdout: (behaviour.stale ?? []).join("\n"), stderr: "" };
      if (verb === "run" && behaviour.failRun !== undefined) return { exitCode: 125, stdout: "", stderr: behaviour.failRun };
      if (verb === "exec" && behaviour.failExec === true) return { exitCode: 1, stdout: "", stderr: "boom" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { docker, calls, verbs: (verb: string) => calls.filter((args) => args[0] === verb) };
}

describe("the task sandbox's docker run arguments (R56)", () => {
  const args = taskSandboxRunArgs({ name: "agentx-task-x", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: [] });

  it("carry every R56 flag", () => {
    expect(args).toEqual(expect.arrayContaining(["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000"]));
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args[args.indexOf("--network") + 1]).toBe(TASK_SANDBOX_NETWORK);
    expect(TASK_SANDBOX_NETWORK).toBe("agentx-task");
  });

  it("cap the sandbox's processes, so a fork bomb cannot starve the instance the worker shares", () => {
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("4096");
  });

  it("leave the worker one CPU: all but one of the host's, and no limit at all on a one-CPU host (the daemon refuses a limit above the host's CPUs)", () => {
    const cpus = (hostCpus: number) => {
      const given = taskSandboxRunArgs({ name: "n", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: [], hostCpus });
      return given.includes("--cpus") ? given[given.indexOf("--cpus") + 1] : undefined;
    };
    expect(cpus(1)).toBeUndefined();
    expect(cpus(2)).toBe("1");
    expect(cpus(8)).toBe("7");
    expect([sandboxCpuLimit(1), sandboxCpuLimit(2), sandboxCpuLimit(8), sandboxCpuLimit(0)]).toEqual([undefined, "1", "7", undefined]);
    // Without a count, this machine's own is used, and the limit is always below it.
    const own = taskSandboxRunArgs({ name: "n", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: [] });
    if (own.includes("--cpus")) expect(Number(own[own.indexOf("--cpus") + 1])).toBeLessThan(availableParallelism());
  });

  it("cap the sandbox's memory and its swap at the same size, sized from the host with a reserve for the worker and the Docker daemon", () => {
    const GIB = 1024 ** 3;
    const memory = (hostMemoryBytes: number) => {
      const given = taskSandboxRunArgs({ name: "n", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: [], hostMemoryBytes });
      const value = given.includes("--memory") ? given[given.indexOf("--memory") + 1] : undefined;
      // Swap equal to memory means no swap beyond the limit.
      expect(given[given.indexOf("--memory-swap") + 1]).toBe(value);
      return value;
    };
    // Reserve: the larger of 1.5 GiB and 20% of the host. Floor: 1 GiB.
    expect(memory(16 * GIB)).toBe("13107m");
    expect(memory(8 * GIB)).toBe("6553m");
    expect(memory(4 * GIB)).toBe("2560m");
    expect(memory(2 * GIB)).toBe("1024m");
    expect(memory(GIB)).toBe("1024m");
    expect([sandboxMemoryLimit(16 * GIB), sandboxMemoryLimit(4 * GIB), sandboxMemoryLimit(GIB / 2), sandboxMemoryLimit(0), sandboxMemoryLimit(Number.NaN)]).toEqual(["13107m", "2560m", "1024m", undefined, undefined]);
    // Without a size, this machine's own is used, and the limit leaves a reserve.
    const own = taskSandboxRunArgs({ name: "n", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: [] });
    expect(own.includes("--memory")).toBe(true);
    expect(own[own.indexOf("--memory") + 1]).toBe(sandboxMemoryLimit(totalmem()));
    expect(own[own.indexOf("--memory-swap") + 1]).toBe(own[own.indexOf("--memory") + 1]);
  });

  it("mount only the workspace, and never the Docker socket, the host network or privileges", () => {
    const joined = args.join(" ");
    expect(args.filter((arg) => arg === "--volume")).toHaveLength(1);
    expect(args[args.indexOf("--volume") + 1]).toBe("/mnt/workspace:/mnt/workspace");
    expect(joined).not.toContain("docker.sock");
    expect(joined).not.toContain("/var/run");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("host");
    expect(joined).not.toMatch(/--network[ =]host|--net[ =]host|--pid(?!s-limit)|--ipc|--userns|--uts|--device|--cap-add|--volumes-from|--add-host/);
  });

  it("label the container with the task and start the image's own init with nothing to run", () => {
    expect(args[args.indexOf("--label") + 1]).toBe(`agentx.task=${TASK}`);
    expect(args).toContain(`agentx.workspace=${workspaceKey("/mnt/workspace")}`);
    expect(args[args.indexOf("--name") + 1]).toBe("agentx-task-x");
    expect(args.slice(args.indexOf(IMAGE) - 2)).toEqual(["--entrypoint", "/usr/bin/tini", IMAGE, "--", "sleep", "infinity"]);
  });

  it("hide the workspace volume's Docker data and verifier runtime behind empty tmpfs mounts", () => {
    const masked = taskSandboxRunArgs({ name: "n", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: ["/mnt/workspace/.docker", "/mnt/workspace/.agentx-runtime"] });
    const tmpfs = masked.flatMap((arg, index) => (arg === "--tmpfs" ? [masked[index + 1]] : []));
    expect(tmpfs).toEqual([
      "/mnt/workspace/.docker:ro,noexec,nosuid,size=4k",
      "/mnt/workspace/.agentx-runtime:ro,noexec,nosuid,size=4k",
    ]);
  });
});

describe("the sandbox's DNS servers (setup agent, SH9)", () => {
  const base = { name: "n", taskId: TASK, image: IMAGE, rootPath: "/mnt/workspace", maskedPaths: [] as string[] };

  it("has no --dns flag unless a DNS server is asked for, so every other sandbox resolves as before", () => {
    expect(taskSandboxRunArgs(base)).not.toContain("--dns");
    expect(taskSandboxRunArgs({ ...base, dns: [] })).not.toContain("--dns");
  });

  it("gives the sandbox the DNS servers it is asked for, in order, as --dns pairs on the task network", () => {
    const args = taskSandboxRunArgs({ ...base, dns: ["172.18.0.1", "fd00::1"] });
    const pairs = args.flatMap((arg, index) => (arg === "--dns" ? [args[index + 1]] : []));
    expect(pairs).toEqual(["172.18.0.1", "fd00::1"]);
    expect(args[args.indexOf("--network") + 1]).toBe(TASK_SANDBOX_NETWORK);
    expect(args.slice(args.indexOf(IMAGE) - 2)).toEqual(["--entrypoint", "/usr/bin/tini", IMAGE, "--", "sleep", "infinity"]);
  });

  it("refuses a server that is not an IP address, or more than three, instead of passing a repository-shaped string to docker", () => {
    for (const bad of ["dns.example.com", "--privileged", "1.2.3.4 --network host", "", "999.1.1.1"]) {
      expect(() => taskSandboxRunArgs({ ...base, dns: [bad] }), bad).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    }
    expect(() => taskSandboxRunArgs({ ...base, dns: ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4"] })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("starts the container with the DNS option it was constructed with, and without one by default", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-sandbox-dns-")));
    try {
      const withDns = fakeDocker();
      await new TaskSandbox({ rootPath: root, taskId: TASK, docker: withDns.docker, image: IMAGE, dns: ["172.18.0.1"] }).start();
      const run = withDns.verbs("run")[0]!;
      expect(run[run.indexOf("--dns") + 1]).toBe("172.18.0.1");
      const without = fakeDocker();
      await new TaskSandbox({ rootPath: root, taskId: TASK, docker: without.docker, image: IMAGE }).start();
      expect(without.verbs("run")[0]).not.toContain("--dns");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is passed on by a sandbox selection", () => {
    const sandbox = taskSandboxFor({ kind: "sandbox", docker: fakeDocker().docker, image: IMAGE, dns: ["172.18.0.1"] }, { rootPath: "/mnt/workspace", taskId: TASK });
    expect(sandbox).toBeInstanceOf(TaskSandbox);
  });
});

describe("starting and stopping a sandbox", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  const workspace = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-sandbox-")));
    cleanup.push(root);
    return root;
  };

  it("creates the agentx-task bridge network when it is missing, and leaves an existing one alone", async () => {
    const root = await workspace();
    const missing = fakeDocker();
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: missing.docker, image: IMAGE }).start();
    expect(missing.calls).toContainEqual(["network", "create", "--driver", "bridge", TASK_SANDBOX_NETWORK]);

    const present = fakeDocker({ networkExists: true });
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: present.docker, image: IMAGE }).start();
    expect(present.verbs("network").map((call) => call[1])).toEqual(["inspect"]);
  });

  it("does not trust a network of that name that is not a plain bridge: it is removed and made again", async () => {
    const root = await workspace();
    for (const network of ["overlay {} false", "bridge {\"com.docker.network.bridge.host_binding_ipv4\":\"0.0.0.0\"} false", "bridge {} true"]) {
      const fake = fakeDocker({ network });
      await new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE }).start();
      expect(fake.verbs("network").map((call) => call[1])).toEqual(["inspect", "rm", "create"]);
    }
  });

  it("fails closed when a network that is not a plain bridge cannot be removed", async () => {
    const root = await workspace();
    const calls: string[][] = [];
    const docker: DockerCli = {
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0, stdout: "macvlan {} false", stderr: "" };
        if (args[0] === "network" && args[1] === "rm") return { exitCode: 1, stdout: "", stderr: "network has active endpoints" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await expect(new TaskSandbox({ rootPath: root, taskId: TASK, docker, image: IMAGE }).start()).rejects.toThrow(/not a plain bridge and could not be removed/u);
    expect(calls.some((args) => args[0] === "run")).toBe(false);
  });

  it("accepts a network that another start created in between", async () => {
    const root = await workspace();
    const calls: string[][] = [];
    let inspections = 0;
    const docker: DockerCli = {
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "network" && args[1] === "inspect") return { exitCode: ++inspections === 1 ? 1 : 0, stdout: "bridge {} false", stderr: "" };
        if (args[0] === "network" && args[1] === "create") return { exitCode: 1, stdout: "", stderr: "network with name agentx-task already exists" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await expect(new TaskSandbox({ rootPath: root, taskId: TASK, docker, image: IMAGE }).start()).resolves.toBeUndefined();
  });

  it("starts once however many commands run, and runs them with docker exec in that container", async () => {
    const root = await workspace();
    const fake = fakeDocker();
    const sandbox = new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE });
    await sandbox.exec(["bash", "-c", "true"], { env: { PI_X: "1" } });
    await sandbox.exec(["bash", "-c", "true"], {});
    expect(fake.verbs("run")).toHaveLength(1);
    const exec = fake.verbs("exec");
    expect(exec).toHaveLength(2);
    expect(exec[0]).toEqual(["exec", "--env", "PI_X=1", sandbox.name, "bash", "-c", "true"]);
    expect(sandbox.name).toMatch(/^agentx-task-0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11-[0-9a-f]{8}$/u);
  });

  it("never removes another sandbox when it starts: only the worker's startup sweep does, and only this workspace's", async () => {
    const root = await workspace();
    const fake = fakeDocker({ stale: ["abc123", "def456"] });
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE }).start();
    expect(fake.verbs("ps")).toEqual([]);
    expect(fake.verbs("rm")).toEqual([]);

    const sweep = fakeDocker({ stale: ["abc123", "def456"] });
    await expect(removeLeftoverTaskSandboxes(root, sweep.docker)).resolves.toBe(2);
    expect(sweep.calls).toEqual([
      ["ps", "--all", "--quiet", "--filter", "label=agentx.task", "--filter", `label=agentx.workspace=${workspaceKey(root)}`],
      ["rm", "--force", "abc123", "def456"],
    ]);
    const none = fakeDocker();
    await expect(removeLeftoverTaskSandboxes(root, none.docker)).resolves.toBe(0);
    expect(none.verbs("rm")).toEqual([]);
    expect(workspaceKey(root)).not.toBe(workspaceKey(`${root}-other`));
  });

  it("hides the worker's own state from the sandbox, creating it first so the task cannot, and the boot script's folders where they exist", async () => {
    const root = await workspace();
    await mkdir(join(root, ".docker"));
    const fake = fakeDocker();
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE }).start();
    const run = fake.verbs("run")[0]!;
    const tmpfs = run.flatMap((arg, index) => (arg === "--tmpfs" ? [run[index + 1]] : []));
    expect(tmpfs).toEqual([
      `${root}/.agentx:ro,noexec,nosuid,size=4k`,
      `${root}/agent-sessions:ro,noexec,nosuid,size=4k`,
      `${root}/.docker:ro,noexec,nosuid,size=4k`,
    ]);
    // Created by the worker, private to it, before the container could create them.
    expect((await stat(join(root, ".agentx"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "agent-sessions"))).isDirectory()).toBe(true);
  });

  it("removes the container when it is disposed, and does nothing when nothing was started", async () => {
    const root = await workspace();
    const fake = fakeDocker();
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE }).dispose();
    expect(fake.calls).toEqual([]);
    const sandbox = new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE });
    await sandbox.exec(["true"], {});
    await sandbox.dispose();
    expect(fake.verbs("rm").at(-1)).toEqual(["rm", "--force", sandbox.name]);
    await sandbox.dispose();
    expect(fake.verbs("rm").filter((call) => call.includes(sandbox.name))).toHaveLength(1);
    await expect(sandbox.exec(["true"], {})).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("retries a failed removal once, and logs a container it could not remove", async () => {
    const root = await workspace();
    const events: Array<Record<string, unknown>> = [];
    const retried = fakeDocker({ failRm: 1 });
    const first = new TaskSandbox({ rootPath: root, taskId: TASK, docker: retried.docker, image: IMAGE, log: (event) => events.push(event) });
    await first.exec(["true"], {});
    await expect(first.dispose()).resolves.toBe(true);
    expect(retried.verbs("rm").filter((call) => call.includes(first.name))).toHaveLength(2);
    expect(events).toEqual([]);

    const stuck = fakeDocker({ failRm: 5 });
    const second = new TaskSandbox({ rootPath: root, taskId: TASK, docker: stuck.docker, image: IMAGE, log: (event) => events.push(event) });
    await second.exec(["true"], {});
    // I1: the answer says the container is not gone (prepare refuses to call the workspace checked); a second dispose says the same.
    await expect(second.dispose()).resolves.toBe(false);
    await expect(second.dispose()).resolves.toBe(false);
    expect(stuck.verbs("rm").filter((call) => call.includes(second.name))).toHaveLength(2);
    expect(events).toEqual([{ event: "task-sandbox.remove.failed", container: second.name, taskId: TASK, reason: "device or resource busy" }]);
  });

  it("removes the container even when docker run failed part-way, and reports why it failed", async () => {
    const root = await workspace();
    const fake = fakeDocker({ failRun: "Error response from daemon: pull access denied" });
    const sandbox = new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, image: IMAGE });
    await expect(sandbox.start()).rejects.toThrow(/could not start the task sandbox.*pull access denied/su);
    await expect(sandbox.exec(["true"], {})).rejects.toThrow(/could not start the task sandbox/u);
    expect(fake.verbs("run")).toHaveLength(1);
    await sandbox.dispose();
    expect(fake.verbs("rm").at(-1)).toEqual(["rm", "--force", sandbox.name]);
  });

  it("is unavailable, not local, when no sandbox image is configured", async () => {
    const root = await workspace();
    const fake = fakeDocker();
    const sandbox = new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, environment: {} });
    await expect(sandbox.start()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(fake.calls).toEqual([]);
  });

  it("reads the image from AGENTX_SANDBOX_IMAGE", async () => {
    const root = await workspace();
    const fake = fakeDocker();
    await new TaskSandbox({ rootPath: root, taskId: TASK, docker: fake.docker, environment: { AGENTX_SANDBOX_IMAGE: IMAGE } }).start();
    expect(fake.verbs("run")[0]).toContain(IMAGE);
  });
});

describe("where the local shell may run (R56)", () => {
  it("is refused on the EC2 runtime, whatever asks for it, and whichever marker says it is EC2", () => {
    for (const marker of [EC2, { AGENTX_RUNTIME: "ec2" }, { ...EC2, AGENTX_RUNTIME: "ec2" }]) {
      expect(() => assertLocalTaskExecutionAllowed({ ...marker, AGENTX_TASK_SHELL: "local" })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
      expect(() => assertLocalTaskExecutionAllowed(marker, { explicit: true })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
      expect(() => taskShellFromEnvironment({ ...marker, AGENTX_TASK_SHELL: "local" })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
      expect(taskShellFromEnvironment(marker)).toBe("sandbox");
    }
  });

  it("selects the sandbox when the environment says nothing, so a missing EC2 marker cannot put task code in the worker", () => {
    expect(taskShellFromEnvironment({})).toBe("sandbox");
    expect(taskShellFromEnvironment({ AGENTX_TASK_SHELL: "" })).toBe("sandbox");
    expect(taskShellFromEnvironment({ AGENTX_TASK_SHELL: "sandbox" })).toBe("sandbox");
    expect(taskShellSelection({})).toMatchObject({ kind: "sandbox" });
  });

  it("allows the local shell only when it is asked for: AGENTX_TASK_SHELL=local, or an explicit choice", () => {
    expect(taskShellFromEnvironment({ AGENTX_TASK_SHELL: "local" })).toBe("local");
    expect(taskShellSelection({ AGENTX_TASK_SHELL: "local" })).toEqual({ kind: "local" });
    expect(() => assertLocalTaskExecutionAllowed({ AGENTX_TASK_SHELL: "local" })).not.toThrow();
    expect(() => assertLocalTaskExecutionAllowed({}, { explicit: true })).not.toThrow();
    // Nothing chose it: a call that reaches the local shell anyway is refused.
    expect(() => assertLocalTaskExecutionAllowed({})).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
    expect(() => assertLocalTaskExecutionAllowed({ AGENTX_TASK_SHELL: "sandbox" })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
  });

  it("refuses a value it does not know", () => {
    expect(() => taskShellFromEnvironment({ AGENTX_TASK_SHELL: "host" })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("the Python user site's .gitignore is rewritten on every start (C67)", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  const workspace = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-sandbox-gitignore-")));
    cleanup.push(root);
    return root;
  };
  const start = async (root: string) => new TaskSandbox({ rootPath: root, taskId: TASK, docker: fakeDocker().docker, image: IMAGE }).start();

  it("writes it on the first start", async () => {
    const root = await workspace();
    await start(root);
    expect(await readFile(join(root, ".agentx-python", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("restores it when a task deleted or changed it", async () => {
    const root = await workspace();
    await mkdir(join(root, ".agentx-python"));
    await writeFile(join(root, ".agentx-python", ".gitignore"), "# nothing is ignored here\n");
    await start(root);
    expect(await readFile(join(root, ".agentx-python", ".gitignore"), "utf8")).toBe("*\n");
    await rm(join(root, ".agentx-python", ".gitignore"));
    await start(root);
    expect(await readFile(join(root, ".agentx-python", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("replaces a directory a task left at its name by moving it aside, never walking into it, and leaves no temporary file behind (L1, N3)", async () => {
    const root = await workspace();
    await mkdir(join(root, ".agentx-python", ".gitignore"), { recursive: true });
    await writeFile(join(root, ".agentx-python", ".gitignore", "inner"), "x");
    await start(root);
    expect(await readFile(join(root, ".agentx-python", ".gitignore"), "utf8")).toBe("*\n");
    const entries = (await readdir(join(root, ".agentx-python"))).sort();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toBe(".gitignore");
    const aside = entries[1]!;
    expect(aside).toMatch(/^\.gitignore\.[0-9a-f-]{36}\.old$/u);
    // The folder was moved whole: what was in it was not deleted by a walk of it.
    expect(await readFile(join(root, ".agentx-python", aside, "inner"), "utf8")).toBe("x");
    // A later start has a plain file at the name and adds nothing.
    await start(root);
    expect(await readdir(join(root, ".agentx-python"))).toHaveLength(2);
  });

  it("replaces a link a task left at its name, without writing through it", async () => {
    const root = await workspace();
    const outside = join(await workspace(), "target.txt");
    await writeFile(outside, "keep me\n");
    await mkdir(join(root, ".agentx-python"));
    await symlink(outside, join(root, ".agentx-python", ".gitignore"));
    await start(root);
    expect(await readFile(outside, "utf8")).toBe("keep me\n");
    const found = await lstat(join(root, ".agentx-python", ".gitignore"));
    expect(found.isFile()).toBe(true);
    expect(await readFile(join(root, ".agentx-python", ".gitignore"), "utf8")).toBe("*\n");
  });
});
