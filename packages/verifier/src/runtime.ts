import type { E2ECollection, E2ERunInput, E2ERuntimePorts } from "@agentx/contracts";

const CLEANUP_CAP_MS = 60_000;

function emptyCollection(input: { startedAt: string; process?: E2ECollection["process"]; cleanup: E2ECollection["cleanup"] }): E2ECollection {
  return { process: input.process ?? { exitCode: null, timedOut: false, aborted: false }, rawReport: null, observedUpstreamRunId: null, coverageByCase: new Map(), artifacts: [], modelReceiptIds: [], startedAt: input.startedAt, finishedAt: new Date().toISOString(), cleanup: input.cleanup };
}

function composeOperationSignal(parent: AbortSignal, deadlineAt: number): { signal: AbortSignal; timedOut: () => boolean; parentAborted: () => boolean; expired: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let deadlineExpired = false;
  let parentWasAborted = parent.aborted;
  const onParentAbort = () => { parentWasAborted = true; controller.abort(parent.reason); };
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", onParentAbort, { once: true });
  const delay = Math.max(0, deadlineAt - Date.now());
  const timer = setTimeout(() => { deadlineExpired = true; controller.abort(new Error("E2E round deadline elapsed")); }, delay);
  const expired = () => { if (!controller.signal.aborted && Date.now() >= deadlineAt) { deadlineExpired = true; controller.abort(new Error("E2E round deadline elapsed")); } return controller.signal.aborted || Date.now() >= deadlineAt; };
  return { signal: controller.signal, timedOut: () => deadlineExpired || Date.now() >= deadlineAt && !parentWasAborted, parentAborted: () => parentWasAborted, expired, dispose: () => { clearTimeout(timer); parent.removeEventListener("abort", onParentAbort); } };
}

function awaitUntilStopped<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("E2E operation aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("E2E operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    value.then((result) => { signal.removeEventListener("abort", onAbort); resolve(result); }, (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error instanceof Error ? error : new Error("E2E operation failed")); });
  });
}

async function closeWithIndependentDeadline(lease: Awaited<ReturnType<E2ERuntimePorts["allocate"]>>): Promise<"confirmed" | "pending" | "failed"> {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(new Error("E2E owned cleanup deadline elapsed")); }, CLEANUP_CAP_MS);
  try {
    const result = await Promise.race([
      lease.close(controller.signal),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("E2E cleanup aborted")), { once: true })),
    ]);
    return result.confirmed ? "confirmed" : "pending";
  } catch {
    return expired ? "pending" : "failed";
  } finally {
    clearTimeout(timer);
  }
}

/** Run one already-admitted lease with one absolute round deadline and a separate owned cleanup window. */
export async function runIsolatedE2E(input: E2ERunInput, ports: E2ERuntimePorts, signal: AbortSignal): Promise<E2ECollection> {
  const startedAt = new Date().toISOString();
  const deadlineAt = Date.parse(input.binding.deadlineAt);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) return emptyCollection({ startedAt, process: { exitCode: null, timedOut: false, aborted: signal.aborted }, cleanup: "confirmed" });
  const operation = composeOperationSignal(signal, deadlineAt);
  let lease: Awaited<ReturnType<E2ERuntimePorts["allocate"]>> | undefined;
  let collected: E2ECollection | undefined;
  let failed = false;
  let lateAllocation = false;
  try {
    if (operation.expired()) throw operation.signal.reason;
    const allocation = ports.allocate(input, operation.signal);
    try { lease = await awaitUntilStopped(allocation, operation.signal); }
    catch (error) {
      if (operation.expired()) {
        lateAllocation = true;
        void allocation.then((lateLease) => closeWithIndependentDeadline(lateLease)).catch(() => undefined);
      }
      throw error;
    }
    if (operation.expired()) throw operation.signal.reason;
    const execution = lease.execute(operation.signal);
    collected = await awaitUntilStopped(execution, operation.signal);
    if (operation.expired()) collected = undefined;
  } catch {
    failed = true;
  } finally {
    operation.dispose();
  }
  const cleanup = lease ? await closeWithIndependentDeadline(lease) : lateAllocation ? "pending" : failed ? "pending" : "confirmed";
  if (!collected) return emptyCollection({ startedAt, process: { exitCode: null, timedOut: operation.timedOut(), aborted: operation.parentAborted() }, cleanup });
  const finalCleanup = collected.cleanup === "failed" ? "failed" : collected.cleanup === "pending" || cleanup === "pending" ? "pending" : cleanup === "failed" ? "failed" : "confirmed";
  return { ...collected, cleanup: finalCleanup };
}
