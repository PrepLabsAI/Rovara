// Setup agent (SH8): the journal and the governor. Every limit stops the run with its own word, in a fixed order, and the first reason is final. Money fails closed. Time that is spent parked on a host
// nobody answered is not wall clock. A limit stop keeps what the run learned.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT, SETUP_AGENT_LIMITS_MAX, SETUP_JOURNAL_MAX_ENTRIES, SETUP_RUN_LIMIT_STOPS, SetupJournalEntrySchema, SetupRunSummarySchema, type SetupAgentLimits, type SetupRunEndWord } from "../../packages/contracts/src/index.js";
import { SETUP_AGENT_MAX_OUTPUT_TOKENS, SetupAgentGovernor, centsFromDollars, estimateNextTurnCents, finishStoppedRun, governorSessionListener, isProbeCommand, stepKeyOf, type SetupGovernorInput } from "../../packages/worker/src/setup-agent-journal.js";
import { setupAgentShell, type SetupCommandRecord } from "../../packages/worker/src/setup-agent.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const fakeToken = () => ["gh", "p_"].join("") + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
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

describe("cents", () => {
  it("rounds a part of a cent up and refuses figures it cannot trust", () => {
    expect(centsFromDollars(0)).toBe(0);
    expect(centsFromDollars(1.4)).toBe(140);
    expect(centsFromDollars(0.001)).toBe(1);
    expect(centsFromDollars(3.999)).toBe(400);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "3", undefined, null, 2_000_000]) expect(centsFromDollars(bad), String(bad)).toBeUndefined();
  });
});

describe("what a step is", () => {
  it("reduces a command to its program and the words that name the step", () => {
    expect(stepKeyOf("uv sync --frozen")).toBe("uv sync");
    expect(stepKeyOf("uv sync")).toBe("uv sync");
    expect(stepKeyOf("cd service && uv sync --frozen 2>&1 | tail -20")).toBe("uv sync");
    expect(stepKeyOf("FOO=1 npm ci --no-audit")).toBe("npm ci");
    expect(stepKeyOf("python -m pytest -q tests/unit")).toBe("pytest tests/unit");
    expect(stepKeyOf("pytest -q")).toBe("pytest");
    expect(stepKeyOf("python3 -m pytest")).toBe(stepKeyOf("pytest -q"));
    expect(stepKeyOf("pytest tests/a")).not.toBe(stepKeyOf("pytest tests/b"));
    expect(stepKeyOf("npm test")).not.toBe(stepKeyOf("npm run build"));
    expect(stepKeyOf("x".repeat(500)).length).toBeLessThanOrEqual(120);
  });
  it("knows which commands only look", () => {
    for (const probe of ["ls -la", "cat README.md", "grep -rn foo .", "git status", "git log -3", "node --version", "echo hi", "find . -name '*.py'"]) expect(isProbeCommand(probe), probe).toBe(true);
    for (const change of ["npm ci", "uv sync", "pip install pytest", "git checkout main", "make build", "pytest -q"]) expect(isProbeCommand(change), change).toBe(false);
  });
});

describe("commands in all", () => {
  it("runs exactly the limit, refuses the next one, and ends the run attempts_used, once", () => {
    const h = harness({ limits: { commands: 3 } });
    expect([h.run("a1"), h.run("b2"), h.run("c3")]).toEqual([true, true, true]);
    expect(h.governor.ended()).toBeUndefined();
    expect(h.run("d4")).toBe(false);
    expect(h.governor.ended()).toBe("attempts_used");
    expect(h.run("e5")).toBe(false);
    expect(h.stops).toEqual(["attempts_used"]);
    expect(h.governor.entries()).toHaveLength(3);
  });
  it("counts the agent's commands only: a person's command does not use the agent's limit, but does use the journal", () => {
    const h = harness({ limits: { commands: 2 } });
    h.run("a1");
    expect(h.governor.recordPersonCommand(h.record("whoami"))).toMatchObject({ n: 2, source: "person" });
    expect(h.run("b2")).toBe(true);
    expect(h.run("c3")).toBe(false);
    expect(h.governor.entries().map((entry) => entry.source)).toEqual(["agent", "person", "agent"]);
  });
  it("never grows the journal past its bound", () => {
    const h = harness({ limits: { commands: SETUP_AGENT_LIMITS_MAX.commands } });
    for (let index = 0; index < SETUP_JOURNAL_MAX_ENTRIES + 20; index += 1) h.governor.recordPersonCommand(h.record(`p${String(index)}`));
    expect(h.governor.entries()).toHaveLength(SETUP_JOURNAL_MAX_ENTRIES);
    expect(h.governor.recordPersonCommand(h.record("one more"))).toBeUndefined();
    expect(h.governor.beforeCommand("x")).toEqual({ allow: false });
    expect(h.governor.ended()).toBe("attempts_used");
  });
  it("does not start with a limit the contract would refuse: over the maximum, zero, a fraction or not a number", () => {
    const start = (over: Partial<SetupAgentLimits>) => () => new SetupAgentGovernor({ limits: limits(over), spendCents: () => 0, nextTurnCents: () => 0, setTimer: () => ({ cancel: () => undefined }) });
    expect(start({ commands: SETUP_AGENT_LIMITS_MAX.commands })).not.toThrow();
    for (const bad of [{ commands: 121 }, { commands: 0 }, { sameStepTries: 6 }, { wallClockMin: 121 }, { budgetCents: 2_001 }, { hostAsks: 11 }, { hostAsks: 1.5 }, { commands: Number.NaN }, { budgetCents: -1 }]) expect(start(bad), JSON.stringify(bad)).toThrow();
  });
});

describe("tries of the same failing step", () => {
  const fail = { exitCode: 1 };
  it("ends the run on one more try of a step that failed that often, however the command is spelled", () => {
    const h = harness({ limits: { sameStepTries: 3 } });
    expect(h.run("uv sync --frozen", fail)).toBe(true);
    expect(h.run("uv sync", fail)).toBe(true);
    expect(h.run("cd svc && uv sync 2>&1 | tail -5", fail)).toBe(true);
    expect(h.run("uv sync --frozen")).toBe(false);
    expect(h.governor.ended()).toBe("attempts_used");
    expect(h.stops).toEqual(["attempts_used"]);
  });
  it("does not stop a different step, and a step that succeeded has its tries back", () => {
    const h = harness({ limits: { sameStepTries: 2 } });
    h.run("pytest a", fail);
    h.run("pytest a", fail);
    expect(h.run("npm test", fail)).toBe(true);
    expect(h.governor.ended()).toBeUndefined();
    const g = harness({ limits: { sameStepTries: 2 } });
    g.run("pytest a", fail);
    g.run("pytest a");
    expect(g.run("pytest a", fail)).toBe(true);
    expect(g.run("pytest a", fail)).toBe(true);
    expect(g.run("pytest a")).toBe(false);
    expect(g.governor.ended()).toBe("attempts_used");
  });
  it("gives the tries back when something changed in between, but not for a command that only looks", () => {
    const changed = harness({ limits: { sameStepTries: 2 } });
    changed.run("pytest -q", fail);
    changed.run("pip install foo");
    changed.run("pytest -q", fail);
    expect(changed.run("pytest -q", fail)).toBe(true);

    const looked = harness({ limits: { sameStepTries: 2 } });
    looked.run("pytest -q", fail);
    looked.run("ls");
    looked.run("cat README.md");
    looked.run("pytest -q", fail);
    expect(looked.run("pytest -q")).toBe(false);
    expect(looked.governor.ended()).toBe("attempts_used");
  });
  it("counts a timeout and a missing exit code as a failure", () => {
    const h = harness({ limits: { sameStepTries: 2 } });
    h.run("make build", { exitCode: null, timedOut: true });
    h.run("make build", { exitCode: null });
    expect(h.run("make build")).toBe(false);
  });
});

describe("wall clock", () => {
  it("allows a command just inside the limit and refuses one at it, with the word time_used", () => {
    const h = harness({ limits: { wallClockMin: 10 } });
    h.clock.t += 10 * MIN - 1_000;
    expect(h.governor.beforeCommand("a")).toMatchObject({ allow: true });
    h.clock.t += 1_000;
    expect(h.governor.beforeCommand("a")).toEqual({ allow: false });
    expect(h.governor.ended()).toBe("time_used");
    expect(h.stops).toEqual(["time_used"]);
  });
  it("arms a deadline timer: it ends the run while the model is only thinking", () => {
    const h = harness({ limits: { wallClockMin: 10 } });
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(10 * MIN);
    h.clock.t += 10 * MIN;
    h.timers[0]!.fire();
    expect(h.governor.ended()).toBe("time_used");
    expect(h.stops).toEqual(["time_used"]);
  });
  it("re-arms a timer that fires early instead of ending the run on its word", () => {
    const h = harness({ limits: { wallClockMin: 10 } });
    h.clock.t += 5 * MIN;
    h.timers[0]!.fire();
    expect(h.governor.ended()).toBeUndefined();
    expect(h.timers).toHaveLength(2);
    expect(h.timers[1]!.ms).toBe(5 * MIN);
  });
  it("never gives a command more time than is left", () => {
    const h = harness({ limits: { wallClockMin: 10 } });
    expect(h.governor.maxTimeoutSeconds()).toBe(600);
    h.clock.t += 9 * MIN + 30_000;
    expect(h.governor.maxTimeoutSeconds()).toBe(30);
    // Through the shell: a command that asks for an hour gets what is left.
    const seen: Array<number | undefined> = [];
    const shell = setupAgentShell({ base: { exec: (_c, _d, o) => { seen.push(o.timeout); return Promise.resolve({ exitCode: 0 }); } }, hooks: h.governor });
    return shell.operations.exec("make", "/w", { onData: () => undefined, timeout: 3_600 }).then(() => expect(seen).toEqual([30]));
  });
  it("cuts the timer when the run ends or is disposed", () => {
    const h = harness();
    h.governor.stop("stopped_by_person");
    expect(h.timers.every((timer) => timer.cancelled)).toBe(true);
    const g = harness();
    g.governor.dispose();
    expect(g.timers[0]!.cancelled).toBe(true);
  });
});

describe("model spend", () => {
  it("refuses a command at the limit, and not below it", () => {
    const h = harness({ limits: { budgetCents: 400 } });
    h.spend.cents = 399;
    expect(h.governor.beforeCommand("a")).toMatchObject({ allow: true });
    h.spend.cents = 400;
    expect(h.governor.beforeCommand("a")).toEqual({ allow: false });
    expect(h.governor.ended()).toBe("budget_used");
    expect(h.stops).toEqual(["budget_used"]);
  });
  it("stops on a usage update with no command at all", () => {
    const h = harness({ limits: { budgetCents: 100 } });
    h.spend.cents = 250;
    expect(h.governor.check()).toBe("budget_used");
    expect(h.governor.entries()).toHaveLength(0);
  });
  it("treats a spend it cannot read as used up", () => {
    const h = harness();
    h.spend.cents = undefined;
    expect(h.governor.beforeCommand("a")).toEqual({ allow: false });
    expect(h.governor.ended()).toBe("budget_used");
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
  it("does not count the time parked on a host ask as wall clock", () => {
    const h = harness({ limits: { wallClockMin: 10 } });
    h.clock.t += 4 * MIN;
    h.governor.parkOnHosts();
    h.clock.t += 5 * 3_600_000;
    expect(h.governor.elapsedMs()).toBe(4 * MIN);
    h.governor.resumeFromHosts();
    h.clock.t += 5 * MIN;
    expect(h.governor.beforeCommand("a")).toMatchObject({ allow: true });
    h.clock.t += MIN;
    expect(h.governor.beforeCommand("a")).toEqual({ allow: false });
    expect(h.governor.ended()).toBe("time_used");
  });
  it("ends hosts_waiting after 24 hours parked, by check and by timer, and not a minute sooner", () => {
    const h = harness();
    h.governor.parkOnHosts();
    h.clock.t += 24 * 3_600_000 - 1_000;
    expect(h.governor.check()).toBeUndefined();
    h.clock.t += 1_000;
    expect(h.governor.check()).toBe("hosts_waiting");
    const g = harness();
    g.governor.parkOnHosts();
    const parkedTimer = g.timers.at(-1)!;
    expect(parkedTimer.ms).toBe(24 * 3_600_000);
    g.clock.t += 24 * 3_600_000;
    parkedTimer.fire();
    expect(g.governor.ended()).toBe("hosts_waiting");
  });
});

describe("order and finality", () => {
  it("gives money before time before attempts before hosts when several are met at once", () => {
    const all = harness({ limits: { commands: 1, budgetCents: 100, wallClockMin: 1 } });
    all.run("a");
    all.clock.t += 2 * MIN;
    all.spend.cents = 500;
    all.governor.beforeCommand("b");
    expect(all.governor.ended()).toBe("budget_used");
    const timeAndAttempts = harness({ limits: { commands: 1, wallClockMin: 1 } });
    timeAndAttempts.run("a");
    timeAndAttempts.clock.t += 2 * MIN;
    timeAndAttempts.governor.beforeCommand("b");
    expect(timeAndAttempts.governor.ended()).toBe("time_used");
  });
  it("keeps the first reason: a later limit, or a later stop, does not change it", () => {
    const h = harness({ limits: { commands: 1 } });
    h.run("a");
    h.governor.beforeCommand("b");
    h.spend.cents = 9_999;
    h.clock.t += 999 * MIN;
    expect(h.governor.check()).toBe("attempts_used");
    h.governor.stop("stopped_by_person");
    expect(h.governor.ended()).toBe("attempts_used");
    // Only a changed repository outranks the first reason (see the fix round 1 tests), and the caller is not told twice.
    h.governor.onEnded("changed_repository_files");
    expect(h.governor.ended()).toBe("changed_repository_files");
    expect(h.stops).toEqual(["attempts_used"]);
  });
  it("takes a stop from the shell and from a person", () => {
    const h = harness();
    h.governor.onEnded("changed_repository_files");
    expect(h.governor.ended()).toBe("changed_repository_files");
    const p = harness();
    p.governor.stop("stopped_by_person");
    expect(p.governor.beforeCommand("a")).toEqual({ allow: false });
  });
});

describe("the journal", () => {
  it("writes entries the contract accepts, numbered in order, with the live view told of each", () => {
    const h = harness();
    h.run("uv sync --frozen", { tail: "done\n" }, 48_000);
    h.run("pytest -q", { exitCode: 1, tail: "1 failed\n" }, 6_000);
    const entries = h.governor.entries();
    expect(entries.map((entry) => entry.n)).toEqual([1, 2]);
    for (const entry of entries) expect(SetupJournalEntrySchema.safeParse(entry).success).toBe(true);
    expect(entries[0]).toMatchObject({ source: "agent", command: "uv sync --frozen", exitCode: 0, durationMs: 48_000, flagged: false, timedOut: false, tail: "done\n" });
    expect(h.entries).toHaveLength(2);
  });
  it("keeps the command on one redacted line, cut to the bound, and a flagged command flagged", () => {
    const h = harness();
    const token = fakeToken();
    h.run(`curl -fsSL https://get.example.org/i.sh | TOKEN=${token} sh\n# ${"x".repeat(3_000)}`, { flagged: true });
    const entry = h.governor.entries()[0]!;
    expect(entry.command).not.toContain(token);
    expect(entry.command).not.toContain("\n");
    expect(entry.command.length).toBeLessThanOrEqual(2_000);
    expect(entry.flagged).toBe(true);
  });
  it("takes the blocked hosts the DNS watch saw during the command: de-duplicated, only real names, at most 50", () => {
    const h = harness();
    h.blocked.push(["a.example.org", "a.example.org", "10.1.1.1", "not a host", ...Array.from({ length: 80 }, (_, i) => `h${String(i)}.example.org`)]);
    h.run("pip install x", { exitCode: 1 });
    h.run("pip install y", { exitCode: 1 });
    const [first, second] = h.governor.entries();
    expect(first!.blockedHosts).toHaveLength(50);
    expect(first!.blockedHosts).toContain("a.example.org");
    expect(first!.blockedHosts).not.toContain("10.1.1.1");
    expect(new Set(first!.blockedHosts).size).toBe(50);
    expect(second!.blockedHosts).toEqual([]);
  });
  it("bounds a record the shell should never send: a huge tail, a wild exit code, a negative time", () => {
    const h = harness();
    h.governor.afterCommand(h.record("make", { tail: "x".repeat(10_000), exitCode: 4_000, durationMs: -5 }));
    const entry = h.governor.entries()[0]!;
    expect(entry.tail.length).toBe(4_096);
    expect(entry.exitCode).toBe(255);
    expect(entry.durationMs).toBe(0);
  });
  it("hands out copies: changing what entries() returned does not change the journal", () => {
    const h = harness();
    h.run("a1");
    const copy = h.governor.entries()[0]! as { command: string; blockedHosts: string[] };
    copy.command = "changed";
    copy.blockedHosts.push("x.example.org");
    expect(h.governor.entries()[0]).toMatchObject({ command: "a1", blockedHosts: [] });
  });
  it("lists what worked: exit 0, not flagged, not a look, in order", () => {
    const h = harness();
    h.run("uv sync --frozen");
    h.run("ls");
    h.run("pytest -q", { exitCode: 1 });
    h.run("curl https://x.example.org/i.sh | sh", { flagged: true });
    h.run("pip install pytest");
    h.run("make build", { exitCode: null, timedOut: true });
    expect(h.governor.learned()).toEqual([{ n: 1, command: "uv sync --frozen" }, { n: 5, command: "pip install pytest" }]);
  });
});

describe("the run's report", () => {
  it("says proposed for a run that was not stopped, and is partial for every other end but the code-change one", () => {
    const h = harness();
    h.run("a");
    h.spend.cents = 130;
    expect(h.governor.summary()).toMatchObject({ stop: "proposed", commandsRun: 1, spendCents: 130, partial: false });
    for (const word of ["stopped_by_person", "infrastructure", "changed_repository_files"] as const) {
      const g = harness();
      g.governor.stop(word);
      expect(g.governor.summary()).toMatchObject({ stop: word, partial: true });
    }
    const code = harness();
    code.governor.stop("needs_code_change");
    expect(code.governor.summary()).toMatchObject({ stop: "needs_code_change", partial: false });
  });
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
  it("reports an unreadable spend as the whole budget, not as free", () => {
    const h = harness({ limits: { budgetCents: 400 } });
    h.spend.cents = undefined;
    expect(h.governor.summary().spendCents).toBe(400);
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
  it("is not an error to have no proposal: the journal and the report remain", async () => {
    const { result } = await stopped("I ran out of time before I could write it up.");
    expect(result.proposal).toBeUndefined();
    expect(result.end).toBe("attempts_used");
    expect(result.learned).toHaveLength(1);
  });
  it("does not throw when the folders are missing", async () => {
    const { result } = await stopped(block(ANSWER), false);
    expect(result.end).toBe("attempts_used");
  });
});

describe("with the shell", () => {
  it("refuses the command after a limit and the base never sees it; a changed repository ends the run through the shell's hook", async () => {
    const h = harness({ limits: { commands: 1 } });
    const ran: string[] = [];
    const shell = setupAgentShell({ base: { exec: (command) => { ran.push(command); return Promise.resolve({ exitCode: 0 }); } }, hooks: h.governor });
    const out: string[] = [];
    await shell.operations.exec("npm ci", "/w", { onData: (d) => out.push(d.toString()) });
    const refused = await shell.operations.exec("npm test", "/w", { onData: (d) => out.push(d.toString()) });
    expect(refused.exitCode).toBe(126);
    expect(ran).toEqual(["npm ci"]);
    expect(h.governor.ended()).toBe("attempts_used");

    const g = harness();
    const changing = setupAgentShell({ base: { exec: () => Promise.resolve({ exitCode: 0 }) }, hooks: g.governor, checkFiles: () => Promise.resolve({ ok: false, reason: "tracked_files_changed" }) });
    await changing.operations.exec("npm install", "/w", { onData: () => undefined });
    expect(g.governor.ended()).toBe("changed_repository_files");
    expect(g.stops).toEqual(["changed_repository_files"]);
  });
});

describe("fix round 1: parallel tool calls", () => {
  const slowShell = (hooks: SetupAgentGovernor, exitCode = 1) => {
    let ran = 0;
    const shell = setupAgentShell({ base: { exec: async () => { ran += 1; await new Promise((resolve) => setTimeout(resolve, 15)); return { exitCode }; } }, hooks });
    return { shell, ran: () => ran, run: (command: string) => shell.operations.exec(command, "/w", { onData: () => undefined }) };
  };
  const governorOf = (over: Partial<SetupAgentLimits>) => new SetupAgentGovernor({ limits: limits(over), spendCents: () => 0, nextTurnCents: () => 0, setTimer: () => ({ cancel: () => undefined }) });

  it("holds the same-step limit when ten copies of a command are in flight at once (the review's probe: all ten used to run)", async () => {
    const governor = governorOf({ commands: 2, sameStepTries: 1 });
    const h = slowShell(governor);
    await Promise.all(Array.from({ length: 10 }, () => h.run("npm ci")));
    expect(h.ran()).toBe(1);
    expect(governor.ended()).toBe("attempts_used");
    expect(governor.entries()).toHaveLength(1);
  });
  it("holds the commands limit when different commands are in flight at once", async () => {
    const governor = governorOf({ commands: 2, sameStepTries: 5 });
    const h = slowShell(governor, 0);
    await Promise.all(Array.from({ length: 10 }, (_, i) => h.run(`make step${String(i)}`)));
    expect(h.ran()).toBe(2);
    expect(governor.ended()).toBe("attempts_used");
    expect(governor.entries()).toHaveLength(2);
  });
  it("gives a reservation back when the command finishes, so a later command is allowed", async () => {
    const governor = governorOf({ commands: 2, sameStepTries: 5 });
    const h = slowShell(governor, 0);
    await h.run("make a1");
    await h.run("make b2");
    expect(governor.ended()).toBeUndefined();
    await h.run("make c3");
    expect(h.ran()).toBe(2);
  });
  it("gives a reservation back when the command throws (a timeout)", async () => {
    const governor = governorOf({ commands: 2, sameStepTries: 5 });
    const shell = setupAgentShell({ base: { exec: () => Promise.reject(new Error("timeout:60")) }, hooks: governor });
    await expect(shell.operations.exec("make a1", "/w", { onData: () => undefined })).rejects.toThrow();
    await expect(shell.operations.exec("make b2", "/w", { onData: () => undefined })).rejects.toThrow();
    expect(governor.ended()).toBeUndefined();
    expect(governor.entries()).toHaveLength(2);
  });
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
  it("finishStoppedRun also takes the shell's word when the governor was never told", async () => {
    const h = harness({ limits: { commands: 1 } });
    h.run("a");
    h.run("b");
    const shell = { ended: () => "changed_repository_files" };
    const rootPath = await mkdtemp(join(tmpdir(), "setup-outrank-"));
    roots.push(rootPath);
    const result = await finishStoppedRun({ governor: h.governor, trackedFiles: { ok: true }, shell, lastText: "x", basedOnRevision: 1, rootPath, repositories: [] });
    expect(result.end).toBe("changed_repository_files");
    expect(result.proposal).toBeUndefined();
  });
});

describe("fix round 1: one model turn cannot carry the run past the budget", () => {
  it("stops when the spend so far plus the next turn's most would reach the budget", () => {
    const h = harness({ limits: { budgetCents: 400 }, nextTurnCents: () => 100 });
    h.spend.cents = 299;
    expect(h.governor.check()).toBeUndefined();
    h.spend.cents = 300;
    expect(h.governor.check()).toBe("budget_used");
  });
  it("reads an estimate that is not a non-negative number as the whole budget", () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const h = harness({ nextTurnCents: () => bad });
      expect(h.governor.check(), String(bad)).toBe("budget_used");
    }
  });
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

describe("fix round 2: the governor and the final look", () => {
  it("has no default for the next turn's cost: a caller that cannot say it does not build a governor (type-checked, and the field is read on every check)", () => {
    // A governor built without it (cast past the type, as a plain-JS caller could) fails closed on its first check instead of treating a turn as free.
    const built = new SetupAgentGovernor({ limits: limits(), spendCents: () => 0, setTimer: () => ({ cancel: () => undefined }) } as unknown as SetupGovernorInput);
    expect(() => built.check()).toThrow();
  });
  it("finishStoppedRun takes the final tracked-file verdict: a repository that is not clean ends the run changed_repository_files with no proposal, whatever stopped it first", async () => {
    for (const verdict of [{ ok: false, reason: "tracked_files_changed" }, { ok: false, reason: "head_moved" }, { ok: false, reason: "index_flags" }, { ok: false, reason: "unreadable" }] as const) {
      const h = harness({ limits: { commands: 1 } });
      h.run("a");
      h.run("b");
      expect(h.governor.ended()).toBe("attempts_used");
      const rootPath = await mkdtemp(join(tmpdir(), "setup-final-"));
      roots.push(rootPath);
      await mkdir(join(rootPath, "repo/web"), { recursive: true });
      const answer = { setup: [{ repo: "web", commands: ["npm ci"], from: [{ kind: "file", repo: "web", path: "package.json", line: 2, quote: "\"scripts\"" }] }] };
      const result = await finishStoppedRun({ governor: h.governor, trackedFiles: verdict, lastText: `x\n\`\`\`agentx-setup-proposal\n${JSON.stringify(answer)}\n\`\`\``, basedOnRevision: 1, rootPath, repositories: [{ name: "web", path: "repo/web", resolvedCommit: "a".repeat(40) }] });
      expect(result, verdict.reason).toMatchObject({ end: "changed_repository_files", proposal: undefined, learned: [] });
    }
  });
});
