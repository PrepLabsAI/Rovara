// Lane L4-NETG (DEC 254zzz77): what the WORKER does on a gateway-mode EC2 host. Everything that runs task code goes on the internal network with the gateway as its only name server, and nothing falls back to a bridge with a
// way out: the task sandbox, the setup run's sandbox, an eval install box and the devcontainer. Not in gateway mode (`bridge`, and every laptop), none of this applies and the arguments are exactly what they were.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as CollectedProcessModule from "../../packages/worker/src/collected-process.js";

const captured = vi.hoisted(() => ({ calls: [] as string[][], environments: [] as Array<NodeJS.ProcessEnv | undefined> }));
vi.mock("../../packages/worker/src/collected-process.js", async (importOriginal) => {
  const original = await importOriginal<typeof CollectedProcessModule>();
  return { ...original, runCollected: async (_executable: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => { captured.calls.push([...args]); captured.environments.push(options?.env); return { exitCode: 0, stdout: "", stderr: "" }; } };
});

const { TASK_SANDBOX_NETWORK, TaskSandbox, daemonProxyFromEnvironment, gatewayEgressFor, gatewayEgressFromEnvironment, sandboxDnsFromEnvironment } = await import("../../packages/worker/src/task-sandbox.js");
const { setupSharedNetwork } = await import("../../packages/worker/src/setup-agent-invocation.js");
const { DEVCONTAINER_GATEWAY_DOCKER, createDevcontainerCli, ensureGatewayNetwork } = await import("../../packages/worker/src/devcontainer.js");
const { evalInstallArgProblems, evalInstallRunArgs } = await import("../../packages/worker/src/verification/eval-bridged-exec.js");
const { createSetupSandbox } = await import("../../packages/worker/src/setup-agent.js");

const IMAGE = `rovara/worker@sha256:${"c".repeat(64)}`;
const TASK = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const PROXY = "http://172.28.251.2:3128";
const GATEWAY_ENV = { AGENTX_DAEMON_PROXY: PROXY, AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway", AGENTX_SANDBOX_NETWORK: "rovara-snet", AGENTX_SANDBOX_DNS: "172.28.250.2" } as const;
const flag = (args: readonly string[], name: string): string[] => args.flatMap((arg, index) => (args[index - 1] === name ? [arg] : []));

describe("gatewayEgressFor", () => {
  it("is on only for an EC2 worker whose boot said exactly `gateway`, and then needs both the network and the name server", () => {
    expect(gatewayEgressFor(GATEWAY_ENV)).toEqual({ network: "rovara-snet", dns: "172.28.250.2" });
    for (const environment of [{}, { AGENTX_RUNTIME: "ec2" }, { ...GATEWAY_ENV, AGENTX_SANDBOX_EGRESS: "bridge" }, { ...GATEWAY_ENV, AGENTX_SANDBOX_EGRESS: "Gateway" }, { ...GATEWAY_ENV, AGENTX_SANDBOX_EGRESS: "" },
      // A laptop sets the network (and no gateway egress); a variable alone on a non-EC2 worker means nothing.
      { AGENTX_SANDBOX_EGRESS: "gateway", AGENTX_SANDBOX_NETWORK: "rovara-snet", AGENTX_SANDBOX_DNS: "172.28.250.2" }]) {
      expect(gatewayEgressFor(environment), JSON.stringify(environment)).toBeUndefined();
      expect(gatewayEgressFromEnvironment(environment)).toBe(false);
    }
    expect(gatewayEgressFromEnvironment(GATEWAY_ENV)).toBe(true);
  });

  it("REFUSES (RUNTIME_UNAVAILABLE) a gateway-mode worker that has lost the network or the name server, and a name server that is not an IPv4 address", () => {
    const withoutNetwork = { AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway", AGENTX_SANDBOX_DNS: "172.28.250.2" };
    const withoutDns = { AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway", AGENTX_SANDBOX_NETWORK: "rovara-snet" };
    for (const environment of [withoutNetwork, withoutDns, { ...GATEWAY_ENV, AGENTX_SANDBOX_NETWORK: "" }, { ...GATEWAY_ENV, AGENTX_SANDBOX_DNS: "" }]) {
      expect(() => gatewayEgressFor(environment), JSON.stringify(environment)).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
    }
    for (const bad of ["dns.example.com", "1.2.3", "::1", "172.28.250.2 --dns 8.8.8.8", "--privileged"]) {
      expect(() => sandboxDnsFromEnvironment({ AGENTX_SANDBOX_DNS: bad }), bad).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    }
    expect(sandboxDnsFromEnvironment({})).toBeUndefined();
  });
});

describe("the task sandbox on a gateway-mode worker", () => {
  const cleanup: string[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
  async function start(environment: NodeJS.ProcessEnv, extra: Partial<ConstructorParameters<typeof TaskSandbox>[0]> = {}): Promise<{ calls: string[][]; error?: unknown }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-gateway-sandbox-")));
    cleanup.push(root);
    const calls: string[][] = [];
    const docker = { run: async (args: readonly string[]) => { calls.push([...args]); return { exitCode: 0, stdout: "", stderr: "" }; } };
    try {
      await new TaskSandbox({ rootPath: root, taskId: TASK, docker, image: IMAGE, environment, ...extra }).start();
      return { calls };
    } catch (error) {
      return { calls, error };
    }
  }

  it("runs on the internal network with the gateway as the ONE name server, and never makes, inspects or removes a network", async () => {
    const { calls, error } = await start(GATEWAY_ENV);
    expect(error).toBeUndefined();
    expect(calls.filter((call) => call[0] === "network")).toEqual([]);
    const run = calls.find((call) => call[0] === "run")!;
    expect(flag(run, "--network")).toEqual(["rovara-snet"]);
    expect(flag(run, "--dns")).toEqual(["172.28.250.2"]);
    expect(run).not.toContain(TASK_SANDBOX_NETWORK);
  });

  it("ignores a name server a caller asked for: the gateway is the only one", async () => {
    const { calls } = await start(GATEWAY_ENV, { dns: ["8.8.8.8", "1.1.1.1"] });
    expect(flag(calls.find((call) => call[0] === "run")!, "--dns")).toEqual(["172.28.250.2"]);
  });

  it("REFUSES to start on a network of its own (a bridge with a way out), and without the network or the name server; docker is never asked to run anything", async () => {
    for (const [environment, extra] of [
      [GATEWAY_ENV, { network: { name: "agentx-setup-abcdef012345", ip: "172.29.4.3" }, dns: ["172.29.4.2"] }],
      [{ AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway" }, {}],
      [{ AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway", AGENTX_SANDBOX_NETWORK: "rovara-snet" }, {}],
      [{ AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway", AGENTX_SANDBOX_DNS: "172.28.250.2" }, {}],
    ] as const) {
      const { calls, error } = await start(environment, extra);
      expect(error, JSON.stringify(environment)).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect(calls, JSON.stringify(environment)).toEqual([]);
    }
  });

  it("is byte-identical to before when the gateway is off: the shared bridge made on demand, no --dns; and a laptop's own network is unchanged", async () => {
    const bridge = await start({ AGENTX_RUNTIME: "ec2" });
    expect(bridge.calls).toContainEqual(["network", "create", "--driver", "bridge", TASK_SANDBOX_NETWORK]);
    const run = bridge.calls.find((call) => call[0] === "run")!;
    expect(flag(run, "--network")).toEqual([TASK_SANDBOX_NETWORK]);
    expect(run).not.toContain("--dns");
    const laptop = await start({ AGENTX_SANDBOX_NETWORK: "rovara-snet-0123" });
    expect(flag(laptop.calls.find((call) => call[0] === "run")!, "--network")).toEqual(["rovara-snet-0123"]);
    expect(laptop.calls.find((call) => call[0] === "run")).not.toContain("--dns");
  });

  it("the setup run's sandbox goes through the same network and name server, and the setup run takes the shared network instead of a run network of its own", async () => {
    expect(setupSharedNetwork(GATEWAY_ENV)).toBe("rovara-snet");
    expect(() => setupSharedNetwork({ AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway" })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
    // As before: an EC2 worker without the gateway gets a run network of its own, and a laptop its machine's network.
    expect(setupSharedNetwork({ AGENTX_RUNTIME: "ec2" })).toBeUndefined();
    expect(setupSharedNetwork({ AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_NETWORK: "rovara-snet-0123" })).toBeUndefined();
    expect(setupSharedNetwork({ AGENTX_SANDBOX_NETWORK: "rovara-snet-0123" })).toBe("rovara-snet-0123");
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-gateway-setup-")));
    cleanup.push(root);
    const calls: string[][] = [];
    const docker = { run: async (args: readonly string[]) => { calls.push([...args]); return { exitCode: 0, stdout: "", stderr: "" }; } };
    await createSetupSandbox({ rootPath: root, taskId: TASK, docker, image: IMAGE, environment: GATEWAY_ENV }).start();
    const run = calls.find((call) => call[0] === "run")!;
    expect(flag(run, "--network")).toEqual(["rovara-snet"]);
    expect(flag(run, "--dns")).toEqual(["172.28.250.2"]);
  });
});

describe("the eval install box on a gateway-mode worker", () => {
  const input = { network: "rovara-snet", image: IMAGE, name: "rovara-eval-install-abc-1-1", checkout: "/scratch/run-1/checkout", command: { executable: "python3", args: ["-m", "pip", "install", "-r", "requirements.txt"], cwd: "." }, taskId: "op-1", workspace: "0123456789abcdef" };

  it("takes the gateway as its one name server, and the argument check accepts exactly that one", () => {
    const args = evalInstallRunArgs({ ...input, dns: "172.28.250.2" });
    expect(flag(args, "--network")).toEqual(["rovara-snet"]);
    expect(flag(args, "--dns")).toEqual(["172.28.250.2"]);
    expect(evalInstallArgProblems(args, { ...input, dns: "172.28.250.2" })).toEqual([]);
    // Any other name server, a second one, or none where one is expected: refused.
    expect(evalInstallArgProblems(args, { ...input, dns: "8.8.8.8" }).length).toBeGreaterThan(0);
    expect(evalInstallArgProblems([...args.slice(0, args.indexOf("--workdir")), "--dns", "8.8.8.8", ...args.slice(args.indexOf("--workdir"))], { ...input, dns: "172.28.250.2" }).length).toBeGreaterThan(0);
    expect(evalInstallArgProblems(evalInstallRunArgs(input), { ...input, dns: "172.28.250.2" }).length).toBeGreaterThan(0);
    expect(() => evalInstallRunArgs({ ...input, dns: "not an address" })).toThrow("the eval install step's arguments are unsound");
  });

  it("without a gateway there is no --dns, and a --dns in the arguments is still refused (as before)", () => {
    const args = evalInstallRunArgs(input);
    expect(args).not.toContain("--dns");
    expect(evalInstallArgProblems(args, input)).toEqual([]);
    expect(evalInstallArgProblems([...args.slice(0, args.indexOf("--workdir")), "--dns", "8.8.8.8", ...args.slice(args.indexOf("--workdir"))], input)).toContain("a flag the install box does not take");
  });
});

describe("the devcontainer on a gateway-mode worker", () => {
  it("runs the CLI through the wrapper and walls the network: a gateway-mode worker's CLI has a walled network (the policy then refuses a repository's own --network and checks the started container)", async () => {
    captured.calls.length = 0;
    const cli = createDevcontainerCli({ environment: GATEWAY_ENV, dockerPath: "/usr/bin/docker" });
    expect(cli.walledNetwork?.name).toBe("rovara-snet");
    await cli.run(["up", "--workspace-folder", "/mnt/workspace/repo"], {});
    // The caller's own docker path is replaced by the wrapper.
    expect(captured.calls[0]!.slice(1, 4)).toEqual(["up", "--docker-path", DEVCONTAINER_GATEWAY_DOCKER]);
    expect(captured.calls[0]).not.toContain("/usr/bin/docker");
  });

  // Lane L4-NETG3 (DEC 254zzz105): the CLI downloads a project's features itself, on the host network; it is given the gateway's daemon proxy.
  it("runs the dev container CLI with the gateway's daemon proxy in its environment (HTTP_PROXY, HTTPS_PROXY, both spellings), keeping loopback off it", async () => {
    captured.calls.length = 0; captured.environments.length = 0;
    await createDevcontainerCli({ environment: GATEWAY_ENV, dockerPath: "/usr/bin/docker" }).run(["up"], {});
    const environment = captured.environments[0]!;
    expect(environment).toMatchObject({ HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, http_proxy: PROXY, https_proxy: PROXY, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" });
    // Not in gateway mode: the CLI's environment is left as it was (no env option at all).
    captured.environments.length = 0;
    await createDevcontainerCli({ environment: {} }).run(["up"], {});
    expect(captured.environments[0]).toBeUndefined();
  });

  it("daemonProxyFromEnvironment: only in gateway mode, only a plain http://address:port, and a gateway-mode worker without one refuses (a feature download never goes out directly)", () => {
    expect(daemonProxyFromEnvironment(GATEWAY_ENV)).toBe(PROXY);
    expect(daemonProxyFromEnvironment({})).toBeUndefined();
    expect(daemonProxyFromEnvironment({ ...GATEWAY_ENV, AGENTX_SANDBOX_EGRESS: "bridge" })).toBeUndefined();
    for (const bad of ["", "172.28.251.2:3128", "https://172.28.251.2:3128", "http://proxy.example.com:3128", "http://172.28.251.2", "http://172.28.251.2:3128/x", "http://172.28.251.2:99999", "http://999.1.1.1:3128", "http://user@172.28.251.2:3128"]) {
      expect(() => daemonProxyFromEnvironment({ ...GATEWAY_ENV, AGENTX_DAEMON_PROXY: bad }), bad).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
    }
    const without: Record<string, string> = { ...GATEWAY_ENV };
    delete without["AGENTX_DAEMON_PROXY"];
    expect(() => daemonProxyFromEnvironment(without)).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
    expect(() => createDevcontainerCli({ environment: without })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
  });

  it("is untouched when the gateway is off: no walled network, the caller's docker path or none", async () => {
    captured.calls.length = 0;
    for (const environment of [{}, { AGENTX_RUNTIME: "ec2" }, { AGENTX_SANDBOX_NETWORK: "rovara-snet-0123" }]) expect(createDevcontainerCli({ environment }).walledNetwork).toBeUndefined();
    await createDevcontainerCli({ environment: {} }).run(["up"], {});
    expect(captured.calls[0]!.slice(1)).toEqual(["up"]);
  });

  it("REFUSES to build a CLI on a gateway-mode worker that has lost its network or name server", () => {
    expect(() => createDevcontainerCli({ environment: { AGENTX_RUNTIME: "ec2", AGENTX_SANDBOX_EGRESS: "gateway" } })).toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
  });

  it("checks the network before every start: it must exist, be a bridge and be internal; anything else refuses", async () => {
    await expect(ensureGatewayNetwork("rovara-snet", async (args) => { expect(args).toEqual(["network", "inspect", "--format", "{{.Driver}}|{{.Internal}}", "rovara-snet"]); return "bridge|true\n"; })).resolves.toBeUndefined();
    for (const answer of ["bridge|false", "host|true", "", "bridge|true|extra"]) {
      await expect(ensureGatewayNetwork("rovara-snet", async () => answer), answer).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    }
    await expect(ensureGatewayNetwork("rovara-snet", async () => { throw new Error("no such network"); })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});
