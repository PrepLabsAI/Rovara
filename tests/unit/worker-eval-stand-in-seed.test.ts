// L4-EINT (E3 and E4 in production): each side's real-software services are seeded from the BASE commit's seed FILES (the same bytes on both sides) and then get generated rows for the tables still empty; a seed that does not
// load ends the start with the fixed sentence; the stand-in set's version follows the seed bytes. Docker is a fake that records what it was asked.
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedFileDigest } from "../../packages/worker/src/service-seed-file.js";
import { evalDatabaseSeed, prepareEvalStandIns, seedPathInRepository } from "../../packages/worker/src/eval-stand-in-plan.js";
import { EVAL_SERVICES_FAILURE_SENTENCE, type EvalServicesStarted } from "../../packages/worker/src/verification/eval-services.js";

const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const SEED = "CREATE TABLE creators (id int primary key, name text);\nINSERT INTO creators VALUES (1, 'a');\n";
const plan = (over: Record<string, unknown> = {}) => ({ id: "db", backing: "local", family: "postgres", catalogId: "postgres", digest: "a".repeat(64), seeds: [{ fixturePath: "seeds/dev.sql" }], ...over }) as never;

async function repo(seed = SEED): Promise<string> {
  const root = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "eint-seed-")); roots.push(root);
  await mkdir(join(root, "seeds"), { recursive: true });
  await writeFile(join(root, "seeds", "dev.sql"), seed);
  return root;
}
const materializeFrom = (root: string) => async (_dir: string, _sha: string, destination: string): Promise<void> => { await cp(root, destination, { recursive: true }); };
const prepare = async (root: string, dependencies: unknown) => prepareEvalStandIns({ descriptor: undefined, dependencies: dependencies as never, repositoryDirectory: root, baseCommit: "a".repeat(40), scratchDir: join(root, "..", `scratch-${String(roots.length)}`), workspaceId: WORKSPACE, operationId: OPERATION, signal: new AbortController().signal, materialize: materializeFrom(root) });

describe("the seed files and the version come from the BASE commit, once", () => {
  it("reads the plan's seed files, keeps them per dependency and moves the version with their bytes", async () => {
    const root = await repo();
    const first = await prepare(root, [plan()]);
    expect([...first.seeds.keys()]).toEqual(["db"]);
    expect(first.seeds.get("db")!.map((bytes) => bytes.toString("utf8"))).toEqual([SEED]);
    expect(first.version).toMatch(/^[a-f0-9]{64}$/u);
    expect((await prepare(root, [plan()])).version).toBe(first.version);
    const changed = await prepare(await repo(`${SEED}INSERT INTO creators VALUES (2, 'b');\n`), [plan()]);
    expect(changed.version).not.toBe(first.version);
    expect(seedFileDigest(changed.seeds.get("db")![0]!)).not.toBe(seedFileDigest(first.seeds.get("db")![0]!));
  });

  it("review M2: a seed path is WORKSPACE-relative (`<repository folder>/<file>`) and is read from this one repository's checkout; another repository's seed is not read from this tree", async () => {
    const root = await repo();
    const folder = root.split("/").at(-1)!;
    const real = await prepare(root, [plan({ seeds: [{ fixturePath: `${folder}/seeds/dev.sql` }] })]);
    expect(real.seeds.get("db")!.map((bytes) => bytes.toString("utf8"))).toEqual([SEED]);
    // The same file name under another repository's folder is not this repository's.
    expect((await prepare(root, [plan({ seeds: [{ fixturePath: "other-repo/seeds/dev.sql" }] })])).seeds.size).toBe(0);
    expect(seedPathInRepository("web/db/seed.sql", "/work/ws/web")).toBe("db/seed.sql");
    expect(seedPathInRepository("ws/web/db/seed.sql", "/work/ws/web")).toBe("db/seed.sql");
    expect(seedPathInRepository("seeds/dev.sql", "/work/ws/web")).toBe("seeds/dev.sql");
    expect(seedPathInRepository("../x.sql", "/work/ws/web")).toBeUndefined();
    expect(seedPathInRepository("", "/work/ws/web")).toBeUndefined();
  });

  it("an approved plan's sha256 must match the file; a file that is missing, a link or outside is no seed (on both sides alike); a plan with no local service has no version", async () => {
    const root = await repo();
    expect((await prepare(root, [plan({ seeds: [{ fixturePath: "seeds/dev.sql", sha256: "0".repeat(64) }] })])).seeds.size).toBe(0);
    expect((await prepare(root, [plan({ seeds: [{ fixturePath: "seeds/dev.sql", sha256: seedFileDigest(Buffer.from(SEED)) }] })])).seeds.size).toBe(1);
    expect((await prepare(root, [plan({ seeds: [{ fixturePath: "seeds/missing.sql" }] })])).seeds.size).toBe(0);
    expect((await prepare(root, [plan({ seeds: [{ fixturePath: "../outside.sql" }] })])).seeds.size).toBe(0);
    const none = await prepare(root, [plan({ backing: "fake" })]);
    expect(none.version).toBeUndefined();
    expect(none.seeds.size).toBe(0);
    // A checkout that cannot be made is nothing prepared (the eval runs as it did), never a throw.
    const broken = await prepareEvalStandIns({ descriptor: undefined, dependencies: [plan()] as never, repositoryDirectory: root, baseCommit: "a".repeat(40), scratchDir: join(root, "..", "scratch-x"), workspaceId: WORKSPACE, operationId: OPERATION, signal: new AbortController().signal, materialize: async () => { throw new Error("no git"); } });
    expect(broken).toEqual({ seeds: new Map() });
  });
});

describe("each side's services are seeded the same way", () => {
  /** A Docker that records every psql call; `fail` makes the load itself exit non-zero. */
  function docker(options: { fail?: boolean } = {}) {
    const loads: Buffer[] = []; const reads: string[] = [];
    const fake = {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      execBytes: async (args: readonly string[], run: { stdin?: Buffer }) => {
        if (run.stdin !== undefined) { loads.push(run.stdin); return { exitCode: options.fail === true ? 1 : 0, stdout: Buffer.alloc(0), stderr: "boom: password=hunter2" }; }
        reads.push(args.at(-1) ?? "");
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ tables: [] })), stderr: "" };
      },
    };
    return { fake: fake as never, loads, reads };
  }
  const started = (targets: EvalServicesStarted["targets"]): Omit<EvalServicesStarted, "stop"> => ({ hosts: [], env: [], secrets: [], started: [], targets, unsupported: [] });
  const pg = { id: "db", container: "rovara-db", family: "postgres", user: "app", database: "app" };

  it("loads the base commit's seed bytes into each postgres service, in order, the same bytes on the old and the new side; another family is left alone", async () => {
    const root = await repo();
    const prepared = await prepare(root, [plan()]);
    const sides: Buffer[][] = [];
    for (const side of ["old", "new"] as const) {
      const d = docker();
      await evalDatabaseSeed({ docker: d.fake, side, prepared })(started([pg, { ...pg, id: "cache", container: "rovara-redis", family: "redis" }]), {} as never, new AbortController().signal);
      sides.push(d.loads);
      expect(d.reads.length).toBeGreaterThan(0);
    }
    expect(sides[0]!.map((bytes) => bytes.toString("utf8"))[0]).toBe(SEED);
    expect(sides[1]!.map((bytes) => bytes.toString("utf8"))).toEqual(sides[0]!.map((bytes) => bytes.toString("utf8")));
  });

  it("runs migrations before ordered seed files and commands through the round runner", async () => {
    const migrate = { cwd: ".", executable: "alembic", args: ["upgrade", "head"], timeoutSeconds: 30 };
    const seed = { cwd: ".", executable: "node", args: ["seed.js"], timeoutSeconds: 30 };
    const prepared = await prepare(await repo(), [plan({ seeds: [{ command: seed }, { fixturePath: "seeds/dev.sql" }, { command: migrate }] })]);
    for (const side of ["old", "new"] as const) {
      const d = docker(); const commands: unknown[] = [];
      const run = async (command: unknown) => { commands.push(command); if (command === seed) expect(d.loads).toHaveLength(0); return { exitCode: 0, timedOut: false }; };
      await evalDatabaseSeed({ docker: d.fake, side, prepared })(started([pg]), {} as never, new AbortController().signal, run);
      expect(commands).toEqual([migrate, seed]);
      expect(d.loads[0]!.toString()).toBe(SEED);
    }
  });

  it("refuses a failed migration, rollback, missing runner or timed out seed before generation", async () => {
    const command = { cwd: ".", executable: "alembic", args: ["upgrade", "head"], timeoutSeconds: 30 };
    const prepared = await prepare(await repo(), [plan({ seeds: [{ command }] })]);
    for (const run of [undefined, async () => ({ exitCode: 1, timedOut: false }), async () => ({ exitCode: null, timedOut: true })]) {
      const d = docker();
      await expect(evalDatabaseSeed({ docker: d.fake, side: "new", prepared })(started([pg]), {} as never, new AbortController().signal, run)).rejects.toThrow(EVAL_SERVICES_FAILURE_SENTENCE);
      expect(d.reads).toEqual([]);
    }
    const rollback = await prepare(await repo(), [plan({ seeds: [{ command: { ...command, args: ["downgrade", "base"] } }] })]);
    const calls: unknown[] = [];
    await expect(evalDatabaseSeed({ docker: docker().fake, side: "old", prepared: rollback })(started([pg]), {} as never, new AbortController().signal, async c => { calls.push(c); return { exitCode: 0, timedOut: false }; })).rejects.toThrow(EVAL_SERVICES_FAILURE_SENTENCE);
    expect(calls).toEqual([]);
  });

  it("a seed that does not load, or a stop, ends the start with the fixed sentence and never repeats Docker's words", async () => {
    const prepared = await prepare(await repo(), [plan()]);
    const failing = docker({ fail: true });
    const error = await evalDatabaseSeed({ docker: failing.fake, side: "new", prepared })(started([pg]), {} as never, new AbortController().signal).then(() => undefined, (e: unknown) => e as Error);
    expect(error?.message).toBe(EVAL_SERVICES_FAILURE_SENTENCE);
    expect(JSON.stringify(error)).not.toContain("hunter2");
    const stopped = new AbortController(); stopped.abort();
    const stop = await evalDatabaseSeed({ docker: docker().fake, side: "old", prepared })(started([pg]), {} as never, stopped.signal).then(() => undefined, (e: unknown) => e as Error);
    expect(stop?.message).toBe(EVAL_SERVICES_FAILURE_SENTENCE);
  });

  it("a postgres service with no seed file still gets the schema read and generated rows (never an empty database by omission)", async () => {
    const d = docker();
    await evalDatabaseSeed({ docker: d.fake, side: "old", prepared: { seeds: new Map() } })(started([pg]), {} as never, new AbortController().signal);
    expect(d.loads).toEqual([]);
    expect(d.reads.length).toBeGreaterThan(0);
  });
});


it("runs command seeds for local engines without a Postgres file loader", async () => {
  const command = { cwd: ".", executable: "node", args: ["seed-cache.js"], timeoutSeconds: 30 };
  const prepared = await prepare(await repo(), [plan({ id: "cache", family: "redis", seeds: [{ command }] })]);
  const calls: unknown[] = [];
  await evalDatabaseSeed({ docker: { run: async () => { throw new Error("no SQL for Redis"); } }, side: "new", prepared })({ hosts: [], env: [], secrets: [], started: [], targets: [{ id: "cache", container: "rovara-cache", family: "redis", user: undefined, database: undefined }], unsupported: [] }, {} as never, new AbortController().signal, async c => { calls.push(c); return { exitCode: 0, timedOut: false }; });
  expect(calls).toEqual([command]);
});
