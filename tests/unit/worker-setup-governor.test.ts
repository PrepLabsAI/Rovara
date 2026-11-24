// Setup agent (SH8): the journal and the governor. Every limit stops the run with its own word, in a fixed order, and the first reason is final. Money fails closed. Time that is spent parked on a host
// nobody answered is not wall clock. A limit stop keeps what the run learned.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT, SETUP_AGENT_LIMITS_MAX, SETUP_JOURNAL_MAX_ENTRIES, SETUP_RUN_LIMIT_STOPS, SetupJournalEntrySchema, SetupRunSummarySchema, type SetupAgentLimits, type SetupRunEndWord } from "../../packages/contracts/src/index.js";
import { SETUP_AGENT_MAX_OUTPUT_TOKENS, SetupAgentGovernor, estimateNextTurnCents, finishStoppedRun, governorSessionListener, isProbeCommand, stepKeyOf, type SetupGovernorInput } from "../../packages/worker/src/setup-agent-journal.js";
import { setupAgentShell, type SetupCommandRecord } from "../../packages/worker/src/setup-agent.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const MIN = 60_000;
const limits = (over: Partial<SetupAgentLimits> = {}): SetupAgentLimits => ({ ...SETUP_AGENT_LIMITS_DEFAULT, ...over });

function harness({ limits: limitOverrides, ...over }: Partial<Omit<SetupGovernorInput, "limits">> & { limits?: Partial<SetupAgentLimits> } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const spend = { cents: 0 as number | undefined };
  const stops: SetupRunEndWord[] = [];
  const timers: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  const blocked: string[][] = [];
  const entries: unknown[] = [];
  const governor = new SetupAgentGovernor({
    limits: limits(limitOverrides),
    now: () => clock.t,
    spendCents: () => spend.cents,
    nextTurnCents: () => 0,
    takeBlockedHosts: () => blocked.shift() ?? [],
    onStop: (word) => stops.push(word),
    onEntry: (entry) => entries.push(entry),
    setTimer: (fire, ms) => { const timer = { ms, fire, cancelled: false }; timers.push(timer); return { cancel: () => { timer.cancelled = true; } }; },
    ...over,
  });
  const record = (command: string, over: Partial<SetupCommandRecord> = {}): SetupCommandRecord => ({ command, flagged: false, exitCode: 0, durationMs: 1_000, timedOut: false, tail: "", startedAt: clock.t, ...over });
  /** Asks, and when allowed runs it for `ms` and records it. */
  const run = (command: string, over: Partial<SetupCommandRecord> = {}, ms = 1_000) => {
    const decision = governor.beforeCommand(command);
    if (!decision.allow) return false;
    clock.t += ms;
    governor.afterCommand(record(command, { durationMs: ms, ...over }));
    return true;
  };
  return { governor, clock, spend, stops, timers, blocked, entries, record, run };
}

describe("a person's command in the journal", () => {
  it("every agent command after a person's command says so (the sandbox may hold what it changed), and commands before it do not", () => {
    const h = harness();
    h.run("npm ci");
    h.governor.recordPersonCommand(h.record("pip install -e ."));
    h.run("pytest -q");
    h.run("ls");
    h.governor.recordPersonCommand(h.record("make clean"));
    h.run("make test");
    const entries = h.governor.entries();
    expect(entries.map((entry) => [entry.n, entry.source, entry.afterPersonCommandN])).toEqual([[1, "agent", undefined], [2, "person", undefined], [3, "agent", 2], [4, "agent", 2], [5, "person", undefined], [6, "agent", 5]]);
    for (const entry of entries) expect(SetupJournalEntrySchema.safeParse(entry).success).toBe(true);
  });
});

describe("what a step is", () => {
  it("knows which commands only look", () => {
    for (const probe of ["ls -la", "cat README.md", "grep -rn foo .", "git status", "git log -3", "node --version", "echo hi", "find . -name '*.py'"]) expect(isProbeCommand(probe), probe).toBe(true);
    for (const change of ["npm ci", "uv sync", "pip install pytest", "git checkout main", "make build", "pytest -q"]) expect(isProbeCommand(change), change).toBe(false);
  });
});

describe("commands in all", () => {
  it("never grows the journal past its bound", () => {
    const h = harness({ limits: { commands: SETUP_AGENT_LIMITS_MAX.commands } });
    for (let index = 0; index < SETUP_JOURNAL_MAX_ENTRIES + 20; index += 1) h.governor.recordPersonCommand(h.record(`p${String(index)}`));
    expect(h.governor.entries()).toHaveLength(SETUP_JOURNAL_MAX_ENTRIES);
    expect(h.governor.recordPersonCommand(h.record("one more"))).toBeUndefined();
    expect(h.governor.beforeCommand("x")).toEqual({ allow: false });
    expect(h.governor.ended()).toBe("attempts_used");
  });
});

describe("wall clock", () => {
  it("re-arms a timer that fires early instead of ending the run on its word", () => {
    const h = harness({ limits: { wallClockMin: 10 } });
    h.clock.t += 5 * MIN;
    h.timers[0]!.fire();
    expect(h.governor.ended()).toBeUndefined();
    expect(h.timers).toHaveLength(2);
    expect(h.timers[1]!.ms).toBe(5 * MIN);
  });
});

describe("host asks", () => {
  it("lets the limit's worth of new hosts through, counts a host once, ignores a name that is not a host, and ends hosts_waiting on one too many", () => {
    const h = harness({ limits: { hostAsks: 2 } });
    expect(h.governor.requestHost("pypi.example.org")).toBe("new");
    expect(h.governor.requestHost("pypi.example.org")).toBe("duplicate");
    expect(h.governor.requestHost("10.0.0.1")).toBe("invalid");
    expect(h.governor.requestHost("https://x.example.org")).toBe("invalid");
    expect(h.governor.requestHost("a.example.org")).toBe("new");
    expect(h.governor.ended()).toBeUndefined();
    expect(h.governor.requestHost("b.example.org")).toBe("stopped");
    expect(h.governor.ended()).toBe("hosts_waiting");
    expect(h.governor.requestHost("c.example.org")).toBe("stopped");
    expect(h.stops).toEqual(["hosts_waiting"]);
    expect(h.governor.summary().hostAsks).toBe(2);
  });
  it("ends hosts_waiting after 2 hours parked, by check and by timer, and not a minute sooner", () => {
    const h = harness();
    h.governor.parkOnHosts();
    h.clock.t += 2 * 3_600_000 - 1_000;
    expect(h.governor.check()).toBeUndefined();
    h.clock.t += 1_000;
    expect(h.governor.check()).toBe("hosts_waiting");
    const g = harness();
    g.governor.parkOnHosts();
    const parkedTimer = g.timers.at(-1)!;
    expect(parkedTimer.ms).toBe(2 * 3_600_000);
    g.clock.t += 2 * 3_600_000;
    parkedTimer.fire();
    expect(g.governor.ended()).toBe("hosts_waiting");
  });
});

describe("the journal", () => {
  it("bounds a record the shell should never send: a huge tail, a wild exit code, a negative time", () => {
    const h = harness();
    h.governor.afterCommand(h.record("make", { tail: "x".repeat(10_000), exitCode: 4_000, durationMs: -5 }));
    const entry = h.governor.entries()[0]!;
    expect(entry.tail.length).toBe(4_096);
    expect(entry.exitCode).toBe(255);
    expect(entry.durationMs).toBe(0);
  });
});

describe("the run's report", () => {
  it("has the contract's limit word, partial, for every limit, and the report passes the contract", () => {
    const words = new Set<string>();
    const make = (over: Partial<SetupAgentLimits>, act: (h: ReturnType<typeof harness>) => void) => { const h = harness({ limits: over }); act(h); words.add(h.governor.summary().stop); expect(SetupRunSummarySchema.safeParse(h.governor.summary()).success).toBe(true); expect(h.governor.summary().partial).toBe(true); };
    make({ commands: 1 }, (h) => { h.run("a"); h.run("b"); });
    make({ sameStepTries: 1 }, (h) => { h.run("a", { exitCode: 1 }); h.run("a"); });
    make({ wallClockMin: 1 }, (h) => { h.clock.t += 2 * MIN; h.run("a"); });
    make({ budgetCents: 100 }, (h) => { h.spend.cents = 100; h.run("a"); });
    make({ hostAsks: 1 }, (h) => { h.governor.requestHost("a.example.org"); h.governor.requestHost("b.example.org"); });
    expect([...words].sort()).toEqual([...SETUP_RUN_LIMIT_STOPS].sort());
  });
});

describe("a stopped run keeps what it learned", () => {
  const block = (answer: unknown) => `working\n\`\`\`agentx-setup-proposal\n${JSON.stringify(answer)}\n\`\`\``;
  const ANSWER = { setup: [{ repo: "web", commands: ["npm ci"], from: [{ kind: "file", repo: "web", path: "package.json", line: 2, quote: "\"scripts\"" }] }] };
  async function stopped(lastText: string, files = true) {
    const rootPath = await mkdtemp(join(tmpdir(), "setup-stopped-"));
    roots.push(rootPath);
    if (files) await mkdir(join(rootPath, "repo/web"), { recursive: true });
    const h = harness({ limits: { commands: 2 } });
    h.run("npm ci");
    h.run("pytest", { exitCode: 1 });
    h.run("never runs");
    const result = await finishStoppedRun({ governor: h.governor, trackedFiles: { ok: true }, lastText, basedOnRevision: 3, rootPath, repositories: [{ name: "web", path: "repo/web", resolvedCommit: "a".repeat(40) }] });
    return { result, h };
  }
  it("returns the proposal the model had given, the commands that worked, and a partial report with the limit's word", async () => {
    const { result } = await stopped(block(ANSWER));
    expect(result.end).toBe("attempts_used");
    expect(result.summary).toMatchObject({ stop: "attempts_used", partial: true, commandsRun: 2 });
    expect(result.proposal?.setup[0]?.value.commands).toEqual(["npm ci"]);
    expect(result.learned).toEqual([{ n: 1, command: "npm ci" }]);
  });
});

describe("fix round 1: parallel tool calls", () => {

  it("counts a command even when its journal entry cannot be written", () => {
    const h = harness({ limits: { commands: 2, sameStepTries: 5 } });
    // A record the contract cannot hold (an exit code that is not a number) must not be a free command.
    for (const command of ["echo 1", "echo 2"]) { h.governor.beforeCommand(command); h.governor.afterCommand(h.record(command, { exitCode: Number.NaN })); }
    expect(h.governor.entries()).toHaveLength(0);
    expect(h.governor.beforeCommand("echo 3")).toEqual({ allow: false });
    expect(h.governor.ended()).toBe("attempts_used");
  });
  it("does not throw out of the hook for a start time Date cannot hold", () => {
    const h = harness();
    h.governor.beforeCommand("echo 1");
    expect(() => h.governor.afterCommand(h.record("echo 1", { startedAt: 9e18 }))).not.toThrow();
    expect(h.governor.entries()).toHaveLength(1);
  });
  it("sees through the wrappers that would make one step look like many", () => {
    for (const same of ["env npm ci", "command npm ci", "/usr/bin/npm ci", "(npm ci)", "time npm ci", "NODE_ENV=x npm ci --no-audit", "sudo -n npm ci", "cd a/b && env npm ci 2>&1 | tail -3"]) expect(stepKeyOf(same), same).toBe("npm ci");
  });
});

describe("fix round 1: a changed repository outranks every other reason", () => {
  const block = (answer: unknown) => `done\n\`\`\`agentx-setup-proposal\n${JSON.stringify(answer)}\n\`\`\``;
  it("a deadline fires mid-command, the command edits a tracked file: the end word is changed_repository_files, there is no proposal, and the caller was told once", async () => {
    const h = harness({ limits: { wallClockMin: 10 } });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const shell = setupAgentShell({ base: { exec: async () => { await gate; return { exitCode: 0 }; } }, hooks: h.governor, checkFiles: () => Promise.resolve({ ok: false, reason: "tracked_files_changed" }) });
    const running = shell.operations.exec("make edit", "/w", { onData: () => undefined });
    h.clock.t += 10 * MIN;
    h.timers[0]!.fire();
    expect(h.governor.ended()).toBe("time_used");
    release();
    await running;
    expect(shell.ended()).toBe("changed_repository_files");
    expect(h.governor.ended()).toBe("changed_repository_files");
    expect(h.stops).toEqual(["time_used"]);
    const rootPath = await mkdtemp(join(tmpdir(), "setup-outrank-"));
    roots.push(rootPath);
    await mkdir(join(rootPath, "repo/web"), { recursive: true });
    const answer = { setup: [{ repo: "web", commands: ["npm ci"], from: [{ kind: "file", repo: "web", path: "package.json", line: 2, quote: "\"scripts\"" }] }] };
    const result = await finishStoppedRun({ governor: h.governor, trackedFiles: { ok: true }, shell, lastText: block(answer), basedOnRevision: 1, rootPath, repositories: [{ name: "web", path: "repo/web", resolvedCommit: "a".repeat(40) }] });
    expect(result).toMatchObject({ end: "changed_repository_files", proposal: undefined, learned: [] });
    expect(result.summary).toMatchObject({ stop: "changed_repository_files", partial: true });
  });
});

describe("fix round 1: one model turn cannot carry the run past the budget", () => {
  it("estimates a turn from the transcript, the output cap and the model's prices, rounding up", () => {
    expect(SETUP_AGENT_MAX_OUTPUT_TOKENS).toBe(8_192);
    // 100k input tokens at $3/M = 30 cents; 8,192 output tokens at $15/M = 12.288 cents; 42.288 -> 43.
    expect(estimateNextTurnCents({ inputTokens: 100_000, maxOutputTokens: 8_192, inputPerMTok: 3, outputPerMTok: 15 })).toBe(43);
    expect(estimateNextTurnCents({ inputTokens: 0, maxOutputTokens: 0, inputPerMTok: 3, outputPerMTok: 15 })).toBe(0);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(estimateNextTurnCents({ inputTokens: bad, maxOutputTokens: 1, inputPerMTok: 1, outputPerMTok: 1 })).toBeNaN();
  });
  it("checks on every turn end, not only on a tool event: a model that ends turns without a command still stops at the budget", () => {
    const h = harness({ limits: { budgetCents: 400 } });
    const listen = governorSessionListener(h.governor);
    listen({ type: "agent_start" });
    h.spend.cents = 500;
    listen({ type: "message_update" });
    expect(h.governor.ended()).toBeUndefined();
    listen({ type: "turn_end" });
    expect(h.governor.ended()).toBe("budget_used");
    expect(h.stops).toEqual(["budget_used"]);
    listen(null);
    listen("x");
  });
});

