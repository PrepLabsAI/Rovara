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
// `changedPrompt` classifier names, and is 0 when there is no classifier (the eval then reads "no changed prompt call", never a pass).
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { EvalBaseAttestation, ModelEgress, ModelEgressFrame } from "@agentx/contracts";
import { createModelBridge } from "../model-bridge.js";
import { createModelBridgeLedger } from "../model-bridge-ledger.js";
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
 * confirmed eval command run in it for one side, and everything stopped before `run` resolves, also on abort. Not built in this base (TE-B1); the worker passes none.
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
  /** The worker's own classifier for "this frame carries a changed prompt". Absent: no call counts, and the eval reads "no changed prompt call". */
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
      const changed = ((): boolean => { try { return options.changedPrompt?.(frame) === true; } catch { return false; } })();
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
      const dir = await mkdtemp(join(options.runDir, "eval-"));
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
          // The product route serves one family; the frame parser has already refused a row that is not a plain catalog word.
          familyOf: () => "gemini",
          ledger: createModelBridgeLedger({ now }),
          now,
          limits: { calls: EVAL_BRIDGE_CALLS_MAX, concurrent: EVAL_BRIDGE_CONCURRENT_MAX, connections: EVAL_BRIDGE_CONNECTIONS_MAX },
          log: (fields) => { if (fields["event"] === "refused" || fields["class"] === "refused") bridgeRefused = true; },
        });
        const socketPath = join(dir, "m.sock");
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
