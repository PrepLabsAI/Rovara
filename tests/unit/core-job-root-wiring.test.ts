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
// Batch 14: the upkeep parts (#959) also look up the optional realtime adapter by name; none is registered here.
const registry = { require: () => ({}), names: () => [], get: () => undefined } as unknown as AdapterRegistry;
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
  // Batch 14: the root puts the company's SystemRuns gate on the flow (#949/#959), so the flow carries a store to read the consent row from.
  const flow = { deps: { companyId: A, store: { get: async () => undefined }, admission: {} } } as never;
  const ciMode = vi.fn(async () => "their_ci_watch" as const);
  runtime.services!(flow, { ciMode });
  // Batch 14: the wiring also carries the upkeep notice's live read (#959) next to the CI reader; L4-U5 adds the setup notice's live read beside it.
  expect(services).toHaveBeenCalledWith(A, flow, expect.anything(), expect.objectContaining({ ciMode, upkeep: expect.objectContaining({ administers: expect.any(Function) as unknown, setupRead: expect.any(Function) as unknown }) as unknown }));
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
