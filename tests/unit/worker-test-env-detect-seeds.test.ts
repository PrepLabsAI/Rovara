// TS-UX-1 (0.5.10): a seed or migration command needs a database that exists only inside the test environment, so the draft OFFERS it as the database dependency's seed (carried in the draft, attached by the broker).
// The worker never takes a command out of setup: whether a database is proposed, and whether the seed is kept (services off drops it), is the broker's to know. Only when a database was found is anything offered at all.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestEnvDraftSchema, formatCommandLine, type SetupProposal } from "@agentx/contracts";
import { detectTestEnvironment } from "../../packages/worker/src/test-env-detect.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "te-detect-seeds-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function write(path: string, text: string) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); }
const repo = { name: "svc", path: "svc", defaultBranch: "main" };
const proposal = (setup: string[]) => ({
  basedOnRevision: 3, notes: "",
  setup: setup.length === 0 ? [] : [{ id: "setup-svc", value: { repo: "svc", commands: setup }, from: [], confidence: "high", risk: "safe" }],
  tests: [], flaggedCommands: [],
}) as unknown as SetupProposal;
const DB_CODE = "export const url = process.env.DATABASE_URL;\n";
const setupLines = (draft: Awaited<ReturnType<typeof detectTestEnvironment>>) => draft!.environment.repos[0]!.setupCommands.map(formatCommandLine);

describe("seed commands are offered to the database, and setup keeps every command it had", () => {
  it("offers nothing when no database was found (positive control: the same command is offered once a database is)", async () => {
    await write("svc/package.json", JSON.stringify({ scripts: { test: "vitest run", seed: "node seed.js" } }));
    const draft = await detectTestEnvironment({ rootPath: root, repositories: [repo], setupProposal: proposal(["npm run seed"]) });
    expect(setupLines(draft)).toContain("npm run seed");
    expect(draft!.seedCommands).toBeUndefined();
    await write("svc/src/db.ts", DB_CODE);
    const routed = await detectTestEnvironment({ rootPath: root, repositories: [repo], setupProposal: proposal(["npm run seed"]) });
    expect(routed!.seedCommands!.map((seed) => formatCommandLine(seed.command))).toContain("npm run seed");
    expect(setupLines(routed)).toContain("npm run seed");
  });
});

// TS-UX-1 item 7: a setup command whose program reads a database setting needs the database, whatever its words (tx-escape's `npm run plant` runs `node tools/plant.js`, which reads process.env.DATABASE_URL).
describe("a command that runs code reading a database setting is routed like a seed", () => {
  const TX = JSON.stringify({ scripts: { test: "node --test", plant: "node tools/plant.js", build: "node tools/build.js" } });
  it("routes the agent's `npm run plant` as a seed, kept as the agent's (source model), never as detected", async () => {
    await write("svc/package.json", TX);
    await write("svc/tools/plant.js", "const url = process.env.DATABASE_URL;\nmodule.exports = url;\n");
    await write("svc/tools/build.js", "console.log('no database here');\n");
    const draft = await detectTestEnvironment({ rootPath: root, repositories: [repo], setupProposal: proposal(["npm run plant", "npm run build"]) });
    expect(draft!.dependencies!.map((item) => item.family)).toEqual(["postgres"]);
    expect(draft!.seedCommands!.map((seed) => [formatCommandLine(seed.command), seed.source])).toEqual([["npm run plant", "model"]]);
    // The build script reads no database setting: it stays a setup command only (positive control: the same shape, a different file).
    expect(setupLines(draft)).toContain("npm run build");
  });
});

describe("runsScriptOf", () => {
  it("reads the runners' own forms", async () => {
    const { runsScriptOf } = await import("../../packages/worker/src/env-detect/propose.js");
    const names = new Set(["plant"]);
    const cmd = (executable: string, args: string[]) => ({ executable, args });
    expect([cmd("npm", ["run", "plant"]), cmd("npm", ["run-script", "plant"]), cmd("yarn", ["plant"]), cmd("pnpm", ["run", "plant"]), cmd("bun", ["run", "plant"])].every((item) => runsScriptOf(item, names))).toBe(true);
    expect([cmd("npm", ["plant"]), cmd("bun", ["plant"]), cmd("node", ["plant"]), cmd("npm", ["run", "plants"])].some((item) => runsScriptOf(item, names))).toBe(false);
  });
});

// TS-UX-1 item 9: a SQL seed file is offered in the draft, workspace-relative, only when a database was found.
describe("seed files in the draft", () => {
  it("carries the repository's SQL seed files as workspace paths when a database is found, and none without one", async () => {
    await write("svc/package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    await write("svc/db/seeds/users.sql", "insert into users values (1);\n");
    const without = await detectTestEnvironment({ rootPath: root, repositories: [repo] });
    expect(without!.seedFiles).toBeUndefined();
    await write("svc/src/db.ts", DB_CODE);
    const draft = await detectTestEnvironment({ rootPath: root, repositories: [repo] });
    expect(TestEnvDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft!.seedFiles).toEqual([{ path: "svc/db/seeds/users.sql", source: { path: "db/seeds/users.sql", line: 1 } }]);
  });
});
