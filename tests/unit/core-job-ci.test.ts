import { describe, expect, it, vi } from "vitest";
import { createDefaultPolicySource, createRowsPolicySource, type PolicySource } from "@agentx/contracts";
import { policyCiReporting } from "../../packages/broker/src/aws/core-job-services.js";
import { CI_MODE_UNREADABLE_WORDS } from "../../packages/broker/src/core-host/switch-blockers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const task = (orgId = A) => ({ orgId, project: "web" }) as never;

describe("policy CI reporting", () => {
  it("uses each company's project policy, without caching or default-company fallback", async () => {
    const scopes: string[] = [];
    const source = createRowsPolicySource(async (scope) => {
      scopes.push(scope.key);
      return { scope, rows: { project: { real_check: scope.key.includes(A) ? "sandbox_only" : "their_ci_watch" } } };
    });
    const read = policyCiReporting(source);
    expect(await read.ciMode(task())).toBe("sandbox_only");
    expect(await read.ciMode(task(B))).toBe("their_ci_watch");
    expect(scopes).toEqual([`company/${A}/project/web`, `company/${B}/project/web`]);
  });
  it.each(["sandbox_only", "their_ci_watch", "their_ci_fix", "rovara_real_run"])("maps %s exactly", async (mode) => {
    const source = createRowsPolicySource(async (scope) => ({ scope, rows: { project: { real_check: mode } } }));
    expect(await policyCiReporting(source).ciMode(task())).toBe(mode);
  });
  it("keeps D1's today value when no store is installed", async () => {
    expect(await policyCiReporting().ciMode(task())).toBe("their_ci_fix");
    expect(await policyCiReporting(createDefaultPolicySource()).ciMode(task())).toBe("their_ci_fix");
  });
  it.each([undefined, null, {}, { status: "refused" }, { status: "disabled", values: { real_check: { value: "sandbox_only" } } }, { status: "resolved", values: { real_check: { value: "canary", origin: "rovara_default" } }, issues: [] }])("refuses malformed policy without leaking", async (answer) => {
    const source = { resolve: async () => answer } as unknown as PolicySource;
    await expect(policyCiReporting(source).ciMode(task())).rejects.toThrow(new Error(CI_MODE_UNREADABLE_WORDS));
  });
  it("refuses bad scope before reading and hides reader failures", async () => {
    const resolve = vi.fn(async () => { throw new Error("private-canary"); });
    for (const value of [{ project: "web" }, { orgId: A, project: "../web" }, { orgId: B, project: null }]) {
      await expect(policyCiReporting({ resolve }).ciMode(value as never)).rejects.toThrow(new Error(CI_MODE_UNREADABLE_WORDS));
    }
    expect(resolve).not.toHaveBeenCalled();
    await expect(policyCiReporting({ resolve }).ciMode(task())).rejects.toThrow(new Error(CI_MODE_UNREADABLE_WORDS));
  });
});

it("rejects inherited or accessor-based policy answers", async () => {
  for (const answer of [
    { status: "resolved", values: Object.create({ real_check: { value: "sandbox_only", origin: "rovara_default" } }) as unknown, issues: [] },
    { status: "resolved", values: { real_check: { get value() { return "sandbox_only"; }, origin: "rovara_default" } }, issues: [] },
  ]) await expect(policyCiReporting({ resolve: async () => answer } as PolicySource).ciMode(task())).rejects.toThrow(new Error(CI_MODE_UNREADABLE_WORDS));
});

it.each([
  { status: "resolved", values: { real_check: { value: "sandbox_only" } }, issues: [] },
  { status: "resolved", values: { real_check: { value: "sandbox_only", origin: "unknown" } }, issues: [] },
  { status: "resolved", values: { real_check: { value: "sandbox_only", origin: "rovara_default" } } },
])("refuses incomplete policy metadata", async (answer) => {
  await expect(policyCiReporting({ resolve: async () => answer } as unknown as PolicySource).ciMode(task())).rejects.toThrow(new Error(CI_MODE_UNREADABLE_WORDS));
});
