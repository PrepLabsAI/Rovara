import { expect } from "vitest";
import { POLICY_FIELDS, POLICY_ORIGINS, type PolicySource, type PolicySourceScope as PolicyScope } from "@agentx/contracts";
import { twoCompanyChecks, type TwoCompanyIsolation } from "../isolation/two-company.js";
import type { ContractCheck } from "./plugin-contract-kit.js";

export interface PolicySourceWorld {
  readonly source: PolicySource;
  /** Authorized scope without rows. */
  readonly scope: PolicyScope;
  /** Scope whose real_check lock is rovara_real_run (the optional adapter storage fixture). */
  readonly lockedScope?: PolicyScope;
  readonly isolation?: TwoCompanyIsolation;
}
export const policySourceChecks: readonly ContractCheck<PolicySourceWorld>[] = [
  {
    name: "returns an origin for every field and preserves today's values when rows are absent",
    async run({ source, scope }) {
      const got = await source.resolve(scope, {});
      expect(got.status).toBe("resolved");
      for (const field of POLICY_FIELDS) {
        expect(got.values[field.id]?.value, field.id).toBe(field.today);
        expect(POLICY_ORIGINS).toContain(got.values[field.id]?.origin);
      }
    },
  },
  {
    name: "task raises are only upward and only on raisable fields",
    async run({ source, scope }) {
      const lower = await source.resolve(scope, { taskRaises: { real_check: "sandbox_only", ci_fix_rounds: 0 } });
      expect(lower.values["real_check"]?.value).toBe("their_ci_fix");
      expect(lower.values["ci_fix_rounds"]?.value).toBe(3);
      const raised = await source.resolve(scope, { taskRaises: { real_check: "rovara_real_run" } });
      expect(raised.values["real_check"]).toEqual({ value: "rovara_real_run", origin: "task_raise" });
    },
  },
  {
    name: "a company's lock never clamps another company sharing the raw project id",
    needs: (world) => world.lockedScope !== undefined,
    async run({ source, scope, lockedScope }) {
      const a = await source.resolve(lockedScope!, { taskRaises: { real_check: "sandbox_only" } });
      const b = await source.resolve(scope, {});
      expect(a.values["real_check"]).toMatchObject({ value: "rovara_real_run", origin: "company_lock" });
      expect(b.values["real_check"]).toEqual({ value: "their_ci_fix", origin: "rovara_default" });
    },
  },
  ...twoCompanyChecks<PolicySourceWorld>(),
];
