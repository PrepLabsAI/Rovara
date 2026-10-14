import type { WorkerInvocation } from "@agentx/contracts";
import type { WorkerTerminalResult } from "./server.js";
import type { createWorkerCallbackSinks } from "./callback-client.js";

type CallbackSinks = ReturnType<typeof createWorkerCallbackSinks>;

/** Keep committed source bytes on their private capability and out of the ordinary/model result callback. */
export async function postWorkerTerminalResult(
  callbacks: Pick<CallbackSinks, "candidateSourceExportSink" | "terminalSink">,
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
    const { workflowCandidateSourceExport: _sourceExport, ...terminalResult } = reported;
    void _sourceExport;
    await callbacks.terminalSink({ ...result, result: terminalResult });
    return;
  }
  await callbacks.terminalSink(result);
}
