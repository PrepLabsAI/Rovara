// The setup run, put together (SH14, worker side), with every outside thing a fake: Docker, the model session and the broker. The things that matter: the run reads the commit the broker resolved
// (never a pull request head); the sandbox is on the run's own network and the worker is not; the agent's shell and a person's command share ONE serialized no-secret base; the journal, host asks and a
// person's commands travel over the one callback and never name a person; the sandbox is removed BEFORE the last tracked-files look; and the network is removed at the end, whatever happened.
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { SETUP_AGENT_LIMITS_DEFAULT, SETUP_HOST_WAIT_MAX_HOURS } from "../../packages/contracts/src/index.js";
import { assertCommitsMatch, hostAnswerNote, runSetupAgent, serialize, setupRepositoriesOf, type SetupRunInput, type SetupRunPorts } from "../../packages/worker/src/setup-agent-run.js";
import { createSetupSandbox, type TrackedFilesVerdict } from "../../packages/worker/src/setup-agent.js";
import { helperRunArgs, networkCreateArgs, setupWorkspaceKey, setupNetworkAddresses, setupNetworkName, setupNetworkSlot, startRunNetwork } from "../../packages/worker/src/setup-network.js";
import type { PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import type { RunNetwork } from "../../packages/worker/src/setup-network.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { workspaceKey } from "../../packages/worker/src/task-sandbox.js";

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
  final?: string; hostOutcome?: string; poll?: (n: number) => unknown; files?: TrackedFilesVerdict[]; blocked?: string[]; limits?: Partial<typeof SETUP_AGENT_LIMITS_DEFAULT>; repositories?: SetupRunInput["repositories"];
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
      await new Promise((resolve) => setTimeout(resolve, 5));
      w.concurrent.now -= 1;
      return { exitCode: 0 };
    },
  };
  w.base = base;
  const listeners: Array<(event: unknown) => void> = [];
  const session: PiSessionHandle = {
    conversationId: "c", sessionFile: "f", prompt: async (text?: string) => { w.prompts.push(String(text)); w.order.push("prompt"); await options.script?.({ bash: sessionBash!, world: w, n: w.prompts.length, emit: (event) => { for (const l of listeners) l(event); } }); for (const l of listeners) l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: options.final ?? block(ANSWER) }], usage: { input: 1000 } } }); },
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
  it("takes the repositories from the manifest, at the commit the broker resolved", () => {
    expect(setupRepositoriesOf("/work", [repo])).toEqual([{ ...repo, directory: "/work/repo/web" }]);
  });
  it("refuses a workspace with a pull request head checked out, a commit that is not a full hash, and no repository", () => {
    expect(() => setupRepositoriesOf("/work", [{ ...repo, checkedOut: { pullRequest: 3, headSha: "b".repeat(40) } }])).toThrow();
    expect(() => setupRepositoriesOf("/work", [{ ...repo, resolvedCommit: "main" }])).toThrow();
    expect(() => setupRepositoriesOf("/work", [{ ...repo, resolvedCommit: "abc123" }])).toThrow();
    expect(() => setupRepositoriesOf("/work", [])).toThrow();
  });
  it("hands the tracked-files check the manifest's directory, never a path from anywhere else", async () => {
    const t = await world();
    const seen: string[] = [];
    t.input.ports.checkFiles = async (repositories) => { seen.push(...repositories.map((r) => `${r.directory}@${r.resolvedCommit ?? ""}`)); return { ok: true }; };
    await runSetupAgent(t.input);
    expect(new Set(seen)).toEqual(new Set([`${t.rootPath}/repo/web@${COMMIT}`]));
  });
});

describe("P1: the manifest is held to the commits the broker recorded", () => {
  it("accepts the manifest when every repository's commit equals the recorded one", () => {
    expect(() => assertCommitsMatch([repo], COMMITS)).not.toThrow();
  });
  it("refuses a different commit, a missing list, a repository the broker did not record, a repository missing from the manifest and a repeated entry", () => {
    expect(() => assertCommitsMatch([repo], [{ repository: "web", commit: "b".repeat(40) }])).toThrow(/another commit/u);
    expect(() => assertCommitsMatch([repo], undefined)).toThrow(/commits the broker recorded/u);
    expect(() => assertCommitsMatch([repo], [{ repository: "api", commit: COMMIT }])).toThrow();
    expect(() => assertCommitsMatch([repo], [...COMMITS, { repository: "api", commit: COMMIT }])).toThrow();
    expect(() => assertCommitsMatch([repo, { ...repo, name: "api", path: "repo/api" }], COMMITS)).toThrow();
    expect(() => assertCommitsMatch([repo], [...COMMITS, ...COMMITS])).toThrow();
  });
  it("starts nothing (no network, no sandbox) when the commits differ", async () => {
    const t = await world();
    t.input.commits = [{ repository: "web", commit: "c".repeat(40) }];
    await expect(runSetupAgent(t.input)).rejects.toThrow(/another commit/u);
    expect(t.w.order).toEqual([]);
    expect(t.w.stopped.network).toBe(false);
  });
});

describe("F5: a run a person stopped finishes, within a few seconds, and reports what it had", () => {
  const stopMidRun = async ({ bash, world: w }: { bash: BashOperations; world: World }) => {
    await bash.exec("npm ci", "/work", { onData: () => undefined });
    await w.control!.abort();
  };
  it("kills the sandbox, looks at the tracked files once more, and reports the proposal it had, marked partial", async () => {
    const t = await world({ script: stopMidRun });
    const result = await runSetupAgent(t.input);
    expect(JSON.stringify(result.setupProposal)).toContain("npm ci");
    expect(result.setupRunSummary).toMatchObject({ partial: true, commandsRun: 1 });
    expect(result.setupRunSummary.stop).not.toBe("proposed");
    const afterPrompt = t.w.order.slice(t.w.order.indexOf("prompt"));
    expect(afterPrompt.indexOf("sandbox.dispose")).toBeLessThan(afterPrompt.lastIndexOf("checkFiles"));
    expect(t.w.stopped.network).toBe(true);
  });
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
  it("a run nobody stopped has no bound on its finish: a slow last look still ends with its proposal", async () => {
    const t = await world({ script: async ({ bash }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); } });
    t.input.stopFinishMs = 5;
    t.input.ports.checkFiles = async () => { await new Promise((resolve) => setTimeout(resolve, 60)); return { ok: true }; };
    const result = await runSetupAgent(t.input);
    expect(result.setupProposal).toBeDefined();
    expect(result.setupRunSummary).toMatchObject({ stop: "proposed", partial: false });
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

  it("waits without a model call while the ask is open, and goes on with one more prompt when an administrator allows the website", async () => {
    let promptsWhileOpen = -1;
    const t = await parked((n, w, clock) => {
      if (n === 3) { promptsWhileOpen = w.prompts.length; clock.now += 2 * HOUR; }
      return { hosts: n < 4 ? open : [{ host: "registry.acme.dev", state: "approved" }] };
    });
    const result = await runSetupAgent(t.input);
    expect(promptsWhileOpen).toBe(1);
    expect(t.w.prompts).toHaveLength(2);
    expect(t.w.prompts[1]).toContain("Allowed: registry.acme.dev");
    expect(t.w.prompts[1]).not.toContain("Not allowed");
    expect(t.w.progress).toContain("Rovara is waiting for an administrator to decide a website.");
    expect(result.setupRunSummary).toMatchObject({ stop: "proposed", partial: false });
    // The two hours parked are not the run's time.
    expect(result.setupRunSummary.elapsedMs).toBeLessThan(HOUR);
    expect(result.setupProposal).toBeDefined();
    // The sandbox was kept for the whole wait: it is removed once, at the end.
    expect(t.w.order.filter((entry) => entry === "sandbox.dispose").length).toBeGreaterThanOrEqual(1);
    expect(t.w.order.indexOf("sandbox.dispose")).toBeGreaterThan(t.w.order.lastIndexOf("prompt"));
  });

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

  it("the 24 hours are the whole run's wait: two waits of 20 hours end it at 24 hours in all, and a run that used them up does not park again", async () => {
    // Wait one: 20 hours, answered "approved" for a.acme.dev. Wait two: b.acme.dev stays open, and 4 hours more end the run.
    const clock = { now: Date.parse("2026-11-02T10:00:00.000Z") };
    let n = 0;
    const t = await world({
      script: async (parts) => { if (parts.n === 1) await parts.bash.exec("npm ci", "/work", { onData: () => undefined }); },
      blocked: ["a.acme.dev", "b.acme.dev"], hostOutcome: "created",
      poll: () => {
        n += 1;
        if (n === 3) clock.now += 20 * HOUR;
        if (n === 8) clock.now += 4 * HOUR + 1000;
        return { hosts: [{ host: "a.acme.dev", state: n < 4 ? "open" : "approved" }, { host: "b.acme.dev", state: "open" }] };
      },
    });
    t.input.ports.now = () => clock.now;
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary).toMatchObject({ stop: "hosts_waiting", partial: true });
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

  it("a person's Stop ends the wait at once and the run finishes as a stopped run (bounded), without another model call", async () => {
    const t = await parked((n, w) => { if (n === 3) void w.control!.abort(); return { hosts: open }; });
    const result = await runSetupAgent(t.input);
    expect(t.w.prompts).toHaveLength(1);
    expect(result.setupRunSummary).toMatchObject({ partial: true });
    expect(result.setupRunSummary.stop).not.toBe("proposed");
    expect(JSON.stringify(result.setupProposal)).toContain("npm ci");
  });

  it("does not park for an ask that waits for nobody (refused, already allowed), nor when the agent says setup needs a code change", async () => {
    for (const hostOutcome of ["refused", "already_allowed", "refused_before", "no_run", "too_many_open"]) {
      const t = await parked(() => ({ hosts: [] }), { hostOutcome });
      const result = await runSetupAgent(t.input);
      expect(t.w.prompts, hostOutcome).toHaveLength(1);
      expect(result.setupRunSummary.stop, hostOutcome).toBe("proposed");
    }
    const code = await parked(() => ({ hosts: open }), { final: `NEEDS CODE CHANGE: the lock file is broken\n${block(ANSWER)}` });
    const result = await runSetupAgent(code.input);
    expect(code.w.prompts).toHaveLength(1);
    expect(code.w.progress).not.toContain("Rovara is waiting for an administrator to decide a website.");
    expect(result.setupRunSummary.stop).toBe("needs_code_change");
  });

  it("sends the last command's entry and its website ask before it decides to wait, even if no talk with the broker has happened yet", async () => {
    const t = await parked((n) => ({ hosts: n < 3 ? open : [{ host: "registry.acme.dev", state: "approved" }] }));
    t.input.ports.tickMs = 600_000;
    const result = await runSetupAgent(t.input);
    expect(t.w.callbacks.filter((body) => (body as { kind: string }).kind === "host")).toHaveLength(1);
    expect(t.w.prompts).toHaveLength(2);
    expect(result.setupRunSummary.stop).toBe("proposed");
  });

  it("a run with no ask never parks", async () => {
    const t = await world({ script: npmCi });
    const result = await runSetupAgent(t.input);
    expect(t.w.prompts).toHaveLength(1);
    expect(t.w.progress).not.toContain("Rovara is waiting for an administrator to decide a website.");
    expect(result.setupRunSummary.stop).toBe("proposed");
  });

  it("parks again for the asks still open after the first answer, and each wait is one more prompt at most", async () => {
    const clock = { now: Date.parse("2026-11-02T10:00:00.000Z") };
    let n = 0;
    const t = await world({
      script: async (parts) => { if (parts.n === 1) await parts.bash.exec("npm ci", "/work", { onData: () => undefined }); },
      blocked: ["a.acme.dev", "b.acme.dev"], hostOutcome: "created",
      poll: () => {
        n += 1;
        const state = (host: string): string => (host === "a.acme.dev" ? (n < 4 ? "open" : "approved") : (n < 9 ? "open" : "approved"));
        return { hosts: ["a.acme.dev", "b.acme.dev"].map((host) => ({ host, state: state(host) })) };
      },
    });
    t.input.ports.now = () => clock.now;
    const result = await runSetupAgent(t.input);
    expect(t.w.prompts).toHaveLength(3);
    expect(t.w.prompts[1]).toContain("Allowed: a.acme.dev");
    expect(t.w.prompts[2]).toContain("Allowed: b.acme.dev");
    expect(result.setupRunSummary.stop).toBe("proposed");
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

describe("a finished run", () => {
  it("reports a proposal and a proposed summary, tears the sandbox and the network down, and removes the sandbox BEFORE the last look at the tracked files", async () => {
    const t = await world({ script: async ({ bash }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); } });
    const result = await runSetupAgent(t.input);
    expect(result.workflowMode).toBe("SETUP_AGENT");
    expect(JSON.stringify(result.setupProposal)).toContain("npm ci");
    expect(result.setupProposal?.basedOnRevision).toBe(4);
    expect(result.setupRunSummary).toMatchObject({ stop: "proposed", partial: false, commandsRun: 1 });
    const afterPrompt = t.w.order.slice(t.w.order.indexOf("prompt"));
    expect(afterPrompt.indexOf("sandbox.dispose")).toBeGreaterThan(-1);
    // The last look at the files comes after the sandbox was removed (every process in it killed).
    expect(afterPrompt.indexOf("sandbox.dispose")).toBeLessThan(afterPrompt.lastIndexOf("checkFiles"));
    expect(t.w.stopped.network).toBe(true);
  });
  it("ends the run changed_repository_files, with no proposal, when the last look (after the kill) finds a tracked file changed", async () => {
    // The shell's own check after the command passes; the last one, taken after the sandbox is gone, fails (a background process edited the file after the last command).
    const t = await world({ script: async ({ bash }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); }, files: [{ ok: true }, { ok: false, reason: "tracked_files_changed" }] });
    const result = await runSetupAgent(t.input);
    expect(result.setupProposal).toBeUndefined();
    expect(result.setupRunSummary).toMatchObject({ stop: "changed_repository_files", partial: true });
  });
  it("tears the network down even when the model session fails", async () => {
    const t = await world();
    t.input.ports.openSession = async () => { throw new Error("no model"); };
    await expect(runSetupAgent(t.input)).rejects.toThrow();
    expect(t.w.stopped.network).toBe(true);
    expect(t.w.order).toContain("sandbox.dispose");
  });
  it("a prompt that fails ends the run infrastructure and still reports a summary", async () => {
    const t = await world();
    const open = t.input.ports.openSession.bind(t.input.ports);
    t.input.ports.openSession = async (parts) => { const s = await open(parts); return { ...s, prompt: async () => { throw new Error("boom"); } }; };
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary).toMatchObject({ stop: "infrastructure", partial: true });
  });
});

describe("the talk with the broker", () => {
  it("sends the journal, asks for a website once, and never names a person", async () => {
    const t = await world({
      blocked: ["artifactory.acme-build.io"],
      script: async ({ bash }) => { await bash.exec("pip install -r requirements.txt", "/work", { onData: () => undefined }); await new Promise((resolve) => setTimeout(resolve, 40)); },
    });
    await runSetupAgent(t.input);
    const journal = t.w.callbacks.filter((body) => (body as { kind: string }).kind === "journal").flatMap((body) => (body as { entries: Array<{ n: number; source: string; blockedHosts: string[] }> }).entries);
    expect(journal.map((entry) => entry.n)).toEqual([1]);
    expect(journal[0]!.blockedHosts).toEqual(["artifactory.acme-build.io"]);
    const hosts = t.w.callbacks.filter((body) => (body as { kind: string }).kind === "host");
    expect(hosts).toEqual([{ kind: "host", host: "artifactory.acme-build.io", journalN: 1 }]);
    expect(JSON.stringify(t.w.callbacks)).not.toMatch(/requestedBy|typedBy|developerId/u);
  });
  it("runs a person's command the broker hands over, through the same shell, tells the agent the result as data, and reports it done", async () => {
    let handed = false;
    const t = await world({
      poll: () => (handed ? { hosts: [] } : ((handed = true), { command: { seq: 1, command: "pip --version" }, hosts: [] })),
      script: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); },
    });
    await runSetupAgent(t.input);
    expect(t.w.ran.map((entry) => entry.command)).toContain("pip --version");
    expect(t.w.callbacks).toContainEqual({ kind: "command_done", seq: 1, journalN: 1 });
    expect(t.w.steered.join("\n")).toContain("This is a RESULT");
    const entries = t.w.callbacks.filter((body) => (body as { kind: string }).kind === "journal").flatMap((body) => (body as { entries: Array<{ source: string }> }).entries);
    expect(entries[0]!.source).toBe("person");
  });
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
  it("a broker that cannot be reached for a while does not stop the run", async () => {
    const t = await world({ script: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); } });
    const callback = t.input.ports.callback.bind(t.input.ports);
    let n = 0;
    t.input.ports.callback = async (body) => { n += 1; if (n <= 3) throw new Error("down"); return callback(body); };
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary.stop).toBe("proposed");
  });
});

describe("one serialized base", () => {
  it("two commands through the same base never run at once, in the order they were given", async () => {
    const t = await world();
    const serial = serialize(t.w.base);
    await Promise.all([serial.exec("a", "/w", { onData: () => undefined }), serial.exec("b", "/w", { onData: () => undefined }), serial.exec("c", "/w", { onData: () => undefined })]);
    expect(t.w.concurrent.max).toBe(1);
    expect(t.w.ran.map((entry) => entry.command)).toEqual(["a", "b", "c"]);
  });
  it("a failed command does not block the ones after it", async () => {
    let n = 0;
    const serial = serialize({ exec: async () => { n += 1; if (n === 1) throw new Error("x"); return { exitCode: 0 }; } });
    await expect(serial.exec("a", "/w", { onData: () => undefined })).rejects.toThrow();
    expect(await serial.exec("b", "/w", { onData: () => undefined })).toEqual({ exitCode: 0 });
  });
  it("the agent's command and a person's command (both from the run) never overlapped in a run that had both", async () => {
    let handed = false;
    const t = await world({
      poll: () => (handed ? { hosts: [] } : ((handed = true), { command: { seq: 1, command: "make test" }, hosts: [] })),
      script: async ({ bash }) => { await Promise.all([bash.exec("npm ci", "/w", { onData: () => undefined }), new Promise((resolve) => setTimeout(resolve, 30))]); await new Promise((resolve) => setTimeout(resolve, 60)); },
    });
    await runSetupAgent(t.input);
    expect(t.w.concurrent.max).toBe(1);
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
  it("the workspace label is the key of the REAL path, so a root reached through a link is the same workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-ws-"));
    roots.push(root);
    const link = `${root}-link`;
    await symlink(root, link);
    roots.push(link);
    expect(await setupWorkspaceKey(link)).toBe(await setupWorkspaceKey(root));
    expect(await setupWorkspaceKey(link)).toBe(workspaceKey(await realpath(root)));
  });
  it("gives up with one fixed sentence when no subnet is free, and never repeats the docker error", async () => {
    const full = fakeDocker((args) => (args[0] === "network" && args[1] === "create" ? { exitCode: 1, stderr: "Pool overlaps" } : { exitCode: 0 }));
    await expect(startRunNetwork(full.docker, { taskId: OPERATION, workspace: "ws-key", image: "i" })).rejects.toThrow("AgentX could not set up the network for the setup run");
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
  it("a poll that says so ends the run at once: no more commands are run, and what it had is reported", async () => {
    let polls = 0;
    const t = await world({
      script: async ({ bash }) => {
        await bash.exec("npm ci", "/work", { onData: () => undefined });
        // The model goes on while the run talks to the broker (a few ticks).
        await new Promise((resolve) => setTimeout(resolve, 80));
        await bash.exec("npm test", "/work", { onData: () => undefined });
      },
      poll: () => { polls += 1; return polls >= 2 ? { hosts: [], companyOff: true } : { hosts: [] }; },
    });
    const result = await runSetupAgent(t.input);
    expect(t.w.ran.map((entry) => entry.command)).toEqual(["npm ci"]);
    expect(result.setupRunSummary).toMatchObject({ stop: "infrastructure", partial: true });
    expect(result.setupProposal).toBeDefined();
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
  it("ends after 5 polls in a row that failed (nothing can reach the run), and not after fewer, and a good poll in between starts the count again", async () => {
    const outcome = async (failures: (n: number) => boolean) => {
      let polls = 0;
      const t = await world({ script: async ({ bash }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); await new Promise((resolve) => setTimeout(resolve, 200)); await bash.exec("npm test", "/work", { onData: () => undefined }); } });
      t.input.ports.callback = async (body) => {
        if ((body as { kind: string }).kind !== "poll") return { ok: true };
        polls += 1;
        if (failures(polls)) throw new Error("the broker is unreachable");
        return { hosts: [] };
      };
      const result = await runSetupAgent(t.input);
      return { ran: t.w.ran.map((entry) => entry.command), stop: result.setupRunSummary.stop };
    };
    expect(await outcome(() => true)).toEqual({ ran: ["npm ci"], stop: "infrastructure" });
    expect(await outcome((n) => n >= 1 && n <= 4)).toEqual({ ran: ["npm ci", "npm test"], stop: "proposed" });
    expect(await outcome((n) => n % 3 !== 0)).toEqual({ ran: ["npm ci", "npm test"], stop: "proposed" });
  });
  it("without it nothing changes", async () => {
    const t = await world({ script: async ({ bash }) => { await bash.exec("npm ci", "/work", { onData: () => undefined }); await bash.exec("npm test", "/work", { onData: () => undefined }); } });
    const result = await runSetupAgent(t.input);
    expect(t.w.ran.map((entry) => entry.command)).toEqual(["npm ci", "npm test"]);
    expect(result.setupRunSummary.stop).toBe("proposed");
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
