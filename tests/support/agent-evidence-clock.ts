import { vi } from "vitest";

/** Capture the harvest clock AFTER assembly: the host stamps its supervisor proof after owned close. */
export async function retainEvidenceCollection<T>(assemble: () => T | Promise<T>) {
  const evidence = await assemble();
  return { evidence, collectedAt: new Date().toISOString() };
}

/** Only Date is controlled: executor, socket and browser timers keep running normally. Callers must run serially. */
export async function atEvidenceCollectionTime<T>(at: string, work: () => T | Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  try { return await work(); } finally { vi.useRealTimers(); }
}
