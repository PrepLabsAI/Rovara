// The eval's sandbox exec over the F1-c model bridge (plan v3.2 row 20.2; TE-F1C-RUNTASK-NOT-WIRED, TE-F1E-RUNTASK-WIRING).
//
// ONE bridge per exec run, listening on a Unix socket in a private folder of its own. The eval process runs in a FRESH sandbox (a `FreshEvalSandbox`:
// a new network, the model helper, nothing from the working sandbox); only the helper reaches this socket, and only with the one token made for this run.
// The bridge's egress is the stage's metered `call` (`request.egress`), so every model call of the eval is counted, held and bounded by the stage; the bridge
// never sees the reservation, the grant, the payer or a key. The token is made for the check round only (`check_unsealed`, mode `real`), is passed to the
// sandbox seam and nowhere else, and is dropped (with the bridge closed and the folder removed) when the run ends, however it ends.
//
// What the exec never does: read the repository's own accounting (the stage counts), turn a thrown fault into a result (the runner makes it "eval run failed"),
// or claim the changed prompt was exercised on the repository's word: `changedPromptCalls` counts the settled-ok calls whose frame the worker's own
// `changedPrompt` classifier names. An absent, unreadable or undecidable classification counts as changed.
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { EVAL_QUESTION_LIMIT, EVAL_VERTEX_PLACEHOLDER, EVAL_VERTEX_ROW, agentXError, attestRovaraOnlyBaseCheckout, type EvalBaseAttestation, type ModelEgress, type ModelEgressFrame } from "@agentx/contracts";
import { createProcessCandidateGit } from "../e2e-candidate-source.js";
import { createModelBridge } from "../model-bridge.js";
import { createModelBridgeLedger } from "../model-bridge-ledger.js";
import { MODEL_HELPER_DEFAULT_PORT, MODEL_HELPER_LEDGER_PATH, MODEL_HELPER_REPLIES_PATH, MODEL_HELPER_ROWS_PATH, MODEL_HELPER_RUN_DIR, modelHelperArgs } from "../model-helper-args.js";
import { isModelHelperAddress, modelHostAddHostArgs, type ModelHostBlock } from "../model-helper-block.js";
import { modelHelperOffer, startModelHelper, type StartedModelHelper } from "../model-helper-network.js";
import { buildModelReplyBundle, modelReplyBundleBytes, modelReplyBundleDigest } from "../model-reply-bundle.js";
import { MODEL_DUMMY_KEY, MODEL_HELPER_BASE_URL, MODEL_METADATA_PORT } from "../model-sandbox-env.js";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL, type ServicesNetwork } from "../run-network.js";
import type { DockerCli } from "../swebench/containers.js";
import { SANDBOX_INIT } from "../task-sandbox.js";
import { readContainedReport } from "./report-file.js";
import { TEST_REPORT_MAX_BYTES } from "./test-report.js";
import type { EvalReportLocation } from "./eval-round.js";
import type { EvalSandboxExec, EvalSandboxRequest, EvalSandboxResult } from "./eval-runner.js";

/** What the fresh sandbox is given to reach the model: the bridge's socket (in a folder only the helper mounts) and the token made for this one run. */
export interface FreshEvalSandboxModel {
  readonly socketPath: string;
  readonly token: string;
}
export interface FreshEvalSandboxRun {
  readonly side: "old" | "new";
  readonly ids: readonly string[];
  readonly runs: 1 | 2 | 3;
  readonly signal: AbortSignal;
  readonly model: FreshEvalSandboxModel;
}
export interface FreshEvalSandboxResult {
  readonly report: EvalReportLocation;
  /** The old side only: made by `attestRovaraOnlyBaseCheckout` after the base commit ran in a Rovara-only checkout. A plain object is not an attestation. */
  readonly attestation?: EvalBaseAttestation | undefined;
}
/**
 * The check round's own sandbox: started new for the run (a network of its own, the model helper at its fixed address, nothing mounted from the working sandbox), the
 * confirmed eval command run in it for one side, and everything stopped before `run` resolves, also on abort. Production: `createFreshEvalSandbox` (below, TE-B1); nothing makes one until the trusted sources are delivered.
 */
export interface FreshEvalSandbox {
  /** Whether a fresh sandbox can be started now. False reads "needs a fresh sandbox" before any money is held. */
  available(): boolean;
  run(input: FreshEvalSandboxRun): Promise<FreshEvalSandboxResult>;
}

export interface BridgedEvalExecOptions {
  readonly sandbox: FreshEvalSandbox;
  /** An absolute folder of the worker's own (its scratch); each run makes a private subfolder in it for the socket and removes it. */
  readonly runDir: string;
  /** The worker's own classifier for "this frame carries a changed prompt". Only an explicit false proves unchanged; unknown counts as changed. */
  readonly changedPrompt?: ((frame: ModelEgressFrame) => boolean) | undefined;
  /** The worker's own pin of the model: true only for a frame that calls the plan's model (and judge). Required: a frame it does not name never reaches the stage and fails the run, so the eval code cannot pick a different or dearer model. */
  readonly modelAllowed: (frame: ModelEgressFrame) => boolean;
  readonly now?: () => number;
}

/**
 * The bridge's own limits for one run. The STAGE holds the exact call count and queues what is over its open-call ceiling; the bridge must never be the first line, or a refusal it makes
 * (which the stage never sees) would read as a failed question. So its limits are far above any eval, and any refusal it still makes fails the run (below).
 */
export const EVAL_BRIDGE_CALLS_MAX = 10_000;
export const EVAL_BRIDGE_CONCURRENT_MAX = 256;
export const EVAL_BRIDGE_CONNECTIONS_MAX = 1_024;

/** The socket's folder (the helper's one mount) and the socket's own name in it. */
export const EVAL_HELPER_DIR_NAME = "models";
export const EVAL_BRIDGE_SOCKET_NAME = "m";

/**
 * A log line of the bridge that says it ended something ITSELF, without an answer the stage settled: its own refusal (`refused`, or class `refused`), a connection or call it dropped (`dropped`, any fixed reason:
 * EVAL-WIRE-BRIDGE-UNLOGGED-DROPS), or a call whose answer it cut (`call` with a `reason`). Any one fails the run.
 */
export function bridgeMadeEnd(fields: Readonly<Record<string, unknown>>): boolean {
  return fields["event"] === "refused" || fields["class"] === "refused" || fields["event"] === "dropped" || (fields["event"] === "call" && fields["reason"] !== undefined);
}

interface RunState { changedPromptCalls: number; open: number; blocked: boolean }

/**
 * The egress for one run. It (1) refuses, before the stage sees it, a frame the worker's own `modelAllowed` does not name (another model than the plan's), (2) counts, for the worker only, the settled-ok
 * calls that carry a changed prompt, and (3) counts the calls open, so a sandbox that returns with a call still open is a failed run. Events pass through untouched.
 */
function runEgress(inner: ModelEgress, options: BridgedEvalExecOptions, state: RunState): ModelEgress {
  return {
    capabilities: inner.capabilities,
    async *forward(scope, frame, forwardOptions) {
      const allowed = ((): boolean => { try { return options.modelAllowed(frame) === true; } catch { return false; } })();
      // Never reaches the stage: the run is failed (Not run) when it ends, and the sandbox is told the call failed.
      if (!allowed) { state.blocked = true; throw new Error("model not allowed"); }
      const changed = ((): boolean => { try { return options.changedPrompt?.(frame) !== false; } catch { return true; } })();
      state.open += 1;
      try {
        for await (const event of inner.forward(scope, frame, forwardOptions)) {
          // Counted when the settle arrives, before it is passed on: the sandbox cannot end before the count is in.
          if (event.kind === "settle" && changed && event.class === "ok") state.changedPromptCalls += 1;
          yield event;
        }
      } finally { state.open -= 1; }
    },
  };
}

export function createBridgedEvalExec(options: BridgedEvalExecOptions): EvalSandboxExec {
  // Only names a run inside this exec (the bridge keeps its token by it); nothing is shared across execs, tasks or companies.
  let runs = 0;
  return {
    async run(request: EvalSandboxRequest): Promise<EvalSandboxResult> {
      if (typeof options.sandbox?.available !== "function" || typeof options.sandbox.run !== "function" || !options.sandbox.available()) throw new Error("no fresh sandbox");
      if (typeof options.modelAllowed !== "function") throw new Error("no model pin");
      if (!isAbsolute(options.runDir)) throw new Error("the eval run folder must be absolute");
      if (request.signal.aborted) throw new Error("eval stage stopped");
      const now = options.now ?? Date.now;
      const execId = `eval-${request.side}-${String(++runs)}`;
      const dir = await mkdtemp(join(options.runDir, "e"));
      const state: RunState = { changedPromptCalls: 0, open: 0, blocked: false };
      // A call the bridge ITSELF refused (its own limits, a bad token, an unknown row, an oversize body) never reached the stage, so the stage cannot mark it: the sandbox saw an error and may have written a
      // failed question. Any such refusal fails the run (Not run), whatever the sandbox wrote.
      let bridgeRefused = false;
      let bridge: ReturnType<typeof createModelBridge> | undefined;
      try {
        bridge = createModelBridge({
          egress: runEgress(request.egress, options, state),
          egressScope: request.scope,
          roundKind: "check_unsealed",
          // The product route serves two shapes: the Gemini API and, for the `vertex` row, Vertex AI (same error bodies). The frame parser has already refused a row that is not a plain catalog word; the worker's own pin (`modelAllowed`) decides which row may call.
          familyOf: (row) => (row === EVAL_VERTEX_ROW ? "vertex" : "gemini"),
          ledger: createModelBridgeLedger({ now }),
          now,
          limits: { calls: EVAL_BRIDGE_CALLS_MAX, concurrent: EVAL_BRIDGE_CONCURRENT_MAX, connections: EVAL_BRIDGE_CONNECTIONS_MAX },
          log: (fields) => { if (bridgeMadeEnd(fields)) bridgeRefused = true; },
        });
        // The socket's own folder is the model helper's one mount (model-helper-launch.ts: its last segment must be `models`); it holds the socket and the helper's run files, nothing else.
        const helperDir = join(dir, EVAL_HELPER_DIR_NAME);
        await mkdir(helperDir, { mode: 0o700 });
        const socketPath = join(helperDir, EVAL_BRIDGE_SOCKET_NAME);
        await bridge.listen(socketPath);
        const token = bridge.issueToken(execId, "check_unsealed", ["real"]);
        let result: Awaited<ReturnType<FreshEvalSandbox["run"]>>;
        try { result = await options.sandbox.run({ side: request.side, ids: request.ids, runs: request.runs, signal: request.signal, model: { socketPath, token } }); }
        finally { bridge.dropToken(execId); }
        // A sandbox that returns with a call open, or after any refusal the stage could not see, did not run cleanly.
        if (bridgeRefused || state.blocked || state.open > 0) throw new Error("eval run not clean");
        return {
          report: result.report, changedPromptCalls: state.changedPromptCalls,
          ...(request.side === "old" && result.attestation !== undefined ? { attestation: result.attestation } : {}),
        };
      } finally {
        // The token is gone first (above); then no call is left open (the stage's close joins the calls), and nothing of the run stays on disk.
        await bridge?.close().catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

// ---- TE-B1: the fresh eval check sandbox (`FreshEvalSandbox` in production)
//
// ONE run = a NEW round network (an `rvi` internal bridge: model-helper-network.ts `startModelHelper` with kind "round"), the model helper on it at .9, and a NEW sandbox container on it at .4 and on no other network, started
// from the worker's own pinned image with a Rovara-only checkout of ONE commit (the base commit for the old side, the candidate commit for the new) as its only mount. Nothing of the working sandbox is used: not its container,
// its network, its workspace or its files. The checkout is written by the worker through the safe git path (`createProcessCandidateGit(...).materializeInto`: a throwaway repository that only borrows the objects, regular
// files only, no hook, filter or attribute runs), so the base round's code is the commit's and nothing the agent left.
//
// THE BRIDGE FOLDER (TE-F1C-SOCKET-ACCESS). The folder that holds the bridge's socket (`models`, made by the exec) is mounted into the HELPER ONLY, read-only (its one mount). The sandbox gets the checkout, a tmpfs and
// nothing else; its arguments are checked against an allow-list before it starts (`freshEvalSandboxArgProblems`), and after it starts a `docker inspect` of BOTH containers must show the sandbox mounting nothing but the
// checkout and the helper mounting nothing but the bridge folder, read-only, or the run is stopped and fails.
//
// THE MODEL ROUTE. The sandbox's client is pointed at the helper by name (`rovara-models`, `--add-host` to .9) with the per-run token in its base URL (`/p/<row>/x/<token>`); every catalog model host is also pinned to .9
// (the helper's by-name block), and the network is internal, so a client that ignores the redirect reaches nothing. The helper (mode `real`) sends each call to the bridge's socket; the bridge's egress is the stage's call.
// The token reaches the sandbox only through an env file the docker CLI reads (mode 0600, in the run's own folder, never on a command line), and the bridge drops it when the exec's run ends.
//
// JOIN. `run` resolves or rejects only after the sandbox container is gone, the helper and its network are stopped, the working sandbox is unpaused and the run's folder is removed, also when the signal fires (the sandbox is
// killed at once). The eval's report is copied out of the checkout (A4's contained, fresh, bounded read) into a report folder of the run before the checkout goes; that folder lives in `scratchDir` (the caller's, per
// invocation) and is removed with it.
//
// OFF BY DEFAULT: nothing in production makes one (`evalHostSourcesFor` answers undefined until the trusted sources are delivered, EVAL-WIRE-SOURCES-NOT-DELIVERED), and `available()` is false on a worker that does not
// offer the model helper (its walls and IPv6 drops: `modelHelperOffer`).

/** Where the checkout is mounted in the sandbox; the eval command's `cwd` is relative to it. */
export const FRESH_EVAL_WORKSPACE = "/workspace";
/** The variables the eval command reads (besides the model client's own base URL and dummy key): which side, how many runs, which questions. */
export const FRESH_EVAL_SIDE_VARIABLE = "ROVARA_EVAL_SIDE";
export const FRESH_EVAL_RUNS_VARIABLE = "ROVARA_EVAL_RUNS";
export const FRESH_EVAL_IDS_VARIABLE = "ROVARA_EVAL_IDS";
/** The one family the product route serves: the Gemini client's base URL and key variables. */
const GEMINI_BASE_URL_VARIABLE = "GOOGLE_GEMINI_BASE_URL";
const GEMINI_KEY_VARIABLES = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;
/** The `vertex` row's client variables (the catalog row's verified set for google-genai in Vertex mode, without its key). Python needs both metadata variables, JS the host only. */
const VERTEX_BASE_URL_VARIABLE = "GOOGLE_VERTEX_BASE_URL";
const VERTEX_METADATA_VARIABLES = ["GCE_METADATA_HOST", "GCE_METADATA_IP"] as const;
const FRESH_EVAL_USER = "1000:1000";
const NO_UPSTREAM_DNS = "127.0.0.1";
const FRESH_EVAL_TMPFS = "/tmp:rw,nosuid,nodev,size=512m,uid=1000,gid=1000";
const FRESH_EVAL_PIDS = "1024";
const FRESH_EVAL_MEMORY = "4g";
const FRESH_EVAL_CPUS = "2";
const DOCKER_CALL_MS = 60_000;
const SANDBOX_START_MS = 5 * 60_000;
/** The longest one side may run (the eval stage's own deadline still applies through the signal). */
export const FRESH_EVAL_RUN_MAX_MS = 4 * 60 * 60_000;
const PINNED_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._/:-]{0,200}@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const WORKSPACE_KEY = /^[0-9a-f]{16}$/u;
const ROW_ID = /^[a-z][a-z0-9-]{0,39}$/u;
const QUESTION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const BRIDGE_TOKEN = /^[A-Za-z0-9]{16,64}$/u;
const PLAIN_ARG = /^[^\0\r\n]{0,8192}$/u;
const EXECUTABLE = /^[A-Za-z0-9._/+-]{1,256}$/u;
const RELATIVE = /^(?:\.|[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+){0,31})$/u;
const SAFE_HOST_PATH = /^\/[A-Za-z0-9_./-]{1,400}$/u;
const NETWORK_NAME = /^rovara-svc-[0-9a-f]{12}$/u;
const IDS_MAX_CHARS = 32 * 1024;

/** The confirmed eval command of the trusted plan: an argv (no shell), run in `cwd` (relative to the checkout). */
export interface FreshEvalCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface FreshEvalSandboxConfig {
  readonly docker: DockerCli;
  /** The worker's own image, pinned (`name@sha256:<64 hex>` or an image id `sha256:<64 hex>`): the helper and the sandbox run it. A tag is refused. */
  readonly image: string;
  /** `setupWorkspaceKey(root)` of the worker's workspace (16 hex): the round network's labels and sweep. */
  readonly workspace: string;
  /** The operation's id; only ever hashed into the round network's name. */
  readonly taskId: string;
  /** The most one run may take, in milliseconds: the round network's expiry and the sandbox's own deadline. */
  readonly roundBudgetMs: number;
  /** The task's repository (its objects are read, nothing in it changes) and the two commits. */
  readonly repository: { readonly directory: string; readonly baseCommit: string; readonly candidateCommit: string };
  readonly command: FreshEvalCommand;
  /** Where the eval writes its measures file, relative to the checkout. */
  readonly report: { readonly cwd: string; readonly argument: string };
  /** The catalog row the eval's client is pointed at (the product route's Gemini row). */
  readonly rowId: string;
  /** An absolute folder of the worker's own for this invocation (checkouts, env files, report copies). The caller removes it at the task's end. */
  readonly scratchDir: string;
  /** The working sandbox's container: paused (and checked paused) while the base side runs, unpaused after. `null`: this task has none. */
  readonly workingSandbox: string | null;
  /** Default: the process environment (the helper gate). */
  readonly environment?: NodeJS.ProcessEnv;
  /** Test seam: writes `commit` of `repositoryRoot` as plain files into the new folder `destination`. Default: the safe git path. */
  readonly materialize?: (repositoryRoot: string, commit: string, destination: string, signal: AbortSignal) => Promise<unknown>;
  readonly now?: () => number;
  /** Test seam for the helper's readiness wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const configProblem = (config: FreshEvalSandboxConfig): boolean => {
  try {
    const c = config as Partial<FreshEvalSandboxConfig> | undefined;
    if (typeof c !== "object" || c === null || typeof c.docker?.run !== "function") return true;
    if (typeof c.image !== "string" || !PINNED_IMAGE.test(c.image)) return true;
    if (typeof c.workspace !== "string" || !WORKSPACE_KEY.test(c.workspace)) return true;
    if (typeof c.taskId !== "string" || c.taskId.length === 0 || c.taskId.length > 160) return true;
    if (!Number.isSafeInteger(c.roundBudgetMs) || c.roundBudgetMs! <= 0 || c.roundBudgetMs! > FRESH_EVAL_RUN_MAX_MS) return true;
    const repo = c.repository;
    if (typeof repo?.directory !== "string" || !isAbsolute(repo.directory) || typeof repo.baseCommit !== "string" || !SHA1.test(repo.baseCommit) || typeof repo.candidateCommit !== "string" || !SHA1.test(repo.candidateCommit)) return true;
    const cmd = c.command;
    if (typeof cmd?.executable !== "string" || !EXECUTABLE.test(cmd.executable) || !Array.isArray(cmd.args) || cmd.args.length > 256 || !cmd.args.every((arg) => typeof arg === "string" && PLAIN_ARG.test(arg))) return true;
    if (typeof cmd.cwd !== "string" || !RELATIVE.test(cmd.cwd) || cmd.cwd.split("/").includes("..")) return true;
    if (typeof c.report?.cwd !== "string" || !RELATIVE.test(c.report.cwd) || c.report.cwd.split("/").includes("..") || typeof c.report.argument !== "string" || c.report.argument === "" || c.report.argument.length > 1024) return true;
    if (typeof c.rowId !== "string" || !ROW_ID.test(c.rowId)) return true;
    if (typeof c.scratchDir !== "string" || !SAFE_HOST_PATH.test(c.scratchDir) || c.scratchDir.split("/").includes("..")) return true;
    if (c.workingSandbox !== null && (typeof c.workingSandbox !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(c.workingSandbox))) return true;
    return false;
  } catch { return true; }
};

/** The input of one run, checked at runtime (the types are not a check). */
function runProblem(input: FreshEvalSandboxRun): boolean {
  try {
    if (input.side !== "old" && input.side !== "new") return true;
    if (![1, 2, 3].includes(input.runs)) return true;
    if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.length > EVAL_QUESTION_LIMIT || !input.ids.every((id) => typeof id === "string" && QUESTION_ID.test(id)) || new Set(input.ids).size !== input.ids.length) return true;
    if (input.ids.join(",").length > IDS_MAX_CHARS) return true;
    if (!(input.signal instanceof AbortSignal)) return true;
    const socket = input.model?.socketPath;
    if (typeof socket !== "string" || !SAFE_HOST_PATH.test(socket) || socket.split("/").includes("..") || basename(dirname(socket)) !== EVAL_HELPER_DIR_NAME || basename(socket) !== EVAL_BRIDGE_SOCKET_NAME) return true;
    return typeof input.model.token !== "string" || !BRIDGE_TOKEN.test(input.model.token);
  } catch { return true; }
}

export interface FreshEvalSandboxArgsInput {
  readonly net: Pick<ServicesNetwork, "name" | "checkSandboxIp" | "labelArgs">;
  readonly image: string;
  readonly name: string;
  /** The checkout on the worker: the one mount, at `FRESH_EVAL_WORKSPACE`. */
  readonly checkout: string;
  readonly envFile: string;
  readonly block: ModelHostBlock;
  readonly command: FreshEvalCommand;
}

/** The fresh sandbox's `docker run` arguments. Throws CONFIG_INVALID (a fixed sentence) when the result would not pass `freshEvalSandboxArgProblems`. Pure. */
export function freshEvalSandboxRunArgs(input: FreshEvalSandboxArgsInput, forbidden: { readonly bridgeDir: string }): string[] {
  const workdir = input.command.cwd === "." ? FRESH_EVAL_WORKSPACE : posix.join(FRESH_EVAL_WORKSPACE, input.command.cwd);
  const args = [
    "run", "--detach", "--pull=never", "--name", input.name, "--stop-timeout", "1", ...input.net.labelArgs(),
    "--network", input.net.name, "--ip", input.net.checkSandboxIp, "--dns", NO_UPSTREAM_DNS, ...modelHostAddHostArgs(input.block),
    "--user", FRESH_EVAL_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--memory", FRESH_EVAL_MEMORY, "--memory-swap", FRESH_EVAL_MEMORY, "--cpus", FRESH_EVAL_CPUS, "--pids-limit", FRESH_EVAL_PIDS, "--log-driver", "none",
    "--tmpfs", FRESH_EVAL_TMPFS,
    "--volume", `${input.checkout}:${FRESH_EVAL_WORKSPACE}:rw`,
    "--env-file", input.envFile,
    "--workdir", workdir,
    "--entrypoint", SANDBOX_INIT,
    input.image, "--", input.command.executable, ...input.command.args,
  ];
  const problems = freshEvalSandboxArgProblems(args, input.net, { checkout: input.checkout, bridgeDir: forbidden.bridgeDir, helperIp: input.block.address });
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", "the fresh eval sandbox's arguments are unsound");
  return args;
}

const SANDBOX_VALUE_FLAGS: ReadonlySet<string> = new Set(["--name", "--stop-timeout", "--label", "--network", "--ip", "--dns", "--add-host", "--user", "--cap-drop", "--security-opt", "--memory", "--memory-swap", "--cpus", "--pids-limit", "--tmpfs", "--volume", "--env-file", "--workdir", "--entrypoint", "--log-driver"]);
const SANDBOX_SINGLE_FLAGS: ReadonlySet<string> = new Set(["--detach", "--pull=never", "--read-only"]);
const isUnder = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder.replace(/\/+$/u, "")}/`) || folder.startsWith(`${path.replace(/\/+$/u, "")}/`);

/**
 * Reads the fresh sandbox's `docker run` arguments back and names every way they are unsound, in fixed words. Allow-list: a flag the sandbox does not take is a problem, so a second network, a published port, a capability,
 * a device, a second mount or the bridge folder cannot be added by accident. An empty list is a sound set.
 */
export function freshEvalSandboxArgProblems(args: readonly string[], net: Pick<ServicesNetwork, "name" | "checkSandboxIp">, expected: { readonly checkout: string; readonly bridgeDir: string; readonly helperIp: string | undefined }): string[] {
  const problems: string[] = [];
  const flags = new Map<string, string[]>();
  let at = 0;
  if (args[at] !== "run") problems.push("it is not a docker run"); else at += 1;
  let image: string | undefined;
  while (at < args.length) {
    const token = args[at]!;
    if (SANDBOX_SINGLE_FLAGS.has(token)) { flags.set(token, [...(flags.get(token) ?? []), ""]); at += 1; continue; }
    if (SANDBOX_VALUE_FLAGS.has(token)) {
      const value = args[at + 1];
      if (value === undefined || value.startsWith("-")) { problems.push("a flag has no value"); at += 1; continue; }
      flags.set(token, [...(flags.get(token) ?? []), value]);
      at += 2;
      continue;
    }
    if (token.startsWith("-")) { problems.push("a flag the fresh sandbox does not take"); at += 1; continue; }
    image = token;
    break;
  }
  const only = (flag: string, wanted: string): boolean => (flags.get(flag) ?? []).length === 1 && flags.get(flag)![0] === wanted;
  if (image === undefined || !PINNED_IMAGE.test(image)) problems.push("the sandbox must run the worker's pinned image");
  if (!only("--network", net.name) || !NETWORK_NAME.test(net.name)) problems.push("the sandbox must be on the round network and on no other network");
  if (!only("--ip", net.checkSandboxIp)) problems.push("the sandbox must have the round's check sandbox address");
  if (!only("--dns", NO_UPSTREAM_DNS)) problems.push("the sandbox's only DNS server must be its own loopback (no upstream)");
  if (!only("--cap-drop", "ALL")) problems.push("the sandbox must drop every capability");
  if (!only("--security-opt", "no-new-privileges")) problems.push("the sandbox must have no-new-privileges and no other security option");
  if (!flags.has("--read-only")) problems.push("the sandbox's root must be read-only");
  if (!only("--user", FRESH_EVAL_USER)) problems.push("the sandbox must run as the non-root user");
  if (!only("--entrypoint", SANDBOX_INIT)) problems.push("the sandbox must start under the init");
  if (!only("--tmpfs", FRESH_EVAL_TMPFS)) problems.push("the sandbox has one tmpfs");
  const volumes = flags.get("--volume") ?? [];
  if (volumes.length !== 1 || volumes[0] !== `${expected.checkout}:${FRESH_EVAL_WORKSPACE}:rw`) problems.push("the sandbox has exactly one mount, the checkout");
  if (isUnder(expected.checkout, expected.bridgeDir)) problems.push("the sandbox must never mount the bridge folder");
  const envFiles = flags.get("--env-file") ?? [];
  if (envFiles.length !== 1 || !SAFE_HOST_PATH.test(envFiles[0]!) || isUnder(envFiles[0]!, expected.bridgeDir) || isUnder(envFiles[0]!, expected.checkout)) problems.push("the sandbox takes one env file, outside its checkout and the bridge folder");
  for (const [flag, value] of [["--memory", FRESH_EVAL_MEMORY], ["--memory-swap", FRESH_EVAL_MEMORY], ["--cpus", FRESH_EVAL_CPUS], ["--pids-limit", FRESH_EVAL_PIDS], ["--stop-timeout", "1"], ["--log-driver", "none"], ["--name", `${net.name}-eval`]] as const) {
    if (!only(flag, value)) problems.push("a limit, the name or the log driver is not the fresh sandbox's own");
  }
  const workdirs = flags.get("--workdir") ?? [];
  if (workdirs.length !== 1 || (workdirs[0] !== FRESH_EVAL_WORKSPACE && !workdirs[0]!.startsWith(`${FRESH_EVAL_WORKSPACE}/`)) || workdirs[0]!.split("/").includes("..")) problems.push("the sandbox's working folder must be in its checkout");
  const labelKeys = (flags.get("--label") ?? []).map((label) => label.split("=")[0]!);
  const runLabels = [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL];
  if (labelKeys.length !== runLabels.length || runLabels.some((key) => labelKeys.filter((candidate) => candidate === key).length !== 1)) problems.push("the sandbox carries the round network's labels and no other");
  for (const host of flags.get("--add-host") ?? []) if (expected.helperIp === undefined || host.slice(host.lastIndexOf(":") + 1) !== expected.helperIp) problems.push("a pinned name points somewhere other than the model helper");
  return problems;
}

/** The mounts of a container from one `docker inspect`: source, destination and whether it is writable; undefined when the look failed or cannot be read (a look that cannot be read is never "fine"). */
export async function containerMounts(docker: DockerCli, container: string): Promise<{ source: string; destination: string; rw: boolean; type: string }[] | undefined> {
  const inspected = await docker.run(["inspect", "--format", "{{json .Mounts}}", container], { timeoutMs: DOCKER_CALL_MS }).catch(() => undefined);
  if (inspected === undefined || inspected.exitCode !== 0) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(inspected.stdout.trim()); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  const mounts: { source: string; destination: string; rw: boolean; type: string }[] = [];
  for (const entry of parsed as unknown[]) {
    const m = entry as { Source?: unknown; Destination?: unknown; RW?: unknown; Type?: unknown };
    if (typeof m?.Source !== "string" || typeof m.Destination !== "string" || typeof m.RW !== "boolean" || typeof m.Type !== "string") return undefined;
    mounts.push({ source: m.Source, destination: m.Destination, rw: m.RW, type: m.Type });
  }
  return mounts;
}

/**
 * TE-F1C-SOCKET-ACCESS, read from the daemon: the helper mounts the bridge folder and nothing else, read-only; the sandbox mounts the checkout (bind) and its tmpfs and nothing else, and never the bridge folder. A look that
 * cannot be read is a failure. Fixed words; no path is repeated.
 */
export function bridgeFolderMountProblems(input: { helper: Awaited<ReturnType<typeof containerMounts>>; sandbox: Awaited<ReturnType<typeof containerMounts>>; bridgeDir: string; checkout: string }): string[] {
  const problems: string[] = [];
  const realBridge = realOrSelf(input.bridgeDir);
  if (input.helper === undefined) problems.push("the helper's mounts could not be read");
  else {
    const binds = input.helper.filter((mount) => mount.type !== "tmpfs");
    if (binds.length !== 1 || realOrSelf(binds[0]!.source) !== realBridge || binds[0]!.rw) problems.push("the helper must mount the bridge folder, read-only, and nothing else");
  }
  if (input.sandbox === undefined) problems.push("the sandbox's mounts could not be read");
  else {
    if (input.sandbox.some((mount) => isUnder(realOrSelf(mount.source), realBridge))) problems.push("the sandbox mounts the bridge folder");
    const binds = input.sandbox.filter((mount) => mount.type !== "tmpfs");
    if (binds.length !== 1 || realOrSelf(binds[0]!.source) !== realOrSelf(input.checkout) || binds[0]!.destination !== FRESH_EVAL_WORKSPACE) problems.push("the sandbox must mount the checkout and nothing else");
  }
  return problems;
}
function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** The env file's text: the model client's base URL (with the run's token) and dummy keys, the side, the runs and the ids. One `NAME=value` a line; every value is a plain word (no line break can add a variable).
 * The `vertex` row (L4-EVV) gets the Vertex client's variables instead of the Gemini ones, the same ones the catalog row lists as verified for google-genai in Vertex mode: its base URL, Rovara's placeholder project and location (the gateway maps
 * them to the connected ones), and the metadata-server pair that lets Application Default Credentials find a dummy token at the helper (`helperIp:8081`). No API key of any kind: a key next to a project makes the client use the express
 * form, which has no project in its path and which the gateway does not serve. A `gemini` row's lines are exactly as before. */
export function freshEvalEnvironment(input: { rowId: string; token: string; side: "old" | "new"; runs: 1 | 2 | 3; ids: readonly string[]; helperIp?: string }): string {
  const base = `${MODEL_HELPER_BASE_URL}/p/${input.rowId}/x/${input.token}`;
  const model: [string, string][] = input.rowId === EVAL_VERTEX_ROW
    ? [
      [VERTEX_BASE_URL_VARIABLE, base],
      ["GOOGLE_CLOUD_PROJECT", EVAL_VERTEX_PLACEHOLDER.projectId], ["GOOGLE_CLOUD_LOCATION", EVAL_VERTEX_PLACEHOLDER.location],
      ...VERTEX_METADATA_VARIABLES.map((name): [string, string] => [name, `${vertexMetadataAddress(input.helperIp)}`]),
    ]
    : [[GEMINI_BASE_URL_VARIABLE, base], ...GEMINI_KEY_VARIABLES.map((name): [string, string] => [name, MODEL_DUMMY_KEY])];
  const lines: [string, string][] = [
    ...model,
    ["HOME", "/tmp"],
    [FRESH_EVAL_SIDE_VARIABLE, input.side],
    [FRESH_EVAL_RUNS_VARIABLE, String(input.runs)],
    [FRESH_EVAL_IDS_VARIABLE, input.ids.join(",")],
  ];
  if (lines.some(([, value]) => !/^[\x21-\x7e]{1,40000}$/u.test(value))) throw new Error("the fresh eval environment is not plain");
  return `${lines.map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}
/** The helper's metadata address for a Vertex row: its own address (.9 of the round network) and the metadata port; any other address is refused. */
function vertexMetadataAddress(helperIp: string | undefined): string {
  if (typeof helperIp !== "string" || !isModelHelperAddress(helperIp)) throw new Error("the fresh eval environment needs the helper's address");
  return `${helperIp}:${String(MODEL_METADATA_PORT)}`;
}

/** Whether this worker offers the model helper's walls a fresh eval sandbox needs (`modelHelperOffer`), for a host that builds the sandbox later (DEC 253n(2)). Never throws. */
export function freshEvalSandboxOffered(environment: NodeJS.ProcessEnv): boolean {
  try { return modelHelperOffer(environment).offered === true; } catch { return false; }
}

/** The fresh eval check sandbox. See the section header above. */
export function createFreshEvalSandbox(config: FreshEvalSandboxConfig): FreshEvalSandbox {
  let rounds = 0;
  const docker = config?.docker;
  const call = (args: string[], timeoutMs = DOCKER_CALL_MS) => docker.run(args, { timeoutMs }).catch(() => ({ exitCode: -1, stdout: "", stderr: "" }));
  return {
    available(): boolean {
      if (configProblem(config)) return false;
      try { return modelHelperOffer(config.environment ?? process.env).offered; } catch { return false; }
    },
    async run(input: FreshEvalSandboxRun): Promise<FreshEvalSandboxResult> {
      if (configProblem(config)) throw new Error("no fresh sandbox");
      if (runProblem(input)) throw new Error("fresh eval run unreadable");
      if (input.signal.aborted) throw new Error("eval stage stopped");
      const now = config.now ?? Date.now;
      const round = ++rounds;
      const bridgeDir = dirname(input.model.socketPath);
      const vertexRow = config.rowId === EVAL_VERTEX_ROW;
      const commit = input.side === "old" ? config.repository.baseCommit : config.repository.candidateCommit;
      await mkdir(config.scratchDir, { recursive: true, mode: 0o700 });
      const runDir = await mkdtemp(join(config.scratchDir, "run-"));
      const reportRoot = await mkdtemp(join(config.scratchDir, "report-"));
      const checkout = join(runDir, "checkout");
      const envFile = join(runDir, "env");
      let helper: StartedModelHelper | undefined;
      let sandboxName: string | undefined;
      let paused = false;
      let finished = false;
      let killed: Promise<unknown> | undefined;
      const kill = (): void => { if (sandboxName !== undefined) killed ??= call(["rm", "--force", sandboxName]); };
      const onAbort = (): void => kill();
      input.signal.addEventListener("abort", onAbort, { once: true });
      let woke = true;
      const outcome = await (async (): Promise<FreshEvalSandboxResult> => { try {
        // 0. The base side: the working sandbox is paused (checked from the daemon) BEFORE the checkout is written and stays paused until the run is over, so nothing of the agent's runs beside the base round or
        // while its objects are read. A sandbox that was already paused is left paused after (it is not ours to wake).
        if (input.side === "old" && config.workingSandbox !== null) {
          const before = await call(["inspect", "--format", "{{.State.Paused}}", config.workingSandbox]);
          if (before.exitCode !== 0 || (before.stdout.trim() !== "true" && before.stdout.trim() !== "false")) throw new Error("the working sandbox could not be read");
          if (before.stdout.trim() === "false") { paused = true; await call(["pause", config.workingSandbox]); }
          const state = await call(["inspect", "--format", "{{.State.Paused}}", config.workingSandbox]);
          if (state.exitCode !== 0 || state.stdout.trim() !== "true") throw new Error("the working sandbox could not be paused");
        }
        // 1. The Rovara-only checkout of the one commit, by the worker (never by the agent, never from the working tree).
        await mkdir(checkout, { mode: 0o755 });
        await chmod(checkout, 0o755);
        await (config.materialize ?? ((root, sha, destination, signal) => createProcessCandidateGit(runDir).materializeInto(root, sha, destination, signal)))(config.repository.directory, commit, checkout, input.signal);
        if (input.signal.aborted) throw new Error("eval stage stopped");
        // 2. The helper's run files beside the socket (its one mount): the row it serves and an empty reply bundle (mode real answers from the bridge only).
        const bundle = buildModelReplyBundle([]);
        await writeFile(join(bridgeDir, "rows.json"), JSON.stringify([{ id: config.rowId, family: vertexRow ? "vertex" : "gemini" }]), { mode: 0o644 });
        await writeFile(join(bridgeDir, "replies.json"), modelReplyBundleBytes(bundle), { mode: 0o644 });
        // 3. The round network and the helper on it (.9), serving only the sandbox's address (.4), real mode over the bridge socket.
        helper = await startModelHelper(docker, {
          kind: "round", id: `${config.taskId}#${randomBytes(8).toString("hex")}`, round, workspace: config.workspace, roundBudgetMs: config.roundBudgetMs, image: config.image, runDir: bridgeDir,
          helperArgs: ({ listen, caller }) => modelHelperArgs({
            listen, port: MODEL_HELPER_DEFAULT_PORT, metaPort: vertexRow ? MODEL_METADATA_PORT : undefined, caller, mode: "real", rows: MODEL_HELPER_ROWS_PATH, replies: MODEL_HELPER_REPLIES_PATH, digest: modelReplyBundleDigest(bundle),
            ledger: MODEL_HELPER_LEDGER_PATH, blockState: "by_name", projectId: vertexRow ? EVAL_VERTEX_PLACEHOLDER.projectId : undefined, recordEscapes: false, bridgeSocket: `${MODEL_HELPER_RUN_DIR}/${EVAL_BRIDGE_SOCKET_NAME}`,
          }),
          ...(config.environment === undefined ? {} : { environment: config.environment }), ...(config.now === undefined ? {} : { now: config.now }), ...(config.sleep === undefined ? {} : { sleep: config.sleep }),
        });
        if (helper.sandboxRole !== "check") throw new Error("not a round network");
        const block = helper.sandboxBlock({});
        if (input.signal.aborted) throw new Error("eval stage stopped");
        // 5. The sandbox: the env file (0600, read by the docker CLI only), then the container on the round network only, then the daemon's own view of both containers' mounts.
        await writeFile(envFile, freshEvalEnvironment({ rowId: config.rowId, token: input.model.token, side: input.side, runs: input.runs, ids: input.ids, helperIp: helper.helperIp }), { mode: 0o600 });
        const name = `${helper.network.name}-eval`;
        const args = freshEvalSandboxRunArgs({ net: helper.network, image: config.image, name, checkout, envFile, block: block.block, command: config.command }, { bridgeDir });
        const notBeforeMs = now();
        sandboxName = name;
        const started = await call(args, SANDBOX_START_MS);
        if (started.exitCode !== 0) throw new Error("the fresh sandbox could not start");
        await rm(envFile, { force: true });
        const mounts = bridgeFolderMountProblems({ helper: await containerMounts(docker, helper.helperName), sandbox: await containerMounts(docker, name), bridgeDir, checkout });
        if (mounts.length > 0) { kill(); throw new Error("the fresh sandbox is not isolated from the bridge folder"); }
        // 6. Wait for the eval to end: its own exit, the run's deadline, or the signal (which kills the sandbox at once).
        const waited = await call(["wait", name], config.roundBudgetMs);
        if (input.signal.aborted) throw new Error("eval stage stopped");
        if (waited.exitCode !== 0 || !/^-?\d+$/u.test(waited.stdout.trim())) { kill(); throw new Error("the fresh sandbox did not finish"); }
        // 7. The report, out of the checkout before it goes: A4's contained, fresh, bounded read; nothing is copied unless the whole file is read.
        const read = await readContainedReport({ root: checkout, cwd: config.report.cwd, argument: config.report.argument, maxBytes: TEST_REPORT_MAX_BYTES, notBeforeMs });
        if (read.ok) {
          const target = join(reportRoot, config.report.cwd, config.report.argument);
          if (!target.startsWith(`${reportRoot}/`)) throw new Error("the eval report is outside its folder");
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, read.bytes, { mode: 0o600 });
        }
        finished = true;
        return {
          report: { root: reportRoot, cwd: config.report.cwd, argument: config.report.argument, notBeforeMs },
          ...(input.side === "old" ? { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: commit }) } : {}),
        };
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        // Join: the sandbox is gone, then the helper and its network, then the working sandbox runs again, then nothing of the run stays on disk (the report copy stays in the caller's scratch).
        kill();
        await killed;
        // Once more after the first removal has returned: a removal sent while `docker run` was still creating the container may have found nothing. (The network's stop also removes every container with its labels.)
        if (sandboxName !== undefined) await call(["rm", "--force", sandboxName]);
        await helper?.stop().catch(() => undefined);
        if (paused && config.workingSandbox !== null) {
          await call(["unpause", config.workingSandbox]);
          woke = (await call(["inspect", "--format", "{{.State.Paused}}", config.workingSandbox])).stdout.trim() === "false";
        }
        await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
        if (!finished) await rm(reportRoot, { recursive: true, force: true }).catch(() => undefined);
        await rm(join(bridgeDir, "rows.json"), { force: true }).catch(() => undefined);
        await rm(join(bridgeDir, "replies.json"), { force: true }).catch(() => undefined);
      } })();
      // A working sandbox left paused is a fault of its own (checked after every other step is done): the run is not a result.
      if (!woke) throw new Error("the working sandbox could not be unpaused");
      return outcome;
    },
  };
}
