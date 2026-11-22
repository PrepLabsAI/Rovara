import { describe, expect, it, vi } from "vitest";
import { PlanEvidenceBundleSchema, type OrgId } from "@agentx/contracts";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createBrokerCoreServices } from "../../packages/broker/src/aws/core-job-services.js";
import { taskKeySigner } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { makeKey, signerOf } from "./policy-hook-fixture.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { planEvidencePointer } from "../../packages/broker/src/core/plan/store.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { planDocument } from "../support/plan-documents.js";

const adapters = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock("../../packages/broker/src/core-host/code-modules.js", async (original) => ({ ...await original<object>(), codeAdapterModules: () => adapters.modules }));
const A: OrgId = "org_aaaaaaaaaaaaaaaaaaaa", B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const commit = "a".repeat(40), digest = "b".repeat(64);
type StoredPlan = Parameters<NonNullable<TaskFlowDeps["afterPlanStored"]>>[0];

async function world() {
  const w = createFakeWorld();
  adapters.modules = w.modules.filter((module) => ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "secrets"].includes(module.point));
  const root = createBrokerCoreRoot({
    env: { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6" },
    taskTokens: () => ({ signer: taskKeySigner(signerOf(makeKey("t".repeat(16)))), issuer: "https://api.example/v1/auth" }),
    documentClient: { async send() { return { Item: undefined }; } }, stateTableName: "state", signInTableName: "signin",
    callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1), repositoryCredential: async () => ({ token: "fake" }), codeModules: () => ({}) as never,
    origin: () => "https://api.example", now: () => new Date(w.clock.now), log: () => undefined,
    ciReporting: { honest: true, ciMode: async () => "sandbox_only" as const },
    services: (companyId, flow, registry, wiring) => createBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!, now: () => new Date(w.clock.now) }),
  });
  await w.store.put({ item: { ...workspaceKey(A, "ws-a"), entityType: "WORKSPACE", id: "ws-a", companyId: A, orgId: A, ownerKey: "owner-a", projectName: "payments" } });
  const flow = (await root.app.runtimeFor(A)).flow.deps;
  const repositories = [{ name: "payments", path: "payments", url: "https://github.com/example/demo.git" }];
  flow.projects = { ...flow.projects, revision: async () => ({ definition: { repositories } }) as never };
  const read = vi.spyOn(w.host, "fileAtRevision").mockImplementation(async (_repo, _path, sha, scope) => `${sha}\n${"orgId" in scope ? scope.orgId : undefined}\nthird`);
  const input = {
    task: { taskId: "task-a", companyId: A, workspaceId: "ws-a", ownerKey: "owner-a", project: "payments", startingRevision: 1, preparedBase: [{ repositoryId: "payments", baseCommitSha: "c".repeat(40) }] },
    workflow: { revision: 7, artifacts: [{ id: "plan-a", sha256: digest, format: "structured", objectKey: "private/owner-a/ws-a/plan-documents/plan-a.json" }], reviewBase: [{ repositoryId: "payments", baseCommitSha: commit }] },
    artifactId: "plan-a", artifactSha256: digest, prefix: "private/owner-a/ws-a/plan-documents/plan-a",
    plan: planDocument({ claims: [{ id: "1", text: "Pinned code", evidence: [{ kind: "code", path: "payments/file.ts", startLine: 1, endLine: 2 }] }], decisions: [] }),
  } as StoredPlan;
  return { root, w, flow, input, read };
}

async function bundleOf(flow: TaskFlowDeps, input: StoredPlan) {
  const pointer = await planEvidencePointer(flow.store, input.task.taskId, input.artifactId);
  expect(pointer).toMatchObject({ entityType: "PLAN_EVIDENCE_POINTER", artifactId: "plan-a", artifactSha256: digest });
  const bytes = await flow.artifacts!.get(pointer!.objectKey, 100_000);
  return PlanEvidenceBundleSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

describe("hosted plan citations", () => {
  it("wires the hosted hook and stores evidence readable by the existing pointer/reader without changing the workflow", async () => {
    const { flow, input } = await world();
    const before = JSON.stringify(input.workflow);
    expect(flow.afterPlanStored).toBeTypeOf("function");
    await flow.afterPlanStored!(input);
    expect((await bundleOf(flow, input)).excerpts[0]).toMatchObject({ status: "ok", commit, lines: [commit, A] });
    expect(JSON.stringify(input.workflow)).toBe(before);
    const first = await planEvidencePointer(flow.store, "task-a", "plan-a");
    await flow.afterPlanStored!(input);
    expect(await planEvidencePointer(flow.store, "task-a", "plan-a")).toEqual(first);
  });

  it("uses the prepared base when reviewBase is absent and preserves unavailable citations when the recorded host cannot read", async () => {
    const { flow, input, read } = await world();
    delete input.workflow.reviewBase;
    await flow.afterPlanStored!(input);
    expect((await bundleOf(flow, input)).excerpts[0]).toMatchObject({ status: "ok", commit: "c".repeat(40), lines: ["c".repeat(40), A] });
    input.task.taskId = "task-unavailable";
    read.mockRejectedValue(new Error("provider unavailable"));
    await expect(flow.afterPlanStored!(input)).resolves.toBeUndefined();
    expect((await bundleOf(flow, input)).excerpts[0]).toMatchObject({ status: "unavailable" });
  });

  it.each(["company", "workspace", "owner", "prefix", "artifact"])("refuses a mismatched %s before resolving or writing evidence", async (kind) => {
    const { flow, input, read } = await world();
    if (kind === "company") input.task.companyId = B;
    if (kind === "workspace") input.task.workspaceId = "ws-other";
    if (kind === "owner") input.task.ownerKey = "owner-other";
    if (kind === "owner" || kind === "workspace") {
      input.prefix = `private/${input.task.ownerKey}/${input.task.workspaceId}/plan-documents/plan-a`;
      input.workflow.artifacts[0]!.objectKey = `${input.prefix}.json`;
    }
    if (kind === "prefix") input.prefix = "private/owner-a/ws-a/evidence/plan-a";
    if (kind === "artifact") input.workflow.artifacts[0]!.objectKey = "private/owner-other/ws-a/plan-documents/plan-a.json";
    await expect(flow.afterPlanStored!(input)).resolves.toBeUndefined();
    expect(await planEvidencePointer(flow.store, "task-a", "plan-a")).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("a different company's runtime cannot write to this workspace and a store fault never rejects the hook", async () => {
    const { root, flow, input, w } = await world();
    const b = (await root.app.runtimeFor(B)).flow.deps;
    input.task.companyId = B;
    await expect(b.afterPlanStored!(input)).resolves.toBeUndefined();
    expect(await planEvidencePointer(flow.store, "task-a", "plan-a")).toBeUndefined();
    input.task.companyId = A;
    const fault = vi.spyOn(w.store, "get").mockRejectedValue(new Error("store unavailable"));
    await expect(flow.afterPlanStored!(input)).resolves.toBeUndefined();
    fault.mockRestore();
  });
});
