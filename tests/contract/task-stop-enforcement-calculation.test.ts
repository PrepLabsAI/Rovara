import { expect, it } from "vitest";
import { calculateTaskStop } from "../../packages/contracts/src/task-stop.js";

const M = 1_000_000;
const inherit = { kind: "inherit" };
const estimate = { kind: "rovara_estimate" };
const limited = (amount: number) => ({ kind: "limited", stopMicrousd: amount });
const policy = (path: number, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2, companyDefault: estimate, projectStop: inherit, agentStop: inherit,
  ceilingMicrousd: 100 * M, pathLimitMicrousd: path, ...extra,
});
const result = (input: unknown): unknown => calculateTaskStop(input);

for (const [name, amount] of [
  ["TASK run", 10], ["QUICK run", 6], ["FULL run", 20], ["AGENT run", 4],
  ["QUICK planning", 2], ["FULL planning", 6], ["configured planning", 50],
  ["history p80 eight times multiplier two", 16], ["non-default multiplier", 240],
  ["high history", 320], ["legacy fallback", 25], ["pinned chain", 750],
  ["SWE-bench cap", 250], ["eval per-run cap", 500],
] as const) {
  it(`keeps seeded estimate-mode ${name} at its existing cap`, () => {
    expect(result(policy(amount * M))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: amount * M, approvalCapMicrousd: 100 * M });
  });
}
it("a lowered ceiling affects no unapproved starting or planning cap", () => {
  for (const path of [2, 6, 20, 25, 50, 750]) {
    expect(result(policy(path * M, { ceilingMicrousd: M }))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: path * M, approvalCapMicrousd: M });
  }
});
it("an explicit numeric company default remains binding alongside higher project and agent stops", () => {
  expect(result(policy(20 * M, { companyDefault: limited(10 * M), projectStop: limited(18 * M), agentStop: limited(15 * M) })))
    .toMatchObject({ kind: "resolved", effectiveStopMicrousd: 10 * M, bindingScopes: ["company_default"] });
});
it("the existing ceiling still bounds an explicit agent limit", () => {
  expect(result(policy(25 * M, { ceilingMicrousd: M, agentStop: limited(20 * M) })))
    .toMatchObject({ kind: "resolved", effectiveStopMicrousd: M, bindingScopes: ["company_ceiling"] });
});
it("the ceiling does not clamp an explicit project-only or company-only policy", () => {
  for (const extra of [{ projectStop: limited(20 * M) }, { companyDefault: limited(20 * M) }]) {
    expect(result(policy(25 * M, { ceilingMicrousd: M, ...extra })))
      .toMatchObject({ kind: "resolved", effectiveStopMicrousd: 20 * M });
  }
});
it("an approved limit replaces the unapproved estimate rather than being minned against it", () => {
  expect(result(policy(6 * M, { approvedRunLimitMicrousd: 80 * M })))
    .toMatchObject({ kind: "resolved", effectiveStopMicrousd: 80 * M, approvalCapMicrousd: 100 * M });
});
for (const ceiling of [7 * M, 100 * M, 1000 * M]) {
  it(`refuses a NEW approval one micro above ceiling ${ceiling} and accepts the boundary`, () => {
    expect(result(policy(M, { ceilingMicrousd: ceiling, approvedRunLimitMicrousd: ceiling })))
      .toMatchObject({ kind: "resolved", effectiveStopMicrousd: ceiling });
    expect(result(policy(M, { ceilingMicrousd: ceiling, approvedRunLimitMicrousd: ceiling + 1 })))
      .toMatchObject({ kind: "refused", reason: "TASK_STOP_APPROVAL_ABOVE_CEILING", approvalCapMicrousd: ceiling });
  });
}
it("a requested amount, chain bound and testing room may only lower the selected limit", () => {
  expect(result(policy(25 * M, { requestedMicrousd: 12 * M, chainMicrousd: 9 * M, testingMicrousd: 4 * M })))
    .toMatchObject({ kind: "resolved", effectiveStopMicrousd: 4 * M, bindingScopes: ["testing"] });
});
it("retains exact one-micro boundaries, explicit zero and tied scopes", () => {
  expect(result(policy(M + 2, { companyDefault: limited(M + 1), projectStop: limited(M + 1) })))
    .toMatchObject({ kind: "resolved", effectiveStopMicrousd: M + 1, bindingScopes: ["company_default", "project"] });
  expect(result(policy(25 * M, { projectStop: limited(-0) })))
    .toMatchObject({ kind: "resolved", effectiveStopMicrousd: 0, bindingScopes: ["project"] });
});
for (const field of ["companyDefault", "projectStop", "agentStop", "ceilingMicrousd", "pathLimitMicrousd"]) {
  it(`refuses missing ${field}, distinguishing missing scope from configured inheritance`, () => {
    const input: Record<string, unknown> = policy(M); delete input[field];
    expect(result(input)).toMatchObject({ kind: "unavailable", reason: "INVALID_OR_MISSING_POLICY" });
    expect(result(policy(M))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: M });
  });
}
for (const amount of [-1, 0.1, NaN, Infinity, 1_000_000_000_001, "1"]) {
  it(`refuses corrupt numeric money ${String(amount)} without rounding or coercion`, () => {
    expect(result(policy(M, { projectStop: { kind: "limited", stopMicrousd: amount } })))
      .toMatchObject({ kind: "unavailable", reason: "INVALID_OR_MISSING_POLICY" });
  });
}
it("does not mutate a supplied policy, accept extra aliases, or turn inherit into unlimited", () => {
  const input = Object.freeze(policy(M, { companyDefault: Object.freeze(limited(1)) }));
  expect(result(input)).toMatchObject({ kind: "resolved", effectiveStopMicrousd: 1 });
  expect(result(policy(M, { maxPerRunCeilingUsd: 1 }))).toMatchObject({ kind: "unavailable" });
});

it("a new max-per-run approval is separate from the task run limit", () => {
  expect(result(policy(4 * M, { approvedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: 4 * M, bindingScopes: ["path"] });
  expect(result(policy(14 * M, { approvedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: 9 * M, bindingScopes: ["approved_max_per_run"] });
});
it("the new approval ceiling refuses a per-run raise even when a smaller task run limit remains", () => {
  expect(result(policy(4 * M, { ceilingMicrousd: 6 * M, approvedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "refused", reason: "TASK_STOP_APPROVAL_ABOVE_CEILING" });
});
it("approved per-run windows retain explicit numeric scope and requested bounds", () => {
  expect(result(policy(14 * M, { companyDefault: limited(5 * M), approvedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: 5 * M, bindingScopes: ["company_default"] });
  expect(result(policy(4 * M, { requestedMicrousd: 3 * M, approvedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: 3 * M, bindingScopes: ["requested"] });
});
it("contradictory approved limit kinds are unavailable", () => {
  expect(result(policy(4 * M, { approvedRunLimitMicrousd: 9 * M, approvedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "unavailable", reason: "INVALID_OR_MISSING_POLICY" });
});

it("a later run approval retains its existing task per-run bound", () => {
  expect(result(policy(14 * M, { approvedRunLimitMicrousd: 14 * M, committedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: 9 * M, bindingScopes: ["committed_max_per_run"] });
});
it("a committed task per-run bound does not bypass a new approval ceiling", () => {
  expect(result(policy(14 * M, { ceilingMicrousd: 12 * M, approvedRunLimitMicrousd: 14 * M, committedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "refused", reason: "TASK_STOP_APPROVAL_ABOVE_CEILING" });
});
it("lowered ceilings do not retroactively clamp a committed task-specific stop without a new approval", () => {
  expect(result(policy(20 * M, { ceilingMicrousd: M, committedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: 9 * M, bindingScopes: ["committed_max_per_run"] });
});
