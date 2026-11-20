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

it("an explicit numeric company default remains binding alongside higher project and agent stops", () => {
  expect(result(policy(20 * M, { companyDefault: limited(10 * M), projectStop: limited(18 * M), agentStop: limited(15 * M) })))
    .toMatchObject({ kind: "resolved", effectiveStopMicrousd: 10 * M, bindingScopes: ["company_default"] });
});
it("the existing ceiling still bounds an explicit agent limit", () => {
  expect(result(policy(25 * M, { ceilingMicrousd: M, agentStop: limited(20 * M) })))
    .toMatchObject({ kind: "resolved", effectiveStopMicrousd: M, bindingScopes: ["company_ceiling"] });
});
for (const ceiling of [7 * M]) {
  it(`refuses a NEW approval one micro above ceiling ${ceiling} and accepts the boundary`, () => {
    expect(result(policy(M, { ceilingMicrousd: ceiling, approvedRunLimitMicrousd: ceiling })))
      .toMatchObject({ kind: "resolved", effectiveStopMicrousd: ceiling });
    expect(result(policy(M, { ceilingMicrousd: ceiling, approvedRunLimitMicrousd: ceiling + 1 })))
      .toMatchObject({ kind: "refused", reason: "TASK_STOP_APPROVAL_ABOVE_CEILING", approvalCapMicrousd: ceiling });
  });
}
it("retains exact one-micro boundaries, explicit zero and tied scopes", () => {
  expect(result(policy(M + 2, { companyDefault: limited(M + 1), projectStop: limited(M + 1) })))
    .toMatchObject({ kind: "resolved", effectiveStopMicrousd: M + 1, bindingScopes: ["company_default", "project"] });
  expect(result(policy(25 * M, { projectStop: limited(-0) })))
    .toMatchObject({ kind: "resolved", effectiveStopMicrousd: 0, bindingScopes: ["project"] });
});
for (const field of ["companyDefault"]) {
  it(`refuses missing ${field}, distinguishing missing scope from configured inheritance`, () => {
    const input: Record<string, unknown> = policy(M); delete input[field];
    expect(result(input)).toMatchObject({ kind: "unavailable", reason: "INVALID_OR_MISSING_POLICY" });
    expect(result(policy(M))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: M });
  });
}

it("approved per-run windows retain explicit numeric scope and requested bounds", () => {
  expect(result(policy(14 * M, { companyDefault: limited(5 * M), approvedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: 5 * M, bindingScopes: ["company_default"] });
  expect(result(policy(4 * M, { requestedMicrousd: 3 * M, approvedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: 3 * M, bindingScopes: ["requested"] });
});

it("a later run approval retains its existing task per-run bound", () => {
  expect(result(policy(14 * M, { approvedRunLimitMicrousd: 14 * M, committedMaxPerRunMicrousd: 9 * M }))).toMatchObject({ kind: "resolved", effectiveStopMicrousd: 9 * M, bindingScopes: ["committed_max_per_run"] });
});
