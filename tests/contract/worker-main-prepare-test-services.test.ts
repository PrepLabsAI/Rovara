// Test services, slice 1, T2: the worker's PREPARE handler as main.ts wires it. main.ts is imported for real (its server is not started and the preparation itself is replaced), the handler is called with a prepare
// invocation that carries a `testServices` plan, and what comes back is checked: the plan reaches the preparation, and the usage record the preparation reports rides in the result under `testServicesUsage`.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type * as ServerModule from "../../packages/worker/src/server.js";
import type * as PrepareModule from "../../packages/worker/src/prepare.js";
import type * as InvokeAuthModule from "../../packages/worker/src/invoke-auth.js";
import type * as ChecksRuntimeModule from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import { TaskDependencyPlanSchema, TestServicesUsageRecordSchema, type TestServicesUsageRecord } from "@agentx/contracts";

const captured = vi.hoisted(() => ({ executor: undefined as undefined | { execute(invocation: unknown): Promise<unknown>; invocationFeatures?: readonly string[] }, options: undefined as undefined | Record<string, unknown>, report: undefined as TestServicesUsageRecord | undefined, cancellationSeen: false }));

vi.mock("../../packages/worker/src/server.js", async (importOriginal) => {
  const original = await importOriginal<typeof ServerModule>();
  return {
    ...original,
    createWorkerServerState: (...args: Parameters<typeof original.createWorkerServerState>) => { captured.executor = args[1]; return original.createWorkerServerState(...args); },
    startWorkerServer: () => undefined,
  };
});
vi.mock("../../packages/worker/src/prepare.js", async (importOriginal) => {
  const original = await importOriginal<typeof PrepareModule>();
  return {
    ...original,
    prepareWorkspace: (options: Record<string, unknown>) => {
      captured.options = options;
      const testServices = options.testServices as { onUsageRecord(record: unknown): void; cancellation?: unknown; operationId?: string } | undefined;
      captured.cancellationSeen = testServices?.cancellation !== undefined && typeof testServices.operationId === "string";
      if (testServices !== undefined && captured.report !== undefined) testServices.onUsageRecord(captured.report);
      return Promise.resolve({ projectName: "sample", projectRevision: 1, repositories: [{ name: "sample", path: "repo/sample", resolvedCommit: "a".repeat(40) }] });
    },
  };
});
vi.mock("../../packages/worker/src/invoke-auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof InvokeAuthModule>();
  return { ...original, invokeAuthenticationFromEnvironment: () => undefined as never };
});
vi.mock("../../packages/worker/src/workflow-e2e-application-runtime.js", async (importOriginal) => {
  const original = await importOriginal<typeof ChecksRuntimeModule>();
  return { ...original, createApplicationChecksFeatureMonitor: () => ({ start: () => undefined, executor: {} }) };
});

const root = await realpath(await mkdtemp(join(tmpdir(), "rsv-main-")));
vi.stubEnv("AGENTX_WORKSPACE_ROOT", root);
vi.stubEnv("AGENTX_CONTROL_PLANE_URL", "http://127.0.0.1:1");
vi.stubEnv("AGENTX_TASK_SHELL", "local");
vi.stubEnv("CONTAINED_FOUNDATION_EVIDENCE_DIR", join(root, "evidence"));
await import("../../packages/worker/src/main.js");
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

const dependency = TaskDependencyPlanSchema.parse({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: "a".repeat(64),
  config: { database: "app", user: "app" }, aliases: ["postgres"], connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], seeds: [], reset: "fresh_per_round",
});
const record: TestServicesUsageRecord = TestServicesUsageRecordSchema.parse({
  schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 12, resetCount: 0 }], unknownCalls: { domains: [], otherCount: 0 },
});
const prepareInvocation = (extra: Record<string, unknown>) => ({
  protocolVersion: 1, kind: "prepare", operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
  payload: { project: { name: "sample", revision: 1, repositories: [], setup: [], readiness: [], orchestratorInstructions: "x" }, ...extra },
});

describe("main.ts's prepare handler with a testServices payload", () => {
  it("hands the plan and the operation to the preparation, and puts the reported usage record in the result under testServicesUsage", async () => {
    captured.report = record;
    const result = await captured.executor!.execute(prepareInvocation({ testServices: { dependencies: [dependency] } })) as Record<string, unknown>;
    const given = captured.options!.testServices as { dependencies: unknown[]; operationId: string };
    expect(given.dependencies).toEqual([dependency]);
    expect(given.operationId).toBe("11111111-1111-4111-8111-111111111111");
    expect(captured.cancellationSeen).toBe(true);
    expect(result.testServicesUsage).toEqual(record);
    expect(TestServicesUsageRecordSchema.safeParse(result.testServicesUsage).success).toBe(true);
    expect(result).toMatchObject({ manifestPath: ".agentx/preparation-manifest.json", projectName: "sample" });
  });

  it("without a testServices payload the preparation gets none and the result has no testServicesUsage (today's)", async () => {
    captured.report = record;
    captured.options = undefined;
    const result = await captured.executor!.execute(prepareInvocation({})) as Record<string, unknown>;
    expect(captured.options!.testServices).toBeUndefined();
    expect(Object.keys(result)).not.toContain("testServicesUsage");
  });

  it("a preparation that reports no record leaves the result without the key", async () => {
    captured.report = undefined;
    const result = await captured.executor!.execute(prepareInvocation({ testServices: { dependencies: [dependency] } })) as Record<string, unknown>;
    expect(Object.keys(result)).not.toContain("testServicesUsage");
  });

  it("advertises the test-services feature only with a worker configuration (none here)", () => {
    expect(captured.executor!.invocationFeatures ?? []).not.toContain("task.testServices.v1");
  });
});
