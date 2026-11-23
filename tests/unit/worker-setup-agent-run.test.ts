// The setup run, put together (SH14, worker side), with every outside thing a fake: Docker, the model session and the broker. The things that matter: the run reads the commit the broker resolved
// (never a pull request head); the sandbox is on the run's own network and the worker is not; the agent's shell and a person's command share ONE serialized no-secret base; the journal, host asks and a
// person's commands travel over the one callback and never name a person; the sandbox is removed BEFORE the last tracked-files look; and the network is removed at the end, whatever happened.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { SETUP_AGENT_LIMITS_DEFAULT, SETUP_HOST_WAIT_MAX_HOURS, SetupEvalDiscoveryReportSchema, SetupRunSummarySchema, UPKEEP_PAUSE_MESSAGES } from "../../packages/contracts/src/index.js";
import { assertCommitsMatch, hostAnswerNote, runSetupAgent, serialize, setupRepositoriesOf, type SetupRunInput, type SetupRunPorts } from "../../packages/worker/src/setup-agent-run.js";
import { createSetupSandbox, type TrackedFilesVerdict } from "../../packages/worker/src/setup-agent.js";
import { helperRunArgs, networkCreateArgs, setupNetworkAddresses, setupNetworkName, setupNetworkSlot, startRunNetwork } from "../../packages/worker/src/setup-network.js";
import type { PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import type { RunNetwork } from "../../packages/worker/src/setup-network.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const COMMIT = "a".repeat(40);
const OPERATION = "11111111-1111-4111-8111-111111111111";
const ANSWER = {
  setup: [{ repo: "web", commands: ["npm ci"], confidence: "high", from: [{ kind: "file", repo: "web", path: "package.json", line: 2, quote: "\"scripts\"" }] }],
  tests: [{ repo: "web", commands: ["npm test"], from: [{ kind: "ci", repo: "web", path: ".github/workflows/ci.yml", line: 5, quote: "run: npm test" }] }],
};
const block = (answer: unknown) => `done\n\`\`\`agentx-setup-proposal\n${JSON.stringify(answer)}\n\`\`\``;
const repo = { name: "web", path: "repo/web", resolvedCommit: COMMIT };
const COMMITS = [{ repository: "web", commit: COMMIT }];

interface World {
  order: string[];
  callbacks: unknown[];
  files: TrackedFilesVerdict[];
  blocked: string[];
  stopped: { network: boolean };
  ran: Array<{ command: string; at: number }>;
  concurrent: { now: number; max: number };
  steered: string[];
  prompts: string[];
  progress: string[];
  base: { exec: BashOperations["exec"] };
  control?: { abort(): Promise<void>; steer(text: string): Promise<boolean>; streaming(): boolean };
}

async function world(options: {
  script?: (parts: { bash: BashOperations; world: World; n: number; emit: (event: unknown) => void }) => Promise<void>;
  final?: string | ((n: number) => string); hostOutcome?: string; poll?: (n: number) => unknown; files?: TrackedFilesVerdict[]; blocked?: string[]; limits?: Partial<typeof SETUP_AGENT_LIMITS_DEFAULT>; repositories?: SetupRunInput["repositories"];
} = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), "setup-run-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, "repo/web"), { recursive: true });
  const w: World = { order: [], callbacks: [], files: options.files ?? [], blocked: options.blocked ?? [], stopped: { network: false }, ran: [], concurrent: { now: 0, max: 0 }, steered: [], prompts: [], progress: [], base: { exec: async () => ({ exitCode: 0 }) } };
  let polls = 0;
  const base: BashOperations = {
    async exec(command, _cwd, opts) {
      w.concurrent.now += 1; w.concurrent.max = Math.max(w.concurrent.max, w.concurrent.now);
      w.ran.push({ command, at: w.ran.length });
      opts.onData(Buffer.from("ok\n"));
      await new Promise((resolve) => setTimeout(resolve, command === "a-long-command-a-person-typed" ? 300 : 5));
      w.concurrent.now -= 1;
      return { exitCode: 0 };
    },
  };
  w.base = base;
  const listeners: Array<(event: unknown) => void> = [];
  const session: PiSessionHandle = {
    conversationId: "c", sessionFile: "f", prompt: async (text?: string) => { w.prompts.push(String(text)); w.order.push("prompt"); await options.script?.({ bash: sessionBash!, world: w, n: w.prompts.length, emit: (event) => { for (const l of listeners) l(event); } }); for (const l of listeners) l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: typeof options.final === "function" ? options.final(w.prompts.length) : (options.final ?? block(ANSWER)) }], usage: { input: 1000 } } }); },
    steer: async (text) => { w.steered.push(text); }, isStreaming: () => true, abort: async () => { w.order.push("abort"); },
    getModel: () => ({ provider: "p", modelId: "m" }), getSessionStats: () => ({ cost: 0.05 }) as never, subscribe: (l) => { listeners.push(l); return () => undefined; }, dispose: () => { w.order.push("session.dispose"); },
  };
  let sessionBash: BashOperations | undefined;
  const network: RunNetwork = { name: "agentx-setup-0123456789ab", subnet: "172.29.9.0/24", gateway: "172.29.9.1", helperName: "h", helperIp: "172.29.9.2", sandboxIp: "172.29.9.3", readBlocked: async () => w.blocked, stop: async () => { w.stopped.network = true; w.order.push("network.stop"); } };
  const ports: SetupRunPorts = {
    startNetwork: async () => network,
    createSandbox: () => ({ bashOperations: () => base, dispose: async () => { w.order.push("sandbox.dispose"); }, fileOpsTarget: () => ({}) }) as never,
    openSession: async (parts) => { sessionBash = parts.bashOperations; return session; },
    callback: async (body) => { w.callbacks.push(body); const kind = (body as { kind: string }).kind; return kind === "poll" ? (options.poll?.(++polls) ?? { hosts: [] }) : kind === "host" && options.hostOutcome !== undefined ? { outcome: options.hostOutcome } : { ok: true }; },
    progress: async (message) => { w.progress.push(message); },
    register: (control) => { w.control = control; return () => undefined; },
    checkFiles: async () => { w.order.push("checkFiles"); return w.files.shift() ?? { ok: true }; },
    tickMs: 5,
    parkTickMs: 5,
  };
  ports.beforeStart = async () => ({ scan: { repositories: [], setup: [], tests: [], checks: [], knowledge: [], sources: [], foundNotUsed: [], notes: [] }, tracked: new Map([["web", new Set(["package.json", ".github/workflows/ci.yml"])]]) });
  const input: SetupRunInput = { rootPath, operationId: OPERATION, basedOnRevision: 4, limits: { ...SETUP_AGENT_LIMITS_DEFAULT, ...options.limits }, price: { inputPerMTok: 3, outputPerMTok: 15 }, repositories: options.repositories ?? [repo], commits: options.repositories === undefined ? [{ repository: "web", commit: COMMIT }] : options.repositories.map((r) => ({ repository: r.name, commit: r.resolvedCommit })), ports };
  return { w, input, rootPath };
}

describe("what the run reads (ED-1)", () => {
  it("refuses a workspace with a pull request head checked out, a commit that is not a full hash, and no repository", () => {
    expect(() => setupRepositoriesOf("/work", [{ ...repo, checkedOut: { pullRequest: 3, headSha: "b".repeat(40) } }])).toThrow();
    expect(() => setupRepositoriesOf("/work", [{ ...repo, resolvedCommit: "main" }])).toThrow();
    expect(() => setupRepositoriesOf("/work", [{ ...repo, resolvedCommit: "abc123" }])).toThrow();
    expect(() => setupRepositoriesOf("/work", [])).toThrow();
  });
});

describe("P1: the manifest is held to the commits the broker recorded", () => {
  it("refuses a different commit, a missing list, a repository the broker did not record, a repository missing from the manifest and a repeated entry", () => {
    expect(() => assertCommitsMatch([repo], [{ repository: "web", commit: "b".repeat(40) }])).toThrow(/another commit/u);
    expect(() => assertCommitsMatch([repo], undefined)).toThrow(/commits the broker recorded/u);
    expect(() => assertCommitsMatch([repo], [{ repository: "api", commit: COMMIT }])).toThrow();
    expect(() => assertCommitsMatch([repo], [...COMMITS, { repository: "api", commit: COMMIT }])).toThrow();
    expect(() => assertCommitsMatch([repo, { ...repo, name: "api", path: "repo/api" }], COMMITS)).toThrow();
    expect(() => assertCommitsMatch([repo], [...COMMITS, ...COMMITS])).toThrow();
  });
});

describe("F5: a run a person stopped finishes, within a few seconds, and reports what it had", () => {
  const stopMidRun = async ({ bash, world: w }: { bash: BashOperations; world: World }) => {
    await bash.exec("npm ci", "/work", { onData: () => undefined });
    await w.control!.abort();
  };
  it("keeps no proposal when the last look at the tracked files finds a change, as for any end", async () => {
    const t = await world({ script: stopMidRun, files: [{ ok: true }, { ok: false, reason: "tracked_files_changed" }] });
    const result = await runSetupAgent(t.input);
    expect(result.setupProposal).toBeUndefined();
    expect(result.setupRunSummary.stop).toBe("changed_repository_files");
  });
  it("is bounded: when the finish takes longer than the bound it reports the stop with no proposal, and still tears the sandbox and the network down", async () => {
    const t = await world({ script: stopMidRun });
    t.input.stopFinishMs = 30;
    t.input.ports.checkFiles = async () => { t.w.order.push("checkFiles"); if (t.w.order.includes("sandbox.dispose")) await new Promise((resolve) => setTimeout(resolve, 400)); return { ok: true }; };
    const started = Date.now();
    const result = await runSetupAgent(t.input);
    expect(Date.now() - started).toBeLessThan(350);
    expect(result.setupProposal).toBeUndefined();
    expect(result.setupRunSummary).toMatchObject({ partial: true });
    expect(t.w.stopped.network).toBe(true);
    expect(t.w.order).toContain("sandbox.dispose");
  });
  it("a finish that fails is the stop with no proposal, never an error that hides the stop", async () => {
    const t = await world({ script: stopMidRun });
    t.input.ports.checkFiles = async () => { if (t.w.order.includes("sandbox.dispose")) throw new Error("git is gone"); return { ok: true }; };
    const result = await runSetupAgent(t.input);
    expect(result.setupProposal).toBeUndefined();
    expect(result.setupRunSummary.partial).toBe(true);
  });
});

describe("hosts_waiting: the run parks while a website waits for an administrator", () => {
  const HOUR = 3_600_000;
  const npmCi = async ({ bash }: { bash: BashOperations }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); };
  /** A run whose first command is blocked on `registry.acme.dev` (asked for, waiting), with a clock the test moves. */
  async function parked(poll: (n: number, w: World, clock: { now: number }) => unknown, over: { final?: string; hostOutcome?: string; limits?: Record<string, number> } = {}) {
    const clock = { now: Date.parse("2026-11-02T10:00:00.000Z") };
    const t = await world({ script: async (parts) => { if (parts.n === 1) await npmCi(parts); }, blocked: ["registry.acme.dev"], hostOutcome: over.hostOutcome ?? "created", ...(over.final === undefined ? {} : { final: over.final }), ...(over.limits === undefined ? {} : { limits: over.limits }), poll: (n) => poll(n, t.w, clock) });
    t.input.ports.now = () => clock.now;
    return { ...t, clock };
  }
  const open = [{ host: "registry.acme.dev", state: "open" }];

  it("goes on when the administrator refuses, and tells the agent not to reach the website another way", async () => {
    const t = await parked((n) => ({ hosts: n < 3 ? open : [{ host: "registry.acme.dev", state: "refused" }] }));
    const result = await runSetupAgent(t.input);
    expect(t.w.prompts).toHaveLength(2);
    expect(t.w.prompts[1]).toContain("Not allowed: registry.acme.dev");
    expect(t.w.prompts[1]).toContain("Do not try to reach them another way");
    expect(result.setupRunSummary.stop).toBe("proposed");
  });

  it("ends hosts_waiting after 24 hours parked, keeps the partial proposal the agent had given, and makes no further model call", async () => {
    const t = await parked((n, _w, clock) => { if (n === 3) clock.now += SETUP_HOST_WAIT_MAX_HOURS * HOUR + 1000; return { hosts: open }; });
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary).toMatchObject({ stop: "hosts_waiting", partial: true });
    expect(t.w.prompts).toHaveLength(1);
    expect(JSON.stringify(result.setupProposal)).toContain("npm ci");
    expect(t.w.stopped.network).toBe(true);
  });

  it("does not end early: just under 24 hours parked it still waits", async () => {
    const t = await parked((n, _w, clock) => {
      if (n === 3) clock.now += SETUP_HOST_WAIT_MAX_HOURS * HOUR - 60_000;
      return { hosts: n < 6 ? open : [{ host: "registry.acme.dev", state: "approved" }] };
    });
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary.stop).toBe("proposed");
    expect(t.w.prompts).toHaveLength(2);
  });

  it("a run whose total wait is already used up ends hosts_waiting instead of parking again", async () => {
    const { SetupAgentGovernor } = await import("../../packages/worker/src/setup-agent-journal.js");
    const clock = { now: 0 };
    const governor = new SetupAgentGovernor({ limits: SETUP_AGENT_LIMITS_DEFAULT, now: () => clock.now, spendCents: () => 0, nextTurnCents: () => 0, setTimer: () => ({ cancel: () => undefined }) });
    governor.parkOnHosts();
    clock.now += 20 * HOUR;
    governor.resumeFromHosts();
    governor.parkOnHosts();
    clock.now += 4 * HOUR - 1;
    expect(governor.check()).toBeUndefined();
    clock.now += 1;
    expect(governor.check()).toBe("hosts_waiting");
    const spent = new SetupAgentGovernor({ limits: SETUP_AGENT_LIMITS_DEFAULT, now: () => clock.now, spendCents: () => 0, nextTurnCents: () => 0, setTimer: () => ({ cancel: () => undefined }) });
    spent.parkOnHosts();
    clock.now += 24 * HOUR;
    spent.resumeFromHosts();
    spent.parkOnHosts();
    expect(spent.ended()).toBe("hosts_waiting");
    // The wall clock does not count the parked time.
    expect(spent.elapsedMs()).toBe(0);
  });

  it("the note names only hosts and fixed words", () => {
    expect(hostAnswerNote(["a.acme.dev"], ["b.acme.dev"])).toBe([
      "Rovara note (not from the repository): you waited while an administrator decided the websites you asked for.",
      "Allowed: a.acme.dev. Rovara staff may still need to approve a website, so it may not work for a few minutes.",
      "Not allowed: b.acme.dev. Do not try to reach them another way.",
      "Redo only the steps that needed these websites, then answer again with your whole proposal in the same format.",
    ].join("\n"));
  });
});

describe("the talk with the broker", () => {
  it("a website asked for by a person's command carries that command's place, so the broker can say who typed it", async () => {
    let handed = false;
    const t = await world({
      blocked: [],
      poll: () => (handed ? { hosts: [] } : ((handed = true), { command: { seq: 1, command: "curl https://pkg.acme-build.io" }, hosts: [] })),
      script: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); t.w.blocked = ["pkg.acme-build.io"]; await new Promise((resolve) => setTimeout(resolve, 80)); },
    });
    // The helper's file changes while the person's command runs; the command's own entry carries the name.
    const original = t.w.base.exec;
    t.w.base.exec = async (...args) => { if (args[0] === "curl https://pkg.acme-build.io") t.w.blocked = ["pkg.acme-build.io"]; return original(...args); };
    await runSetupAgent(t.input);
    const host = t.w.callbacks.find((body) => (body as { kind: string }).kind === "host") as { viaCommandSeq?: number } | undefined;
    expect(host?.viaCommandSeq).toBe(1);
  });
  it("tells the agent when an admin allowed a website, once, without the broker's words", async () => {
    const t = await world({
      poll: () => ({ hosts: [{ host: "pkg.acme-build.io", state: "approved" }] }),
      script: async () => { await new Promise((resolve) => setTimeout(resolve, 60)); },
    });
    await runSetupAgent(t.input);
    expect(t.w.steered.filter((text) => text.includes("pkg.acme-build.io"))).toHaveLength(1);
  });
});

describe("one serialized base", () => {
  it("a failed command does not block the ones after it", async () => {
    let n = 0;
    const serial = serialize({ exec: async () => { n += 1; if (n === 1) throw new Error("x"); return { exitCode: 0 }; } });
    await expect(serial.exec("a", "/w", { onData: () => undefined })).rejects.toThrow();
    expect(await serial.exec("b", "/w", { onData: () => undefined })).toEqual({ exitCode: 0 });
  });
});

describe("the sandbox of the run holds no secret and sits on the run's own network", () => {
  const fakeDocker = () => {
    const calls: string[][] = [];
    const docker: DockerCli = { run: (args) => { calls.push([...args]); return Promise.resolve({ exitCode: 0, stdout: "[]", stderr: "" }); } };
    return { docker, calls };
  };
  it("starts the sandbox with the run's network, its address and the helper as the only resolver, and no environment variable", async () => {
    const { docker, calls } = fakeDocker();
    const rootPath = await mkdtemp(join(tmpdir(), "setup-sbx-"));
    roots.push(rootPath);
    const sandbox = createSetupSandbox({ rootPath, taskId: OPERATION, docker, image: "worker@sha256:" + "b".repeat(64), dns: ["172.29.9.2"], network: { name: "agentx-setup-0123456789ab", ip: "172.29.9.3" } });
    await sandbox.start();
    const run = calls.find((args) => args[0] === "run")!;
    const at = (flag: string) => run[run.indexOf(flag) + 1];
    expect(at("--network")).toBe("agentx-setup-0123456789ab");
    expect(at("--ip")).toBe("172.29.9.3");
    expect(at("--dns")).toBe("172.29.9.2");
    expect(run).not.toContain("--env");
    expect(run).not.toContain("-e");
    expect(calls.some((args) => args[0] === "network" && args[1] === "create")).toBe(false);
    await sandbox.dispose();
  });
  it("the Docker guard refuses another network, another address and a name as resolver", async () => {
    const { docker } = fakeDocker();
    const rootPath = await mkdtemp(join(tmpdir(), "setup-sbx-"));
    roots.push(rootPath);
    const guarded = (await import("../../packages/worker/src/setup-agent.js")).guardedSetupDocker(docker, { rootPath, network: { name: "agentx-setup-0123456789ab", ip: "172.29.9.3", helperIp: "172.29.9.2" } });
    const { taskSandboxRunArgs } = await import("../../packages/worker/src/task-sandbox.js");
    const good = taskSandboxRunArgs({ name: "agentx-task-x", taskId: "x", image: "i", rootPath, maskedPaths: [], dns: ["172.29.9.2"], network: { name: "agentx-setup-0123456789ab", ip: "172.29.9.3" }, hostCpus: 2, hostMemoryBytes: 8 * 2 ** 30 });
    await expect(guarded.run(good)).resolves.toBeTruthy();
    for (const bad of [
      taskSandboxRunArgs({ name: "agentx-task-x", taskId: "x", image: "i", rootPath, maskedPaths: [], dns: ["172.29.9.2"], network: { name: "agentx-task", ip: "172.29.9.3" }, hostCpus: 2, hostMemoryBytes: 8 * 2 ** 30 }),
      taskSandboxRunArgs({ name: "agentx-task-x", taskId: "x", image: "i", rootPath, maskedPaths: [], dns: ["172.29.9.2"], network: { name: "agentx-setup-0123456789ab", ip: "172.29.9.9" }, hostCpus: 2, hostMemoryBytes: 8 * 2 ** 30 }),
      good.map((arg) => (arg === "172.29.9.2" ? "evil.example.com" : arg)),
      taskSandboxRunArgs({ name: "agentx-task-x", taskId: "x", image: "i", rootPath, maskedPaths: [], hostCpus: 2, hostMemoryBytes: 8 * 2 ** 30 }),
    ]) await expect(guarded.run(bad)).rejects.toThrow();
  });
});

describe("the network and the helper (deployment code; not run against Docker here)", () => {
  const fakeDocker = (script: (args: string[]) => { exitCode: number; stdout?: string; stderr?: string } = () => ({ exitCode: 0 })) => {
    const calls: string[][] = [];
    const docker: DockerCli = { run: (args) => { calls.push([...args]); const r = script([...args]); return Promise.resolve({ exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }); } };
    return { docker, calls };
  };
  it("derives names and addresses from numbers and hashes, never from free text", () => {
    expect(setupNetworkName(OPERATION)).toMatch(/^agentx-setup-[0-9a-f]{12}$/u);
    expect(setupNetworkSlot(OPERATION)).toBeGreaterThanOrEqual(1);
    expect(setupNetworkSlot(OPERATION, 5)).not.toBe(setupNetworkSlot(OPERATION, 0));
    expect(setupNetworkAddresses(7)).toEqual({ subnet: "172.29.7.0/24", gateway: "172.29.7.1", helperIp: "172.29.7.2", sandboxIp: "172.29.7.3", bridge: "rvbs7" });
    expect(() => setupNetworkAddresses(0)).toThrow();
    expect(() => setupNetworkAddresses(254)).toThrow();
  });
  it("the helper has no capability, is read-only, binds port 53 only through the one namespaced sysctl, serves only the sandbox and is bounded", () => {
    const args = helperRunArgs({ name: "n-dns", network: "n", taskId: OPERATION, workspace: "ws-key", image: "worker@sha256:" + "b".repeat(64), addresses: setupNetworkAddresses(7), upstream: "127.0.0.11" });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("--cap-drop")).toBe("ALL");
    expect(at("--security-opt")).toBe("no-new-privileges");
    expect(args).toContain("--read-only");
    expect(at("--sysctl")).toBe("net.ipv4.ip_unprivileged_port_start=53");
    expect(at("--user")).toBe("1000:1000");
    expect(at("--source")).toBe("172.29.7.3");
    expect(at("--listen")).toBe("172.29.7.2");
    expect(at("--pids-limit")).toBe("64");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--network=host");
    expect(args).not.toContain("--volume");
    expect(args.some((arg) => arg.includes("docker.sock"))).toBe(false);
  });
  it("makes the network, then the helper; reads the blocked names with one fixed exec; removes both at the end, once", async () => {
    const { docker, calls } = fakeDocker((args) => (args[0] === "exec" ? { exitCode: 0, stdout: JSON.stringify(["a.acme-build.io", 3, "b.acme-build.io"]) } : { exitCode: 0 }));
    const net = await startRunNetwork(docker, { taskId: OPERATION, workspace: "ws-key", image: "worker@sha256:" + "b".repeat(64) });
    expect(calls[0]!.slice(0, 3)).toEqual(["network", "create", "--driver"]);
    // The workspace label ties the run to one worker; the bridge name is what the boot firewall walls (rvb*).
    expect(calls[0]!.join(" ")).toMatch(/--label agentx\.setup-workspace=ws-key/u);
    expect(calls[0]!.join(" ")).toMatch(/com\.docker\.network\.bridge\.name=rvbs\d+/u);
    expect(calls[1]![0]).toBe("run");
    expect(await net.readBlocked()).toEqual(["a.acme-build.io", "b.acme-build.io"]);
    expect(calls.at(-1)).toEqual(["exec", net.helperName, "cat", "/state/blocked.json"]);
    await net.stop();
    await net.stop();
    expect(calls.filter((args) => args[0] === "network" && args[1] === "rm")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "rm")).toHaveLength(1);
  });
  it("tries the next subnet when one is taken, and removes what it made when the helper will not start", async () => {
    let creates = 0;
    const taken = fakeDocker((args) => (args[0] === "network" && args[1] === "create" ? (++creates === 1 ? { exitCode: 1, stderr: "Pool overlaps with other one on this address space" } : { exitCode: 0 }) : { exitCode: 0 }));
    await startRunNetwork(taken.docker, { taskId: OPERATION, workspace: "ws-key", image: "i" });
    expect(creates).toBe(2);
    const broken = fakeDocker((args) => (args[0] === "run" ? { exitCode: 125, stderr: "secret detail" } : { exitCode: 0 }));
    await expect(startRunNetwork(broken.docker, { taskId: OPERATION, workspace: "ws-key", image: "i" })).rejects.toThrow("AgentX could not set up the network for the setup run");
    expect(broken.calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(true);
    expect(broken.calls.some((args) => args[0] === "rm")).toBe(true);
  });
  it("a host interface name that is taken is cured by the next slot; a network of this name is not retried, and its error is never repeated", async () => {
    let creates = 0;
    const taken = fakeDocker((args) => (args[0] === "network" && args[1] === "create" ? (++creates === 1 ? { exitCode: 1, stderr: "Error response from daemon: bridge device rvbs7 already exists" } : { exitCode: 0 }) : { exitCode: 0 }));
    await startRunNetwork(taken.docker, { taskId: OPERATION, workspace: "ws-key", image: "i" });
    expect(creates).toBe(2);
    let same = 0;
    const clash = fakeDocker((args) => (args[0] === "network" && args[1] === "create" ? (++same, { exitCode: 1, stderr: "network with name agentx-setup-abc already exists" }) : { exitCode: 0 }));
    await expect(startRunNetwork(clash.docker, { taskId: OPERATION, workspace: "ws-key", image: "i" })).rejects.toThrow("AgentX could not set up the network for the setup run");
    expect(same).toBe(1);
  });
  it("reads nothing (not even a broken file) as an empty list", async () => {
    const bad = fakeDocker((args) => (args[0] === "exec" ? { exitCode: 0, stdout: "not json" } : { exitCode: 0 }));
    const net = await startRunNetwork(bad.docker, { taskId: OPERATION, workspace: "ws-key", image: "i" });
    expect(await net.readBlocked()).toEqual([]);
  });
  it("also builds the network create arguments from the hashed name only", () => {
    const args = networkCreateArgs("agentx-setup-abc", OPERATION, setupNetworkAddresses(7), "ws-key");
    expect(args).toContain("--subnet");
    // The host interface is rvbs<slot>, which the boot firewall's rvb+ rules wall off (tests/contract/container-firewall.test.ts).
    expect(args.join(" ")).toContain("--opt com.docker.network.bridge.name=rvbs7");
    expect(args).toContain("agentx.setup-workspace=ws-key");
    expect(args.at(-1)).toBe("agentx-setup-abc");
  });
});

describe("L12: setup runs turned off for the company end a run that is going", () => {
  it("L4-T5: the run says it was turned off (the summary's `cannot`), and a stop for any other reason does not say so", async () => {
    let polls = 0;
    const off = await world({
      script: async ({ bash }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); await new Promise((resolve) => setTimeout(resolve, 80)); await bash.exec("npm test", "/work", { onData: () => undefined }); },
      poll: () => { polls += 1; return polls >= 2 ? { hosts: [], companyOff: true } : { hosts: [] }; },
    });
    expect((await runSetupAgent(off.input)).setupRunSummary).toMatchObject({ stop: "infrastructure", partial: true, cannot: "company_off" });
    // Nothing can reach the run (5 polls in a row failed): it ends `infrastructure` too, but trying again can help, so it says nothing of being turned off.
    const unreachable = await world({ script: async ({ bash }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); await new Promise((resolve) => setTimeout(resolve, 200)); await bash.exec("npm test", "/work", { onData: () => undefined }); } });
    unreachable.input.ports.callback = async (body) => { if ((body as { kind: string }).kind !== "poll") return { ok: true }; throw new Error("the broker is unreachable"); };
    const summary = (await runSetupAgent(unreachable.input)).setupRunSummary;
    expect(summary.stop).toBe("infrastructure");
    expect(summary).not.toHaveProperty("cannot");
    // The run was already over for another reason (its command limit) when the answer came: the reason it stopped is the one it reports, with no cause of being turned off.
    let denied = false;
    const limited = await world({
      limits: { commands: 1 as never },
      script: async ({ bash }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); await bash.exec("npm test", "/work", { onData: () => undefined }).catch(() => undefined); denied = true; await new Promise((resolve) => setTimeout(resolve, 150)); },
      poll: () => (denied ? { hosts: [], companyOff: true } : { hosts: [] }),
    });
    const limitedSummary = (await runSetupAgent(limited.input)).setupRunSummary;
    expect(limitedSummary.stop).toBe("attempts_used");
    expect(limitedSummary).not.toHaveProperty("cannot");
    // A run that finished by itself before the answer came reports no cause.
    const done = await world({ script: async ({ bash }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); await bash.exec("npm test", "/work", { onData: () => undefined }); } });
    const finished = (await runSetupAgent(done.input)).setupRunSummary;
    expect(finished.stop).toBe("proposed");
    expect(finished).not.toHaveProperty("cannot");
  });
  it("L4-T5: after its talk stops, a run still ending (a person's command still running) says it is alive, and stops saying so once it is over", async () => {
    let polls = 0;
    const t = await world({
      script: async ({ bash }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); await new Promise((resolve) => setTimeout(resolve, 60)); },
      poll: () => { polls += 1; return polls === 1 ? { hosts: [], command: { seq: 1, command: "a-long-command-a-person-typed" } } : { hosts: [] }; },
    });
    t.input.ports.aliveMs = 20;
    const original = t.input.ports.callback.bind(t.input.ports);
    let beats = 0;
    t.input.ports.callback = async (body) => { if ((body as { kind: string }).kind === "alive") beats += 1; return original(body); };
    await runSetupAgent(t.input);
    expect(t.w.ran.map((entry) => entry.command)).toContain("a-long-command-a-person-typed");
    expect(beats).toBeGreaterThanOrEqual(2);
    const after = beats;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(beats).toBe(after);
  });
  it("the run still looks at the broker when its journal callback fails: a stop reaches it", async () => {
    let polls = 0;
    const t = await world({
      script: async ({ bash }) => {
        await bash.exec("npm ci", "/work", { onData: () => undefined });
        await new Promise((resolve) => setTimeout(resolve, 80));
        await bash.exec("npm test", "/work", { onData: () => undefined });
      },
    });
    t.input.ports.callback = async (body) => {
      const kind = (body as { kind: string }).kind;
      if (kind === "journal") throw new Error("the journal is refused");
      polls += 1;
      return polls >= 2 ? { hosts: [], companyOff: true } : { hosts: [] };
    };
    const result = await runSetupAgent(t.input);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(t.w.ran.map((entry) => entry.command)).toEqual(["npm ci"]);
    expect(result.setupRunSummary.stop).toBe("infrastructure");
  });
});

describe("F5: the invocation of a stopped run ends cancelled and carries its report", () => {
  it("is a cancelled end with the run's result when the cancel controller stopped the operation, and nothing for a run nobody cancelled", async () => {
    const { WorkerCancellationController, WorkerOperationCancelledError } = await import("../../packages/worker/src/cancel.js");
    const { cancelledWithReport } = await import("../../packages/worker/src/setup-agent-invocation.js");
    const controller = new WorkerCancellationController();
    const result = { workflowMode: "SETUP_AGENT" as const, setupRunSummary: { stop: "infrastructure", commandsRun: 1, spendCents: 0, elapsedMs: 5, hostAsks: 0, partial: true } as never };
    expect(cancelledWithReport(controller, OPERATION, result)).toBeUndefined();
    expect(cancelledWithReport(undefined, OPERATION, result)).toBeUndefined();
    controller.register(OPERATION, { abort: async () => undefined });
    await controller.cancel(OPERATION, 1);
    const stopped = cancelledWithReport(controller, OPERATION, result);
    expect(stopped).toBeInstanceOf(WorkerOperationCancelledError);
    expect(stopped?.setupRunResult).toBe(result);
    expect(cancelledWithReport(controller, "22222222-2222-4222-8222-222222222222", result)).toBeUndefined();
  });
});

describe("DEC 253q(a): the eval the agent drafts goes to the broker through the run's own setup callback", () => {
  const IMAGE = `registry.example/worker@sha256:${"e".repeat(64)}`;
  const EVAL = { suites: [{ selection: "evals/demo", questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt" }], command: { executable: "node", args: ["evals/run.js"], cwd: "." },
    report: { cwd: ".", argument: "rovara-measures.json" }, model: "gemini-2.5-flash", modelVersion: "gemini-2.5-flash-001", judge: { kind: "rule", scoringPath: "evals/demo/score.txt" }, subsetSupported: false, maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 5 }] };
  const tracked = new Map([["web", new Set(["package.json", ".github/workflows/ci.yml", "evals/demo/q1.txt", "evals/demo/score.txt"])]]);
  const scan = { repositories: [], setup: [], tests: [], checks: [], knowledge: [], sources: [], foundNotUsed: [], notes: [] };
  const evalWorld = async (options: { final?: string; image?: string; files?: TrackedFilesVerdict[] } = {}) => {
    const t = await world({ final: options.final ?? block({ ...ANSWER, eval: EVAL }), ...(options.files === undefined ? {} : { files: options.files }) });
    t.input.ports.beforeStart = async () => ({ scan, tracked });
    t.input.evalImage = options.image ?? IMAGE;
    t.input.discoverEvals = async () => ({ status: "found", candidates: [{ path: "evals/demo", label: "x", tool: "eval folder" }], omitted: [], message: "" });
    return t;
  };
  const sent = (t: { w: World }) => t.w.callbacks.filter((body) => (body as { kind: string }).kind === "eval_discovery") as Array<{ report: { suites: Array<Record<string, unknown>> } }>;
  it("sends nothing when the agent drafted no eval, the draft fails a rule, the worker image is not pinned, the run ended without a proposal or asked for a code change (mutant: the proposed-only gate)", async () => {
    for (const t of [await evalWorld({ final: block(ANSWER) }), await evalWorld({ final: block({ ...ANSWER, eval: { suites: [{ ...EVAL.suites[0], judgePin: "b".repeat(64) }] } }) }),
      await evalWorld({ image: "worker:latest" }), await evalWorld({ files: [{ ok: false, reason: "tracked_files_changed" }] }),
      await evalWorld({ final: `NEEDS CODE CHANGE: the lockfile is broken\n${block({ ...ANSWER, eval: EVAL })}` })]) {
      await runSetupAgent(t.input);
      expect(sent(t)).toEqual([]);
    }
  });
  it("a draft it could not use is said in fixed words on the run's live view, never the draft or a path (mutant: the progress line)", async () => {
    const t = await evalWorld({ final: block({ ...ANSWER, eval: { suites: [{ ...EVAL.suites[0], questions: [{ id: "q1", category: "ordinary", path: "evals/demo/secret-canary.txt" }] }] } }) });
    await runSetupAgent(t.input);
    expect(t.w.progress).toContain("Rovara did not use the eval the setup drafted (a file it names is not in the repository).");
    expect(t.w.progress.join("\n")).not.toContain("secret-canary");
    const none = await evalWorld({ final: block(ANSWER) });
    await runSetupAgent(none.input);
    expect(none.w.progress.join("\n")).not.toContain("did not use the eval");
  });
  // DEC 254zzz43: the wrapper file is dry-run in THIS sandbox, before the sandbox is removed, and only a pass makes it offered.
  const ROWS_OUTPUT = { kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true } };
  const GOOD_REPORT = "---REPORT---\n<testsuite name=\"rovara-eval\" tests=\"2\" failures=\"1\">\n  <testcase classname=\"eval\" name=\"rovara-dry-run-pass\"/>\n  <testcase classname=\"eval\" name=\"rovara-dry-run-fail\"><failure message=\"did not pass\"/></testcase>\n</testsuite>\n";
  const wrapperWorld = async (exec: (command: string) => { exitCode: number; output: string }) => {
    const t = await evalWorld({ final: block({ ...ANSWER, eval: { suites: [{ ...EVAL.suites[0], output: ROWS_OUTPUT }] } }) });
    t.w.base.exec = async (command, _cwd, opts) => {
      if (!command.includes("rovara-wrapper-dryrun")) return { exitCode: 0 };
      t.w.order.push("dry-run");
      const done = exec(command);
      opts.onData(Buffer.from(done.output));
      return { exitCode: done.exitCode };
    };
    return t;
  };
  it("dry-runs the wrapper in the setup sandbox BEFORE it is removed, and a pass is carried into the report (mutants: the order, the carry)", async () => {
    const t = await wrapperWorld(() => ({ exitCode: 0, output: GOOD_REPORT }));
    await runSetupAgent(t.input);
    expect(t.w.order.indexOf("dry-run")).toBeGreaterThanOrEqual(0);
    expect(t.w.order.indexOf("dry-run")).toBeLessThan(t.w.order.indexOf("sandbox.dispose"));
    expect(sent(t)[0]!.report.suites[0]).toMatchObject({ output: ROWS_OUTPUT, wrapperDryRun: "passed" });
  });
  it("a broker that refuses the report does not fail the run", async () => {
    const t = await evalWorld();
    const ports = t.input.ports;
    const callback = (body: unknown) => ports.callback(body);
    t.input.ports = { ...ports, callback: async (body) => { if ((body as { kind: string }).kind === "eval_discovery") throw new Error("refused"); return callback(body); } };
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary).toMatchObject({ stop: "proposed" });
    expect(result.setupProposal).toBeDefined();
  });
});

describe("L4-E12: the free dry run of the drafted eval goes through the same callback, after the report, and never changes the run", () => {
  const IMAGE = `registry.example/worker@sha256:${"e".repeat(64)}`;
  const EVAL = { suites: [{ selection: "evals/demo", questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt" }], command: { executable: "node", args: ["evals/run.js"], cwd: "." },
    report: { cwd: ".", argument: "rovara-measures.json" }, model: "gemini-2.5-flash", modelVersion: "gemini-2.5-flash-001", judge: { kind: "rule", scoringPath: "evals/demo/score.txt" }, subsetSupported: false, maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 10 }] };
  const tracked = new Map([["web", new Set(["package.json", ".github/workflows/ci.yml", "evals/demo/q1.txt", "evals/demo/score.txt"])]]);
  const scan = { repositories: [], setup: [], tests: [], checks: [], knowledge: [], sources: [], foundNotUsed: [], notes: [] };
  const LIST = { version: 1, modelCalls: 0, ended: "failed", databases: [{ port: 5432, engine: "postgres" }], hosts: [], envVars: [] };
  const evalWorld = async (dry?: (report: unknown, signal: AbortSignal) => Promise<unknown>, options: { files?: TrackedFilesVerdict[]; final?: string } = {}) => {
    const t = await world({ final: options.final ?? block({ ...ANSWER, eval: EVAL }), ...(options.files === undefined ? {} : { files: options.files }) });
    t.input.ports.beforeStart = async () => ({ scan, tracked });
    t.input.evalImage = IMAGE;
    t.input.discoverEvals = async () => ({ status: "found", candidates: [{ path: "evals/demo", label: "x", tool: "eval folder" }], omitted: [], message: "" });
    if (dry !== undefined) t.input.evalDryRun = dry as never;
    return t;
  };
  const kinds = (t: { w: World }) => t.w.callbacks.map((body) => (body as { kind: string }).kind);

  it("sends the list once, right after the eval report, only for a report the broker took", async () => {
    const seen: unknown[] = [];
    const t = await evalWorld(async (report) => { seen.push(report); return LIST; });
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary).toMatchObject({ stop: "proposed" });
    expect(kinds(t).slice(-2)).toEqual(["eval_discovery", "eval_dry_run"]);
    expect(t.w.callbacks.at(-1)).toEqual({ kind: "eval_dry_run", list: LIST });
    expect(seen).toHaveLength(1);
    expect(SetupEvalDiscoveryReportSchema.safeParse(seen[0]).success).toBe(true);
  });

  it("a dry run that fails, finds nothing to say (undefined) or whose callback is refused leaves the run's result exactly as it was", async () => {
    const plain = await evalWorld();
    const base = await runSetupAgent(plain.input);
    for (const dry of [async () => { throw new Error("boom"); }, async () => undefined]) {
      const t = await evalWorld(dry);
      const result = await runSetupAgent(t.input);
      expect(result.setupRunSummary).toMatchObject({ stop: base.setupRunSummary.stop });
      expect(result.setupProposal).toEqual(base.setupProposal);
      expect(kinds(t)).not.toContain("eval_dry_run");
    }
    const t = await evalWorld(async () => LIST);
    const ports = t.input.ports;
    t.input.ports = { ...ports, callback: async (body) => { if ((body as { kind: string }).kind === "eval_dry_run") throw new Error("refused"); return ports.callback(body); } };
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary).toMatchObject({ stop: "proposed" });
    expect(result.setupProposal).toBeDefined();
  });

});

// L4-SR2: the gateway's upkeep pause under an unattended repair draft. The worker reads the gateway's fixed sentence (as the wiki build's worker does), ends the run `infrastructure` and puts the reason in the summary; a plain
// model refusal, a spent budget and any other fault carry none. The broker takes the word only from an unattended draft (tests/unit/setup-repair-draft.test.ts).
describe("L4-SR2: the gateway's upkeep pause", () => {
  const errored = (message: string) => async ({ emit }: { emit: (event: unknown) => void }) => { emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: message, content: [], usage: { input: 10 } } }); };
  it.each(Object.entries(UPKEEP_PAUSE_MESSAGES))("a turn that failed with the %s sentence ends the run `infrastructure` with that reason in the summary (mutant: the pause is not read)", async (reason, sentence) => {
    const t = await world({ script: errored(`422 ${sentence}`) });
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary).toMatchObject({ stop: "infrastructure", pause: reason });
    expect(SetupRunSummarySchema.safeParse(result.setupRunSummary).success).toBe(true);
  });
  it("a prompt that throws the sentence reports the same", async () => {
    const t = await world({ script: async () => { throw new Error(UPKEEP_PAUSE_MESSAGES.monthly_limit); } });
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary).toMatchObject({ stop: "infrastructure", pause: "monthly_limit" });
  });
  it("any other refusal carries no pause, and words that only look like the sentence are not one", async () => {
    for (const script of [errored("the provider is down"), errored("upkeep_paused: nightly upkeep is paused"), async () => { throw new Error("the provider is down"); }]) {
      const t = await world({ script });
      const result = await runSetupAgent(t.input);
      expect(result.setupRunSummary).not.toHaveProperty("pause");
    }
    const ordinary = await world();
    expect((await runSetupAgent(ordinary.input)).setupRunSummary).not.toHaveProperty("pause");
  });
});

// A glued package-manager run (`npm run lint npm test`) in the agent's answer is told to it once, in fixed words, and the corrected answer is the one read.
describe("a command the reader will not keep is told to the agent once", () => {
  const BAD = { ...ANSWER, tests: [{ ...ANSWER.tests[0]!, commands: ["npm run lint npm test"] }] };
  const names = (t: { w: World }) => t.w.prompts.filter((text) => text.includes("Rovara will not keep"));
  it("answers again once with the commands apart, and the second answer is the proposal", async () => {
    const t = await world({ final: (n) => block(n === 1 ? BAD : ANSWER) });
    const result = await runSetupAgent(t.input);
    expect(names(t)).toHaveLength(1);
    expect(t.w.prompts).toHaveLength(2);
    expect(result.setupProposal?.tests[0]?.value.commands).toEqual(["npm test"]);
    expect(result.setupProposal?.flaggedCommands).toEqual([]);
  });
  it("a second answer that is still glued is flagged, not asked for again", async () => {
    const t = await world({ final: block(BAD) });
    const result = await runSetupAgent(t.input);
    expect(names(t)).toHaveLength(1);
    expect(result.setupProposal?.tests).toEqual([]);
    expect(result.setupProposal?.flaggedCommands.map((item) => item.command)).toEqual(["npm run lint npm test"]);
  });
  it("a second answer with no proposal block does not replace the first", async () => {
    const t = await world({ final: (n) => (n === 1 ? block(BAD) : "sorry, here you go") });
    const result = await runSetupAgent(t.input);
    expect(result.setupProposal?.flaggedCommands).toHaveLength(1);
    expect(result.setupProposal?.setup[0]?.value.commands).toEqual(["npm ci"]);
  });
  it("an answer with well-formed commands is never asked about again (mutant: always ask)", async () => {
    const t = await world();
    await runSetupAgent(t.input);
    expect(t.w.prompts).toHaveLength(1);
  });
});
