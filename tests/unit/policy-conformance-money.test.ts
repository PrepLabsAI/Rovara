// The money cases of the admission conformance suite (`capacity`): a positive control (a small reference adapter that holds a budget correctly passes them all)
// and negative controls (an adapter that reads and then writes without a fence, or one that admits an unknown cost as free, is caught).
import { describe, expect, it } from "vitest";
import type { Admission, AdmissionDecision, AdmissionRequest, Cost } from "@rovara-code/contracts";
import { raceAdmissions, runAdmissionConformance } from "../support/ports/policy-conformance.js";

const COMPANY = "org_00000000000000000000";
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A budget of `limitMicros`, held per request key. `fenced`: the room is checked and taken in one step (as a conditional write does); otherwise it is read,
 * then (after a pause another request can run in) written, the read-modify-write the rules forbid. `unknownMicros`: what a request with no cost holds.
 */
function budgetAdmission(options: { limitMicros: number; fenced: boolean; unknownMicros: number }): Admission {
  let used = 0;
  const holds = new Map<string, { micros: number; open: boolean }>();
  const take = async (micros: number): Promise<boolean> => {
    if (options.fenced) {
      if (used + micros > options.limitMicros) return false;
      used += micros;
      return true;
    }
    const seen = used;
    await pause();
    if (seen + micros > options.limitMicros) return false;
    used = seen + micros;
    return true;
  };
  const amountOf = (request: AdmissionRequest): number => request.estimate?.cost?.micros ?? options.unknownMicros;
  const admit = async (request: AdmissionRequest): Promise<AdmissionDecision> => {
    const id = `${request.companyId}:${request.idempotencyKey}`;
    if (holds.has(id)) return { allowed: true, reservationId: id };
    holds.set(id, { micros: 0, open: false });
    const micros = amountOf(request);
    if (!(await take(micros))) {
      holds.delete(id);
      return { allowed: false, code: "budget_exhausted", message: "The budget is used up." };
    }
    holds.set(id, { micros, open: true });
    return { allowed: true, reservationId: id };
  };
  const end = (reservationId: string, keepMicros: number): void => {
    const hold = holds.get(reservationId);
    if (hold === undefined || !hold.open) return;
    hold.open = false;
    used += keepMicros - hold.micros;
  };
  return {
    enforcesCost: true,
    admit,
    async stage(request) { return { decision: await admit(request), items: [] }; },
    async settle(reservationId, actual: { cost?: Cost }) { end(reservationId, actual.cost?.micros ?? holds.get(reservationId)?.micros ?? 0); },
    async release(reservationId) { end(reservationId, 0); },
  };
}

const dollar = (n: number): AdmissionRequest => ({ companyId: COMPANY, idempotencyKey: "k", action: "model.call", estimate: { cost: { micros: n * 1_000_000, currency: "USD" } } });

runAdmissionConformance("reference budget (holds an allowance)", {
  create: async () => budgetAdmission({ limitMicros: 5_000_000, fenced: true, unknownMicros: 2_000_000 }),
  admissible: dollar(1),
  refused: { ...dollar(6), idempotencyKey: "too-much" },
  enforcesCost: true,
  capacity: { request: dollar(1), fits: 5 },
});

describe("the money cases catch a broken budget adapter", () => {
  it("a read-modify-write without a fence admits racing requests past the allowance", async () => {
    const broken = budgetAdmission({ limitMicros: 5_000_000, fenced: false, unknownMicros: 2_000_000 });
    expect((await raceAdmissions(broken, dollar(1), 13)).allowed).toBeGreaterThan(5);
  });

  it("an adapter that holds nothing for an unknown cost admits it once the allowance is used", async () => {
    const free = budgetAdmission({ limitMicros: 5_000_000, fenced: true, unknownMicros: 0 });
    expect((await raceAdmissions(free, dollar(1), 5)).allowed).toBe(5);
    const unknown: AdmissionRequest = { ...dollar(1) };
    delete unknown.estimate;
    expect((await free.admit({ ...unknown, idempotencyKey: "unknown" })).allowed).toBe(true);
  });
});
