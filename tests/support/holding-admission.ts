// An `Admission` that really holds what it is asked for: each reservation is held until it is settled or released, once. A second resolution, or one for an id it never gave, is a violation; a test reads
// `open()` to see what is still held (a leak) and `settled`/`released` to see which way each went.
import type { Admission, AdmissionRequest } from "@agentx/contracts";

export function holdingAdmission() {
  const asked: AdmissionRequest[] = [];
  const state = new Map<string, "held" | "settled" | "released">();
  const settled: Array<{ id: string; tokens: number | undefined }> = [];
  const released: string[] = [];
  const violations: string[] = [];
  let gate: Promise<void> | undefined;
  const admission: Admission = {
    async admit(request) {
      asked.push(request);
      const id = `held-${String(asked.length)}`;
      state.set(id, "held");
      if (gate !== undefined) await gate;
      return { allowed: true, reservationId: id };
    },
    async stage(request) { return { decision: await admission.admit(request), items: [] }; },
    async settle(id, actual) {
      if (state.get(id) !== "held") violations.push(`settle ${id} while ${state.get(id) ?? "unknown"}`);
      state.set(id, "settled");
      settled.push({ id, tokens: actual.tokens });
    },
    async release(id) {
      if (state.get(id) !== "held") violations.push(`release ${id} while ${state.get(id) ?? "unknown"}`);
      state.set(id, "released");
      released.push(id);
    },
  };
  return {
    admission, asked, settled, released, violations,
    /** What is still held: a reservation nobody settled or released. */
    open: (): string[] => [...state].filter(([, value]) => value === "held").map(([id]) => id),
    /** Makes every `admit` wait until `count` of them are waiting, then lets them all go (to make two starts overlap). */
    holdUntil(count: number): void {
      let waiting = 0;
      let release: (() => void) | undefined;
      gate = new Promise<void>((resolve) => { release = resolve; });
      const original = admission.admit.bind(admission);
      admission.admit = async (request) => {
        waiting += 1;
        if (waiting >= count) release?.();
        return original(request);
      };
    },
  };
}
