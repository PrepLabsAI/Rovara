// Lane H: with no policy address the install is exactly as before (the same adapters, the same parsed config bytes); with one, the hook stands in front of
// whatever admission and approvers the install has, and an install that sets it without a signing key does not start.
import { describe, expect, it } from "vitest";
import { createAdapterRegistry, parsePluginConfig } from "../../packages/broker/src/ports/adapter-registry.js";
import { registerCodeDefaults } from "../../packages/broker/src/ports/policy-defaults.js";
import { POLICY_HOOK_ADAPTER_NAME, PolicyHookSetupError, applyPolicyHook } from "../../packages/broker/src/core/policy-hook/index.js";
import { applyHostedPolicyHook } from "../../packages/broker/src/core/policy-hook/hosted.js";
import { policyHookKeyThumbprint } from "../../packages/contracts/src/policy-hook.js";
import { COMPANY, ISSUER, fakeService, makeKey, settingsFor, signerOf } from "./policy-hook-fixture.js";

const install = makeKey("install-key-1");
const hookKey = makeKey("hook-key-1");

function registry() {
  const r = createAdapterRegistry();
  registerCodeDefaults(r, { priceTable: { currency: "USD", models: {} } });
  return r;
}

describe("policy hook wiring", () => {
  it("no address: nothing changes (same adapters, same names)", () => {
    const r = registry();
    const admission = r.require("admission");
    const approvers = r.require("approvers");
    expect(applyPolicyHook(r, undefined, undefined)).toBeUndefined();
    expect(applyPolicyHook(r, undefined, { issuer: ISSUER, signer: signerOf(install) })).toBeUndefined();
    expect(r.require("admission")).toBe(admission);
    expect(r.require("approvers")).toBe(approvers);
    expect(r.names("admission")).toEqual(["allow-all"]);
    expect(r.names("approvers")).toEqual(["local-owner"]);
  });

  it("no address: a config without it parses to the same bytes as before", () => {
    const config = { version: 1, companyId: COMPANY, plugins: [{ point: "storage", name: "sqlite", module: "./plugins/sqlite.js", settings: { path: "state.db" } }] };
    expect(JSON.stringify(parsePluginConfig(config))).toBe('{"version":1,"companyId":"org_aaaaaaaaaaaaaaaaaaaa","plugins":[{"point":"storage","name":"sqlite","module":"./plugins/sqlite.js","enabled":true,"settings":{"path":"state.db"}}]}');
    expect(JSON.stringify(parsePluginConfig({ version: 1, plugins: [] }))).toBe('{"version":1,"plugins":[]}');
  });

  it("a config with an address parses; a bad one is refused", () => {
    const settings = settingsFor(hookKey);
    expect(parsePluginConfig({ version: 1, plugins: [], policyHook: settings }).policyHook).toEqual(settings);
    expect(() => parsePluginConfig({ version: 1, plugins: [], policyHook: { ...settings, address: "http://rules.example/hook" } })).toThrow();
    expect(() => parsePluginConfig({ version: 1, plugins: [], policyHook: { address: settings.address, keys: [] } })).toThrow();
  });

  it("an address without the install's signing key does not start", () => {
    expect(() => applyPolicyHook(registry(), settingsFor(hookKey), undefined)).toThrow(PolicyHookSetupError);
  });

  it("binds hosted settings to the same guards and requires the install signer", async () => {
    const settings = { address: "https://rules.example/hook", jwks: "https://rules.example/keys", thumbprints: [policyHookKeyThumbprint(hookKey.jwk)] };
    expect(() => applyHostedPolicyHook(registry(), settings, undefined)).toThrow(PolicyHookSetupError);
    const r = registry();
    applyHostedPolicyHook(r, settings, { issuer: ISSUER, signer: signerOf(install) }, { fetch: async () => new Response('{"keys":[]}'), admission: { holdMs: 0 } });
    expect(r.names("admission")).toEqual([POLICY_HOOK_ADAPTER_NAME]);
    expect(r.names("approvers")).toEqual([POLICY_HOOK_ADAPTER_NAME]);
    expect(await r.require("admission").admit({ companyId: COMPANY, idempotencyKey: "k", action: "task.start", projectName: "web", subject: { type: "task", id: "task_1" } })).toMatchObject({ allowed: false, code: "company_rules_no_answer" });
  });

  it("an address: the hook wraps the install's admission and approvers and asks", async () => {
    const r = registry();
    const service = fakeService({ key: hookKey, now: () => Date.now(), answer: () => ({ allow: false }) });
    expect(applyPolicyHook(r, settingsFor(hookKey), { issuer: ISSUER, signer: signerOf(install) }, { fetch: service.fetch })).toBeDefined();
    expect(r.names("admission")).toEqual([POLICY_HOOK_ADAPTER_NAME]);
    expect(r.names("approvers")).toEqual([POLICY_HOOK_ADAPTER_NAME]);
    const decision = await r.require("admission").admit({ companyId: COMPANY, idempotencyKey: "k", action: "task.start", projectName: "web", subject: { type: "task", id: "task_1" } });
    expect(decision).toMatchObject({ allowed: false, code: "company_rules_refused" });
    expect(service.asked).toHaveLength(1);
    const approvers = r.require("approvers");
    // Reading a requirement never asks; it gives the stricter default until the service has answered a real decision.
    expect((await approvers.requirement({ companyId: COMPANY, requestId: "r", kind: "plan", subject: { type: "task", id: "task_1" }, revision: 1, artifactDigest: "d" })).minApprovers).toBe(2);
    expect(service.asked).toHaveLength(1);
    r.seal();
  });
});
