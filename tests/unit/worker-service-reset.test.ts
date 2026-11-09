// TS18: seeds and reset hooks (test-services.md 4.0.6 step 4, 4.1.2). Nothing starts Docker: a fake daemon records every argument list. What is checked: seeds run in order and stop at the first failure with a fixed
// sentence; each reset kind sends exactly its fixed statements (no repository text, no secret in an argument); the order of a reset between checks and for a fresh round; and the check round asks for fresh helpers first.
import { describe, expect, it } from "vitest";
import type { ProjectCommand } from "@agentx/contracts";
import { runChecks, planChecks, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { controlCallArgs, type HelperCredentials, type HelperFiles } from "../../packages/worker/src/service-helpers.js";
import { runNetworkAddresses, runNetworkBridge, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName, type ServicesNetwork } from "../../packages/worker/src/run-network.js";
import { probeService } from "../../packages/worker/src/service-probe.js";
import {
  REDIS_FLUSH_SCRIPT, RESET_PATH, SeedError, VALKEY_FLUSH_SCRIPT, createResetHooks, flushHook, freshHelpers, httpResetHook, resetForNextCheck, restartHook, runSeeds, seedRun, templateDbHook,
  type ResetDependency, type SeedPorts,
} from "../../packages/worker/src/service-reset.js";
import type { ResetContext, ResetRequest, ServiceSession } from "../../packages/worker/src/service-runner.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

const PASSWORD = ["pw", "Zk3Lm9Qx7TbW"].join("");
const TOKEN = ["tok", "Ab12Cd34Ef56"].join("");
const PROBE_IMAGE = `rovara/worker@sha256:${"b".repeat(64)}`;
const RUN = "44444444-4444-4444-8444-444444444444";
const SLOT = 77;
const command = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: ".", executable, args, timeoutSeconds: 60 });
const signal = new AbortController().signal;

function net(): ServicesNetwork {
  const labels = { runId: RUN, workspace: "0123456789abcdef", createdAt: 1_800_000_000_000, expiresAt: 1_800_001_500_000 };
  return { name: runNetworkName(RUN), bridge: runNetworkBridge(RUN, SLOT), slot: SLOT, ...runNetworkAddresses(SLOT), helperIp: (index: number) => runNetworkHelperIp(SLOT, index), labelArgs: () => runNetworkLabelArgs(labels), stop: () => Promise.resolve() };
}

// ---- seeds

function seedPorts(options: { fail?: string; timeout?: string; throwFixture?: boolean } = {}) {
  const events: string[] = [];
  const ports: SeedPorts = {
    runCommand: (c) => { events.push(`cmd:${c.executable}`); return Promise.resolve({ exitCode: options.fail === c.executable ? 1 : 0, timedOut: options.timeout === c.executable }); },
    applyFixture: (id, seed) => { events.push(`fixture:${id}:${seed.fixturePath}`); return options.throwFixture === true ? Promise.reject(new Error(`secret ${PASSWORD} in ${seed.fixturePath}`)) : Promise.resolve(); },
  };
  return { ports, events };
}

describe("seeds", () => {
  it("run in order, commands through the sandbox port and fixtures through the dependency's own", async () => {
    const s = seedPorts();
    await runSeeds("db", [{ command: command("one") }, { fixturePath: "seeds/a.sql" }, { command: command("two") }], s.ports, signal);
    expect(s.events).toEqual(["cmd:one", "fixture:db:seeds/a.sql", "cmd:two"]);
  });
  it("stop at the first failure, with one fixed sentence that carries no output and no path", async () => {
    const s = seedPorts({ fail: "two" });
    const error = await runSeeds("db", [{ command: command("one") }, { command: command("two") }, { command: command("three") }], s.ports, signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SeedError);
    expect(error).toMatchObject({ reason: "seed_failed", message: "A test service's seed did not complete" });
    expect(s.events).toEqual(["cmd:one", "cmd:two"]);
    const throwing: SeedPorts = { runCommand: () => Promise.reject(new Error(`boom ${PASSWORD}`)), applyFixture: () => Promise.resolve() };
    const fromCommand = await runSeeds("db", [{ command: command("one") }], throwing, signal).catch((caught: unknown) => caught);
    expect(fromCommand).toBeInstanceOf(SeedError);
    expect((fromCommand as Error).message).toBe("A test service's seed did not complete");
    const fixture = seedPorts({ throwFixture: true });
    const fromFixture = (await runSeeds("db", [{ fixturePath: "seeds/secret.sql" }], fixture.ports, signal).catch((caught: unknown) => caught)) as Error;
    expect(fromFixture.message).toBe("A test service's seed did not complete");
    expect(fromFixture.message).not.toContain(PASSWORD);
    expect(fromFixture.message).not.toContain("secret.sql");
  });
  it("a seed that times out, a stopped run and too many seeds each have their own fixed sentence", async () => {
    await expect(runSeeds("db", [{ command: command("slow") }], seedPorts({ timeout: "slow" }).ports, signal)).rejects.toMatchObject({ reason: "seed_timeout", message: "A test service's seed ran out of time" });
    const stopped = new AbortController();
    stopped.abort();
    const s = seedPorts();
    await expect(runSeeds("db", [{ command: command("one") }], s.ports, stopped.signal)).rejects.toMatchObject({ reason: "stopped" });
    expect(s.events).toEqual([]);
    const many = Array.from({ length: 9 }, () => ({ command: command("x") }));
    await expect(runSeeds("db", many, seedPorts().ports, signal)).rejects.toMatchObject({ reason: "seed_failed" });
    const aborting = new AbortController();
    const port: SeedPorts = { runCommand: () => { aborting.abort(); return Promise.resolve({ exitCode: 0, timedOut: false }); }, applyFixture: () => Promise.resolve() };
    await expect(runSeeds("db", [{ command: command("x") }], port, aborting.signal)).rejects.toMatchObject({ reason: "stopped" });
  });
});

// ---- order

function fakeSession(keep: Record<string, boolean> = {}) {
  const events: string[] = [];
  const session: Pick<ServiceSession, "reset" | "seeded"> = {
    reset: (id) => { events.push(`reset:${id}`); return Promise.resolve({ keptSeeds: keep[id] === true }); },
    seeded: (id) => { events.push(`seeded:${id}`); return Promise.resolve(); },
  };
  return { session, events };
}
const deps: ResetDependency[] = [
  { id: "db", reset: "between_checks", seeds: [{ command: command("seed-db") }] },
  { id: "cache", reset: "between_checks", seeds: [{ command: command("seed-cache") }] },
  { id: "aws", reset: "fresh_per_round", seeds: [{ command: command("seed-aws") }] },
];

describe("the order", () => {
  it("after the start: each dependency's seeds then its seeded call, in start order", async () => {
    const f = fakeSession();
    const s = seedPorts();
    const events: string[] = [];
    await seedRun({ ...f.session, seeded: (id) => { events.push(`seeded:${id}`); return Promise.resolve(); } }, deps, { ...s.ports, runCommand: (c, sig) => { events.push(`cmd:${c.executable}`); return s.ports.runCommand(c, sig); } }, signal);
    expect(events).toEqual(["cmd:seed-db", "seeded:db", "cmd:seed-cache", "seeded:cache", "cmd:seed-aws", "seeded:aws"]);
  });
  it("between checks: only between_checks dependencies, in order; a reset that lost the data is followed by its seeds; one that kept them is not", async () => {
    const f = fakeSession({ db: true });
    const s = seedPorts();
    const events: string[] = [];
    await resetForNextCheck({ reset: (id, sig) => { events.push(`reset:${id}`); return f.session.reset(id, sig); }, seeded: (id) => { events.push(`seeded:${id}`); return Promise.resolve(); } }, deps,
      { ...s.ports, runCommand: (c, sig) => { events.push(`cmd:${c.executable}`); return s.ports.runCommand(c, sig); } }, signal);
    expect(events).toEqual(["reset:db", "reset:cache", "cmd:seed-cache", "seeded:cache"]);
  });
  it("a fresh round: every dependency whatever its mode, and the first failure ends it", async () => {
    const f = fakeSession();
    const s = seedPorts();
    await freshHelpers(f.session, deps, s.ports, signal);
    expect(f.events).toEqual(["reset:db", "seeded:db", "reset:cache", "seeded:cache", "reset:aws", "seeded:aws"]);
    const failing = fakeSession();
    const broken = seedPorts({ fail: "seed-cache" });
    await expect(freshHelpers(failing.session, deps, broken.ports, signal)).rejects.toMatchObject({ reason: "seed_failed" });
    expect(failing.events).toEqual(["reset:db", "seeded:db", "reset:cache"]);
    const stopped = new AbortController();
    stopped.abort();
    const untouched = fakeSession();
    await expect(freshHelpers(untouched.session, deps, s.ports, stopped.signal)).rejects.toMatchObject({ reason: "stopped" });
    expect(untouched.events).toEqual([]);
  });
  it("L6: a fresh round takes the working sandbox out of the network FIRST, then resets, and a failure to leave ends it before any reset", async () => {
    const f = fakeSession();
    const order: string[] = [];
    const session = { ...f.session, enterCheckRound: () => { order.push("leave"); return Promise.resolve(); }, reset: (id: string, sig?: AbortSignal) => { order.push(`reset:${id}`); return f.session.reset(id, sig); } };
    await freshHelpers(session, deps, seedPorts().ports, signal);
    expect(order.slice(0, 2)).toEqual(["leave", "reset:db"]);
    const stuck = fakeSession();
    await expect(freshHelpers({ ...stuck.session, enterCheckRound: () => Promise.reject(new Error("still attached")) }, deps, seedPorts().ports, signal)).rejects.toThrow();
    expect(stuck.events).toEqual([]);
  });
  it("L3: between two checks the between_checks helpers are put back (not before the first); a failure leaves that check and the rest not_run", async () => {
    const order: string[] = [];
    const runners = (reset?: CheckRunners["resetBetweenChecks"]): CheckRunners => ({
      runProjectCommand: (c) => { order.push(`check:${c.executable}`); return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }); },
      runAgentCommand: () => Promise.resolve({ exitCode: 0, timedOut: false, output: "" }),
      ...(reset === undefined ? {} : { resetBetweenChecks: reset }),
    });
    const plan = planChecks([command("one"), command("two"), command("three")], { firstRuns: () => [] });
    const options = { budgetMs: 600_000, signal };
    const plain = await runChecks(plan, runners(), options);
    expect(plain.entries.map((entry) => entry.after)).toEqual(["passed", "passed", "passed"]);
    order.length = 0;
    await runChecks(plan, runners(() => { order.push("reset"); return Promise.resolve(); }), options);
    expect(order).toEqual(["check:one", "reset", "check:two", "reset", "check:three"]);
    order.length = 0;
    let calls = 0;
    const longer = planChecks([command("one"), command("two"), command("three"), command("four")], { firstRuns: () => [] });
    const failed = await runChecks(longer, runners(() => (++calls === 2 ? Promise.reject(new Error(`docker ${PASSWORD}`)) : Promise.resolve())), options);
    // The failure is sticky: the fourth check is not run either, and no further reset is tried.
    expect(failed.entries.map((entry) => entry.after)).toEqual(["passed", "passed", "not_run", "not_run"]);
    expect(calls).toBe(2);
    expect(JSON.stringify(failed.entries)).not.toContain(PASSWORD);
    order.length = 0;
    const early = await runChecks(plan, runners(() => Promise.reject(new Error("x"))), options);
    expect(early.entries.map((entry) => entry.after)).toEqual(["passed", "not_run", "not_run"]);
    expect(order).toEqual(["check:one"]);
    const throwing = await runChecks(plan, runners(() => { throw new Error("sync"); }), options);
    expect(throwing.entries.map((entry) => entry.after)).toEqual(["passed", "not_run", "not_run"]);
  });
  it("the check round asks for fresh helpers before its first check; with none to ask for nothing changes; a failure runs no check", async () => {
    const order: string[] = [];
    const runners = (fresh?: CheckRunners["freshServices"]): CheckRunners => ({
      runProjectCommand: () => { order.push("check"); return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }); },
      runAgentCommand: () => Promise.resolve({ exitCode: 0, timedOut: false, output: "" }),
      ...(fresh === undefined ? {} : { freshServices: fresh }),
    });
    const plan = planChecks([command("test"), command("lint")], { firstRuns: () => [] });
    const options = { budgetMs: 600_000, signal };
    const plain = await runChecks(plan, runners(), options);
    expect(plain.entries.map((entry) => entry.after)).toEqual(["passed", "passed"]);
    order.length = 0;
    const withFresh = await runChecks(plan, runners(() => { order.push("fresh"); return Promise.resolve(); }), options);
    expect(order).toEqual(["fresh", "check", "check"]);
    expect(withFresh.entries.map((entry) => entry.after)).toEqual(["passed", "passed"]);
    order.length = 0;
    for (const fresh of [() => Promise.reject(new Error(`docker ${PASSWORD}`)), () => { throw new Error("sync"); }] as Array<CheckRunners["freshServices"]>) {
      const failed = await runChecks(plan, runners(fresh), options);
      expect(order).toEqual([]);
      expect(failed.entries.map((entry) => entry.after)).toEqual(["not_run", "not_run"]);
      expect(failed.stopped).toBe(false);
      expect(JSON.stringify(failed.entries)).not.toContain(PASSWORD);
    }
    const stopped = new AbortController();
    stopped.abort();
    let asked = 0;
    const aborted = await runChecks(plan, runners(() => { asked += 1; return Promise.resolve(); }), { budgetMs: 600_000, signal: stopped.signal });
    expect(asked).toBe(0);
    expect(aborted.stopped).toBe(true);
  });
});

// ---- hooks

type ContextChange = Omit<Partial<ResetContext>, "request"> & { request?: Partial<ResetRequest>; stdout?: string; kind?: string; startTimeoutS?: number };
function context(change: ContextChange = {}) {
  const calls: string[][] = [];
  const timeouts: Array<number | undefined> = [];
  let clock = 1_000_000;
  const docker: DockerCli = {
    run(args, options) { calls.push([...args]); timeouts.push(options?.timeoutMs); return Promise.resolve({ exitCode: 0, stdout: stdout ?? "", stderr: "" }); },
  };
  const { request, stdout, kind, startTimeoutS, ...rest } = change;
  const value: ResetContext = {
    phase: "reset", docker, network: net(),
    helper: { id: "db", container: "rvi-h1234567890", address: runNetworkHelperIp(SLOT, 0), aliases: ["postgres"], ports: [5432] },
    request: { id: "db", name: "db", entry: { id: kind === "valkey" ? "valkey@8" : "postgres@16", reset: { kind: "template_db" }, run: { ports: [5432] }, health: { kind: "command", check: "pg_isready", startTimeoutS: startTimeoutS ?? 30 } } as never, credentials: { user: "rovara", database: "app" }, ...request },
    health: () => Promise.resolve(true), now: () => clock, sleep: (ms) => { clock += ms; return Promise.resolve(); }, ...rest,
  };
  return { value, calls, timeouts, advance: (ms: number) => { clock += ms; } };
}

describe("template_db (Postgres)", () => {
  it("after the seeds: disconnect, rename to the template, mark it, copy it back; nothing but fixed words and the helper's own names", async () => {
    const c = context({ phase: "seeded" });
    await templateDbHook(c.value);
    expect(c.calls).toEqual([["exec", "rvi-h1234567890", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "rovara", "-d", "postgres",
      "-c", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'app' AND pid <> pg_backend_pid()",
      "-c", 'ALTER DATABASE "app" RENAME TO "app_seeded"', "-c", 'ALTER DATABASE "app_seeded" WITH IS_TEMPLATE true', "-c", 'ALTER DATABASE "app_seeded" WITH ALLOW_CONNECTIONS false',
      "-c", 'CREATE DATABASE "app" TEMPLATE "app_seeded"']]);
    expect(c.calls.flat().join(" ")).not.toContain(PASSWORD);
  });
  it("between checks: disconnect, drop, copy the template; the seeded data is kept", async () => {
    const c = context();
    await expect(templateDbHook(c.value)).resolves.toEqual({ keptSeeds: true });
    expect(c.calls[0]!.slice(11)).toEqual([
      "-c", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'app' AND pid <> pg_backend_pid()",
      "-c", 'DROP DATABASE IF EXISTS "app" WITH (FORCE)', "-c", 'CREATE DATABASE "app" TEMPLATE "app_seeded"']);
  });
  it("M3: when the working database is the image's default `postgres`, the control connection is to template1 (a connection to the database being renamed or dropped cannot do it)", async () => {
    const seeded = context({ phase: "seeded", request: { credentials: { user: "rovara", database: "postgres" } } });
    await templateDbHook(seeded.value);
    const args = seeded.calls[0]!;
    expect(args.slice(args.indexOf("-d"), args.indexOf("-d") + 2)).toEqual(["-d", "template1"]);
    expect(args).toContain('ALTER DATABASE "postgres" RENAME TO "postgres_seeded"');
    expect(args).toContain('ALTER DATABASE "postgres_seeded" WITH ALLOW_CONNECTIONS false');
    const reset = context({ request: { credentials: { user: "rovara", database: "postgres" } } });
    await templateDbHook(reset.value);
    expect(reset.calls[0]!.slice(reset.calls[0]!.indexOf("-d"), reset.calls[0]!.indexOf("-d") + 2)).toEqual(["-d", "template1"]);
    expect(reset.calls[0]).toContain('DROP DATABASE IF EXISTS "postgres" WITH (FORCE)');
    // Any other name is reached from `postgres`.
    const other = context({ request: { credentials: { user: "rovara", database: "shop" } } });
    await templateDbHook(other.value);
    expect(other.calls[0]!.slice(other.calls[0]!.indexOf("-d"), other.calls[0]!.indexOf("-d") + 2)).toEqual(["-d", "postgres"]);
  });
  it("M3: template0 and template1 are never the working database", async () => {
    for (const database of ["template0", "template1"]) for (const phase of ["seeded", "reset"] as const) {
      const c = context({ phase, request: { credentials: { user: "rovara", database } } });
      await expect(templateDbHook(c.value), `${database} ${phase}`).rejects.toThrow();
      expect(c.calls).toEqual([]);
    }
  });
  it("a hostile or missing name is refused before anything reaches Docker, and a failed exec is a failure", async () => {
    for (const credentials of <HelperCredentials[]>[{ user: "rovara", database: 'app"; DROP DATABASE x; --' }, { user: "ro vara", database: "app" }, { user: "rovara", database: "a".repeat(60) }, { user: "rovara" }, { database: "app" }, {}]) {
      const c = context({ request: { credentials } });
      await expect(templateDbHook(c.value), JSON.stringify(credentials)).rejects.toThrow();
      expect(c.calls).toEqual([]);
    }
    const failing = context();
    failing.value.docker = { run: () => Promise.resolve({ exitCode: 2, stdout: "", stderr: PASSWORD }) };
    await expect(templateDbHook(failing.value)).rejects.toThrow();
  });
});

describe("flush (Redis)", () => {
  it("runs one fixed shell line that reads the password inside the container; the data is gone", async () => {
    const c = context({ stdout: "OK\n" });
    await expect(flushHook(c.value)).resolves.toEqual({ keptSeeds: false });
    expect(c.calls).toEqual([["exec", "rvi-h1234567890", "sh", "-c", REDIS_FLUSH_SCRIPT]]);
    expect(REDIS_FLUSH_SCRIPT).toContain("/etc/rovara/redis.conf");
    expect(REDIS_FLUSH_SCRIPT).not.toContain(PASSWORD);
    const seeded = context({ phase: "seeded" });
    await flushHook(seeded.value);
    expect(seeded.calls).toEqual([]);
  });
  it("L5: a Valkey helper is flushed with valkey-cli, a Redis one with redis-cli", async () => {
    const valkey = context({ stdout: "OK", kind: "valkey" });
    await flushHook(valkey.value);
    expect(valkey.calls[0]).toEqual(["exec", "rvi-h1234567890", "sh", "-c", VALKEY_FLUSH_SCRIPT]);
    expect(VALKEY_FLUSH_SCRIPT).toContain("valkey-cli flushall");
    expect(VALKEY_FLUSH_SCRIPT).not.toContain("redis-cli");
    expect(REDIS_FLUSH_SCRIPT).toContain("redis-cli flushall");
  });
  it("L5: the CLI must say OK: an empty answer, an error line or anything else is a failed flush", async () => {
    for (const stdout of ["", "(error) NOAUTH Authentication required.\n", "OKAY", "ERR something"]) await expect(flushHook(context({ stdout }).value), stdout).rejects.toThrow();
  });
});

describe("restart", () => {
  it("restarts with a one second stop, then waits until healthy; the data is gone", async () => {
    let answers = 0;
    const c = context({ health: () => Promise.resolve(++answers >= 3) });
    await expect(restartHook(c.value)).resolves.toEqual({ keptSeeds: false });
    expect(c.calls).toEqual([["restart", "--time", "1", "rvi-h1234567890"]]);
    expect(answers).toBe(3);
  });
  it("M1: waits for the entry's own startTimeoutS, not a fixed minute", async () => {
    for (const startTimeoutS of [5, 90]) {
      const c = context({ startTimeoutS, health: () => Promise.resolve(false) });
      const began = c.value.now();
      await expect(restartHook(c.value), String(startTimeoutS)).rejects.toThrow();
      const spent = c.value.now() - began;
      expect(spent).toBeGreaterThanOrEqual(startTimeoutS * 1_000);
      expect(spent).toBeLessThanOrEqual(startTimeoutS * 1_000 + 500);
    }
  });
  it("gives up after the entry's time, on a stop, and on a restart that fails; nothing happens for the seeded phase", async () => {
    const never = context({ health: () => Promise.resolve(false) });
    await expect(restartHook(never.value)).rejects.toThrow();
    const stopped = new AbortController();
    stopped.abort();
    await expect(restartHook(context({ signal: stopped.signal }).value)).rejects.toThrow();
    const failing = context();
    failing.value.docker = { run: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "" }) };
    await expect(restartHook(failing.value)).rejects.toThrow();
    const seeded = context({ phase: "seeded" });
    await restartHook(seeded.value);
    expect(seeded.calls).toEqual([]);
  });
});

describe("http_reset (Rovara local AWS)", () => {
  function files() {
    const written: Array<{ name: string; content: string; mode: number }> = [];
    const removed: string[] = [];
    const seam: HelperFiles = { write: (name, content, mode) => { written.push({ name, content, mode }); return Promise.resolve(`/run/rovara/${name}`); }, remove: (name) => { removed.push(name); return Promise.resolve(); } };
    return { seam, written, removed };
  }
  const awsContext = (change: ContextChange = {}) => context({ request: { entry: { reset: { kind: "http_reset" }, run: { ports: [4566] } } as never }, ...change });

  it("makes the control call from a hardened container with the token in an env file (never an argument), and removes the file", async () => {
    const f = files();
    const c = awsContext();
    const hook = httpResetHook({ files: f.seam, probeImage: PROBE_IMAGE, controlToken: () => TOKEN });
    await expect(hook(c.value)).resolves.toEqual({ keptSeeds: false });
    expect(c.calls).toHaveLength(1);
    const args = c.calls[0]!;
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(f.written).toEqual([{ name: expect.stringMatching(/\.env$/u) as string, content: `ROVARA_CONTROL_TOKEN=${TOKEN}\n`, mode: 0o600 }]);
    expect(args).toContain("--env-file");
    expect(args[args.indexOf("--env-file") + 1]).toBe(`/run/rovara/${f.written[0]!.name}`);
    for (const word of ["--rm", "--read-only", "--cap-drop", "no-new-privileges", "--pids-limit", "--post"]) expect(args).toContain(word);
    expect(args.slice(args.indexOf("--host"))).toEqual(["--host", c.value.helper.address, "--port", "4566", "--path", "/_rovara/reset", "--post"]);
    for (const [index, word] of net().labelArgs().entries()) expect(args[args.indexOf("--label") + 0 + index] ?? word).toBeDefined();
    expect(net().labelArgs().every((word) => args.includes(word))).toBe(true);
    expect(f.removed).toEqual([f.written[0]!.name]);
  });
  it("H1: with no override, the token is the one the runner put on the context (the request's controlToken); the POST path is the fork's, and a context without one is refused", async () => {
    const f = files();
    const c = awsContext({ controlToken: TOKEN });
    await httpResetHook({ files: f.seam, probeImage: PROBE_IMAGE })(c.value);
    expect(f.written[0]?.content).toBe(`ROVARA_CONTROL_TOKEN=${TOKEN}\n`);
    expect(c.calls[0]!.join(" ")).not.toContain(TOKEN);
    expect(c.calls[0]!.slice(c.calls[0]!.indexOf("--path"))).toEqual(["--path", "/_rovara/reset", "--post"]);
    expect(RESET_PATH).toBe("/_rovara/reset");
    const g = files();
    const none = awsContext();
    await expect(httpResetHook({ files: g.seam, probeImage: PROBE_IMAGE })(none.value)).rejects.toThrow();
    expect(g.written).toEqual([]);
    expect(none.calls).toEqual([]);
  });
  it("a failed call removes the named container and the file, and is a failure; no token or a bad one is refused before any file is written", async () => {
    const f = files();
    const c = awsContext();
    c.value.docker = { run: (args) => { c.calls.push([...args]); return Promise.resolve({ exitCode: args[0] === "run" ? 1 : 0, stdout: "", stderr: TOKEN }); } };
    await expect(httpResetHook({ files: f.seam, probeImage: PROBE_IMAGE, controlToken: () => TOKEN })(c.value)).rejects.toThrow();
    expect(c.calls.some((call) => call[0] === "rm" && call.includes("--force") && call.includes("--volumes"))).toBe(true);
    expect(f.removed).toHaveLength(1);
    for (const token of [undefined, "short", "has space 12345678", `${TOKEN}\nX=1`, "a".repeat(65)]) {
      const g = files();
      await expect(httpResetHook({ files: g.seam, probeImage: PROBE_IMAGE, controlToken: () => token })(awsContext().value), String(token)).rejects.toThrow();
      expect(g.written).toEqual([]);
    }
    const portless = awsContext({ request: { entry: { reset: { kind: "http_reset" }, run: { ports: [] } } as never } });
    const h = files();
    await expect(httpResetHook({ files: h.seam, probeImage: PROBE_IMAGE, controlToken: () => TOKEN })(portless.value)).rejects.toThrow();
    expect(h.written).toEqual([]);
    expect(portless.calls).toEqual([]);
    const seeded = awsContext({ phase: "seeded" });
    await httpResetHook({ files: f.seam, probeImage: PROBE_IMAGE, controlToken: () => TOKEN })(seeded.value);
    expect(seeded.calls).toEqual([]);
  });
  it("controlCallArgs refuses a bad image, path, address, port, name or file", () => {
    const good = { probeImage: PROBE_IMAGE, address: runNetworkHelperIp(SLOT, 0), port: 4566, path: "/_rovara/reset", name: "rvi-x-r1234abcd", envFile: "/run/rovara/x.env" };
    expect(() => controlCallArgs(net(), good)).not.toThrow();
    const bad: Array<Partial<typeof good>> = [
      { probeImage: "rovara/worker:latest" }, { path: "/a/../b" }, { path: "reset" }, { path: "/x?y=1" }, { address: "10.0.0.1" }, { address: "172.30.1.2;rm" }, { address: `${runNetworkHelperIp(SLOT, 0)};rm` }, { address: `${runNetworkHelperIp(SLOT, 0)} --privileged` }, { port: 0 }, { port: 70_000 },
      { name: "A B" }, { name: "-x" }, { envFile: "../x.env" }, { envFile: "/run/rovara/../x.env" }, { envFile: "relative.env" },
    ];
    for (const change of bad) expect(() => controlCallArgs(net(), { ...good, ...change }), JSON.stringify(change)).toThrow();
  });
  it("the probe program makes the call: a POST with the token header and no body; it must answer 2xx; no token or a bad one never reaches the network", async () => {
    const seen: Array<{ method?: string | undefined; url?: string | undefined; headers: IncomingHttpHeaders }> = [];
    const server = createServer((request, response) => { seen.push({ method: request.method, url: request.url, headers: request.headers }); response.statusCode = request.headers["x-rovara-control-token"] === TOKEN ? 204 : 403; response.end(); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(probeService({ host: "127.0.0.1", port, path: "/_rovara/reset", post: { token: TOKEN } })).resolves.toBe(true);
      expect(seen[0]).toMatchObject({ method: "POST", url: "/_rovara/reset" });
      expect(seen[0]?.headers["x-rovara-control-token"]).toBe(TOKEN);
      expect(seen[0]?.headers["content-length"]).toBe("0");
      await expect(probeService({ host: "127.0.0.1", port, path: "/_rovara/reset", post: { token: "wrongtoken123" } })).resolves.toBe(false);
      const before = seen.length;
      for (const post of [{ token: "" }, { token: "short" }, { token: "has space 12345678" }, { token: `${TOKEN}\r\nX: 1` }]) await expect(probeService({ host: "127.0.0.1", port, path: "/_rovara/reset", post })).resolves.toBe(false);
      await expect(probeService({ host: "127.0.0.1", port, post: { token: TOKEN } })).resolves.toBe(false);
      expect(seen.length).toBe(before);
      await expect(probeService({ host: "127.0.0.1", port, path: "/x" })).resolves.toBe(false);
      expect(seen.at(-1)?.method).toBe("GET");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("the probe program's own command line", () => {
  it("--post takes the token from the environment, never from an argument", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((request, response) => { seen.push(request.headers); response.statusCode = request.headers["x-rovara-control-token"] === TOKEN ? 204 : 403; response.end(); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    const { main } = await import("../../packages/worker/src/service-probe.js");
    const argv = process.argv;
    const exit = process.exit.bind(process);
    const token = process.env["ROVARA_CONTROL_TOKEN"];
    const codes: Array<number | undefined> = [];
    process.exit = ((code?: number) => { codes.push(code); }) as never;
    try {
      process.env["ROVARA_CONTROL_TOKEN"] = TOKEN;
      process.argv = ["node", "probe", "--post", "--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/reset"];
      await main();
      expect(codes).toEqual([0]);
      expect(seen[0]?.["x-rovara-control-token"]).toBe(TOKEN);
      // No token in the environment: the call is refused before it is made.
      delete process.env["ROVARA_CONTROL_TOKEN"];
      const before = seen.length;
      process.argv = ["node", "probe", "--post", "--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/reset"];
      await main();
      expect(codes).toEqual([0, 1]);
      expect(seen.length).toBe(before);
    } finally {
      process.argv = argv;
      process.exit = exit;
      if (token === undefined) delete process.env["ROVARA_CONTROL_TOKEN"]; else process.env["ROVARA_CONTROL_TOKEN"] = token;
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("createResetHooks", () => {
  it("covers every kind; http_reset only when it is given what it needs", () => {
    expect(Object.keys(createResetHooks()).sort()).toEqual(["flush", "restart", "template_db"]);
    const files: HelperFiles = { write: () => Promise.resolve("/x"), remove: () => Promise.resolve() };
    expect(Object.keys(createResetHooks({ http: { files, probeImage: PROBE_IMAGE, controlToken: () => TOKEN } })).sort()).toEqual(["flush", "http_reset", "restart", "template_db"]);
  });
});
