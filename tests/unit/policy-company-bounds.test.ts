import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolvePolicy, type PolicyValue } from "../../packages/contracts/src/policy.js";
import { createDefaultPolicySource, createRowsPolicySource } from "../../packages/contracts/src/ports/policy-source.js";
import { withPolicyHookValues } from "../../packages/contracts/src/ports/policy-hook-values.js";

const scope = { key: "company/project" };
const hook = (rows: Record<string, unknown>, locks: Record<string, PolicyValue>) => withPolicyHookValues(
  createRowsPolicySource(async (scope) => ({ scope, rows })), async () => ({ locks, expiresAt: 100 }),
  { scopeOf: () => ({ companyId: "company", projectName: "project" }), now: () => 0 },
);
it("a tighter hook limit retains the task-raise reason after a row ceiling already clamped it", async () => {
  const rows = { project: { model_budget_usd: 2 }, companyCeilings: { model_budget_usd: 4 } };
  const request = { taskRaises: { model_budget_usd: 100 } };
  const locks = { model_budget_usd: 3 };
  const result = await hook(rows, locks).resolve(scope, request);
  expect(result).toEqual(resolvePolicy({ ...rows, ...request, companyLocks: locks }));
  expect(result.values.model_budget_usd?.reason).toBe("raised to the company limit");
});
it("unreadable hook answers and expired answers use the fixed refusal", async () => {
  for (const answer of [
    { locks: {}, expiresAt: -1 },
    { locks: {}, expiresAt: NaN },
    Object.defineProperty({}, "locks", { get() { throw new Error("private-canary"); } }),
  ]) {
    const source = withPolicyHookValues(createRowsPolicySource(async (scope) => ({ scope, rows: {} })), async () => answer as never, { scopeOf: () => ({ companyId: "company" }), now: () => 0 });
    await expect(source.resolve(scope, {})).rejects.toThrow(/^policy_unavailable$/);
  }
});

it("absent rows are byte-identical across the existing policy entry points", async () => {
  const golden = readFileSync("tests/fixtures/project-settings-today.json", "utf8").trim();
  expect(JSON.stringify(resolvePolicy({}))).toBe(golden);
  for (const source of [createDefaultPolicySource(), createRowsPolicySource(async (scope) => ({ scope, rows: {} }))]) {
    expect(JSON.stringify(await source.resolve(scope, {}))).toBe(golden);
  }
});
