import type { WorkerInvocation } from "@agentx/contracts";
import type { WorkerTerminalResult } from "./server.js";
import type { createWorkerCallbackSinks } from "./callback-client.js";

type CallbackSinks = ReturnType<typeof createWorkerCallbackSinks>;

/** Keep committed source bytes on their private capability and out of the ordinary/model result callback. */
export async function postWorkerTerminalResult(
  callbacks: Pick<CallbackSinks, "candidateSourceExportSink" | "terminalSink"> & Partial<Pick<CallbackSinks, "candidateBuildSourceSink" | "baselineSourceSink">>,
  result: WorkerTerminalResult,
  invocation: WorkerInvocation,
  log: (event: Record<string, unknown>) => void = (event) => console.log(JSON.stringify(event)),
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
      catch (error) {
        // Not delivering it never fails the export, but the cause is on record so a broker failure or a deploy skew is not mistaken for an old worker.
        const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
        log({ component: "worker", level: "warn", event: "candidate-build-source.delivery_failed", operationId: result.operationId,
          errorCode: typeof code === "string" ? code : "UNKNOWN", errorMessage: (error instanceof Error ? error.message : "unknown failure").slice(0, 300) });
      }
    }
    // M1.3 Task 3.7b: the unchanged code, for the baseline round, follows the candidate's export on its own request. Like the build source it only informs a round that never
    // gates, so no failure to deliver it may fail the export or the terminal result: without it the baseline says it could not be checked.
    const baselineSource = reported.workflowBaselineSource;
    if (baselineSource !== undefined && callbacks.baselineSourceSink !== undefined) {
      try { await callbacks.baselineSourceSink(baselineSource as Parameters<NonNullable<CallbackSinks["baselineSourceSink"]>>[0]); }
      catch (error) {
        const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
        log({ component: "worker", level: "warn", event: "baseline-source.delivery_failed", operationId: result.operationId,
          errorCode: typeof code === "string" ? code : "UNKNOWN", errorMessage: (error instanceof Error ? error.message : "unknown failure").slice(0, 300) });
      }
    }
    const { workflowCandidateSourceExport: _sourceExport, workflowCandidateBuildSource: _buildSource, workflowBaselineSource: _baselineSource, ...terminalResult } = reported;
    void _sourceExport; void _buildSource; void _baselineSource;
    await callbacks.terminalSink({ ...result, result: terminalResult });
    return;
  }
  // Whatever else it carries, the unchanged code's export never travels on the model-visible result.
  if (reported?.workflowBaselineSource !== undefined) {
    const { workflowBaselineSource: baselineSource, ...terminalResult } = reported;
    // T7a: a planning run that was asked for the unchanged code (to ground the plan's must-not-change scenarios) delivers it on the same request as a coding run's, with the same
    // rule: it only informs a round that never gates, so no failure to deliver it may fail the terminal result.
    if (invocation.kind === "task" && invocation.payload.workflowMode === "PLAN" && invocation.payload.workflowE2EGroundingSource === true && callbacks.baselineSourceSink !== undefined) {
      try { await callbacks.baselineSourceSink(baselineSource as Parameters<NonNullable<CallbackSinks["baselineSourceSink"]>>[0]); }
      catch (error) {
        const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
        // Only the fixed code: the text of a failure is not logged for a planning run.
        log({ component: "worker", level: "warn", event: "grounding-source.delivery_failed", operationId: result.operationId, errorCode: typeof code === "string" ? code : "UNKNOWN" });
      }
    }
    await callbacks.terminalSink({ ...result, result: terminalResult });
    return;
  }
  await callbacks.terminalSink(result);
}
