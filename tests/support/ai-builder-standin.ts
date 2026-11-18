// L4-VX: the test world for the "AI builder" stand-in (tests/fixtures/ai-builder-sample): a real git repository of a small Gemini-on-Vertex agent, a real child process that runs
// the project's own eval command, and a fake Vertex endpoint, all offline. Rovara's own pieces are the real ones: the plan, the metered stage, the bridge-shaped egress, the baseline
// measurement, the question-level comparison, the changed-prompt classifier. Only the model (a local stub), the money (a scripted meter) and the sandbox (a plain child process in a
// checkout) are stand-ins.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVAL_VERTEX_PLACEHOLDER, attestRovaraOnlyBaseCheckout, evalBaseCacheKey, evalCommandFingerprintOf, evalJudgePinOf, evalQuestionHash, evalSetHashOf, evalSpendInputsDigest,
  routeEgressRequest, type BaseScoreCache, type PromptLocation, type EvalBaseRecord, type EvalSpendGrant, type ModelEgressFrame, type ModelEgressRow,
} from "@agentx/contracts";
import { fixtureEgressRows } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { createEvalBaselines } from "../../packages/worker/src/verification/eval-baseline-refresh.js";
import { candidatePromptChanges, changedPromptClassifier } from "../../packages/worker/src/verification/eval-changed-prompt.js";
import type { EvalFinalCheckPlan, EvalFinalCheckPorts } from "../../packages/worker/src/verification/eval-final-check.js";
import { createEvalGatewayAccess } from "../../packages/worker/src/verification/eval-gateway-access.js";
import { freshEvalEnvironment } from "../../packages/worker/src/verification/eval-bridged-exec.js";
import { createEvalMeter, type EvalModelAccess } from "../../packages/worker/src/verification/eval-model-access.js";
import { createModelMetadataServer } from "../../packages/worker/src/model-helper-metadata.js";
import { evalSettingsFingerprint } from "../../packages/worker/src/verification/eval-round.js";
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
export const teamGate = (dir: string): Run => runProject(dir, PYTHON, ["evals/run.py", "--gate"], { DESKBOT_FAKE_VERTEX: "1" });

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

/** The Vertex project and location the stand-in's customer connected in Cloud (what the gateway's key store holds). Rovara's sandbox never learns them. */
export const CONNECTED_VERTEX = { project: "deskbot-prod-1", location: "us-central1" } as const;
const TASK_TOKEN = "task-token-abcdefghijklmnop";
const STAGE_SCOPE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const GATEWAY_URL = "https://gateway.example.test";
const VERTEX_PRODUCT_PATH = /^\/v1\/product\/vertex\/(v1|v1beta1)\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/:]+):(generateContent|streamGenerateContent)$/u;

export interface FakeGatewayOptions {
  readonly fake: FakeVertex;
  readonly frames: StandInWorld["frames"];
  readonly current: { side: "old" | "new" };
  /** Whether the project has a Vertex connection (a hold is refused when it has none). Default true. */
  readonly connected?: boolean;
  readonly providerClass?: "rate_limit" | "provider_error" | undefined;
}
/**
 * The Cloud model gateway as far as the eval stage sees it, in process (no socket): the whole-stage hold, a Vertex product call under the stage's scope, the release. It applies the rules Cloud's product route applies: the call needs the
 * stage's scope; the request's project and location must be the CONNECTED ones or Rovara's placeholder pair (which the route maps to the connected ones under a scope), anything else is refused before a send; the upstream path is built from the
 * connection, never from the request, and goes through the REAL egress route check for a Vertex row. Money: each ok call settles at CALL_COST_MICROS.
 */
export function fakeEvalGateway(options: FakeGatewayOptions) {
  const holds: Array<{ calls: number; costMicros: number }> = [];
  const releases: Array<Record<string, unknown>> = [];
  const lines = (status: number, body: string, settle: Record<string, unknown>): Response => new Response(
    [{ kind: "head", status, headers: [["content-type", "application/json"]] }, { kind: "chunk", b64: Buffer.from(body).toString("base64") }, { kind: "settle", status, estimated: false, ...settle }].map(l => JSON.stringify(l)).join("\n") + "\n",
    { status: 200, headers: { "content-type": "application/x-ndjson" } });
  const refused = (status: number, refusal: string): Response => lines(status, JSON.stringify({ error: { code: status, message: "refused" } }), { class: "refused", refusal, costMicros: 0 });
  const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const vertexRow = (rows as Record<string, ModelEgressRow>)["vertex"]!;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(typeof init?.body === "string" ? init.body : "");
    if (url.origin !== GATEWAY_URL || headers.get("x-api-key") !== TASK_TOKEN) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/v1/product/eval/hold") {
      const asked = JSON.parse(body.toString("utf8")) as { calls: number; costMicros: number };
      holds.push({ calls: asked.calls, costMicros: asked.costMicros });
      if (options.connected === false) return json({ error: "not_set_up" }, 404);
      return json({ scope: STAGE_SCOPE, calls: asked.calls, costMicros: asked.costMicros, expiresAt: 1 });
    }
    if (url.pathname === "/v1/product/eval/release") { releases.push(JSON.parse(body.toString("utf8")) as Record<string, unknown>); return json({ released: 1 }); }
    const match = VERTEX_PRODUCT_PATH.exec(url.pathname);
    if (match === null) return json({ error: "not_found" }, 404);
    const [, version, project, location, model, operation] = match as unknown as [string, string, string, string, string, string];
    const path = url.pathname.slice("/v1/product/vertex".length);
    const record = (routed: boolean, refusal?: string): void => { options.frames.push({ side: options.current.side, row: "vertex", path, routed, ...(refusal === undefined ? {} : { refusal }) }); };
    if (headers.get("x-rovara-eval-scope") !== STAGE_SCOPE) { record(false, "not_found"); return refused(404, "not_found"); }
    const placeholder = project === EVAL_VERTEX_PLACEHOLDER.projectId && location === EVAL_VERTEX_PLACEHOLDER.location;
    if (!placeholder && (project !== CONNECTED_VERTEX.project || location !== CONNECTED_VERTEX.location)) { record(false, "not_allowed"); return refused(400, "not_allowed"); }
    // The upstream path is built from the connection, never from the request.
    const upstream = `/${version}/projects/${CONNECTED_VERTEX.project}/locations/${CONNECTED_VERTEX.location}/publishers/google/models/${model}:${operation}`;
    const routed = routeEgressRequest(vertexRow, { vertex: CONNECTED_VERTEX }, { method: "POST", path: upstream, query: url.search.slice(1) });
    record(routed.ok, routed.ok ? undefined : routed.refusal);
    if (!routed.ok) return refused(403, routed.refusal);
    if (options.providerClass !== undefined) return lines(options.providerClass === "rate_limit" ? 429 : 500, "{}", { class: options.providerClass, costMicros: 0 });
    const response = await fetch(`${options.fake.endpoint}${upstream}`, { method: "POST", headers: { "content-type": headers.get("content-type") ?? "application/json", authorization: "Bearer gateway-minted-token" }, body });
    const text = await response.text();
    return lines(response.status, text, response.status === 200 ? { class: "ok", costMicros: CALL_COST_MICROS } : { class: "provider_error", costMicros: CALL_COST_MICROS });
  }) as typeof fetch;
  const access: EvalModelAccess = createEvalGatewayAccess(GATEWAY_URL, async () => TASK_TOKEN, { fetch: fetchImpl });
  return { access, holds, releases };
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

/** The eval's catalog row in the confirmed plan, and so the variables the sandbox gets: the Gemini API's, or (L4-EVV) Vertex AI's. */
export type Transport = "gemini" | "vertex";
export interface StandInWorldOptions {
  /** Which row the confirmed plan names, and so which client variables Rovara's sandbox sets (the real `freshEvalEnvironment`). Default "gemini". */
  transport?: Transport;
  /** Vertex only: the project the client is made to use instead of the placeholder Rovara gives it (code that hardcodes its own project). */
  clientProject?: string;
  /** Vertex only: the project has no Vertex connection in Cloud. */
  vertexConnected?: boolean;
  /** The sample's change patch for the candidate (a file under changes/), or undefined for no change. */
  patch?: string | undefined;
  /** L4-EVP: the prompt locations the project confirmed in setup, handed to the changed-prompt classifier as the broker sends them with the eval request. */
  promptLocations?: readonly PromptLocation[] | undefined;
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
  readonly fake: FakeVertex;
  /** Vertex only: what the in-process gateway saw (the stage's hold and release). */
  readonly gateway: { readonly holds: Array<{ calls: number; costMicros: number }>; readonly releases: Array<Record<string, unknown>> } | undefined;
  /** Vertex only: how many metadata-server token requests the client made (it asks for its credential before the first call). */
  readonly metadataTokenRequests: () => number;
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
  try { return await buildWorld(options, repo, started => { fake = started; }); }
  catch (error) { await fake?.stop(); await rm(repo.root, { recursive: true, force: true }); throw error; }
}

async function buildWorld(options: StandInWorldOptions, repo: StandInRepo, onFake: (fake: FakeVertex) => void): Promise<StandInWorld> {
  const transport = options.transport ?? "gemini";
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
  const isChanged = changedPromptClassifier(await candidatePromptChanges(repositories, identities, new AbortController().signal, repo.baseSha, undefined, options.promptLocations ?? []));

  // The model route: the egress the metered stage forwards to. Gemini: a scripted stage that applies the REAL route check to every frame (the row's path allow-list), then answers from the fake Vertex.
  const scripted = scriptedAccess(async function* (frame) {
    const row: ModelEgressRow | undefined = (rows as Record<string, ModelEgressRow>)[frame.row];
    const routed = row === undefined ? { ok: false as const, refusal: "not_allowed" } : routeEgressRequest(row, {}, frame);
    frames.push({ side: current.side, row: frame.row, path: frame.path, routed: routed.ok, ...(routed.ok ? {} : { refusal: routed.refusal }) });
    if (options.providerClass !== undefined) { yield* classAnswer(options.providerClass, options.providerClass === "rate_limit" ? 429 : 500); return; }
    if (!routed.ok) { yield* classAnswer("refused", 403); return; }
    const response = await fetch(`${fake.endpoint}${frame.path}`, { method: "POST", headers: Object.fromEntries(frame.headers.filter(([name]) => ["content-type", "x-goog-api-key", "authorization"].includes(name.toLowerCase()))), body: Buffer.from(frame.body) });
    const text = await response.text();
    yield* answer({ status: response.status, class: response.status === 200 ? "ok" : "provider_error", costMicros: CALL_COST_MICROS }, text);
  });
  // Vertex: the stage's access is the REAL gateway adapter (`createEvalGatewayAccess`) over an in-process Cloud gateway, so the worker's path check, the product route it picks, the scope header and the NDJSON read are all the production code.
  const gateway = transport === "vertex" ? fakeEvalGateway({ fake, frames, current, ...(options.vertexConnected === undefined ? {} : { connected: options.vertexConnected }), providerClass: options.providerClass }) : undefined;
  const access: { access: EvalModelAccess } = gateway === undefined ? scripted : { access: gateway.access };
  let metadataTokenRequests = 0;

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
      const base = `http://127.0.0.1:${port}`;
      // The variables Rovara's fresh check sandbox writes (`freshEvalEnvironment`, the production function): for the gemini row the Gemini client's base URL and placeholder keys, for the vertex row (L4-EVV) the Vertex client's base URL, the placeholder
      // project and location, and the metadata-server pair. Only the addresses are swapped for local ones; every name and value is what production writes.
      const metadata: Server | undefined = transport === "vertex" ? createModelMetadataServer({ caller: "127.0.0.1", projectId: EVAL_VERTEX_PLACEHOLDER.projectId, maxConnections: 8 }) : undefined;
      metadata?.on("request", req => { if ((req.url ?? "").includes("/token")) metadataTokenRequests++; });
      if (metadata !== undefined) await new Promise<void>(resolve => metadata.listen(0, "127.0.0.1", resolve));
      const metadataAddress = metadata === undefined ? "" : `127.0.0.1:${(metadata.address() as { port: number }).port}`;
      const written = freshEvalEnvironment({ rowId: transport, token: "runtoken0123456789", side: request.side, runs: request.runs, ids: request.ids, helperIp: "172.30.1.9" })
        .replaceAll("http://rovara-models:8080", base).replaceAll("172.30.1.9:8081", metadataAddress);
      const fromFile = Object.fromEntries(written.split("\n").filter(Boolean).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as [string, string]).filter(([name]) => name !== "HOME"));
      const env = cleanEnv({ ...fromFile, ...(transport === "vertex" && options.clientProject !== undefined ? { GOOGLE_CLOUD_PROJECT: options.clientProject } : {}) });
      const notBeforeMs = Date.now() - 1000;
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(EVAL_COMMAND.executable, [...EVAL_COMMAND.args], { cwd: join(dir, EVAL_COMMAND.cwd), env, stdio: "ignore" });
          const stop = () => child.kill("SIGKILL");
          request.signal.addEventListener("abort", stop, { once: true });
          child.once("error", reject); child.once("exit", code => { request.signal.removeEventListener("abort", stop); resolve(code); });
        });
        sides.push({ side: request.side, runs: request.runs, ids: request.ids, exitCode });
      } finally {
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
        if (metadata !== undefined) await new Promise<void>(resolve => { metadata.close(() => resolve()); metadata.closeAllConnections(); });
      }
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
  const judgePin = evalJudgePinOf({ catalogRowId: transport, judge: { kind: "rule", scoringPath: SCORING_PATH }, scoringHash: sha256(scoring) });
  const setHash = await evalSetHash(baseDir);
  const commandFingerprint = evalCommandFingerprintOf({ ...EVAL_COMMAND, args: [...EVAL_COMMAND.args] }, EVAL_REPORT);
  const key = { company: "company-a", project: "project-a", baseCommit: repo.baseSha, codeHash: "c".repeat(64), judgePin, commandFingerprint, catalogRowId: transport, model: "gemini-2.5-flash", modelVersion: "gemini-2.5-flash-001" };
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
    repo, baseDir, candidateDir, candidate, ports, plan, grant, cache, frames, sides, fake, gateway: gateway === undefined ? undefined : { holds: gateway.holds, releases: gateway.releases }, metadataTokenRequests: () => metadataTokenRequests,
    cleanup: async () => { await fake.stop(); await rm(repo.root, { recursive: true, force: true }); },
  };
}
