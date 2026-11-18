// L4-VX: the test world for the "AI builder" stand-in (tests/fixtures/ai-builder-sample): a real git repository of a small Gemini-on-Vertex agent, a real child process that runs
// the project's own eval command, and a fake Vertex endpoint, all offline. Rovara's own pieces are the real ones: the plan, the metered stage, the bridge-shaped egress, the baseline
// measurement, the question-level comparison, the changed-prompt classifier. Only the model (a local stub), the money (a scripted meter) and the sandbox (a plain child process in a
// checkout) are stand-ins.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attestRovaraOnlyBaseCheckout, evalBaseCacheKey, evalCommandFingerprintOf, evalJudgePinOf, evalQuestionHash, evalSetHashOf, evalSpendInputsDigest,
  routeEgressRequest, type BaseScoreCache, type EvalBaseRecord, type EvalSpendGrant, type ModelEgressFrame, type ModelEgressRow,
} from "@agentx/contracts";
import { fixtureEgressRows } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { createEvalBaselines } from "../../packages/worker/src/verification/eval-baseline-refresh.js";
import { candidatePromptChanges, changedPromptClassifier } from "../../packages/worker/src/verification/eval-changed-prompt.js";
import type { EvalFinalCheckPlan, EvalFinalCheckPorts } from "../../packages/worker/src/verification/eval-final-check.js";
import { createEvalMeter } from "../../packages/worker/src/verification/eval-model-access.js";
import { evalSettingsFingerprint } from "../../packages/worker/src/verification/eval-round.js";
import { EvalSandboxRunFailure, diagnoseEvalFailure } from "../../packages/worker/src/verification/eval-run-diagnostic.js";
import { createEvalRunner, type EvalSandboxExec, type EvalSandboxRequest } from "../../packages/worker/src/verification/eval-runner.js";
import { answer, classAnswer, scriptedAccess } from "./eval-model-access.js";

export const STAND_IN_DIR = fileURLToPath(new URL("../fixtures/ai-builder-sample/", import.meta.url));
export const EVAL_COMMAND = { executable: "python3", args: ["evals/run.py", "--out", "rovara-measures.json"], cwd: "." } as const;
export const EVAL_REPORT = { cwd: ".", argument: "rovara-measures.json" } as const;
export const SCORING_PATH = "evals/support/scoring.py";
export const CASES_DIR = "evals/support/cases";
/** What one model call costs the stage: a made-up, fixed amount (the real price comes from the provider's usage). */
export const CALL_COST_MICROS = 20;

const PYTHON = "python3";
export const pythonAvailable = (): boolean => spawnSync(PYTHON, ["--version"], { encoding: "utf8" }).status === 0;
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
/** A clean environment for the project's own commands: no secrets, no bytecode written, no home directory writes. */
const cleanEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ PATH: process.env["PATH"] ?? "", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0", HOME: tmpdir(), ...extra });

/**
 * L4-EVS: the stand-in's "saved environment": a folder that holds the project's one third-party package (PyYAML, `requirements.txt`) the way an installed environment does. Offline there is no PyPI, so it holds a
 * tiny stand-in module with the same name and the one function the eval command uses (`safe_load` of flat `key: value` lines). The eval command is run with `python3 -S` (no site-packages of the machine at all, as in
 * the sealed worker image, which has python3 and pip and nothing else) and `PYTHONPATH` set to this folder for a world that has the saved environment, so the result never depends on what this Mac has installed.
 */
const YAML_STAND_IN = [
  "def safe_load(text):",
  "    out = {}",
  "    for line in text.splitlines():",
  "        line = line.split('#', 1)[0].strip()",
  "        if not line or ':' not in line:",
  "            continue",
  "        key, value = line.split(':', 1)",
  "        value = value.strip()",
  "        try:",
  "            out[key.strip()] = float(value) if '.' in value else int(value)",
  "        except ValueError:",
  "            out[key.strip()] = value",
  "    return out",
  "",
].join("\n");
export function createSavedEnvironment(): { readonly path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), "vx-saved-env-"));
  writeFileSync(join(path, "yaml.py"), YAML_STAND_IN);
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
let sharedSavedEnvironment: ReturnType<typeof createSavedEnvironment> | undefined;
/** One per process, for the commands the tests run directly (the team's gate, a plain eval run); removed when the process ends. */
export function savedEnvironmentPath(): string {
  if (sharedSavedEnvironment === undefined) { sharedSavedEnvironment = createSavedEnvironment(); process.once("exit", () => sharedSavedEnvironment?.remove()); }
  return sharedSavedEnvironment.path;
}
/** The eval command's own interpreter flags: no site-packages of the machine. */
export const EVAL_PYTHON_FLAGS = ["-S"] as const;
/** Run the project's eval command (`python3 -S evals/run.py ...`) in a checkout, with or without the saved environment. */
export function evalRun(dir: string, args: string[], env: Record<string, string> = {}, saved = true): Run {
  return runProject(dir, PYTHON, [...EVAL_PYTHON_FLAGS, ...args], { ...(saved ? { PYTHONPATH: savedEnvironmentPath() } : {}), ...env });
}

export interface StandInRepo {
  readonly root: string;
  readonly dir: string;
  readonly baseSha: string;
  /** Commit one of the sample's change patches (or nothing, for a candidate equal to the base) on a new branch and return its identity. */
  candidate(patch: string | undefined, branch: string): { commitSha: string; treeSha: string };
}
export async function createStandInRepo(): Promise<StandInRepo> {
  const root = await mkdtemp(join(tmpdir(), "vx-standin-"));
  const dir = join(root, "repo");
  await cp(STAND_IN_DIR, dir, { recursive: true, filter: source => !source.includes("__pycache__") });
  git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "Deskbot sample");
  const baseSha = git(dir, "rev-parse", "HEAD");
  return {
    root, dir, baseSha,
    candidate(patch, branch) {
      git(dir, "checkout", "-q", "-B", branch, baseSha);
      if (patch !== undefined) git(dir, "apply", join(STAND_IN_DIR, "changes", patch));
      git(dir, "add", "-A"); git(dir, "commit", "-qm", patch ?? "No change", "--allow-empty");
      const commitSha = git(dir, "rev-parse", "HEAD");
      return { commitSha, treeSha: git(dir, "rev-parse", "HEAD^{tree}") };
    },
  };
}

/** One commit's files as a plain folder (what a fresh check sandbox mounts). */
export async function checkout(repo: StandInRepo, sha: string, name: string): Promise<string> {
  const target = join(repo.root, name);
  await mkdir(target, { recursive: true });
  const result = spawnSync("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", repo.dir, sha, target], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("checkout failed");
  return target;
}

export interface Run { status: number | null; stdout: string; stderr: string }
/** Run a command of the project (its own CI-like command, its unit tests, its eval gate) in a checkout, offline. */
export function runProject(dir: string, command: string, args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(command, args, { cwd: dir, env: cleanEnv(env), encoding: "utf8", timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
export const unitTests = (dir: string): Run => runProject(dir, PYTHON, ["-m", "unittest", "discover", "-s", "tests", "-t", "."]);
export const teamGate = (dir: string, saved = true): Run => evalRun(dir, ["evals/run.py", "--gate"], { DESKBOT_FAKE_VERTEX: "1" }, saved);

/** The fake Vertex endpoint, started from the sample's own `fake_vertex/server.py` as a child process on a free port. */
export interface FakeVertex { readonly endpoint: string; readonly requests: () => Promise<number>; stop(): Promise<void> }
export async function startFakeVertex(dir: string): Promise<FakeVertex> {
  const child: ChildProcess = spawn(PYTHON, ["fake_vertex/server.py", "--port", "0"], { cwd: dir, env: cleanEnv({}), stdio: ["ignore", "pipe", "ignore"] });
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the fake Vertex did not start")), 15_000);
    let seen = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      const match = /listening ([\d.]+):(\d+)/u.exec(seen);
      if (match !== null) { clearTimeout(timer); resolve(`http://${match[1]}:${match[2]}`); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("the fake Vertex stopped")); });
  });
  return {
    endpoint,
    requests: async () => ((await (await fetch(`${endpoint}/healthz`)).json()) as { requests: number }).requests,
    stop: async () => { if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise<void>(resolve => child.once("exit", () => resolve())); } },
  };
}

/** What Rovara's plan holds about the sample's eval: questions from the cases folder of the base and of the candidate, hashed the way the broker hashes them. */
export async function questionPlan(baseDir: string, candidateDir: string): Promise<EvalFinalCheckPlan["questions"]> {
  const files = (await readdir(join(baseDir, CASES_DIR))).filter(name => name.endsWith(".json")).sort();
  return Promise.all(files.map(async name => {
    const base = await readFile(join(baseDir, CASES_DIR, name));
    const head = await readFile(join(candidateDir, CASES_DIR, name)).catch(() => undefined);
    const parsed = JSON.parse(base.toString("utf8")) as { id: string; category: "ordinary" | "safety" | "refusal" };
    return { id: parsed.id, category: parsed.category, baseHash: evalQuestionHash(base), headHash: head === undefined ? evalQuestionHash(new Uint8Array()) : evalQuestionHash(head) };
  }));
}
export async function evalSetHash(dir: string): Promise<string> {
  const names = (await readdir(join(dir, CASES_DIR))).filter(name => name.endsWith(".json")).sort();
  return evalSetHashOf(await Promise.all(names.map(async name => ({ path: `${CASES_DIR}/${name}`, bytes: await readFile(join(dir, CASES_DIR, name)) }))));
}

/** A base-score cache that lives in memory: what the document store holds in production. */
export function memoryBaseCache(): BaseScoreCache & { readonly records: Map<string, EvalBaseRecord> } {
  const records = new Map<string, EvalBaseRecord>();
  return {
    records,
    read: async parts => records.get(evalBaseCacheKey(parts)),
    readMeasurement: async () => "idle",
    startMeasurement: async () => ({ status: "started", mark: { claimId: "00000000-0000-4000-8000-000000000000", startedAt: Date.now(), expiresAt: Date.now() + 60_000, state: "measuring" } }),
    finishMeasurement: async () => undefined,
    write: async (parts, record) => { records.set(evalBaseCacheKey(parts), record); return "stored"; },
  };
}

export type Transport = "gemini" | "vertex";
export interface StandInWorldOptions {
  /** Which client shape the eval command is pointed at. The sandbox Rovara builds sets only the Gemini one. Default "gemini". */
  transport?: Transport;
  /** The sample's change patch for the candidate (a file under changes/), or undefined for no change. */
  patch?: string | undefined;
  /** Whether the eval runs in the project's saved environment (its PyYAML installed) or in the bare sandbox (nothing but the standard library). Default "saved". */
  environment?: "saved" | "bare";
  /** Refuse every model call with this class, as the stage's gateway would. */
  providerClass?: "rate_limit" | "provider_error" | undefined;
}
export interface StandInWorld {
  readonly repo: StandInRepo;
  readonly baseDir: string;
  readonly candidateDir: string;
  readonly candidate: { commitSha: string; treeSha: string };
  readonly ports: EvalFinalCheckPorts;
  readonly plan: EvalFinalCheckPlan;
  readonly grant: EvalSpendGrant;
  readonly cache: ReturnType<typeof memoryBaseCache>;
  /** Every frame the eval's model calls produced, with what the real route check said about it. */
  readonly frames: Array<{ side: "old" | "new"; row: string; path: string; routed: boolean; refusal?: string | undefined }>;
  readonly sides: Array<{ side: "old" | "new"; runs: number; ids: readonly string[]; exitCode: number | null }>;
  /** The saved environment this world's eval runs with (undefined for a bare world). */
  readonly savedEnvironment: string | undefined;
  readonly fake: FakeVertex;
  cleanup(): Promise<void>;
}

const rows = fixtureEgressRows();
const readBody = (request: IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk)); request.on("end", () => resolve(Buffer.concat(chunks))); request.on("error", reject);
});

export async function createStandInWorld(options: StandInWorldOptions = {}): Promise<StandInWorld> {
  const repo = await createStandInRepo();
  let fake: FakeVertex | undefined;
  const removers: Array<() => void> = [];
  try { return await buildWorld(options, repo, started => { fake = started; }, remove => { removers.push(remove); }); }
  catch (error) { await fake?.stop(); removers.forEach(remove => remove()); await rm(repo.root, { recursive: true, force: true }); throw error; }
}

async function buildWorld(options: StandInWorldOptions, repo: StandInRepo, onFake: (fake: FakeVertex) => void, onCleanup: (remove: () => void) => void): Promise<StandInWorld> {
  const transport = options.transport ?? "gemini";
  const saved = options.environment === "bare" ? undefined : createSavedEnvironment();
  onCleanup(() => saved?.remove());
  const candidate = repo.candidate(options.patch, "candidate");
  const baseDir = await checkout(repo, repo.baseSha, "base");
  const candidateDir = await checkout(repo, candidate.commitSha, "candidate");
  const fake = await startFakeVertex(baseDir);
  onFake(fake);
  const frames: StandInWorld["frames"] = [];
  const current = { side: "old" as "old" | "new" };
  const sides: StandInWorld["sides"] = [];
  // The real classifier for "did this call exercise the changed prompt", over the real git objects.
  const repositories = [{ repositoryId: "app", directory: repo.dir, baseCommitSha: repo.baseSha }];
  const identities = [{ repositoryId: "app", commitSha: candidate.commitSha, treeSha: candidate.treeSha, baseCommitSha: repo.baseSha }];
  const isChanged = changedPromptClassifier(await candidatePromptChanges(repositories, identities, new AbortController().signal, repo.baseSha));

  // The model route: the egress the metered stage forwards to. It applies the REAL route check to every frame (the row's path allow-list), then answers from the fake Vertex.
  const access = scriptedAccess(async function* (frame) {
    const row: ModelEgressRow | undefined = (rows as Record<string, ModelEgressRow>)[frame.row];
    const routed = row === undefined ? { ok: false as const, refusal: "not_allowed" } : routeEgressRequest(row, {}, frame);
    frames.push({ side: current.side, row: frame.row, path: frame.path, routed: routed.ok, ...(routed.ok ? {} : { refusal: routed.refusal }) });
    if (options.providerClass !== undefined) { yield* classAnswer(options.providerClass, options.providerClass === "rate_limit" ? 429 : 500); return; }
    if (!routed.ok) { yield* classAnswer("refused", 403); return; }
    const response = await fetch(`${fake.endpoint}${frame.path}`, { method: "POST", headers: Object.fromEntries(frame.headers.filter(([name]) => ["content-type", "x-goog-api-key", "authorization"].includes(name.toLowerCase()))), body: Buffer.from(frame.body) });
    const text = await response.text();
    yield* answer({ status: response.status, class: response.status === 200 ? "ok" : "provider_error", costMicros: CALL_COST_MICROS }, text);
  });

  const exec: EvalSandboxExec = {
    async run(request: EvalSandboxRequest) {
      current.side = request.side;
      const dir = request.side === "old" ? baseDir : candidateDir;
      let changedPromptCalls = 0;
      // A tiny model bridge: what the sandbox's model client reaches (`/p/<row>/x/<token>/...`). Every call goes through the stage's egress.
      const server: Server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
        void (async () => {
          const match = /^\/p\/([a-z][a-z0-9-]*)\/x\/[A-Za-z0-9]+(\/[^?]*)(?:\?(.*))?$/u.exec(incoming.url ?? "");
          if (match === null || incoming.method !== "POST") { outgoing.writeHead(404).end(); return; }
          const headers: Array<[string, string]> = Object.entries(incoming.headers).flatMap(([name, value]) => (typeof value === "string" ? [[name, value] as [string, string]] : []));
          const frame: ModelEgressFrame = { row: match[1]!, method: "POST", path: match[2]!, query: match[3] ?? "", headers, body: new Uint8Array(await readBody(incoming)) };
          let ok = false;
          for await (const event of request.egress.forward(request.scope, frame, { signal: request.signal })) {
            if (event.kind === "head") outgoing.writeHead(event.status, Object.fromEntries(event.headers));
            else if (event.kind === "chunk") outgoing.write(event.bytes);
            else ok = event.class === "ok";
          }
          outgoing.end();
          if (ok && request.side === "new" && isChanged(frame)) changedPromptCalls++;
        })().catch(() => { try { outgoing.destroy(); } catch { /* gone */ } });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}/p/gemini/x/runtoken`;
      // The variables Rovara's fresh check sandbox sets (freshEvalEnvironment): the Gemini client's base URL and placeholder keys, side, runs, ids. Nothing for Vertex.
      const env = cleanEnv({
        ROVARA_EVAL_SIDE: request.side, ROVARA_EVAL_RUNS: String(request.runs), ROVARA_EVAL_IDS: request.ids.join(","),
        ...(saved === undefined ? {} : { PYTHONPATH: saved.path }),
        ...(transport === "gemini" ? { GOOGLE_GEMINI_BASE_URL: base, GEMINI_API_KEY: "rovara-test-key", GOOGLE_API_KEY: "rovara-test-key" } : { VERTEX_API_ENDPOINT: base }),
      });
      const notBeforeMs = Date.now() - 1000;
      let stderrTail = "";
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          // The bare sandbox shape: `-S` (no site-packages of this machine), stderr kept (its last 16 KB) the way the sandbox's capped log is, never shown raw.
          const child = spawn(EVAL_COMMAND.executable, [...EVAL_PYTHON_FLAGS, ...EVAL_COMMAND.args], { cwd: join(dir, EVAL_COMMAND.cwd), env, stdio: ["ignore", "ignore", "pipe"] });
          child.stderr.on("data", (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString("utf8")).slice(-16_384); });
          const stop = () => child.kill("SIGKILL");
          request.signal.addEventListener("abort", stop, { once: true });
          child.once("error", reject); child.once("exit", code => { request.signal.removeEventListener("abort", stop); resolve(code); });
        });
        sides.push({ side: request.side, runs: request.runs, ids: request.ids, exitCode });
        // What the real sandbox does: a command that failed and left no report is a failed run with a named, redacted cause (the diagnostic), never a half result.
        if (exitCode !== 0 && !existsSync(join(dir, EVAL_REPORT.cwd, EVAL_REPORT.argument))) throw new EvalSandboxRunFailure(diagnoseEvalFailure({ phase: "run", exitCode: exitCode ?? undefined, output: stderrTail, secrets: ["runtoken", "rovara-test-key"] }));
      } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
      return {
        report: { root: dir, cwd: EVAL_REPORT.cwd, argument: EVAL_REPORT.argument, notBeforeMs },
        changedPromptCalls,
        ...(request.side === "old" ? { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: repo.baseSha }) } : {}),
      };
    },
  };

  // The plan, built the way the broker builds it from a confirmed setup.
  const settings = { imageDigest: `sha256:${"1".repeat(64)}`, route: "gateway" };
  const scoring = await readFile(join(baseDir, SCORING_PATH));
  const judgePin = evalJudgePinOf({ catalogRowId: "gemini", judge: { kind: "rule", scoringPath: SCORING_PATH }, scoringHash: sha256(scoring) });
  const setHash = await evalSetHash(baseDir);
  const commandFingerprint = evalCommandFingerprintOf({ ...EVAL_COMMAND, args: [...EVAL_COMMAND.args] }, EVAL_REPORT);
  const key = { company: "company-a", project: "project-a", baseCommit: repo.baseSha, codeHash: "c".repeat(64), judgePin, commandFingerprint, catalogRowId: "gemini", model: "gemini-2.5-flash", modelVersion: "gemini-2.5-flash-001" };
  const inputs = { evalSetHash: setHash, judgePin, commandFingerprint, model: key.model, modelVersion: key.modelVersion, catalogRowId: key.catalogRowId, settingsFingerprint: evalSettingsFingerprint(settings, judgePin) };
  const plan: EvalFinalCheckPlan = {
    company: key.company, project: key.project, selection: "evals/support", inputs, key, settings, evalSetHash: setHash, evalConfigured: true, judgePin, baselineJudgePin: judgePin, subsetSupported: true,
    questions: await questionPlan(baseDir, candidateDir), maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 100,
  };
  const grant: EvalSpendGrant = { company: key.company, project: key.project, selection: plan.selection, role: "owner", inputsDigest: evalSpendInputsDigest(inputs), provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };
  const cache = memoryBaseCache();
  const ports: EvalFinalCheckPorts = {
    roundKind: "check_unsealed", plan: async () => plan, approval: { read: async () => grant },
    meter: createEvalMeter(access.access), cache, baselines: createEvalBaselines(), runner: createEvalRunner(exec),
  };
  return {
    repo, baseDir, candidateDir, candidate, ports, plan, grant, cache, frames, sides, fake, savedEnvironment: saved?.path,
    cleanup: async () => { await fake.stop(); saved?.remove(); await rm(repo.root, { recursive: true, force: true }); },
  };
}
