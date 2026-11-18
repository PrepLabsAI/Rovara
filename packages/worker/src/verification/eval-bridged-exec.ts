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
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { EVAL_INSTALL_STEP_MAX_MS, EVAL_QUESTION_LIMIT, isEvalStandInPlanHost, type EvalStandInCounts, EVAL_VERTEX_PLACEHOLDER, EVAL_VERTEX_ROW, EvalEnvironmentSchema, agentXError, attestRovaraOnlyBaseCheckout, type EvalBaseAttestation, type EvalEnvironment, type EvalInstallCommand, type ModelEgress, type ModelEgressFrame } from "@agentx/contracts";
import { createProcessCandidateGit } from "../e2e-candidate-source.js";
import { createModelBridge } from "../model-bridge.js";
import { createModelBridgeLedger } from "../model-bridge-ledger.js";
import { MODEL_HELPER_DEFAULT_PORT, MODEL_HELPER_LEDGER_PATH, MODEL_HELPER_REPLIES_PATH, MODEL_HELPER_ROWS_PATH, MODEL_HELPER_RUN_DIR, modelHelperArgs } from "../model-helper-args.js";
import { MODEL_BLACKHOLE_ADDRESS, isModelHelperAddress, modelHostAddHostArgs, planModelHostBlock, sealedModelHostPairs, type ModelHostBlock } from "../model-helper-block.js";
import { modelHelperOffer, startModelHelper, type StartedModelHelper } from "../model-helper-network.js";
import { SERVED_MODEL_FAMILIES, type ModelReplySet } from "@agentx/contracts/model-helper";
import { buildModelReplyBundle, modelReplyBundleBytes, modelReplyBundleDigest } from "../model-reply-bundle.js";
import { MODEL_DUMMY_KEY, MODEL_HELPER_BASE_URL, MODEL_METADATA_PORT } from "../model-sandbox-env.js";
import { CHECK_SANDBOX_HOSTNAME, SINKHOLE_ALIAS, checkSandboxHostsFile, checkSandboxNames, checkSandboxResolvConf, readSealedDnsRecord, sealedDnsHelperRunArgs, waitForSealedDnsHelper, type RunHostEntry, type SealedDnsRecord } from "../check-sandbox.js";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL, runNetworkHelperIp, type ServicesNetwork } from "../run-network.js";
import type { DockerCli } from "../swebench/containers.js";
import { SANDBOX_INIT, TASK_SANDBOX_LABEL, TASK_SANDBOX_NETWORK, TASK_SANDBOX_WORKSPACE_LABEL, sandboxNetworkFromEnvironment } from "../task-sandbox.js";
import { readContainedReport } from "./report-file.js";
import { EVAL_PYTHON_USER_BASE, useSavedEnvironment, type UseSavedEnvironmentInput } from "./eval-environment.js";
import { EvalSandboxRunFailure, diagnoseEvalFailure } from "./eval-run-diagnostic.js";
import type { EvalServicesStarted, EvalServicesStarter } from "./eval-services.js";
import { EVAL_CA_RELATIVE_PATH, evalStandInTrustEnvironment } from "../run-ca.js";
import { evalStandInDnsPairs, evalStandInHostsLines, startEvalStandIns, type StartedEvalStandIns } from "../eval-standin-hosted.js";
import type { EvalStandInRound } from "../eval-standin-round.js";
import { caseRowsOf, measuresFromCaseReports, type CaseRow } from "./eval-report-formats.js";
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
  /** L4-E56: only when the round has stand-ins: whether this run hit a gap (a made-up answer; an unreadable helper counts as a hit) and the round's counts as they stand. */
  readonly standIns?: { readonly hitGap: boolean; readonly counts: EvalStandInCounts } | undefined;
}
/**
 * The check round's own sandbox: started new for the run (a network of its own, the model helper at its fixed address, nothing mounted from the working sandbox), the
 * confirmed eval command run in it for one side, and everything stopped before `run` resolves, also on abort. Production: `createFreshEvalSandbox` (below, TE-B1); nothing makes one until the trusted sources are delivered.
 */
export interface FreshEvalSandbox {
  /** Whether a fresh sandbox can be started now. False reads "needs a fresh sandbox" before any money is held. */
  available(): boolean;
  run(input: FreshEvalSandboxRun): Promise<FreshEvalSandboxResult>;
  /**
   * L4-E12 (E2): the FREE dry run. The eval command runs ONCE on the commit the sandbox is configured with (main), in a sealed box whose model helper serves SCRIPTED replies: no bridge, no token, no model route to the gateway,
   * so no model call can be made and none can cost money. Returns what the run left behind (its output tail, how it ended, the sealed name server's record of every unknown name); it never reads a report and never throws for a
   * failed command (a failed eval still shows what it reached). Absent on a sandbox that cannot run one.
   */
  dryRun?(input: FreshEvalDryRun): Promise<EvalDryRunObservation>;
}

export interface FreshEvalDryRun {
  readonly ids: readonly string[];
  readonly signal: AbortSignal;
}
/** What one dry run left behind. Nothing here has been read for meaning: `eval-dry-run.ts` makes the dependency list from it. The output is redacted (the run's own secrets are gone) and bounded. */
export interface EvalDryRunObservation {
  readonly code: number | undefined;
  readonly timedOut: boolean;
  /** The last 200 lines of the eval's own output (stdout and stderr), redacted of this run's token and placeholder keys. */
  readonly output: string;
  /** The sealed name server's record: every unknown name the eval asked for. */
  readonly dns: SealedDnsRecord;
  /** The hosts pinned to the model helper (never named as a dependency). */
  readonly modelRoute: { readonly hosts: readonly string[]; readonly suffixes: readonly string[] };
  /** The run's own placeholder values (never a real secret: a dry run holds none), so a name that contains one is never kept. */
  readonly secrets: readonly string[];
  /** The sinkhole's address: where every unknown name pointed, so a failed connection to it (nothing listens there: it reads refused or unreachable) names the port the eval wanted. */
  readonly sinkholeIp: string;
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
          ...(result.standIns === undefined ? {} : { standIns: result.standIns }),
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

/** L4-E12: a dry run has no bridge; this placeholder fills the helper's `/x/<token>` path segment and opens nothing. */
const DRY_RUN_TOKEN = "dryrun0000000000";
/** The sinkhole's address: the last of the round's 32 service addresses, which no service takes (test-services-run.ts `SINKHOLE_HELPER_INDEX`). */
const SINKHOLE_HELPER_INDEX = 31;
const MODEL_HELPER_NAME = "rovara-models";
/** A dry run's scripted replies: ONE reply per served model family that matches every call, so the eval gets as far as it can without any model. Never a real answer; never counted as proof. */
const DRY_RUN_REPLY_SETS: readonly ModelReplySet[] = SERVED_MODEL_FAMILIES.map((family): ModelReplySet => ({
  version: 1, family,
  replies: [{ id: "dry-run", match: {}, response: { text: "ok", finish: "stop" }, provenance: "task_made" }],
}));

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
/** L4-EVS: the eval keeps a small capped log until its container is removed (the worker reads the tail of it for a failed run, redacted); it was `--log-driver none`. */
const FRESH_EVAL_LOG_OPTIONS = ["max-size=64k", "max-file=1"] as const;
const LOG_TAIL_LINES = "200";
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
  /**
   * L4-EVS: the environment the sealed run starts from, delivered with the plan (saved image, or the project's approved install steps). Absent: the bare worker image, byte-identical to before.
   * A saved image is tried first; when it cannot be used the plan's `fallbackInstall` steps run instead (never both). Install steps run BEFORE the round network exists, in a box with no model route.
   */
  readonly evalEnvironment?: EvalEnvironment | undefined;
  /** Test seam: the saved image's dependency folders into the checkout. Default: the preparation's own pull and checks (`useSavedEnvironment`). */
  readonly useSavedEnvironment?: (input: UseSavedEnvironmentInput) => Promise<boolean>;
  /** The network an install step joins. Default: the machine's shared sandbox network (its reach is the allowed-websites firewall). */
  readonly installNetwork?: string | undefined;
  /**
   * L4-E12 (E1): the project's test services on this round's network. Absent: no service, byte-identical to before. Each `run` starts a FRESH copy (the old side and the new side never share one) and stops it before the network goes.
   * With services the round uses the sealed name server (the service names are in the box's hosts file and the name server's table).
   */
  readonly services?: EvalServicesStarter | undefined;
  /**
   * L4-E12 (E2): the sealed name server on the round instead of loopback DNS: `resolv.conf` names it, every unknown name goes to the sinkhole and is recorded. Default: on when `services` is set or for a dry run, off otherwise (the
   * round is exactly what it was). A host that wants it on for every eval round says true.
   */
  readonly sealedDns?: boolean | undefined;
  /**
   * L4-E56: the round's outside-HTTP stand-ins. Absent: the sandbox is byte-identical to before (no helper, no vendor name, no trust variable). Present: the round uses the sealed name server (E2) and a stand-in helper takes the
   * SINKHOLE's address (.47): every planned vendor name is in the box's hosts file and the name server's table at that address, and every other name the name server does not know goes to the sinkhole, which is the stand-in's
   * catch-all (never stop). The ONE `round` is shared by both sides and every re-ask (one answer book). The box trusts the round's authority through environment variables only. `start` is a test seam (default: `startEvalStandIns`).
   */
  readonly standIns?: { readonly round: EvalStandInRound; readonly start?: typeof startEvalStandIns | undefined } | undefined;
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
    if (c.evalEnvironment !== undefined && !EvalEnvironmentSchema.safeParse(c.evalEnvironment).success) return true;
    if (c.installNetwork !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(c.installNetwork)) return true;
    if (c.services !== undefined && typeof c.services?.start !== "function") return true;
    if (c.sealedDns !== undefined && typeof c.sealedDns !== "boolean") return true;
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
  readonly net: Pick<ServicesNetwork, "name" | "checkSandboxIp" | "labelArgs"> & Partial<Pick<ServicesNetwork, "dnsHelperIp">>;
  readonly image: string;
  readonly name: string;
  /** The checkout on the worker: the one mount, at `FRESH_EVAL_WORKSPACE`. */
  readonly checkout: string;
  readonly envFile: string;
  readonly block: ModelHostBlock;
  readonly command: FreshEvalCommand;
  /** L4-E12 (E1): the names of the run's services and the helper address of each (.16 to .47 of the round's slot). Pinned with `--add-host` (no sealed name server) or written in the hosts file (sealed). */
  readonly serviceHosts?: readonly RunHostEntry[];
  /** L4-E12 (E2): the sealed name server's two files, mounted read-only over /etc/resolv.conf and /etc/hosts (the run's own folder, never the checkout). Present: no `--dns` and no `--add-host`. */
  readonly dnsFiles?: FreshEvalDnsFiles;
}
export interface FreshEvalDnsFiles { readonly resolvConfPath: string; readonly hostsPath: string }
const RESOLV_CONF_TARGET = "/etc/resolv.conf";
const HOSTS_TARGET = "/etc/hosts";

/** The fresh sandbox's `docker run` arguments. Throws CONFIG_INVALID (a fixed sentence) when the result would not pass `freshEvalSandboxArgProblems`. Pure. */
export function freshEvalSandboxRunArgs(input: FreshEvalSandboxArgsInput, forbidden: { readonly bridgeDir: string }): string[] {
  const workdir = input.command.cwd === "." ? FRESH_EVAL_WORKSPACE : posix.join(FRESH_EVAL_WORKSPACE, input.command.cwd);
  const args = [
    "run", "--detach", "--pull=never", "--name", input.name, "--stop-timeout", "1", ...input.net.labelArgs(),
    "--network", input.net.name, "--ip", input.net.checkSandboxIp,
    // Sealed: the name server's own files are mounted (below) and the hostname is the check sandbox's; otherwise loopback DNS and the pinned names, as before (plus the run's service names, E1).
    ...(input.dnsFiles === undefined
      ? ["--dns", NO_UPSTREAM_DNS, ...modelHostAddHostArgs(input.block), ...(input.serviceHosts ?? []).flatMap((entry) => ["--add-host", `${entry.alias}:${entry.address}`])]
      // Sealed: Docker's embedded resolver (127.0.0.11) cannot be removed from a user-network container, so its ONLY upstream is the run's own sealed name server (`--dns`): an unpatched daemon that forwards the queries of an internal-only container then forwards them to the sinkholing, recording name server and never to the host's resolvers.
      : ["--dns", input.net.dnsHelperIp ?? "", "--hostname", CHECK_SANDBOX_HOSTNAME]),
    "--user", FRESH_EVAL_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--memory", FRESH_EVAL_MEMORY, "--memory-swap", FRESH_EVAL_MEMORY, "--cpus", FRESH_EVAL_CPUS, "--pids-limit", FRESH_EVAL_PIDS, "--log-driver", "json-file", ...FRESH_EVAL_LOG_OPTIONS.flatMap(option => ["--log-opt", option]),
    "--tmpfs", FRESH_EVAL_TMPFS,
    "--volume", `${input.checkout}:${FRESH_EVAL_WORKSPACE}:rw`,
    ...(input.dnsFiles === undefined ? [] : ["--volume", `${input.dnsFiles.resolvConfPath}:${RESOLV_CONF_TARGET}:ro`, "--volume", `${input.dnsFiles.hostsPath}:${HOSTS_TARGET}:ro`]),
    "--env-file", input.envFile,
    "--workdir", workdir,
    "--entrypoint", SANDBOX_INIT,
    input.image, "--", input.command.executable, ...input.command.args,
  ];
  const problems = freshEvalSandboxArgProblems(args, input.net, { checkout: input.checkout, bridgeDir: forbidden.bridgeDir, helperIp: input.block.address, ...(input.serviceHosts === undefined ? {} : { serviceHosts: input.serviceHosts }), ...(input.dnsFiles === undefined ? {} : { dnsFiles: input.dnsFiles }) });
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", "the fresh eval sandbox's arguments are unsound");
  return args;
}

const SANDBOX_VALUE_FLAGS: ReadonlySet<string> = new Set(["--name", "--stop-timeout", "--label", "--network", "--ip", "--dns", "--add-host", "--hostname", "--user", "--cap-drop", "--security-opt", "--memory", "--memory-swap", "--cpus", "--pids-limit", "--tmpfs", "--volume", "--env-file", "--workdir", "--entrypoint", "--log-driver", "--log-opt"]);
const SANDBOX_SINGLE_FLAGS: ReadonlySet<string> = new Set(["--detach", "--pull=never", "--read-only"]);
const isUnder = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder.replace(/\/+$/u, "")}/`) || folder.startsWith(`${path.replace(/\/+$/u, "")}/`);

/**
 * Reads the fresh sandbox's `docker run` arguments back and names every way they are unsound, in fixed words. Allow-list: a flag the sandbox does not take is a problem, so a second network, a published port, a capability,
 * a device, a second mount or the bridge folder cannot be added by accident. An empty list is a sound set.
 */
export function freshEvalSandboxArgProblems(args: readonly string[], net: Pick<ServicesNetwork, "name" | "checkSandboxIp"> & Partial<Pick<ServicesNetwork, "dnsHelperIp">>, expected: { readonly checkout: string; readonly bridgeDir: string; readonly helperIp: string | undefined; readonly serviceHosts?: readonly RunHostEntry[]; readonly dnsFiles?: FreshEvalDnsFiles }): string[] {
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
  const sealed = expected.dnsFiles !== undefined;
  // Sealed (E2): the name server is the run's own, through two mounted files, and the embedded resolver's only upstream is that same name server; `--add-host` is not used (a bind-mounted /etc/hosts would hide it). Not sealed: loopback DNS, as before.
  if (sealed) {
    if (net.dnsHelperIp === undefined || !only("--dns", net.dnsHelperIp)) problems.push("a sealed sandbox's only DNS server must be the run's own sealed name server");
    if (!only("--hostname", CHECK_SANDBOX_HOSTNAME)) problems.push("a sealed sandbox's host name is the check sandbox's");
  } else {
    if (!only("--dns", NO_UPSTREAM_DNS)) problems.push("the sandbox's only DNS server must be its own loopback (no upstream)");
    if (flags.has("--hostname")) problems.push("only a sealed sandbox sets its host name");
  }
  if (!only("--cap-drop", "ALL")) problems.push("the sandbox must drop every capability");
  if (!only("--security-opt", "no-new-privileges")) problems.push("the sandbox must have no-new-privileges and no other security option");
  if (!flags.has("--read-only")) problems.push("the sandbox's root must be read-only");
  if (!only("--user", FRESH_EVAL_USER)) problems.push("the sandbox must run as the non-root user");
  if (!only("--entrypoint", SANDBOX_INIT)) problems.push("the sandbox must start under the init");
  if (!only("--tmpfs", FRESH_EVAL_TMPFS)) problems.push("the sandbox has one tmpfs");
  const volumes = flags.get("--volume") ?? [];
  const wantedVolumes = [`${expected.checkout}:${FRESH_EVAL_WORKSPACE}:rw`, ...(expected.dnsFiles === undefined ? [] : [`${expected.dnsFiles.resolvConfPath}:${RESOLV_CONF_TARGET}:ro`, `${expected.dnsFiles.hostsPath}:${HOSTS_TARGET}:ro`])];
  if (volumes.length !== wantedVolumes.length || volumes.some((volume, index) => volume !== wantedVolumes[index])) problems.push(sealed ? "the sandbox has exactly three mounts: the checkout and the run's two name files, read-only" : "the sandbox has exactly one mount, the checkout");
  if (isUnder(expected.checkout, expected.bridgeDir)) problems.push("the sandbox must never mount the bridge folder");
  if (expected.dnsFiles !== undefined) for (const file of [expected.dnsFiles.resolvConfPath, expected.dnsFiles.hostsPath]) {
    if (!SAFE_HOST_PATH.test(file) || isUnder(file, expected.bridgeDir) || isUnder(file, expected.checkout)) problems.push("the name files are outside the checkout and the bridge folder");
  }
  const envFiles = flags.get("--env-file") ?? [];
  if (envFiles.length !== 1 || !SAFE_HOST_PATH.test(envFiles[0]!) || isUnder(envFiles[0]!, expected.bridgeDir) || isUnder(envFiles[0]!, expected.checkout)) problems.push("the sandbox takes one env file, outside its checkout and the bridge folder");
  for (const [flag, value] of [["--memory", FRESH_EVAL_MEMORY], ["--memory-swap", FRESH_EVAL_MEMORY], ["--cpus", FRESH_EVAL_CPUS], ["--pids-limit", FRESH_EVAL_PIDS], ["--stop-timeout", "1"], ["--log-driver", "json-file"], ["--name", `${net.name}-eval`]] as const) {
    if (!only(flag, value)) problems.push("a limit, the name or the log driver is not the fresh sandbox's own");
  }
  const logOptions = [...(flags.get("--log-opt") ?? [])].sort();
  if (logOptions.length !== 2 || logOptions[0] !== FRESH_EVAL_LOG_OPTIONS[1] || logOptions[1] !== FRESH_EVAL_LOG_OPTIONS[0]) problems.push("the fresh sandbox keeps one small capped log and no other log option");
  const workdirs = flags.get("--workdir") ?? [];
  if (workdirs.length !== 1 || (workdirs[0] !== FRESH_EVAL_WORKSPACE && !workdirs[0]!.startsWith(`${FRESH_EVAL_WORKSPACE}/`)) || workdirs[0]!.split("/").includes("..")) problems.push("the sandbox's working folder must be in its checkout");
  const labelKeys = (flags.get("--label") ?? []).map((label) => label.split("=")[0]!);
  const runLabels = [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL];
  if (labelKeys.length !== runLabels.length || runLabels.some((key) => labelKeys.filter((candidate) => candidate === key).length !== 1)) problems.push("the sandbox carries the round network's labels and no other");
  const serviceHosts = new Set((expected.serviceHosts ?? []).map((entry) => `${entry.alias}:${entry.address}`));
  if (sealed && flags.has("--add-host")) problems.push("a sealed sandbox pins no name with --add-host");
  // A pinned name points at the model helper, or is one of the run's own service names at that service's helper address (E1). Nothing else.
  // A service entry is checked again here (plain alias, an address in the run's helper range .16 to .47), not only where it was made.
  for (const entry of expected.serviceHosts ?? []) if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u.test(entry.alias) || !new RegExp(`^${net.checkSandboxIp.replace(/\.\d+$/u, "").replace(/\./gu, "\\.")}\\.(?:1[6-9]|2\\d|3\\d|4[0-6])$`, "u").test(entry.address)) problems.push("a service name is not a plain name at one of the run's helper addresses");
  for (const host of flags.get("--add-host") ?? []) if (!serviceHosts.has(host) && (expected.helperIp === undefined || host.slice(host.lastIndexOf(":") + 1) !== expected.helperIp)) problems.push("a pinned name points somewhere other than the model helper or one of the run's own services");
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
export function bridgeFolderMountProblems(input: { helper: Awaited<ReturnType<typeof containerMounts>>; sandbox: Awaited<ReturnType<typeof containerMounts>>; bridgeDir: string; checkout: string; dnsFiles?: FreshEvalDnsFiles | undefined }): string[] {
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
    // The checkout, and (sealed, E2) the run's own two name files read-only over /etc/resolv.conf and /etc/hosts: nothing else.
    const checkoutBinds = binds.filter((mount) => mount.destination === FRESH_EVAL_WORKSPACE);
    const others = binds.filter((mount) => mount.destination !== FRESH_EVAL_WORKSPACE);
    if (checkoutBinds.length !== 1 || realOrSelf(checkoutBinds[0]!.source) !== realOrSelf(input.checkout)) problems.push("the sandbox must mount the checkout and nothing else");
    const wanted = input.dnsFiles === undefined ? [] : [[RESOLV_CONF_TARGET, input.dnsFiles.resolvConfPath], [HOSTS_TARGET, input.dnsFiles.hostsPath]] as const;
    if (others.length !== wanted.length || !wanted.every(([target, source]) => others.some((mount) => mount.destination === target && !mount.rw && realOrSelf(mount.source) === realOrSelf(source)))) problems.push("the sandbox must mount the checkout and nothing else");
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
export function freshEvalEnvironment(input: { rowId: string; token: string; side: "old" | "new"; runs: 1 | 2 | 3; ids: readonly string[]; helperIp?: string; /** L4-E56: the path of the round's PUBLIC certificate inside the box: the trust variables (names and this one path; never a key or PEM text). */ standInCertificate?: string; /** L4-EVS: only when an environment was prepared: a `pip --user` install in the install step lives in the checkout and the run finds it. */ pythonUserBase?: boolean; /** L4-E12 (E1): the connection variables of the run's services (`DATABASE_URL`, `PG*`, `REDIS_URL`, ...): plain `[name, value]` pairs, after the model's and before the run's own. A name already set, or one of Rovara's, is refused. */ services?: ReadonlyArray<readonly [string, string]> }): string {
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
    ...(input.pythonUserBase === true ? [["PYTHONUSERBASE", EVAL_PYTHON_USER_BASE] as [string, string]] : []),
    ...(input.services ?? []).map(([name, value]): [string, string] => [name, value]),
    ...(input.standInCertificate === undefined ? [] : evalStandInTrustEnvironment(input.standInCertificate)),
    [FRESH_EVAL_SIDE_VARIABLE, input.side],
    [FRESH_EVAL_RUNS_VARIABLE, String(input.runs)],
    [FRESH_EVAL_IDS_VARIABLE, input.ids.join(",")],
  ];
  if (lines.some(([, value]) => !/^[\x21-\x7e]{1,40000}$/u.test(value))) throw new Error("the fresh eval environment is not plain");
  if (lines.some(([name]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)) || new Set(lines.map(([name]) => name)).size !== lines.length) throw new Error("the fresh eval environment names a variable twice or one that is not a plain name");
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

// ---- L4-EVS: the install phase (see eval-environment.ts). One approved install step, in its own box, BEFORE the round network exists.

const INSTALL_USER = FRESH_EVAL_USER;
const INSTALL_TMPFS = FRESH_EVAL_TMPFS;
const INSTALL_LOG_OPTIONS = ["max-size=64k", "max-file=1"] as const;
const WORKSPACE = FRESH_EVAL_WORKSPACE;
const INSTALL_NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export interface EvalInstallArgsInput {
  /** The machine's shared sandbox network (`agentx-task`, or the one `AGENTX_SANDBOX_NETWORK` names). Never the round's network. */
  readonly network: string;
  readonly image: string;
  readonly name: string;
  readonly checkout: string;
  readonly command: EvalInstallCommand;
  /** The operation's id and the worker's workspace key: the labels every task sandbox carries, so the worker's own leftover sweep finds an install box a crash left behind. */
  readonly taskId: string;
  readonly workspace: string;
}

/** The block every install box has: model names to a dropped address, no helper. A fresh value per call (pure). */
export function installModelBlock(): ModelHostBlock {
  return planModelHostBlock({ hasModelRow: false, nonAiGate: true, wallsOffered: true });
}

/** The `docker run` arguments of one install step. Throws CONFIG_INVALID (a fixed sentence) when the result would not pass `evalInstallArgProblems`. Pure. */
export function evalInstallRunArgs(input: EvalInstallArgsInput): string[] {
  const workdir = input.command.cwd === "." ? WORKSPACE : posix.join(WORKSPACE, input.command.cwd);
  const args = [
    "run", "--detach", "--pull=never", "--name", input.name, "--stop-timeout", "1",
    "--label", `${TASK_SANDBOX_LABEL}=${input.taskId}`, "--label", `${TASK_SANDBOX_WORKSPACE_LABEL}=${input.workspace}`,
    "--network", input.network, ...modelHostAddHostArgs(installModelBlock()),
    "--user", INSTALL_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--memory", "4g", "--memory-swap", "4g", "--cpus", "2", "--pids-limit", "1024",
    "--log-driver", "json-file", ...INSTALL_LOG_OPTIONS.flatMap(option => ["--log-opt", option]),
    "--tmpfs", INSTALL_TMPFS,
    "--volume", `${input.checkout}:${WORKSPACE}:rw`,
    "--env", "HOME=/tmp", "--env", `PYTHONUSERBASE=${EVAL_PYTHON_USER_BASE}`,
    "--workdir", workdir,
    "--entrypoint", SANDBOX_INIT,
    input.image, "--", input.command.executable, ...input.command.args,
  ];
  if (evalInstallArgProblems(args, { checkout: input.checkout, network: input.network }).length > 0) throw agentXError("CONFIG_INVALID", "the eval install step's arguments are unsound");
  return args;
}

const INSTALL_VALUE_FLAGS: ReadonlySet<string> = new Set(["--name", "--stop-timeout", "--label", "--network", "--add-host", "--user", "--cap-drop", "--security-opt", "--memory", "--memory-swap", "--cpus", "--pids-limit", "--log-driver", "--log-opt", "--tmpfs", "--volume", "--env", "--workdir", "--entrypoint"]);
const INSTALL_SINGLE_FLAGS: ReadonlySet<string> = new Set(["--detach", "--pull=never", "--read-only"]);

/** Reads an install step's `docker run` arguments back and names every way they are unsound, in fixed words. Allow-list: a flag the install box does not take (an env file, a second mount, a published port, a device, a DNS server, an address, a capability) is a problem. */
export function evalInstallArgProblems(args: readonly string[], expected: { readonly checkout: string; readonly network: string }): string[] {
  const problems: string[] = [];
  const flags = new Map<string, string[]>();
  let at = 0;
  if (args[at] !== "run") problems.push("it is not a docker run"); else at += 1;
  let image: string | undefined;
  while (at < args.length) {
    const token = args[at]!;
    if (INSTALL_SINGLE_FLAGS.has(token)) { flags.set(token, [...(flags.get(token) ?? []), ""]); at += 1; continue; }
    if (INSTALL_VALUE_FLAGS.has(token)) {
      const value = args[at + 1];
      if (value === undefined || value.startsWith("-")) { problems.push("a flag has no value"); at += 1; continue; }
      flags.set(token, [...(flags.get(token) ?? []), value]);
      at += 2;
      continue;
    }
    if (token.startsWith("-")) { problems.push("a flag the install box does not take"); at += 1; continue; }
    image = token;
    break;
  }
  const only = (flag: string, wanted: string): boolean => (flags.get(flag) ?? []).length === 1 && flags.get(flag)![0] === wanted;
  if (image === undefined || !/^(?:[A-Za-z0-9][A-Za-z0-9._/:-]{0,200}@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u.test(image)) problems.push("the install box must run the worker's pinned image");
  if (!INSTALL_NETWORK_NAME.test(expected.network) || !only("--network", expected.network)) problems.push("the install box must be on the shared sandbox network and on no other network");
  if (!only("--cap-drop", "ALL")) problems.push("the install box must drop every capability");
  if (!only("--security-opt", "no-new-privileges")) problems.push("the install box must have no-new-privileges and no other security option");
  if (!flags.has("--read-only")) problems.push("the install box's root must be read-only");
  if (!only("--user", INSTALL_USER)) problems.push("the install box must run as the non-root user");
  if (!only("--entrypoint", SANDBOX_INIT)) problems.push("the install box must start under the init");
  if (!only("--tmpfs", INSTALL_TMPFS)) problems.push("the install box has one tmpfs");
  const volumes = flags.get("--volume") ?? [];
  if (volumes.length !== 1 || volumes[0] !== `${expected.checkout}:${WORKSPACE}:rw`) problems.push("the install box has exactly one mount, the checkout");
  const envs = [...(flags.get("--env") ?? [])].sort();
  if (envs.length !== 2 || envs[0] !== "HOME=/tmp" || envs[1] !== `PYTHONUSERBASE=${EVAL_PYTHON_USER_BASE}`) problems.push("the install box takes two plain variables and no secret");
  const logOptions = [...(flags.get("--log-opt") ?? [])].sort();
  if (!only("--log-driver", "json-file") || logOptions.length !== 2 || logOptions[0] !== INSTALL_LOG_OPTIONS[1] || logOptions[1] !== INSTALL_LOG_OPTIONS[0]) problems.push("the install box keeps a small capped log");
  for (const [flag, value] of [["--memory", "4g"], ["--memory-swap", "4g"], ["--cpus", "2"], ["--pids-limit", "1024"], ["--stop-timeout", "1"]] as const) if (!only(flag, value)) problems.push("a limit is not the install box's own");
  const labelKeys = (flags.get("--label") ?? []).map(label => label.split("=")[0]!).sort();
  if (labelKeys.length !== 2 || labelKeys[0] !== TASK_SANDBOX_LABEL || labelKeys[1] !== TASK_SANDBOX_WORKSPACE_LABEL) problems.push("the install box carries the task sandbox labels and no other");
  const names = flags.get("--name") ?? [];
  if (names.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(names[0]!)) problems.push("the install box has one name");
  const workdirs = flags.get("--workdir") ?? [];
  if (workdirs.length !== 1 || (workdirs[0] !== WORKSPACE && !workdirs[0]!.startsWith(`${WORKSPACE}/`)) || workdirs[0]!.split("/").includes("..")) problems.push("the install box's working folder must be in its checkout");
  // Model names go nowhere (the dropped address); no name points at a helper, and the helper's own name is not added.
  for (const host of flags.get("--add-host") ?? []) if (!host.endsWith(`:${MODEL_BLACKHOLE_ADDRESS}`) || host.startsWith("rovara-models:")) problems.push("a pinned name points somewhere other than the dropped address");
  return problems;
}

/** The fresh eval check sandbox. See the section header above. */
export function createFreshEvalSandbox(config: FreshEvalSandboxConfig): FreshEvalSandbox {
  let rounds = 0;
  const docker = config?.docker;
  const call = (args: string[], timeoutMs = DOCKER_CALL_MS) => docker.run(args, { timeoutMs }).catch(() => ({ exitCode: -1, stdout: "", stderr: "", timedOut: false }));
  /** L4-E12: ONE round, shared by `run` (the paid eval: the model over the bridge) and `dryRun` (the free dry run: scripted replies, nothing bridged). A dry round hands what it saw to `dry.observed` and returns nothing. */
  const execute = async (input: FreshEvalSandboxRun, dry: { readonly observed: (seen: EvalDryRunObservation) => void } | undefined): Promise<FreshEvalSandboxResult | undefined> => {
      if (configProblem(config)) throw new Error("no fresh sandbox");
      if (runProblem(input)) throw new Error("fresh eval run unreadable");
      const dryRun = dry !== undefined;
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
      const installBoxes: string[] = [];
      let paused = false;
      let finished = false;
      let killed: Promise<unknown> | undefined;
      let installing: string | undefined;
      const kill = (): void => { if (sandboxName !== undefined) killed ??= call(["rm", "--force", sandboxName]); };
      // A stop also ends an install step that is running (its box is removed at once), not only the sealed sandbox.
      const onAbort = (): void => { kill(); if (installing !== undefined) void call(["rm", "--force", installing]); };
      input.signal.addEventListener("abort", onAbort, { once: true });
      let woke = true;
      // The one deadline of this run: the install steps and every sealed run share it (the old code gave the one sealed run the whole budget).
      const deadline = now() + config.roundBudgetMs;
      // A plan with no install step gives the sealed run the whole budget, exactly as before.
      let installed = false;
      const remainingMs = (): number => (installed ? Math.max(1, deadline - now()) : config.roundBudgetMs);
      // What must never show in a failed run's output tail: this run's token and the placeholder keys.
      const secrets: string[] = [input.model.token, MODEL_DUMMY_KEY];
      // L4-E12: the sealed name server (E2) is used when asked for, for a dry run, and (unless switched off) whenever the round has services; otherwise loopback DNS as before.
      // A stand-in always uses the sealed name server (a setting that says otherwise cannot leave the vendor names unresolved).
      const sealed = dryRun || config.sealedDns === true || config.standIns !== undefined || (config.sealedDns === undefined && config.services !== undefined);
      let servicesRun: EvalServicesStarted | undefined;
      let standIn: StartedEvalStandIns | undefined;
      const outcome = await (async (): Promise<FreshEvalSandboxResult | undefined> => { try {
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
        // 1a. L4-E56: the round's PUBLIC certificate, written NOW, before any install step runs repository code in a box that mounts this checkout read-write as the worker's own uid: such code could plant a link where the worker
        // writes. The folder is removed first (it is the worker's own materialized content, a link in it is removed as a link), made new, and the file created exclusively and never through a link. Never in a dry run.
        if (!dryRun && config.standIns !== undefined) {
          const certificateDir = join(checkout, dirname(EVAL_CA_RELATIVE_PATH));
          await rm(certificateDir, { recursive: true, force: true });
          await mkdir(certificateDir, { mode: 0o755 });
          await writeFile(join(checkout, EVAL_CA_RELATIVE_PATH), config.standIns.round.certificatePem, { mode: 0o644, flag: "wx" });
        }
        // 1b. L4-EVS: the environment. The saved image's dependency folders next to the commit's files, or (when there is none, or it cannot be used) the project's approved install steps, run now in a box with no
        // model route and gone before the round network exists. No environment in the plan: nothing here runs and the sealed run is exactly what it was.
        const environment = config.evalEnvironment;
        let installs: readonly EvalInstallCommand[] = [];
        if (environment?.kind === "saved") {
          const used = await (config.useSavedEnvironment ?? useSavedEnvironment)({ environment, checkout, docker, ...(config.now === undefined ? {} : { now: config.now }) });
          if (!used) installs = environment.fallbackInstall ?? [];
        } else if (environment?.kind === "install") installs = environment.commands;
        if (input.signal.aborted) throw new Error("eval stage stopped");
        // Only a plan with install steps reads the network setting (a plan without an environment is byte-identical to before).
        const installNetwork = installs.length === 0 ? "" : config.installNetwork ?? sandboxNetworkFromEnvironment(config.environment ?? process.env) ?? TASK_SANDBOX_NETWORK;
        const taskHash = createHash("sha256").update(`eval-install\0${config.taskId}`).digest("hex").slice(0, 12);
        let step = 0;
        for (const command of installs) {
          step += 1;
          const name = `rovara-eval-install-${taskHash}-${String(round)}-${String(step)}`;
          installBoxes.push(name);
          installing = name;
          installed = true;
          const started = await call(evalInstallRunArgs({ network: installNetwork, image: config.image, name, checkout, command, taskId: config.taskId, workspace: config.workspace }), SANDBOX_START_MS);
          if (started.exitCode !== 0) throw new EvalSandboxRunFailure(diagnoseEvalFailure({ phase: "install", output: started.stderr, secrets }));
          const waited = await call(["wait", name], Math.min(EVAL_INSTALL_STEP_MAX_MS, remainingMs()));
          if (input.signal.aborted) throw new Error("eval stage stopped");
          // A step that ran out of time is stopped BEFORE its log is read (the capped log survives until the box is removed).
          if (waited.timedOut === true) await call(["kill", name]);
          const logged = await call(["logs", "--tail", LOG_TAIL_LINES, name]);
          const code = /^-?\d+$/u.test(waited.stdout.trim()) ? Number(waited.stdout.trim()) : undefined;
          // The box is removed as soon as its output is read; an install step that did not end is killed (the removal below).
          await call(["rm", "--force", name]);
          installing = undefined;
          if (waited.timedOut === true) throw new EvalSandboxRunFailure(diagnoseEvalFailure({ phase: "install", timedOut: true, output: `${logged.stdout}\n${logged.stderr}`, secrets }));
          if (waited.exitCode !== 0 || code !== 0) throw new EvalSandboxRunFailure(diagnoseEvalFailure({ phase: "install", exitCode: code, output: `${logged.stdout}\n${logged.stderr}`, secrets }));
        }
        // 2. The helper's run files beside the socket (its one mount): the row it serves and an empty reply bundle (mode real answers from the bridge only).
        // A dry run answers every model call from a scripted reply (mode `scripted`, no bridge socket: nothing can reach the gateway, so nothing can cost money); a paid run's helper has no scripted reply (mode `real` over the bridge).
        const bundle = buildModelReplyBundle(dryRun ? DRY_RUN_REPLY_SETS : []);
        await writeFile(join(bridgeDir, "rows.json"), JSON.stringify([{ id: config.rowId, family: vertexRow ? "vertex" : "gemini" }]), { mode: 0o644 });
        await writeFile(join(bridgeDir, "replies.json"), modelReplyBundleBytes(bundle), { mode: 0o644 });
        // 3. The round network and the helper on it (.9), serving only the sandbox's address (.4), real mode over the bridge socket.
        helper = await startModelHelper(docker, {
          kind: "round", id: `${config.taskId}#${randomBytes(8).toString("hex")}`, round, workspace: config.workspace, roundBudgetMs: config.roundBudgetMs, image: config.image, runDir: bridgeDir,
          helperArgs: ({ listen, caller }) => modelHelperArgs({
            listen, port: MODEL_HELPER_DEFAULT_PORT, metaPort: vertexRow ? MODEL_METADATA_PORT : undefined, caller, mode: dryRun ? "scripted" : "real", rows: MODEL_HELPER_ROWS_PATH, replies: MODEL_HELPER_REPLIES_PATH, digest: modelReplyBundleDigest(bundle),
            ledger: MODEL_HELPER_LEDGER_PATH, blockState: "by_name", projectId: vertexRow ? EVAL_VERTEX_PLACEHOLDER.projectId : undefined, recordEscapes: false, ...(dryRun ? {} : { bridgeSocket: `${MODEL_HELPER_RUN_DIR}/${EVAL_BRIDGE_SOCKET_NAME}` }),
          }),
          ...(config.environment === undefined ? {} : { environment: config.environment }), ...(config.now === undefined ? {} : { now: config.now }), ...(config.sleep === undefined ? {} : { sleep: config.sleep }),
        });
        if (helper.sandboxRole !== "check") throw new Error("not a round network");
        const block = helper.sandboxBlock({});
        if (input.signal.aborted) throw new Error("eval stage stopped");
        // 4. L4-E12 (E1): this run's OWN copy of the project's services, on this round's network at .16 to .47 (never in a dry run: a dry run must SEE what the eval needs, so it is given nothing). A start that fails ends the run.
        if (!dryRun && config.services !== undefined) {
          servicesRun = await config.services.start(helper.network, input.signal);
          secrets.push(...servicesRun.secrets);
        }
        if (input.signal.aborted) throw new Error("eval stage stopped");
        // 4a. L4-E56: the round's outside-HTTP stand-in at the sinkhole's address (.47), serving only the box (.4) on ports 80 and 443. One retry; a second failure fails the run (a Rovara problem: the eval is "Not run", the task still
        // reaches its PR). The PUBLIC certificate was written into the checkout right after it was materialized (step 1a: before any install step can plant a link); the authority's key stays in the helper's own read-only mount and the worker's memory. Never in a dry run.
        let standInNames: string[] = [];
        if (!dryRun && config.standIns !== undefined) {
          const round = config.standIns.round;
          const reserved = new Set([...sealedModelHostPairs(block.block).map((pair) => pair.slice(0, pair.indexOf("="))), MODEL_HELPER_NAME, SINKHOLE_ALIAS, CHECK_SANDBOX_HOSTNAME]);
          standInNames = round.plan.map((entry) => entry.host).filter((host) => isEvalStandInPlanHost(host) && !reserved.has(host));
          const standInDir = join(runDir, "standin-run");
          await mkdir(standInDir, { mode: 0o700 });
          standIn = await (config.standIns.start ?? startEvalStandIns)({ docker, image: config.image, net: helper.network, parent: standInDir, content: round.setContent(), roundBudgetMs: config.roundBudgetMs, ...(config.sleep === undefined ? {} : { sleep: config.sleep }) });
          if (input.signal.aborted) throw new Error("eval stage stopped");
        }
        // 4b. L4-E12 (E2): the sealed name server at .2: the run's service names and the model hosts in its table, every other name to the sinkhole (.47), every unknown name recorded. Its two files are mounted read-only over /etc/resolv.conf and /etc/hosts.
        const sinkholeIp = runNetworkHelperIp(helper.network.slot, SINKHOLE_HELPER_INDEX);
        const serviceHosts: RunHostEntry[] = servicesRun === undefined || servicesRun.hosts.length === 0 ? [] : checkSandboxNames(helper.network, servicesRun.hosts, sinkholeIp).filter((entry) => entry.alias !== SINKHOLE_ALIAS);
        const dnsName = `${helper.network.name}-dns`;
        let dnsFiles: FreshEvalDnsFiles | undefined;
        if (sealed) {
          const names = checkSandboxNames(helper.network, serviceHosts, sinkholeIp);
          const modelPairs = sealedModelHostPairs(block.block);
          dnsFiles = { resolvConfPath: join(runDir, "resolv.conf"), hostsPath: join(runDir, "hosts") };
          await writeFile(dnsFiles.resolvConfPath, checkSandboxResolvConf(helper.network.dnsHelperIp), { flag: "wx", mode: 0o644 });
          await writeFile(dnsFiles.hostsPath, `${checkSandboxHostsFile(helper.network.checkSandboxIp, names)}${modelPairs.map((pair) => `${pair.slice(pair.indexOf("=") + 1)} ${pair.slice(0, pair.indexOf("="))}\n`).join("")}${standIn === undefined ? "" : evalStandInHostsLines(standIn.address, standInNames)}`, { flag: "wx", mode: 0o644 });
          await chmod(dnsFiles.resolvConfPath, 0o644);
          await chmod(dnsFiles.hostsPath, 0o644);
          const dnsStarted = await call([...sealedDnsHelperRunArgs({ net: helper.network, image: config.image, helpers: serviceHosts, sinkholeIp }), ...modelPairs.flatMap((pair) => ["--host", pair]), ...(standIn === undefined ? [] : evalStandInDnsPairs(standIn.address, standInNames).flatMap((pair) => ["--host", pair]))], SANDBOX_START_MS);
          if (dnsStarted.exitCode !== 0) throw new Error("the sealed name server could not start");
          await waitForSealedDnsHelper(docker, dnsName, { signal: input.signal, ...(config.now === undefined ? {} : { now: config.now }), ...(config.sleep === undefined ? {} : { sleep: config.sleep }) });
        }
        if (input.signal.aborted) throw new Error("eval stage stopped");
        // 5. The sandbox: the env file (0600, read by the docker CLI only), then the container on the round network only, then the daemon's own view of both containers' mounts.
        const name = `${helper.network.name}-eval`;
        /** Starts the sealed eval once (`runs` is what the command is told) and waits for it: its own exit, the run's deadline, or the signal (which kills the sandbox at once). */
        const sealedRun = async (runs: 1 | 2 | 3): Promise<{ notBeforeMs: number; code: number | undefined; timedOut: boolean; output: string }> => {
          await writeFile(envFile, freshEvalEnvironment({ rowId: config.rowId, token: input.model.token, side: input.side, runs, ids: input.ids, helperIp: helper!.helperIp, ...(environment === undefined ? {} : { pythonUserBase: true }), ...(servicesRun === undefined ? {} : { services: servicesRun.env }), ...(standIn === undefined ? {} : { standInCertificate: posix.join(FRESH_EVAL_WORKSPACE, EVAL_CA_RELATIVE_PATH) }) }), { mode: 0o600 });
          const args = freshEvalSandboxRunArgs({ net: helper!.network, image: config.image, name, checkout, envFile, block: block.block, command: config.command, ...(serviceHosts.length === 0 ? {} : { serviceHosts }), ...(dnsFiles === undefined ? {} : { dnsFiles }) }, { bridgeDir });
          const notBeforeMs = now();
          sandboxName = name;
          const started = await call(args, SANDBOX_START_MS);
          await rm(envFile, { force: true });
          if (started.exitCode !== 0) throw new Error("the fresh sandbox could not start");
          const mounts = bridgeFolderMountProblems({ helper: await containerMounts(docker, helper!.helperName), sandbox: await containerMounts(docker, name), bridgeDir, checkout, dnsFiles });
          if (mounts.length > 0) { kill(); throw new Error("the fresh sandbox is not isolated from the bridge folder"); }
          // 6. Wait for the eval to end.
          const waited = await call(["wait", name], remainingMs());
          if (input.signal.aborted) throw new Error("eval stage stopped");
          const timedOut = waited.timedOut === true;
          if (!timedOut && (waited.exitCode !== 0 || !/^-?\d+$/u.test(waited.stdout.trim()))) { kill(); throw new Error("the fresh sandbox did not finish"); }
          // Stopped BEFORE the log is read, so a run past its deadline keeps no model access while the worker reads.
          if (timedOut) await call(["kill", name]);
          const logged = await call(["logs", "--tail", LOG_TAIL_LINES, name]);
          if (timedOut) kill();
          return { notBeforeMs, code: timedOut ? undefined : Number(waited.stdout.trim()), timedOut, output: `${logged.stdout}\n${logged.stderr}` };
        };
        const reportTarget = join(checkout, config.report.cwd, config.report.argument);
        const readReport = (notBeforeMs: number) => readContainedReport({ root: checkout, cwd: config.report.cwd, argument: config.report.argument, maxBytes: TEST_REPORT_MAX_BYTES, notBeforeMs });
        /** A run that left no readable report AND did not end well is a failed eval with a named cause; one that ended well without a report reads as it always did (no measures file). */
        const failed = (run: Awaited<ReturnType<typeof sealedRun>>): EvalSandboxRunFailure => new EvalSandboxRunFailure(diagnoseEvalFailure({ phase: "run", exitCode: run.code, timedOut: run.timedOut, output: run.output, secrets, modelRoute: { hosts: block.block.hosts, suffixes: block.block.suffixesNotBlockedByName } }));
        const firstRun = await sealedRun(input.runs);
        // L4-E12 (E2): a dry run reads no report. It hands back what the one run left: its output, how it ended and the sealed name server's record (read while the name server still runs), then everything is stopped below.
        if (dry !== undefined) {
          const dns = dnsFiles === undefined ? { unknown: [], dropped: 0, unrecorded: 0 } : await readSealedDnsRecord(docker, dnsName);
          dry.observed({ code: firstRun.code, timedOut: firstRun.timedOut, output: firstRun.output, dns, modelRoute: { hosts: [...block.block.hosts], suffixes: [...block.block.suffixesNotBlockedByName] }, secrets: [...secrets], sinkholeIp });
          finished = true;
          return undefined;
        }
        const firstRead = await readReport(firstRun.notBeforeMs);
        let notBeforeMs = firstRun.notBeforeMs;
        let bytes: Buffer | undefined;
        // A run that ran out of time is a failed run, whatever it wrote.
        if (firstRun.timedOut) throw failed(firstRun);
        if (!firstRead.ok) {
          if (firstRun.code !== 0) throw failed(firstRun);
        } else {
          bytes = firstRead.bytes;
          // 7a. The customer's own output: a per-case report (JUnit, a test runner's JSON, promptfoo) is one run's result. The command runs once per run (the first run was told `runs`; a measures-file command loops by itself), and the
          // reports become Rovara's measures file here, so nothing downstream changes. Anything else (a measures file) is copied as it is.
          const text = ((): string | undefined => { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(firstRead.bytes); } catch { return undefined; } })();
          const firstRows = text === undefined ? undefined : caseRowsOf(text);
          if (firstRows !== undefined) {
            const reports: CaseRow[][] = [firstRows];
            let converted: Buffer | undefined;
            for (let more = 1; more < input.runs; more += 1) {
              // The earlier report goes first: a run that wrote nothing must not leave one that looks fresh.
              await rm(reportTarget, { force: true }).catch(() => undefined);
              await call(["rm", "--force", name]);
              const next = await sealedRun(1);
              if (next.timedOut) throw failed(next);
              const read = await readReport(next.notBeforeMs);
              const rows = read.ok ? ((): CaseRow[] | undefined => { try { return caseRowsOf(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes)); } catch { return undefined; } })() : undefined;
              if (rows === undefined) { if (!read.ok && next.code !== 0) throw failed(next); reports.length = 0; break; }
              reports.push(rows);
              notBeforeMs = next.notBeforeMs;
            }
            const measures = reports.length === input.runs ? measuresFromCaseReports(reports, input.ids) : undefined;
            if (measures !== undefined) converted = Buffer.from(measures, "utf8");
            bytes = converted;
          }
        }
        // 7b. The report, out of the checkout before it goes: A4's contained, fresh, bounded read (done above); nothing is copied unless the whole file is read.
        if (bytes !== undefined) {
          const target = join(reportRoot, config.report.cwd, config.report.argument);
          if (!target.startsWith(`${reportRoot}/`)) throw new Error("the eval report is outside its folder");
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, bytes, { mode: 0o600 });
        }
        // 8. L4-E56: the stand-in's summary, read while the helper is still up and after the sandbox's last exit (the helper writes it before it sends each answer). An unreadable one says nothing, so the run counts as having hit a gap.
        const standInResult = config.standIns === undefined || standIn === undefined ? undefined : config.standIns.round.absorb(await standIn.summary().catch(() => undefined));
        finished = true;
        return {
          report: { root: reportRoot, cwd: config.report.cwd, argument: config.report.argument, notBeforeMs: Math.min(notBeforeMs, firstRun.notBeforeMs) },
          ...(input.side === "old" ? { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: commit }) } : {}),
          ...(standInResult === undefined ? {} : { standIns: standInResult }),
        };
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        // Join: the sandbox is gone, then the helper and its network, then the working sandbox runs again, then nothing of the run stays on disk (the report copy stays in the caller's scratch).
        kill();
        await killed;
        // Once more after the first removal has returned: a removal sent while `docker run` was still creating the container may have found nothing. (The network's stop also removes every container with its labels.)
        if (sandboxName !== undefined) await call(["rm", "--force", sandboxName]);
        for (const box of installBoxes) await call(["rm", "--force", box]);
        // This run's services go before the network does (the network's own stop would remove them too; this one waits for their files).
        await standIn?.stop().catch(() => undefined);
        await servicesRun?.stop().catch(() => undefined);
        await helper?.stop().catch(() => undefined);
        if (paused && config.workingSandbox !== null) {
          await call(["unpause", config.workingSandbox]);
          woke = (await call(["inspect", "--format", "{{.State.Paused}}", config.workingSandbox])).stdout.trim() === "false";
        }
        await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
        // A dry run copies no report out, so its report folder never stays.
        if (!finished || dryRun) await rm(reportRoot, { recursive: true, force: true }).catch(() => undefined);
        await rm(join(bridgeDir, "rows.json"), { force: true }).catch(() => undefined);
        await rm(join(bridgeDir, "replies.json"), { force: true }).catch(() => undefined);
      } })();
      // A working sandbox left paused is a fault of its own (checked after every other step is done): the run is not a result.
      if (!woke) throw new Error("the working sandbox could not be unpaused");
      return outcome;
  };
  return {
    available(): boolean {
      if (configProblem(config)) return false;
      try { return modelHelperOffer(config.environment ?? process.env).offered; } catch { return false; }
    },
    async run(input: FreshEvalSandboxRun): Promise<FreshEvalSandboxResult> {
      const done = await execute(input, undefined);
      if (done === undefined) throw new Error("fresh eval run unreadable");
      return done;
    },
    async dryRun(input: FreshEvalDryRun): Promise<EvalDryRunObservation> {
      if (configProblem(config)) throw new Error("no fresh sandbox");
      if (!(input?.signal instanceof AbortSignal)) throw new Error("fresh eval run unreadable");
      await mkdir(config.scratchDir, { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(join(config.scratchDir, "dry-"));
      try {
        // The helper's one mount is a folder named `models`; a dry run has no bridge, so it holds only the helper's own run files.
        const bridgeDir = join(dir, EVAL_HELPER_DIR_NAME);
        await mkdir(bridgeDir, { mode: 0o700 });
        let seen: EvalDryRunObservation | undefined;
        // The old side is main (the configured base commit). The token is a placeholder that opens nothing: there is no bridge for it to reach.
        await execute({ side: "old", ids: input.ids, runs: 1, signal: input.signal, model: { socketPath: join(bridgeDir, EVAL_BRIDGE_SOCKET_NAME), token: DRY_RUN_TOKEN } }, { observed: (value) => { seen = value; } });
        if (seen === undefined) throw new Error("the dry run left nothing");
        return seen;
      } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
    },
  };
}
