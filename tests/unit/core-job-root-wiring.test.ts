import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { AdapterRegistry } from "@agentx/contracts";
import type { CoreHostAppOptions } from "../../packages/broker/src/core-host/app.js";
import { companyScoped } from "@agentx/contracts";
import { createBrokerCoreRoot, type BrokerCoreRootInputs } from "../../packages/broker/src/aws/core-engine-root.js";
import { hostedPolicySource } from "../../packages/broker/src/aws/core-policy-source.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const captured = vi.hoisted<{ options: unknown }>(() => ({ options: undefined }));
vi.mock("../../packages/broker/src/core-host/app.js", () => ({ createCoreHostApp(options: unknown) { captured.options = options; return { serving: false }; } }));
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const inputs = (extra: Partial<BrokerCoreRootInputs> = {}): BrokerCoreRootInputs => ({ env: {}, documentClient: { send: async () => { throw new Error("unused"); } }, stateTableName: "state", signInTableName: undefined, callbackSigningKey: "a".repeat(32), repositoryGrantKey: Buffer.alloc(32), repositoryCredential: async () => { throw new Error("unused"); }, codeModules: () => { throw new Error("unused"); }, origin: () => "", log: () => undefined, ...extra });
// The registry is only asked for its store by the money stop (core-money-stop, merged with L3 in the batch of 2026-11-16); nothing here reads it.
// Batch 14: the upkeep parts (#959) also look up the optional realtime adapter by name; none is registered here.
const registry = { require: () => ({}), names: () => [], get: () => undefined } as unknown as AdapterRegistry;
const runtimeOptions = () => (captured.options as CoreHostAppOptions).runtime(registry, A, {} as never);
const task = (orgId: string) => ({ orgId, project: "web" }) as never;

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
