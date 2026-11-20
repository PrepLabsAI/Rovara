// TS-UX-1 item 9 (security-sensitive): a dependency's seed FILE is read from the repository checkout only (no traversal, no symlink escape, no hidden folder, a size cap, the file that was resolved) and loaded into the
// disposable test database by its own client inside its container, over the local socket (no host, port or password), in one transaction, under a time limit. Every failure is a fixed reason.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_SERVICES_FILE_SEED_FEATURE, WORKER_INVOCATION_FEATURES } from "@agentx/contracts";
import { DATABASE_READ_MAX_BYTES, SEED_FILE_MAX_BYTES, SeedFileError, loadSeedFile, readDatabaseText, readSeedFile, seedFileContentProblem, seedFileDigest, seedFileLoadArgs, seedRoleStatements } from "../../packages/worker/src/service-seed-file.js";
import { seedFileApplier } from "../../packages/worker/src/test-services-run.js";
import { SeedError, runSeeds } from "../../packages/worker/src/service-reset.js";

let root: string;
let outside: string;
const repo = () => join(root, "repo");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "seed-file-root-"));
  outside = await mkdtemp(join(tmpdir(), "seed-file-outside-"));
  await mkdir(join(repo(), "db", "seeds"), { recursive: true });
  await writeFile(join(repo(), "db", "seeds", "users.sql"), "insert into users values (1);\n");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

const read = (fixturePath: string, extra: { family?: string; hiddenPaths?: string[] } = {}) => readSeedFile({ rootPath: root, repositoryPaths: [repo()], hiddenPaths: extra.hiddenPaths ?? [], fixturePath, family: extra.family ?? "postgres" });
const reasonOf = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return "loaded"; } catch (error) { return error instanceof SeedFileError ? error.reason : `other: ${String(error)}`; } };

describe("reading a seed file from the repository", () => {
  it("refuses traversal and absolute paths, before touching the disk", async () => {
    await writeFile(join(outside, "x.sql"), "select 1;");
    expect(await reasonOf(read("repo/../../x.sql"))).toBe("outside");
    expect(await reasonOf(read(join(outside, "x.sql")))).toBe("outside");
  });
  it("refuses a symlink that points outside the repository, and a file outside any repository folder; a symlink inside it to a file inside it is fine", async () => {
    await writeFile(join(outside, "secret.sql"), "select 1;");
    await symlink(join(outside, "secret.sql"), join(repo(), "db", "seeds", "escape.sql"));
    expect(await reasonOf(read("repo/db/seeds/escape.sql"))).toBe("outside");
    await symlink(outside, join(repo(), "db", "linked"));
    expect(await reasonOf(read("repo/db/linked/secret.sql"))).toBe("outside");
    await writeFile(join(root, "loose.sql"), "select 1;");
    expect(await reasonOf(read("loose.sql"))).toBe("outside");
    await symlink(join(repo(), "db", "seeds", "users.sql"), join(repo(), "db", "seeds", "alias.sql"));
    expect((await read("repo/db/seeds/alias.sql")).length).toBeGreaterThan(0);
  });
  it("refuses a file over the size cap, a missing file, a directory, another extension and a family whose client loads no file", async () => {
    await writeFile(join(repo(), "big.sql"), Buffer.alloc(SEED_FILE_MAX_BYTES + 1, 0x20));
    expect(await reasonOf(read("repo/big.sql"))).toBe("too_large");
    expect(await reasonOf(read("repo/missing.sql"))).toBe("not_a_file");
    await mkdir(join(repo(), "dir.sql"));
    expect(await reasonOf(read("repo/dir.sql"))).toBe("not_a_file");
    await writeFile(join(repo(), "seed.sh"), "rm -rf /");
    expect(await reasonOf(read("repo/seed.sh"))).toBe("unsupported");
    expect(await reasonOf(read("repo/db/seeds/users.sql", { family: "redis" }))).toBe("unsupported");
  });
});

describe("loading it with the database's own client", () => {
  const target = { container: "rovara-svc-run1-postgres", family: "postgres", user: "rovara", database: "app" };
  const ROLE = "rovara_seed_0123456789ab";
  /** A fake Docker that records every call: `run` is Rovara's own fixed statements, `execBytes` the file load. */
  const fakeDocker = (load: { exitCode: number | null; timedOut?: boolean } = { exitCode: 0 }, runExit = 0) => {
    const calls: string[][] = [];
    return {
      calls,
      run: vi.fn(async (args: readonly string[]) => { calls.push(["run", ...args]); return { exitCode: runExit, stdout: "", stderr: "" }; }),
      execBytes: vi.fn(async (args: readonly string[], options: { stdin?: Buffer }) => { void options; calls.push(["load", ...args]); return { stdout: Buffer.alloc(0), stderr: "", ...load }; }),
    };
  };
  const statementsOf = (call: string[]) => call.flatMap((arg, at) => (call[at - 1] === "-c" ? [arg] : []));

  it("M2: a timeout kills psql inside the container (timeout -s KILL, exit 137), terminates the role's backends, and still drops the role", async () => {
    for (const load of [{ exitCode: 137 }, { exitCode: null, timedOut: true }]) {
      const docker = fakeDocker(load);
      expect(await reasonOf(loadSeedFile(docker, target, Buffer.from("select pg_sleep(9999);"), new AbortController().signal, { role: ROLE, timeoutMs: 5_000 }))).toBe("timeout");
      expect(docker.calls[2]!.slice(4, 8)).toEqual(["timeout", "-s", "KILL", "5"]);
      expect(statementsOf(docker.calls[3]!)).toEqual([`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${ROLE}'`]);
      expect(statementsOf(docker.calls[4]!)[2]).toBe(`DROP ROLE "${ROLE}"`);
    }
    // The role's own statement limit is set too, so the server stops a statement even if the kill were lost.
    expect(seedRoleStatements({ role: ROLE, database: "app" }, 5_000)).toContain(`ALTER ROLE "${ROLE}" SET statement_timeout = 5000`);
  });
  it("a bad SQL file (psql exits non-zero) is a load failure and the role is still dropped; a failure to make the role loads nothing", async () => {
    const bad = fakeDocker({ exitCode: 3 });
    expect(await reasonOf(loadSeedFile(bad as never, target, Buffer.from("inssert"), new AbortController().signal, { role: ROLE }))).toBe("load_failed");
    expect(statementsOf(bad.calls.at(-1)!).at(-1)).toBe(`DROP ROLE "${ROLE}"`);
    const noRole = fakeDocker({ exitCode: 0 }, 1);
    expect(await reasonOf(loadSeedFile(noRole as never, target, Buffer.from("select 1"), new AbortController().signal, { role: ROLE }))).toBe("load_failed");
    expect(noRole.execBytes).not.toHaveBeenCalled();
    expect(await reasonOf(loadSeedFile({ run: noRole.run }, target, Buffer.from("select 1"), new AbortController().signal, { role: ROLE }))).toBe("unsupported");
  });
  it("a grant that fails after the role is made still drops the role, and a statement the role may not run is its own reason", async () => {
    const calls: string[][] = [];
    let call = 0;
    const docker = {
      run: vi.fn(async (args: readonly string[]) => { calls.push([...args]); call += 1; return { exitCode: call === 2 ? 1 : 0, stdout: "", stderr: "" }; }),
      execBytes: vi.fn(async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "" })),
    };
    expect(await reasonOf(loadSeedFile(docker, target, Buffer.from("select 1"), new AbortController().signal, { role: ROLE }))).toBe("load_failed");
    expect(docker.execBytes).not.toHaveBeenCalled();
    expect(statementsOf(calls.at(-1)!).at(-1)).toBe(`DROP ROLE "${ROLE}"`);
    const denied = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), execBytes: vi.fn(async () => ({ exitCode: 3, stdout: Buffer.alloc(0), stderr: "ERROR:  permission denied for function pg_read_file" })) };
    expect(await reasonOf(loadSeedFile(denied, target, Buffer.from("select pg_read_file('/etc/passwd');"), new AbortController().signal, { role: ROLE }))).toBe("not_allowed");
  });
  it("I2: a file with a psql meta-command (any backslash) or PROGRAM is refused before anything runs", async () => {
    for (const text of ["\\! sh -c 'id'", "select 1;\n\\c host=other", "insert into t values ('a'); \\copy t from '/etc/passwd'", "COPY t FROM PROGRAM 'id';", "copy t from program 'id'"]) {
      const docker = fakeDocker();
      const reason = await reasonOf(loadSeedFile(docker, target, Buffer.from(text), new AbortController().signal, { role: ROLE }));
      expect(["meta_command", "program"], text).toContain(reason);
      expect(docker.calls, text).toEqual([]);
    }
    expect(seedFileContentProblem(Buffer.from("insert into programs values ('a programme');"))).toBeUndefined();
    expect(seedFileContentProblem(Buffer.from("insert into t values (1);"))).toBeUndefined();
  });
  it("refuses names that are not the launcher's plain ones (nothing a repository wrote reaches an argument), and a role name it did not make", () => {
    expect(() => seedFileLoadArgs({ ...target, database: "app; drop" }, ROLE)).toThrow(SeedFileError);
    expect(() => seedFileLoadArgs({ ...target, user: undefined }, ROLE)).toThrow(SeedFileError);
    expect(() => seedFileLoadArgs({ ...target, container: "--privileged" }, ROLE)).toThrow(SeedFileError);
    expect(() => seedFileLoadArgs({ ...target, family: "mysql" }, ROLE)).toThrow(SeedFileError);
    expect(() => seedFileLoadArgs(target, "postgres")).toThrow(SeedFileError);
    expect(() => seedFileLoadArgs(target, 'rovara_seed_0123456789ab" SUPERUSER')).toThrow(SeedFileError);
  });
});

describe("M1: the opened descriptor's own path", () => {
  it("a descriptor whose path is not the resolved one (a parent folder swapped for a link) is refused; the resolved path is accepted", async () => {
    const real = await (await import("node:fs/promises")).realpath(join(repo(), "db", "seeds", "users.sql"));
    expect(await reasonOf(readSeedFile({ rootPath: root, repositoryPaths: [repo()], hiddenPaths: [], fixturePath: "repo/db/seeds/users.sql", family: "postgres", fdPath: async () => join(outside, "secret.sql") }))).toBe("outside");
    expect(await reasonOf(readSeedFile({ rootPath: root, repositoryPaths: [repo()], hiddenPaths: [], fixturePath: "repo/db/seeds/users.sql", family: "postgres", fdPath: async () => { throw new Error("no /proc"); } }))).toBe("outside");
    expect((await readSeedFile({ rootPath: root, repositoryPaths: [repo()], hiddenPaths: [], fixturePath: "repo/db/seeds/users.sql", family: "postgres", fdPath: async () => real })).length).toBeGreaterThan(0);
  });
});

describe("the run's seed port", () => {
  const item = { plan: { id: "postgres", family: "postgres" }, request: { credentials: { user: "rovara", database: "app" } } } as never;
  const okDocker = () => ({ run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), execBytes: vi.fn(async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "" })) });
  const commandPort = async () => ({ exitCode: 0, timedOut: false });
  it("loads the file into THIS phase's helper and reports the sha256 it loaded; a failed load fails the seeds with the fixed sentence (the error text never travels)", async () => {
    const docker = okDocker();
    const log = vi.fn();
    const loaded: unknown[] = [];
    const apply = seedFileApplier({ docker, rootPath: root, repositoryPaths: [repo()], items: [item], helpers: [{ id: "postgres", container: "rovara-svc-r1-postgres" }], log, onLoaded: (entry) => loaded.push(entry) });
    await runSeeds("postgres", [{ fixturePath: "repo/db/seeds/users.sql" }], { runCommand: commandPort, applyFixture: apply }, new AbortController().signal);
    expect((docker.execBytes.mock.calls[0]! as unknown as [string[]])[0]).toContain("rovara-svc-r1-postgres");
    expect(loaded).toEqual([{ id: "postgres", path: "repo/db/seeds/users.sql", sha256: seedFileDigest(Buffer.from("insert into users values (1);\n")) }]);
    const bad = seedFileApplier({ docker: { run: docker.run, execBytes: async () => ({ exitCode: 3, stdout: Buffer.alloc(0), stderr: "ERROR: relation \"users\" does not exist" }) }, rootPath: root, repositoryPaths: [repo()], items: [item], helpers: [{ id: "postgres", container: "c1" }], log });
    const failed = await runSeeds("postgres", [{ fixturePath: "repo/db/seeds/users.sql" }], { runCommand: commandPort, applyFixture: bad }, new AbortController().signal).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(SeedError);
    expect((failed as Error).message).toBe("A test service's seed did not complete");
    expect(log).toHaveBeenLastCalledWith({ event: "test-services.seed-file.refused", reason: "load_failed" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("relation");
    expect(JSON.stringify(log.mock.calls)).not.toContain("users.sql");
  });
  it("I3 (SEED-FILE-LOCK): a file changed after approval is not loaded, and the seeds fail asking for a fresh approval; the approved content loads", async () => {
    const approved = seedFileDigest(Buffer.from("insert into users values (1);\n"));
    const docker = okDocker();
    const apply = seedFileApplier({ docker, rootPath: root, repositoryPaths: [repo()], items: [item], helpers: [{ id: "postgres", container: "c1" }] });
    await runSeeds("postgres", [{ fixturePath: "repo/db/seeds/users.sql", sha256: approved }], { runCommand: commandPort, applyFixture: apply }, new AbortController().signal);
    expect(docker.execBytes).toHaveBeenCalledTimes(1);
    // Someone commits a different seed (or the agent rewrites it in the candidate tree) after the approval.
    await writeFile(join(repo(), "db", "seeds", "users.sql"), "insert into users values (2);\n");
    const changed = await runSeeds("postgres", [{ fixturePath: "repo/db/seeds/users.sql", sha256: approved }], { runCommand: commandPort, applyFixture: apply }, new AbortController().signal).catch((error: unknown) => error);
    expect((changed as SeedError).reason).toBe("seed_changed");
    expect((changed as Error).message).toContain("approve it again");
    expect(docker.execBytes).toHaveBeenCalledTimes(1);
  });
  it("refuses a dependency this phase has no helper for", async () => {
    const apply = seedFileApplier({ docker: okDocker(), rootPath: root, repositoryPaths: [repo()], items: [item], helpers: [] });
    expect(await reasonOf(apply("postgres", { fixturePath: "repo/db/seeds/users.sql" }, new AbortController().signal))).toBe("unsupported");
  });
  it("is a worker feature the broker checks before it sends a plan with a file seed", () => {
    expect(TEST_SERVICES_FILE_SEED_FEATURE).toBe("task.testServices.fileSeed.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_SERVICES_FILE_SEED_FEATURE);
  });
});

// L4-E34 (E3): Rovara's own fixed read-only statements (the schema, a few parent keys) are read as the database's owner over the local socket, as exact bytes, bounded, with fixed failure words.
describe("reading one fixed answer from the database", () => {
  const target = { container: "rovara-svc-run1-postgres", family: "postgres", user: "rovara", database: "app" };
  const fake = (result: Record<string, unknown> = {}) => {
    const calls: string[][] = []; const options: Array<{ maxStdoutBytes: number; timeoutMs?: number; stdin?: Buffer }> = [];
    return { calls, options, execBytes: vi.fn(async (args: readonly string[], opts: { maxStdoutBytes: number; timeoutMs?: number; stdin?: Buffer }) => { calls.push([...args]); options.push(opts); return { exitCode: 0, stdout: Buffer.from(' {"tables":[]}\n'), stderr: "", ...result }; }) };
  };
  it("runs psql as the owner over the container's socket (no host, port or password), one -c, and returns the exact text trimmed", async () => {
    const docker = fake();
    expect(await readDatabaseText(docker, target, "SELECT 1", new AbortController().signal)).toBe('{"tables":[]}');
    expect(docker.calls).toEqual([["exec", "rovara-svc-run1-postgres", "psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-U", "rovara", "-d", "app", "-c", "SET default_transaction_read_only = on", "-c", "SELECT 1"]]);
    expect(docker.calls[0]!.some(arg => /^-h$|^--host|^-p$|^--port|PGPASSWORD|password/iu.test(arg))).toBe(false);
    expect(docker.options[0]!.maxStdoutBytes).toBe(DATABASE_READ_MAX_BYTES); expect(docker.options[0]!.stdin).toBeUndefined();
  });
  it("refuses anything but a SELECT, a NUL, a long statement, other names and another family, before any call", async () => {
    const docker = fake();
    for (const statement of ["DROP TABLE users", "  insert into t values (1)", "SELECT 1\0", `SELECT ${"x".repeat(70_000)}`]) expect(await reasonOf(readDatabaseText(docker, target, statement, new AbortController().signal))).toBe("unsupported");
    for (const bad of [{ ...target, user: "x; drop" }, { ...target, database: "a b" }, { ...target, container: "../x" }, { ...target, family: "redis" }, { ...target, user: undefined }]) expect(await reasonOf(readDatabaseText(docker, bad, "SELECT 1", new AbortController().signal))).toBe("unsupported");
    expect(docker.execBytes).not.toHaveBeenCalled();
  });
  it("turns every failure into a fixed reason that carries no output: a non-zero exit, a too large answer, a timeout, a cancel, a docker error", async () => {
    const signal = () => new AbortController().signal;
    expect(await reasonOf(readDatabaseText(fake({ exitCode: 2, stderr: "secret-in-stderr" }), target, "SELECT 1", signal()))).toBe("load_failed");
    expect(await reasonOf(readDatabaseText(fake({ tooLarge: true }), target, "SELECT 1", signal()))).toBe("load_failed");
    expect(await reasonOf(readDatabaseText(fake({ timedOut: true, exitCode: null }), target, "SELECT 1", signal()))).toBe("timeout");
    expect(await reasonOf(readDatabaseText(fake({ aborted: true, exitCode: null }), target, "SELECT 1", signal()))).toBe("load_failed");
    const aborted = new AbortController(); aborted.abort();
    expect(await reasonOf(readDatabaseText(fake(), target, "SELECT 1", aborted.signal))).toBe("load_failed");
    expect(await reasonOf(readDatabaseText({ execBytes: async () => { throw new Error("private-docker-error"); } }, target, "SELECT 1", signal()))).toBe("load_failed");
    expect(await reasonOf(readDatabaseText({}, target, "SELECT 1", signal()))).toBe("unsupported");
    try { await readDatabaseText(fake({ exitCode: 2, stderr: "secret-in-stderr" }), target, "SELECT 1", signal()); } catch (error) { expect(String(error)).not.toContain("secret-in-stderr"); expect(String(error)).not.toContain("SELECT"); }
  });
});
