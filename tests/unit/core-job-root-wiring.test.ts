import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { AdapterRegistry } from "@agentx/contracts";
import type { CoreHostAppOptions } from "../../packages/broker/src/core-host/app.js";
import { companyScoped, createRowsPolicySource } from "@agentx/contracts";
import { createBrokerCoreRoot, type BrokerCoreRootInputs } from "../../packages/broker/src/aws/core-engine-root.js";
import { hostedPolicySource } from "../../packages/broker/src/aws/core-policy-source.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const captured = vi.hoisted<{ options: unknown }>(() => ({ options: undefined }));
vi.mock("../../packages/broker/src/core-host/app.js", () => ({ createCoreHostApp(options: unknown) { captured.options = options; return { serving: false }; } }));
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const inputs = (extra: Partial<BrokerCoreRootInputs> = {}): BrokerCoreRootInputs => ({ env: {}, documentClient: { send: async () => { throw new Error("unused"); } }, stateTableName: "state", signInTableName: undefined, callbackSigningKey: "a".repeat(32), repositoryGrantKey: Buffer.alloc(32), repositoryCredential: async () => { throw new Error("unused"); }, codeModules: () => { throw new Error("unused"); }, origin: () => "", log: () => undefined, ...extra });
// The registry is only asked for its store by the money stop (core-money-stop, merged with L3 in the batch of 2026-11-16); nothing here reads it.
// L4-HW3 also asks it which points are registered (the standing-instructions seam looks for a code host and the company-instructions point): none here.
const registry = { require: () => ({}), names: () => [] } as unknown as AdapterRegistry;
const runtimeOptions = () => (captured.options as CoreHostAppOptions).runtime(registry, A, {} as never);
const task = (orgId: string) => ({ orgId, project: "web" }) as never;

it("the root gives runtime the injected company/project policy, or D1 today when absent", async () => {
  const source = createRowsPolicySource(async (scope) => ({ scope, rows: { project: { real_check: scope.key.includes(A) ? "sandbox_only" : "their_ci_watch" } } }));
  createBrokerCoreRoot(inputs({ policySource: source }));
  const runtime = runtimeOptions();
  expect(await runtime.ciReporting!.ciMode(task(A))).toBe("sandbox_only");
  expect(await runtime.ciReporting!.ciMode(task(B))).toBe("their_ci_watch");
  createBrokerCoreRoot(inputs());
  expect(await runtimeOptions().ciReporting!.ciMode(task(A))).toBe("their_ci_fix");
});

it("passes the runtime's checked CI reader into the company service builder", () => {
  const services = vi.fn(() => ({}));
  createBrokerCoreRoot(inputs({ services }));
  const runtime = runtimeOptions();
  const flow = {} as never;
  const ciMode = vi.fn(async () => "their_ci_watch" as const);
  runtime.services!(flow, { ciMode });
  expect(services).toHaveBeenCalledWith(A, flow, expect.anything(), { ciMode });
});

it("preserves an explicitly malformed CI reporting input for the runtime to refuse", () => {
  createBrokerCoreRoot(inputs({ ciReporting: null as never }));
  expect(runtimeOptions().ciReporting).toBeNull();
});

// L4-HW3d: the deployed broker passes the cached, company-scoped project policy source (aws/core-policy-source.ts) to the root, which builds it over its own rules service. The dispatcher roots
// build no merge tracking and wire none; nothing wires an explicit `policySource` (that input stays for a test or a different deployment).
it("the deployed broker root wires the hosted policy source; the dispatcher roots wire no policy source, so a root without one is D1 today (their_ci_fix)", () => {
  const broker = readFileSync("packages/broker/src/aws/broker.ts", "utf8");
  expect(broker).toMatch(/hostedPolicySource:\s*\(hook\)\s*=>\s*hostedPolicySource\(\{ documentClient, tableName: requiredEnvironment\("STATE_TABLE_NAME"\), now: Date\.now \}, hook\)/u);
  expect(broker).not.toMatch(/\bpolicySource:/u);
  for (const file of ["packages/broker/src/aws/dispatcher.ts", "packages/broker/src/aws/worker-machines/dispatcher-core.ts"]) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(/\b[hH]?ostedPolicySource\b|\bpolicySource\b/u);
  }
});

it("the root builds the hosted policy source once and hands it its own rules-service thunk; its answer is each company's CI mode; an explicit policySource or ciReporting wins", async () => {
  const built = vi.fn((hook: () => unknown) => { void hook; return createRowsPolicySource(async (scope) => ({ scope, rows: { project: { real_check: scope.key.includes(A) ? "sandbox_only" : "rovara_real_run" } } })); });
  createBrokerCoreRoot(inputs({ hostedPolicySource: built }));
  expect(built).toHaveBeenCalledTimes(1);
  // No rules service in this install: the thunk answers none (the settings page's and the per-task limit reader's reading of "no rules service").
  expect(built.mock.calls[0]![0]()).toBeUndefined();
  const runtime = runtimeOptions();
  expect(await runtime.ciReporting!.ciMode(task(A))).toBe("sandbox_only");
  expect(await runtime.ciReporting!.ciMode(task(B))).toBe("rovara_real_run");
  expect(built).toHaveBeenCalledTimes(1);
  const explicit = createRowsPolicySource(async (scope) => ({ scope, rows: { project: { real_check: "their_ci_watch" } } }));
  createBrokerCoreRoot(inputs({ hostedPolicySource: built, policySource: explicit }));
  expect(built).toHaveBeenCalledTimes(1);
  expect(await runtimeOptions().ciReporting!.ciMode(task(A))).toBe("their_ci_watch");
  const reader = { honest: true as const, ciMode: async () => "sandbox_only" as const };
  createBrokerCoreRoot(inputs({ hostedPolicySource: built, ciReporting: reader }));
  expect(await runtimeOptions().ciReporting!.ciMode(task(A))).toBe("sandbox_only");
});

it("the thunk the root hands over refuses (never none) when the install's rules service is set but unusable: no signer, or settings that do not read", () => {
  const hook = JSON.stringify({ address: "https://rules.example/v1/policy-hook", jwks: "https://rules.example/keys", thumbprints: ["a".repeat(43)] });
  const thunkOf = (extra: Partial<BrokerCoreRootInputs>, env: Record<string, string>) => {
    const built = vi.fn((thunk: () => unknown) => { void thunk; return createRowsPolicySource(async (scope) => ({ scope, rows: {} })); });
    createBrokerCoreRoot(inputs({ hostedPolicySource: built, env: { ROVARA_CORE_ENGINE: "on", ...env }, ...extra }));
    return built.mock.calls[0]![0];
  };
  expect(() => thunkOf({}, { ROVARA_POLICY_HOOK: hook })()).toThrow();
  expect(() => thunkOf({ policyHookInstall: () => undefined }, { ROVARA_POLICY_HOOK: hook })()).toThrow();
  expect(() => thunkOf({}, { ROVARA_POLICY_HOOK: "not json" })()).toThrow();
  expect(thunkOf({ policyHookInstall: () => ({ issuer: "https://install.example/v1/auth", signer: {} as never }) }, { ROVARA_POLICY_HOOK: hook })()).toMatchObject({ settings: { jwks: "https://rules.example/keys" } });
});

it("the real hosted source on the root: a project's stored choice is its merge tracking CI mode, per company; an unreadable row refuses", async () => {
  const db = new FakeDynamoDb();
  const row = (companyId: string, overrides: unknown) => db.set({ pk: companyScoped(companyId, "PROJECT_SETTINGS#web"), sk: "META", entityType: "PROJECT_SETTINGS", companyId, projectName: "web", overrides, revision: 1, updatedAt: "2026-11-18T10:00:00.000Z", updatedBy: "d".repeat(64) });
  row(A, { real_check: "sandbox_only" });
  row(B, { real_check: "private-canary" });
  createBrokerCoreRoot(inputs({ documentClient: db, stateTableName: "state", hostedPolicySource: (hook) => hostedPolicySource({ documentClient: db, tableName: "state", now: Date.now }, hook) }));
  const runtime = runtimeOptions();
  expect(await runtime.ciReporting!.ciMode(task(A))).toBe("sandbox_only");
  await expect(runtime.ciReporting!.ciMode(task(B))).rejects.toThrow("the project's CI mode could not be read");
});
