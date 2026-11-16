import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { POLICY_FIELDS, resolvePolicy, type PolicyValue } from "../../packages/contracts/src/policy.js";
import { createDefaultPolicySource, createRowsPolicySource } from "../../packages/contracts/src/ports/policy-source.js";
import { withPolicyHookValues } from "../../packages/contracts/src/ports/policy-hook-values.js";

const scope = { key: "company/project" };
const hook = (rows: Record<string, unknown>, locks: Record<string, PolicyValue>) => withPolicyHookValues(
  createRowsPolicySource(async (scope) => ({ scope, rows })), async () => ({ locks, expiresAt: 100 }),
  { scopeOf: () => ({ companyId: "company", projectName: "project" }), now: () => 0 },
);
it("company numeric limits are ceilings; round time is a minimum", () => {
  const result = resolvePolicy({ project: { ci_fix_rounds: 3, model_budget_usd: 20, machine_budget_minutes: 90, round_time_minutes: 30 },
    companyLocks: { ci_fix_rounds: 1, model_budget_usd: 5, machine_budget_minutes: 60, round_time_minutes: 60 } });
  expect(result.values.ci_fix_rounds).toMatchObject({ value: 1, origin: "company_limit" });
  expect(result.values.model_budget_usd).toMatchObject({ value: 5, origin: "company_limit" });
  expect(result.values.machine_budget_minutes).toMatchObject({ value: 60, origin: "company_limit" });
  expect(result.values.round_time_minutes).toMatchObject({ value: 60, origin: "company_minimum" });
});
it("preset bounds expand only minimum fields through resolver and hook", async () => {
  const rows = { project: { ci_fix_rounds: 0, model_budget_usd: 1, machine_budget_minutes: 1 } };
  const expected = resolvePolicy({ ...rows, companyLocks: { preset_level: "careful" } });
  expect(expected.values.ci_fix_rounds?.value).toBe(0);
  expect(expected.values.model_budget_usd?.value).toBe(1);
  expect(expected.values.machine_budget_minutes?.value).toBe(1);
  expect(await hook(rows, { preset_level: "careful" }).resolve(scope, {})).toEqual(expected);
});
it("task raise stops at the company limit, including through the hook", async () => {
  const rows = { project: { model_budget_usd: 2 } };
  const request = { taskRaises: { model_budget_usd: 20 } };
  const expected = resolvePolicy({ ...rows, ...request, companyLocks: { model_budget_usd: 5 } });
  expect(expected.issues).toEqual([]);
  expect(expected.values.model_budget_usd).toMatchObject({ value: 5, origin: "company_limit", reason: "raised to the company limit" });
  expect(await hook(rows, { model_budget_usd: 5 }).resolve(scope, request)).toEqual(expected);
  expect(resolvePolicy({ ...rows, ...request }).issues).toContain("no_ceiling");
});
it("resolver equals hook for 1000 deterministic random field bounds", async () => {
  let seed = 232;
  const draw = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 1000; i++) {
    const field = POLICY_FIELDS[i % POLICY_FIELDS.length]!;
    const value = (): PolicyValue => field.order?.[draw() % field.order.length] ?? (field.kind === "boolean" ? draw() % 2 === 0 : field.id === "ci_fix_rounds" ? draw() % 4 : field.id === "round_time_minutes" ? 30 + draw() % 91 : draw() % 100);
    const rows = { project: { [field.id]: value() } }; const locks = { [field.id]: value() };
    expect(await hook(rows, locks).resolve(scope, {})).toEqual(resolvePolicy({ ...rows, companyLocks: locks }));
  }
});
it("hook and resolver agree on randomized task raises including limits of zero", async () => {
  for (let initial = 0; initial < 10; initial++) for (let limit = 0; limit < 10; limit++) {
    const rows = { project: { model_budget_usd: initial } };
    const request = { taskRaises: { model_budget_usd: initial + 3 } };
    const locks = { model_budget_usd: limit };
    expect(await hook(rows, locks).resolve(scope, request)).toEqual(resolvePolicy({ ...rows, ...request, companyLocks: locks }));
  }
});
it("hook limits never undo an existing row ceiling during a task raise", async () => {
  const rows = { project: { model_budget_usd: 2 }, companyCeilings: { model_budget_usd: 4 } };
  const request = { taskRaises: { model_budget_usd: 100 } };
  expect((await hook(rows, { model_budget_usd: 7 }).resolve(scope, request)).values.model_budget_usd?.value).toBe(4);
});
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
