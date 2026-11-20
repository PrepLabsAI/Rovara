// L4-ART: the broker's hosted core root gives each company's flow its own company-bound `artifacts` reader (the registry's object storage held to that company's workspaces). Real broker root,
// registry and runtimes over fakes. (The dispatcher's runtime is pinned in aws-core-dispatch-host.test.ts.)
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { artifactObjectKey } from "../../packages/broker/src/services/callbacks.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));

const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array | undefined): string | undefined => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

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
  const registry = await root.app.registry();
  const blobs = registry.require("object-storage");
  const put = (key: string, body: string) => blobs.put(key, text(body), { contentType: "text/plain", metadata: {}, retention: "plan" });
  const workspace = (companyId: OrgId, id: string, ownerKey: string) => w.store.put({ item: { ...workspaceKey(companyId, id), entityType: "WORKSPACE", id, companyId, orgId: companyId, ownerKey, projectName: "payments" } });
  return { root, w, put, workspace, logs };
}

describe("the broker's core root gives each company's flow a company-bound artifacts reader", () => {

  it("wires hosted second review and design review with fail-safe company autonomy", async () => {
    const { root } = await world();
    const a = (await root.app.runtimeFor(A)).flow.deps;
    const b = (await root.app.runtimeFor(B)).flow.deps;
    expect(typeof a.secondReview?.prepare).toBe("function");
    // Each company owns its design runtime.
    expect(a.designReview).toBeDefined();
    expect(b.designReview).toBeDefined();
    expect(a.designReview).not.toBe(b.designReview);
    expect(a.secondReview).not.toBe(b.secondReview);
    expect(await a.autonomy!({ companyId: A } as never)).toEqual({ autonomy: "suggest", unreadable: true });
    expect(await a.autonomy!({ companyId: B } as never)).toEqual({ autonomy: "suggest", noCompany: true });
  });

  it("reads a company's own workspace documents and never another company's, even for the same raw workspace id", async () => {
    const { root, put, workspace, logs, w } = await world();
    await workspace(A, "ws-shared", "owner-a"); await workspace(B, "ws-shared", "owner-b"); await workspace(B, "ws-b-only", "owner-b");
    await put(artifactObjectKey("ws-shared", "op-1", "plan.md"), "the shared id's document");
    const record = (companyId: OrgId, workspaceId: string, name: string) => w.store.put({ item: { ...workspaceKey(companyId, workspaceId), sk: `ARTIFACT#op-1#${name}`, entityType: "ARTIFACT", objectKey: artifactObjectKey(workspaceId, "op-1", name) } });
    await record(A, "ws-shared", "plan.md");
    await put("private/owner-b/ws-b-only/plan-documents/art-1.json", "b's private plan");
    const a = (await root.app.runtimeFor(A)).flow.deps.artifacts!, b = (await root.app.runtimeFor(B)).flow.deps.artifacts!;
    // The same key: it names a workspace both companies have a record for, so each reads what is stored there; the object is one install-wide object by that key.
    expect(decode(await a.get(artifactObjectKey("ws-shared", "op-1", "plan.md"), 1000))).toBe("the shared id's document");
    // B holds a workspace of the same raw id but never recorded that artifact: it is not B's to read
    expect(await b.get(artifactObjectKey("ws-shared", "op-1", "plan.md"), 1000)).toBeUndefined();
    // B's private plan is B's: A's flow is refused (and says why in fixed words, never the key)
    expect(await a.get("private/owner-b/ws-b-only/plan-documents/art-1.json", 1000)).toBeUndefined();
    expect(decode(await b.get("private/owner-b/ws-b-only/plan-documents/art-1.json", 1000))).toBe("b's private plan");
    const refusals = logs.filter((entry) => entry["event"] === "core_engine.artifact_read_refused");
    expect(refusals).toEqual([
      { event: "core_engine.artifact_read_refused", companyId: B, reason: "artifact_not_recorded" },
      { event: "core_engine.artifact_read_refused", companyId: A, reason: "workspace_not_company" },
    ]);
    expect(JSON.stringify(logs)).not.toContain("ws-b-only");
    // Anything that is not the flow's own key shape reads as not there
    expect(await a.get("private/org_aaaaaaaaaaaaaaaaaaaa/fixtures/x.json", 1000)).toBeUndefined();
  });

  it("bounds a read: an object bigger than the caller's limit is not there", async () => {
    const { root, put, workspace, w } = await world();
    await workspace(A, "ws-a", "owner-a");
    await put(artifactObjectKey("ws-a", "op-1", "big.json"), "x".repeat(600));
    await w.store.put({ item: { ...workspaceKey(A, "ws-a"), sk: "ARTIFACT#op-1#big.json", entityType: "ARTIFACT", objectKey: artifactObjectKey("ws-a", "op-1", "big.json") } });
    const a = (await root.app.runtimeFor(A)).flow.deps.artifacts!;
    expect(await a.get(artifactObjectKey("ws-a", "op-1", "big.json"), 599)).toBeUndefined();
    expect((await a.get(artifactObjectKey("ws-a", "op-1", "big.json"), 600))?.byteLength).toBe(600);
  });
});
