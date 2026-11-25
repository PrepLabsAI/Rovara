import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { evalDatabaseSeed, prepareEvalStandIns } from "../../packages/worker/src/eval-stand-in-plan.js";
import { STAND_IN_SCHEMA_STATEMENT } from "../../packages/worker/src/service-seed-generate.js";
import type { EvalServicesStarted } from "../../packages/worker/src/verification/eval-services.js";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const schema = { tables: [{ name: "users", hasRows: true, primaryKey: ["id"], uniques: [], foreignKeys: [], columns: [{ name: "id", type: "integer", nullable: false, identity: "", generated: false, enumValues: [] }] }] };
const target = { id: "db", container: "rovara-db", family: "postgres", user: "app", database: "app" };
const started: Omit<EvalServicesStarted, "stop"> = { targets: [target], hosts: [], env: [], secrets: [], started: [], unsupported: [] };
const planLog = (value: number, rows = 0) => {
  const scan = { "Node Type": "Index Scan", Schema: "public", "Relation Name": "users", Alias: "u", "Actual Rows": rows, "Actual Loops": 1, "Index Cond": `(u.id = ${value})` };
  return `LOG:  duration: 0.04 ms  plan:\n${JSON.stringify({ "Query Text": `SELECT * FROM users u WHERE u.id = ${value} LIMIT 1`, Plan: { "Node Type": "Limit", "Actual Rows": rows, "Actual Loops": 1, Plans: [scan] } }, null, 2)}\n`;
};
async function world() {
  const root = await mkdtemp(join(tmpdir(), "eint-observer-")); roots.push(root);
  const prepared = await prepareEvalStandIns({ descriptor: undefined, dependencies: [{ ...target, backing: "local", seeds: [] }] as never, repositoryDirectory: root, baseCommit: "a".repeat(40), scratchDir: root, workspaceId: "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11", operationId: "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50", signal: signal(), materialize: async (_r, _s, dest) => { await mkdir(dest, { recursive: true }); } });
  const loads: string[] = []; const controls: string[][] = []; let logs = ""; let failed = false; let missing = false;
  const docker: DockerCli = {
    run: async args => { controls.push([...args]); return { exitCode: failed ? 1 : 0, stdout: "", stderr: args[0] === "logs" ? logs : "" }; },
    execBytes: async (args, opts) => { if (opts.stdin !== undefined) loads.push(opts.stdin.toString()); return { exitCode: 0, stdout: Buffer.from(args.includes(STAND_IN_SCHEMA_STATEMENT) ? JSON.stringify(schema) : args.some(a => a.startsWith("SELECT EXISTS")) ? (missing ? "f" : "t") : "{}"), stderr: "" }; },
  };
  const seed = async (side: "old" | "new") => evalDatabaseSeed({ docker, side, prepared })(started, {} as never, signal());
  return { prepared, loads, controls, seed, logs: (text: string) => { logs = text; }, fail: () => { failed = true; }, missing: () => { missing = true; } };
}

it("records actual zero-row lookups, queues one fill for BOTH sides, and replays it into fresh re-ask databases", async () => {
  const w = await world();
  const old = await w.seed("old"); w.logs(planLog(777) + planLog(42, 1)); await old!.observe(["q1"], signal());
  const newer = await w.seed("new"); w.logs(planLog(777) + planLog(888)); await newer!.observe(["q1"], signal());
  expect(await w.prepared.databases!.fillMissingRows({ ids: ["q1"] })).toEqual(["q1"]);
  await w.seed("old"); await w.seed("new");
  expect(w.loads).toHaveLength(2);
  expect(w.loads[0]).toBe(w.loads[1]);
  expect(w.loads[0]).toContain("777"); expect(w.loads[0]).not.toContain("888"); expect(w.loads[0]).not.toContain("42");
  expect(await w.prepared.databases!.fillMissingRows({ ids: ["q1"] })).toEqual([]);
  expect(w.controls.some(args => args.join(" ").includes("auto_explain"))).toBe(true);
  // Re-ask observations cannot create another pass, and a failed SQL block cannot silently compare.
  w.logs(planLog(999)); await newer!.observe(["q1"], signal());
  expect(await w.prepared.databases!.fillMissingRows({ ids: ["q1"] })).toEqual([]);
  w.missing(); await expect(w.seed("new")).rejects.toThrow("Rovara could not start the test services for this eval");
});

it("ignores a malformed plan, a nonzero result, or a failed observer", async () => {
  for (const mode of ["bad", "nonzero", "failed"] as const) {
    const w = await world(); const old = await w.seed("old"); const newer = await w.seed("new");
    w.logs(mode === "bad" ? 'LOG: plan:\n{"broken":' : planLog(999, mode === "nonzero" ? 1 : 0));
    if (mode === "failed") w.fail();
    const ids = ["q1"];
    await old!.observe(ids, signal()); await newer!.observe(ids, signal());
    expect(await w.prepared.databases!.fillMissingRows({ ids })).toEqual([]);
    expect(w.loads).toEqual([]);
  }
});

