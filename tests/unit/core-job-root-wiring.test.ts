import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { AdapterRegistry } from "@agentx/contracts";
import type { CoreHostAppOptions } from "../../packages/broker/src/core-host/app.js";
import { createRowsPolicySource } from "@agentx/contracts";
import { createBrokerCoreRoot, type BrokerCoreRootInputs } from "../../packages/broker/src/aws/core-engine-root.js";
const captured = vi.hoisted<{ options: unknown }>(() => ({ options: undefined }));
vi.mock("../../packages/broker/src/core-host/app.js", () => ({ createCoreHostApp(options: unknown) { captured.options = options; return { serving: false }; } }));
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const inputs = (extra: Partial<BrokerCoreRootInputs> = {}): BrokerCoreRootInputs => ({ env: {}, documentClient: { send: async () => { throw new Error("unused"); } }, stateTableName: "state", signInTableName: undefined, callbackSigningKey: "a".repeat(32), repositoryGrantKey: Buffer.alloc(32), repositoryCredential: async () => { throw new Error("unused"); }, codeModules: () => { throw new Error("unused"); }, origin: () => "", log: () => undefined, ...extra });
// The registry is only asked for its store by the money stop (core-money-stop, merged with L3 in the batch of 2026-11-16); nothing here reads it.
const registry = { require: () => ({}), get: () => undefined, names: () => [] } as unknown as AdapterRegistry;
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
  // The company service builder reads the flow's deps for the system-runs gate (L4-P1): an empty deps is enough, nothing here reads a row.
  const flow = { deps: { admission: {}, store: {}, companyId: A } } as never;
  const ciMode = vi.fn(async () => "their_ci_watch" as const);
  runtime.services!(flow, { ciMode });
  expect(services).toHaveBeenCalledWith(A, flow, expect.anything(), { ciMode, upkeep: expect.objectContaining({ administers: expect.any(Function) as unknown, setupRead: expect.any(Function) as unknown }) as unknown });
});

it("preserves an explicitly malformed CI reporting input for the runtime to refuse", () => {
  createBrokerCoreRoot(inputs({ ciReporting: null as never }));
  expect(runtimeOptions().ciReporting).toBeNull();
});

it("the deployed broker and dispatcher roots wire no D1 policy source yet (TE-D1 is not shipped), so CI mode is their_ci_fix", () => {
  for (const file of ["packages/broker/src/aws/broker.ts", "packages/broker/src/aws/dispatcher.ts", "packages/broker/src/aws/worker-machines/dispatcher-core.ts"]) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(/\bpolicySource\b/u);
  }
});
