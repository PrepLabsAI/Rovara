import { invalidModelAccess } from "./token.js";

export interface TaskTokenDeadline { check(): void }
/** One elapsed-time budget for all reads, description and signing in this request. */
export async function withinTaskTokenDeadline<T>(work: (deadline: TaskTokenDeadline) => Promise<T>): Promise<T> {
  const end = performance.now() + 30_000;
  let expired = false;
  // A delayed event loop must not publish or sign before the timer gets its turn.
  const guard: TaskTokenDeadline = { check() { if (expired || performance.now() >= end) throw invalidModelAccess(); } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(invalidModelAccess()); }, 30_000);
  });
  try { return await Promise.race([work(guard), deadline]); }
  finally { clearTimeout(timer); expired = true; }
}
