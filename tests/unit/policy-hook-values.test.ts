// Lane H: "what are the company's values?". Locks only tighten; the answer is cached until its expiry; with no answer the last good answer is used for a few
// minutes, then the strictest default (the source's fixed refusal) applies.
import { describe, expect, it } from "vitest";
import { createPolicyHookClient } from "../../packages/broker/src/core/policy-hook/client.js";
import { policyHookValuesAsker } from "../../packages/broker/src/core/policy-hook/values.js";
import { createRowsPolicySource, withPolicyHookValues, type PolicySource } from "../../packages/contracts/src/index.js";
import { COMPANY, ISSUER, fakeService, makeKey, settingsFor, signerOf } from "./policy-hook-fixture.js";

const install = makeKey("install-key-1");
const hookKey = makeKey("hook-key-1");
const T0 = 1_800_000_000_000;
const scope = { key: "company:web" };

function world(answer: Parameters<typeof fakeService>[0]["answer"], rows: Record<string, unknown> = {}) {
  let clock = T0;
  const service = fakeService({ key: hookKey, now: () => clock, answer, lifetime: 60 });
  const client = createPolicyHookClient({ settings: settingsFor(hookKey), install: { issuer: ISSUER, signer: signerOf(install) }, fetch: service.fetch, now: () => clock });
  const base: PolicySource = createRowsPolicySource(async (s) => ({ scope: s, rows }));
  const source = withPolicyHookValues(base, policyHookValuesAsker(client), { scopeOf: (s) => (s.key === scope.key ? { companyId: COMPANY, projectName: "web" } : undefined), now: () => clock });
  return { source, service, advance: (ms: number) => { clock += ms; } };
}

describe("policy hook: company values", () => {
  it("locks tighten values and never loosen them", async () => {
    const w = world(() => ({ locks: { extra_review: true, ci_fix_rounds: 1, model_budget_usd: 5, real_check: "sandbox_only" } }), { project: { ci_fix_rounds: 2, real_check: "rovara_real_run" } });
    const resolved = await w.source.resolve(scope, {});
    expect(resolved.values["extra_review"]).toEqual({ value: true, origin: "company_minimum", clampedBy: "company_minimum", companyBound: { kind: "minimum", value: true } });
    expect(resolved.values["ci_fix_rounds"]).toEqual({ value: 1, origin: "company_limit", clampedBy: "company_limit", companyBound: { kind: "limit", value: 1 } });
    expect(resolved.values["model_budget_usd"]).toEqual({ value: 5, origin: "company_limit", clampedBy: "company_limit", companyBound: { kind: "limit", value: 5 } });
    // sandbox_only is looser than the project's rovara_real_run ("higher" is stricter): kept as the project set it.
    expect(resolved.values["real_check"]).toEqual({ value: "rovara_real_run", origin: "changed_here", companyBound: { kind: "minimum", value: "sandbox_only" } });
    expect(w.service.asked[0]!.q).toEqual({ cid: COMPANY, pid: "web" });
  });

  it("caches until the answer expires, then asks again", async () => {
    const w = world(() => ({ locks: { extra_review: true } }));
    await w.source.resolve(scope, {});
    w.advance(59_000);
    await w.source.resolve(scope, {});
    expect(w.service.asked).toHaveLength(1);
    w.advance(2_000);
    await w.source.resolve(scope, {});
    expect(w.service.asked).toHaveLength(2);
  });

  it("no answer: the last good answer for five minutes after it expired, then the strictest default (refusal)", async () => {
    let up = true;
    const w = world(() => (up ? { locks: { extra_review: true } } : new Response("down", { status: 503 })));
    await w.source.resolve(scope, {});
    up = false;
    w.advance(60_000 + 299_000);
    expect((await w.source.resolve(scope, {})).values["extra_review"]!.value).toBe(true);
    w.advance(2_000);
    await expect(w.source.resolve(scope, {})).rejects.toThrow("policy_unavailable");
  });

  it("a preset lock expands carefulness minima without setting spend bounds", async () => {
    const result = await world(() => ({ locks: { preset_level: "careful" } })).source.resolve(scope, {});
    expect(result.values["real_check"]?.value).toBe("rovara_real_run");
    expect(result.values["model_budget_usd"]?.value).toBeNull();
  });

  it("no answer and nothing cached, an unreadable lock, or an unknown scope: the strictest default", async () => {
    await expect(world(() => new Response("down", { status: 503 })).source.resolve(scope, {})).rejects.toThrow("policy_unavailable");
    await expect(world(() => ({ locks: { not_a_field: true } })).source.resolve(scope, {})).rejects.toThrow("policy_unavailable");
    await expect(world(() => ({ locks: { extra_review: "yes" } })).source.resolve(scope, {})).rejects.toThrow("policy_unavailable");
    await expect(world(() => ({ locks: {} })).source.resolve({ key: "other" }, {})).rejects.toThrow("policy_unavailable");
  });
});
