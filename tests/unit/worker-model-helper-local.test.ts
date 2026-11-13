// TE-F2 part B: the LAPTOP path. A loopback helper child, started for the check round, reached by the same base-URL variables; no container and no block, so the evidence says exactly "model hosts not blocked on this machine".
// The user's shell may hold REAL model keys: they are overridden with the dummy in the commands' environment and never reach the child. Everything is offline: the real child listens on 127.0.0.1 only.
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { builtinModelCatalog, modelHostBlockList } from "../../packages/contracts/src/index.js";
import { createCheckRunners } from "../../packages/worker/src/verification/checks.js";
import { MODEL_DUMMY_KEY, laptopModelEnvironment, modelFailureBaseUrl, modelKeyVariables, modelRowBaseUrl } from "../../packages/worker/src/model-helper-env.js";
import { LOCAL_HELPER_CHILD_ENVIRONMENT, localModelHelperPlan, type SpawnSeam } from "../../packages/worker/src/model-helper-local.js";
import { withModelHelperRound, type ModelHelperRoundResult } from "../../packages/worker/src/model-helper-round.js";
import { createRepoReplySetSource } from "../../packages/worker/src/model-reply-set-load.js";

const CATALOG = builtinModelCatalog().rows;
const BLOCK = modelHostBlockList(CATALOG, []);
const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../../packages/worker/dist/model-helper.js");
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "rsml-"));
  dirs.push(dir);
  return dir;
};
const setEnv = (name: string, value: string): void => {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
};
/** A real-looking key, built at run time (the public repo refuses key-shaped literals). */
const realLookingKey = (): string => ["sk", "proj", "A1b2C3d4E5f6G7h8", String(Date.now()), "Zq9Xw8Vu7Ts6"].join("-");

describe("the variables", () => {
  it("point the row's client at the helper, add the companions, and override EVERY key variable with the dummy; Vertex gets the metadata server and an emptied key-file path", () => {
    const gemini = laptopModelEnvironment({ rows: CATALOG, rowIds: ["gemini", "vertex"], baseUrl: "http://127.0.0.1:5555", metadataHostPort: "127.0.0.1:5556", projectId: "rovara-test-project" });
    expect(gemini.ok).toBe(true);
    const env = gemini.ok ? gemini.environment : {};
    expect(env).toMatchObject({
      GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:5555/p/gemini", GOOGLE_VERTEX_BASE_URL: "http://127.0.0.1:5555/p/vertex", GCE_METADATA_HOST: "127.0.0.1:5556", GCE_METADATA_IP: "127.0.0.1:5556",
      GOOGLE_CLOUD_PROJECT: "rovara-test-project", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: "",
    });
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CO_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY"]) expect(env[name], name).toBe(MODEL_DUMMY_KEY);
    expect(modelKeyVariables(CATALOG)).toEqual(expect.arrayContaining(["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]));
  });
  it("the OpenAI-compatible row's URL carries /v1, a row with its own prefix keeps it, and two rows that want one variable with different values are a conflict", () => {
    const openai = CATALOG.find((row) => row.id === "openai") as (typeof CATALOG)[number];
    const viaGoogle = CATALOG.find((row) => row.id === "gemini-openai") as (typeof CATALOG)[number];
    expect(modelRowBaseUrl(openai, "http://h:1/")).toBe("http://h:1/p/openai/v1");
    expect(modelRowBaseUrl(viaGoogle, "http://h:1")).toBe("http://h:1/p/gemini-openai/v1beta/openai");
    expect(laptopModelEnvironment({ rows: CATALOG, rowIds: ["openai", "gemini-openai"], baseUrl: "http://h:1" })).toEqual({ ok: false, reason: "conflict" });
    expect(laptopModelEnvironment({ rows: CATALOG, rowIds: ["nope"], baseUrl: "http://h:1" })).toEqual({ ok: false, reason: "unknown_row" });
  });
  it("the failure base URL is a pure function of the row, the mode and afterCalls", () => {
    const openai = CATALOG.find((row) => row.id === "openai") as (typeof CATALOG)[number];
    expect(modelFailureBaseUrl(openai, "http://h:1", { mode: "rate_limit", afterCalls: 2 })).toBe("http://h:1/p/openai/f/rate_limit/n/2/v1");
    expect(modelFailureBaseUrl(openai, "http://h:1", { mode: "token_limit", variant: "input" })).toBe("http://h:1/p/openai/f/token_limit.input/v1");
  });
});

function repo(): { root: string; source: ReturnType<typeof createRepoReplySetSource> } {
  const root = tmp();
  const env = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" };
  const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8" }).trim();
  git("init", "--quiet");
  mkdirSync(join(root, ".rovara/mocks/model"), { recursive: true });
  writeFileSync(join(root, ".rovara/mocks/model/openai_compatible.json"), JSON.stringify({ version: 1, family: "openai_compatible", replies: [{ id: "chat", match: {}, response: { text: "Hello from the laptop script.", finish: "stop" } }] }));
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  return { root, source: createRepoReplySetSource({ repositoryRoot: root, baseCommit: git("rev-parse", "HEAD"), workingRoot: root, scratchRoot: tmp() }) };
}

describe("the loopback child", () => {
  it("is built before the tests run (the dist of this package)", () => {
    expect(existsSync(ENTRY), "run `tsc -b` first: the laptop child is dist/model-helper.js").toBe(true);
  });
  it("never receives a real key from the user's shell: its whole environment is fixed", async () => {
    const key = realLookingKey();
    for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]) setEnv(name, key);
    setEnv("NODE_OPTIONS", "--require /nonexistent");
    const { source } = repo();
    let childEnv: NodeJS.ProcessEnv | undefined;
    const seam: SpawnSeam = (command, args, options) => {
      childEnv = options.env;
      return spawn(command, args as string[], options);
    };
    const plan = localModelHelperPlan({ catalogRows: CATALOG, rowIds: ["openai"], source, blockList: BLOCK, entry: ENTRY, spawn: seam, scratchRoot: tmp() });
    const started = await plan.start(new AbortController().signal);
    try {
      expect(childEnv).toEqual({ ...LOCAL_HELPER_CHILD_ENVIRONMENT });
      expect(JSON.stringify(childEnv)).not.toContain(key);
      expect(started?.commandEnvironment.OPENAI_API_KEY).toBe(MODEL_DUMMY_KEY);
      expect(JSON.stringify(started?.commandEnvironment)).not.toContain(key);
    } finally {
      await started?.stop();
    }
  });
  it("a real round: the project's command reaches the helper through its redirect with the DUMMY key, gets the scripted reply, and the evidence says 'model hosts not blocked on this machine'", async () => {
    const key = realLookingKey();
    setEnv("OPENAI_API_KEY", key);
    setEnv("GEMINI_API_KEY", key);
    setEnv("AGENTX_TASK_SHELL", "local");
    const { root, source } = repo();
    const results: ModelHelperRoundResult[] = [];
    const plan = localModelHelperPlan({ catalogRows: CATALOG, rowIds: ["openai"], source, blockList: BLOCK, entry: ENTRY, scratchRoot: tmp(), onResult: (result) => results.push(result) });
    const runners = withModelHelperRound(plan, createCheckRunners({ rootPath: root, local: true }));
    const script = `
      const http = require("node:http");
      const url = new URL(process.env.OPENAI_BASE_URL + "/chat/completions");
      const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
      const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.OPENAI_API_KEY } }, (res) => {
        let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => console.log(JSON.stringify({ status: res.statusCode, key: process.env.OPENAI_API_KEY, gemini: process.env.GEMINI_API_KEY, creds: process.env.GOOGLE_APPLICATION_CREDENTIALS, text })));
      });
      req.end(body);`;
    const result = await runners.runProjectCommand({ cwd: ".", executable: process.execPath, args: ["-e", script], timeoutSeconds: 30 }, new AbortController().signal);
    await runners.endRound?.();
    expect(result.exitCode, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as { status: number; key: string; gemini: string; creds: string; text: string };
    expect(out.status).toBe(200);
    expect(out.key).toBe(MODEL_DUMMY_KEY);
    expect(out.gemini).toBe(MODEL_DUMMY_KEY);
    expect(out.creds).toBe("");
    expect(out.text).toContain("Hello from the laptop script.");
    expect(result.stdout).not.toContain(key);
    expect(results).toHaveLength(1);
    const evidence = results[0]?.evidence;
    expect(evidence?.lines[0]).toBe("model hosts not blocked on this machine");
    expect(evidence).toMatchObject({ result: "ran", countsTowardProof: 1 });
    expect(results[0]?.summary).toMatchObject({ blockState: "not_blocked_here", scripted: { before_task: 1, task_made: 0 } });
    // the helper child and its files are gone after the round
    expect(results[0]?.summary?.trusted).toBe(true);
  }, 60_000);
  it("a project with no reply set starts no helper and its commands run unchanged", async () => {
    const root = tmp();
    const source = createRepoReplySetSource({ repositoryRoot: root, baseCommit: "1".repeat(40), workingRoot: root, scratchRoot: tmp() });
    let started = false;
    const plan = localModelHelperPlan({ catalogRows: CATALOG, rowIds: ["openai"], source, blockList: BLOCK, entry: ENTRY, spawn: (...args) => { started = true; return spawn(args[0], args[1] as string[], args[2]); }, scratchRoot: tmp() });
    expect(await plan.start(new AbortController().signal)).toBeUndefined();
    expect(started).toBe(false);
  });
});
