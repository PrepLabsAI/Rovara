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
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { EvalBaseAttestation, ModelEgress, ModelEgressEvent, ModelEgressFrame } from "@agentx/contracts";
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
  readonly now?: () => number;
}

/** The bridge's own call limit for one run. The stage already holds the exact count; this only stops a runaway client, and must never be the first line (the bridge's default of 200 is below an eval budget). */
export const EVAL_BRIDGE_CALLS_MAX = 10_000;
const ROW = /^[a-z][a-z0-9-]{0,39}$/u;

/** The egress, counting (for the worker only) the calls that settled ok and carry a changed prompt. Events pass through untouched. */
function countingEgress(inner: ModelEgress, changedPrompt: BridgedEvalExecOptions["changedPrompt"], onChanged: () => void): ModelEgress {
  return {
    capabilities: inner.capabilities,
    async *forward(scope, frame, options) {
      let changed = false;
      try { changed = changedPrompt?.(frame) === true; } catch { changed = false; }
      let counted = false;
      for await (const event of inner.forward(scope, frame, options) as AsyncIterable<ModelEgressEvent>) {
        // Counted when the settle arrives, before it is passed on: the sandbox cannot end before the count is in.
        if (event.kind === "settle" && changed && !counted && event.class === "ok") { counted = true; onChanged(); }
        yield event;
      }
    },
  };
}

let runs = 0;

export function createBridgedEvalExec(options: BridgedEvalExecOptions): EvalSandboxExec {
  return {
    async run(request: EvalSandboxRequest): Promise<EvalSandboxResult> {
      if (typeof options.sandbox?.available !== "function" || typeof options.sandbox.run !== "function" || !options.sandbox.available()) throw new Error("no fresh sandbox");
      if (!isAbsolute(options.runDir)) throw new Error("the eval run folder must be absolute");
      if (request.signal.aborted) throw new Error("eval stage stopped");
      const now = options.now ?? Date.now;
      const execId = `eval-${request.side}-${String(++runs)}`;
      const dir = await mkdtemp(join(options.runDir, "eval-"));
      let bridge: ReturnType<typeof createModelBridge> | undefined;
      try {
        await chmod(dir, 0o700);
        let changedPromptCalls = 0;
        bridge = createModelBridge({
          egress: countingEgress(request.egress, options.changedPrompt, () => { changedPromptCalls += 1; }),
          egressScope: request.scope,
          roundKind: "check_unsealed",
          // The product route serves one family; a row the eval names that is not a plain catalog word is refused by the bridge ("not found").
          familyOf: (row) => (ROW.test(row) ? "gemini" : undefined),
          ledger: createModelBridgeLedger({ now }),
          now,
          limits: { calls: EVAL_BRIDGE_CALLS_MAX },
        });
        const socketPath = join(dir, "m.sock");
        await bridge.listen(socketPath);
        const token = bridge.issueToken(execId, "check_unsealed", ["real"]);
        let result: Awaited<ReturnType<FreshEvalSandbox["run"]>>;
        try { result = await options.sandbox.run({ side: request.side, ids: request.ids, runs: request.runs, signal: request.signal, model: { socketPath, token } }); }
        finally { bridge.dropToken(execId); }
        return {
          report: result.report, changedPromptCalls,
          ...(request.side === "old" && result.attestation !== undefined ? { attestation: result.attestation } : {}),
        };
      } finally {
        // The token is gone first (above); then no call is left open, and nothing of the run stays on disk.
        await bridge?.close().catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
