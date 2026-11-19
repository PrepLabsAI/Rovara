// L4-HW4: the broker's hosted core root gives each company's flow its own `keepEvidence` over the company-bound evidence store (the registry's object storage held to that company's workspaces).
// Real broker root, registry and runtimes over fakes. The evidence itself (guard, caps, Proof route) is pinned in hosted-keep-evidence.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));

const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";

async function world() {
  const w = createFakeWorld();
  w.clock.now = Date.now();
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  const logs: Array<Record<string, unknown>> = [];
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_ENGINE: `on:${A}:${B}`, ROVARA_CORE_ALLOWED_COMPANIES: `${A}:${B}`, ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6" },
    taskTokens: () => ({ signer: taskKeySigner(signerOf(makeKey("t".repeat(16)))), issuer: "https://api.example/v1/auth" }),
    documentClient: { async send() { return { Item: undefined }; } }, stateTableName: "state", signInTableName: "signin", callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: (entry) => { logs.push(entry); },
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
  });
  const workspace = (companyId: OrgId, id: string, ownerKey: string) => w.store.put({ item: { ...workspaceKey(companyId, id), entityType: "WORKSPACE", id, companyId, orgId: companyId, ownerKey, projectName: "payments" } });
  return { root, workspace, logs };
}

describe("the broker's core root keeps evidence for each company's flow", () => {
  const operation = { id: "op-1", workspaceId: "ws-a", dispatch: { kind: "task", payload: {} } } as never;
  const taskOf = (companyId: OrgId, workspaceId: string, ownerKey: string) => ({ companyId, workspaceId, ownerKey, taskId: "task-1", project: "payments" }) as never;
  const keep = (flow: { keepEvidence?: (input: never) => Promise<unknown> }, task: unknown) => flow.keepEvidence!({ task, operation, workflow: {}, candidateDigest: "c".repeat(64), checks: [{ id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "failed", class: "regression", output: "", durationMs: 1, exitCode: 1 }] } as never);

  it("sets a keeper on every company's flow, a different one for each", async () => {
    const { root } = await world();
    const [a, b] = [(await root.app.runtimeFor(A)).flow.deps, (await root.app.runtimeFor(B)).flow.deps];
    expect(typeof a.keepEvidence).toBe("function");
    expect(typeof b.keepEvidence).toBe("function");
    expect(a.keepEvidence).not.toBe(b.keepEvidence);
  });

  it("keeps a company's own task's pack in the shared bucket under its own workspace, and refuses (in fixed words) a task naming another company's workspace", async () => {
    const { root, workspace, logs } = await world();
    await workspace(A, "ws-a", "owner-a"); await workspace(B, "ws-b", "owner-b");
    const a = (await root.app.runtimeFor(A)).flow.deps, b = (await root.app.runtimeFor(B)).flow.deps;
    expect(await keep(a, taskOf(A, "ws-a", "owner-a"))).toMatchObject({ kept: true });
    const key = `private/owner-a/ws-a/evidence-pack/task-1/${"c".repeat(64)}.json`;
    const blobs = (await root.app.registry()).require("object-storage");
    expect(await blobs.stat(key)).toBeDefined();
    // B's keeper handed A's workspace (or its owner's key) keeps nothing there.
    expect(await keep(b, taskOf(B, "ws-a", "owner-a"))).toEqual({ kept: false, reason: "fault" });
    expect(await keep(b, taskOf(B, "ws-b", "owner-a"))).toEqual({ kept: false, reason: "fault" });
    expect(await blobs.stat("private/owner-a/ws-b/evidence-pack/task-1/" + "c".repeat(64) + ".json")).toBeUndefined();
    expect(logs.filter((entry) => entry["event"] === "core_engine.evidence_refused")).toEqual([
      { event: "core_engine.evidence_refused", companyId: B, reason: "workspace_not_company" },
      { event: "core_engine.evidence_refused", companyId: B, reason: "owner_mismatch" },
    ]);
    expect(JSON.stringify(logs)).not.toContain("owner-a/ws-a");
  });
});
