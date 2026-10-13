import type { E2ECollection, E2ERunInput, E2ERuntimePorts } from "@agentx/contracts";

const CLEANUP_CAP_MS = 60_000;

function emptyCollection(input: { startedAt: string; process?: E2ECollection["process"]; cleanup: E2ECollection["cleanup"] }): E2ECollection {
  return { process: input.process ?? { exitCode: null, timedOut: false, aborted: false }, rawReport: null, observedUpstreamRunId: null, coverageByCase: new Map(), artifacts: [], modelReceiptIds: [], startedAt: input.startedAt, finishedAt: new Date().toISOString(), cleanup: input.cleanup };
}

function composeOperationSignal(parent: AbortSignal, deadlineAt: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let deadlineExpired = false;
  const onParentAbort = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", onParentAbort, { once: true });
  const delay = Math.max(0, deadlineAt - Date.now());
  const timer = setTimeout(() => { deadlineExpired = true; controller.abort(new Error("E2E round deadline elapsed")); }, delay);
  return { signal: controller.signal, timedOut: () => deadlineExpired, dispose: () => { clearTimeout(timer); parent.removeEventListener("abort", onParentAbort); } };
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
  try {
    if (operation.signal.aborted) throw operation.signal.reason;
    lease = await ports.allocate(input, operation.signal);
    if (operation.signal.aborted) throw operation.signal.reason;
    collected = await lease.execute(operation.signal);
  } catch {
    failed = true;
  } finally {
    operation.dispose();
  }
  const cleanup = lease ? await closeWithIndependentDeadline(lease) : failed ? "pending" : "confirmed";
  if (!collected) return emptyCollection({ startedAt, process: { exitCode: null, timedOut: operation.timedOut(), aborted: signal.aborted }, cleanup });
  const finalCleanup = collected.cleanup === "failed" ? "failed" : collected.cleanup === "pending" || cleanup === "pending" ? "pending" : cleanup === "failed" ? "failed" : "confirmed";
  return { ...collected, cleanup: finalCleanup };
}
