import { agentXError } from "@agentx/contracts";
import { boundedCompanyReads, COMPANY_READ_LIMITS } from "./company-check.js";

export interface AbortableReadSender {
  send(command: unknown, options: { abortSignal: AbortSignal }): Promise<unknown>;
}
export interface ServerKeyRead {
  abortSignal: AbortSignal;
  readCounted<T>(work: () => Promise<T>, countRows: (result: T) => number): Promise<T>;
}

export interface ServerReadContext extends ServerKeyRead {
  budget: ReturnType<typeof boundedCompanyReads>;
  client: { send(command: unknown): Promise<unknown> };
  readFailed(): boolean;
  check(): void;
  close(): Promise<void>;
}

/** One lifetime for authentication, local authority and projection. No detached I/O race. */
export function serverReadContext(sender: AbortableReadSender, clock: () => number = Date.now): ServerReadContext {
  const controller = new AbortController();
  const deadline = clock() + COMPANY_READ_LIMITS.milliseconds;
  let closed = false;
  let failedRead = false;
  const pending = new Set<Promise<unknown>>();
  const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Server read is unavailable.");
  const active = () => {
    if (closed || controller.signal.aborted || clock() >= deadline) {
      controller.abort(); throw unavailable();
    }
  };
  const timer = setTimeout(() => controller.abort(), COMPANY_READ_LIMITS.milliseconds);
  timer.unref?.();
  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    active();
    const result = work(); pending.add(result);
    try { const value = await result; active(); return value; }
    catch (error) { failedRead = true; throw error; }
    finally { pending.delete(result); }
  };
  const budget = boundedCompanyReads({ send: (command) => track(() => sender.send(command, { abortSignal: controller.signal })) }, clock);
  const check = () => { active(); budget.check(); };
  return {
    budget, abortSignal: controller.signal,
    client: { send: async (command: unknown) => { check(); const result = await budget.client.send(command); check(); return result; } },
    readCounted: <T>(work: () => Promise<T>, countRows: (result: T) => number) => budget.readCounted(() => track(work), countRows),
    readFailed: () => failedRead,
    check,
    async close() {
      closed = true; clearTimeout(timer); controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
