import { describe, expect, it, vi } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { when } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import * as codeModules from "../../packages/broker/src/core-host/code-modules.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";

async function world() {
  const w = createFakeWorld();
  const modules = vi.spyOn(codeModules, "codeAdapterModules").mockReturnValue(w.modules.filter(module =>
    ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point)));
  const client = { send: vi.fn<(command: unknown) => Promise<unknown>>(async () => ({})) };
  const logs: Array<Record<string, unknown>> = [];
  try {
    const root = createBrokerCoreRoot({
      env: { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6" },
      taskTokens: () => ({ signer: taskKeySigner(signerOf(makeKey("t".repeat(16)))), issuer: "https://api.example/v1/auth" }),
      documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1),
      repositoryCredential: async () => ({ token: "fixture" }), codeModules: () => ({}) as never,
      origin: () => "https://api.example", now: () => new Date(w.clock.now), log: entry => { logs.push(entry); },
      ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
      services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
    });
    // Force the real root to construct its registry while the deployment adapters are replaced by fakes.
    const registry = await root.app.registry();
    return { root, registry, w, client, logs };
  } finally { modules.mockRestore(); }
}

describe("hosted root merge guards in the default suite", () => {
  it("routes sign-in authority conditions and State writes in one hosted transaction", async () => {
    const h = await world();
    const store = h.registry.require("storage");
    const transaction = vi.spyOn(h.w.store, "transact");
    const identity = { pk: "DEVELOPER#creator", sk: "META" };
    const round = { pk: "ROUND#root-wiring", sk: "META" };
    try {
      expect(await store.transact([
        { kind: "check", key: identity, condition: when.eq("revoked", false) },
        { kind: "put", item: { ...round, admitted: true } },
      ])).toEqual({ applied: true });
      expect(transaction).not.toHaveBeenCalled();
      expect(h.client.send).toHaveBeenCalledTimes(1);
      const command = h.client.send.mock.calls[0]![0];
      expect(command).toBeInstanceOf(TransactWriteCommand);
      expect((command as TransactWriteCommand).input.TransactItems).toMatchObject([
        { ConditionCheck: { TableName: "signin", Key: identity } },
        { Put: { TableName: "state", Item: round } },
      ]);
    } finally { transaction.mockRestore(); }
  });

});
