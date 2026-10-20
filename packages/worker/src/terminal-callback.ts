import type { WorkerInvocation } from "@agentx/contracts";
import type { WorkerTerminalResult } from "./server.js";
import type { createWorkerCallbackSinks } from "./callback-client.js";

type CallbackSinks = ReturnType<typeof createWorkerCallbackSinks>;

/** Keep committed source bytes on their private capability and out of the ordinary/model result callback. */
export async function postWorkerTerminalResult(
  callbacks: Pick<CallbackSinks, "candidateSourceExportSink" | "terminalSink"> & Partial<Pick<CallbackSinks, "candidateBuildSourceSink">>,
  result: WorkerTerminalResult,
  invocation: WorkerInvocation,
): Promise<void> {
  const reported = result.result !== null && typeof result.result === "object" && !Array.isArray(result.result)
    ? result.result as Record<string, unknown> : undefined;
  const sourceExport = reported?.workflowCandidateSourceExport;
  if (reported !== undefined && sourceExport !== undefined) {
    if (invocation.kind !== "task" || invocation.payload.workflowMode !== "IMPLEMENT") {
      throw new Error("committed candidate source export is limited to implementation tasks");
    }
    await callbacks.candidateSourceExportSink(sourceExport as Parameters<CallbackSinks["candidateSourceExportSink"]>[0]);
    // The build source follows the export on its own request. It only ever informs application dispatch, so no failure to deliver it may fail the
    // portable export or the terminal result: without it the broker refuses an application round with a reason.
    const buildSource = reported.workflowCandidateBuildSource;
    if (buildSource !== undefined && callbacks.candidateBuildSourceSink !== undefined) {
      try { await callbacks.candidateBuildSourceSink(buildSource as Parameters<CallbackSinks["candidateBuildSourceSink"]>[0]); }
      catch { /* a missing build source is a later, explained refusal, never a failed export */ }
    }
    const { workflowCandidateSourceExport: _sourceExport, workflowCandidateBuildSource: _buildSource, ...terminalResult } = reported;
    void _sourceExport; void _buildSource;
    await callbacks.terminalSink({ ...result, result: terminalResult });
    return;
  }
  await callbacks.terminalSink(result);
}
