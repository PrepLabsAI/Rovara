import { expect, it } from "vitest";
import { createDefaultPolicySource, createRowsPolicySource, type PolicyScope } from "../../packages/contracts/src/ports/policy-source.js";
import { policySourceChecks, type PolicySourceWorld } from "../../packages/testing/src/ports/policy-source-conformance.js";
import { runContract } from "../../packages/testing/src/ports/plugin-contract-kit.js";
import { COMPANY_A, COMPANY_B, attempt, type IsolationCompany } from "../../packages/testing/src/isolation/two-company.js";

const scopeFor = (me: IsolationCompany): PolicyScope => ({ key: `${me.orgId}:shared-project` });
function rowsWorld(): PolicySourceWorld {
  const a = scopeFor(COMPANY_A); const b = scopeFor(COMPANY_B); const reads: string[] = [];
  const source = createRowsPolicySource(async (scope) => {
    reads.push(scope.key);
    if (scope.key === a.key) return { scope, rows: { companyLocks: { real_check: "rovara_real_run", model_budget_usd: 17 } } };
    if (scope.key === b.key) return { scope, rows: {} };
    return undefined;
  });
  return { source, scope: b, lockedScope: a, isolation: {
    surfaces: [{ kind: "read", name: "policy scopes and locks", async plant(me) { return { handle: scopeFor(me), markers: [me.label === "A" ? "rovara_real_run" : "their_ci_fix"] }; },
      async observe(me) {
        reads.length = 0; const got = await source.resolve(scopeFor(me), {});
        expect(reads).toEqual([scopeFor(me).key]);
        return got.values["real_check"];
      } }],
    failClosed: [{ name: "missing or failing scope lookup", async prepare() { await source.resolve(a, {}); }, async attempt(mode) {
      return createRowsPolicySource(async () => { if (mode === "throws") throw new Error(COMPANY_A.canary); return undefined; }).resolve(a, {});
    } }],
  } };
}
runContract("PolicySource laptop default", policySourceChecks, () => ({ source: createDefaultPolicySource(), scope: scopeFor(COMPANY_B) }));
runContract("PolicySource rows fake", policySourceChecks, rowsWorld);

it("operator disablement is separate from rows and returns only null values", async () => {
  const source = createRowsPolicySource(async (scope) => ({ scope, rows: { companyLocks: { preset_level: "careful" } } }), { installOff: true });
  for (const candidate of [source, createDefaultPolicySource({ installOff: true })]) {
    const got = await candidate.resolve(scopeFor(COMPANY_A), { taskRaises: { extra_review: true } });
    expect(got.status).toBe("disabled");
    expect(Object.keys(got.values)).toHaveLength(10);
    for (const row of Object.values(got.values)) expect(row).toEqual({ value: null, origin: "install_off" });
  }
  await expect(createRowsPolicySource(async (scope) => ({ scope, rows: { installOff: true } })).resolve(scopeFor(COMPANY_A), {})).rejects.toThrow("policy_unavailable");
  await expect(createDefaultPolicySource().resolve(scopeFor(COMPANY_A), { installOff: true } as never)).rejects.toThrow("policy_unavailable");
});

it("two-company scoping rejects a reader returning another scope like a missing scope", async () => {
  const a = scopeFor(COMPANY_A); const b = scopeFor(COMPANY_B);
  const missing = await attempt(() => createRowsPolicySource(async () => undefined).resolve(b, {}));
  const foreign = await attempt(() => createRowsPolicySource(async () => ({ scope: a, rows: { project: { model_budget_usd: 99 } } })).resolve(b, {}));
  expect(foreign).toEqual(missing); expect(foreign.ok).toBe(false);
});

it("validates scope, request and rows before resolution and never falls back on unreadable rows", async () => {
  let reads = 0;
  const source = createRowsPolicySource(async (scope) => { reads += 1; return { scope, rows: {} }; });
  for (const request of [{ branch: "/x" }, { unknown: 1 }, JSON.parse('{"__proto__":{}}') as unknown]) {
    await expect(source.resolve(scopeFor(COMPANY_A), request as never)).rejects.toThrow("policy_unavailable");
  }
  await expect(source.resolve({ key: "" }, {})).rejects.toThrow("policy_unavailable");
  expect(reads).toBe(0);
  await expect(createRowsPolicySource(async (scope) => ({ scope, rows: { unknown: 1 } })).resolve(scopeFor(COMPANY_A), {})).rejects.toThrow("policy_unavailable");
});
