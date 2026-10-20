import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, E2EApplicationPreparedEnvironmentSchema, e2eApplicationPreparedEnvironmentDigest } from "@agentx/contracts";
import { createAPIApplicationCliHost, executeE2EAPIApplicationScenario, validateE2EAPIApplicationPath, type E2EApiRuntimePorts } from "../../packages/verifier/src/api-runtime.js";
import type { E2EApplicationCliLaunchContext } from "../../packages/verifier/src/application-runtime-bootstrap.js";
import { createE2EApplicationRuntimePorts, prepareE2EApplicationEnvironment, sealE2EApplicationEnvironment } from "../../packages/verifier/src/application-services.js";
import { isPinnedRovaraHttpEngine } from "../../packages/verifier/src/rovara-http-engine-descriptor.js";
import { createCompiledApiApplicationFixture } from "../support/e2e-application-fixture.js";

const sha = "b".repeat(64);
const launch: E2EApplicationCliLaunchContext = {
  schemaVersion: "e2e-application-cli-launch/v1", launchId: "00000000-0000-4000-8000-000000000011", shardId: "api-shard",
  compiledInventoryDigest: sha, groupCompiledInventoryDigest: sha, bindingDigest: sha, roundId: "00000000-0000-4000-8000-000000000012",
  runId: "00000000-0000-4000-8000-000000000013", cliHost: { profileId: "api-profile", descriptor: { entryPointId: "api", entryPointManifestDigest: sha } },
  selectedTarget: { kind: "api", targetId: "api-target", applicationId: "orders-api", runtimeProfileId: "api-profile", accountProfileId: "viewer",
    protocol: "http", originRef: "orders-origin" }, transportId: "transport", transportCorrelationId: "00000000-0000-4000-8000-000000000014",
  deadlineAt: "2099-01-01T00:00:00.000Z",
};
const ports: E2EApiRuntimePorts = {
  casePlans: { readCasePlan: async () => { throw new Error("not called by a construction-only test"); } },
  caseObservations: { readCaseObservationBinding: async () => { throw new Error("not called by a construction-only test"); } },
  evidence: { recordCaseEvidence: async () => { throw new Error("not called by a construction-only test"); } },
  actionWindows: { begin: async () => ({ actionId: "action-window" }), finish: async () => ({ confirmed: true as const }) },
  openCaseSession: async () => ({ sessionRef: "session", accountIdDigest: sha }),
  closeCaseSession: async () => ({ confirmed: true }),
  request: async () => ({ requestId: "request", responseId: "response", method: "GET", path: "/api/orders", status: 200,
    body: Buffer.from("{}"), contentType: "application/json", origin: "http://127.0.0.1:43124", observedAt: new Date().toISOString() }),
  originFor: () => "http://127.0.0.1:43124", readApprovedJsonSchema: async () => ({ proof: { ref: { artifactId: "schema", sha256: sha,
    byteLength: 2, mediaType: "application/json" as const }, bytes: Buffer.from("{}") }, assetBinding: { caseId: "case", assertionIndex: 0,
    kind: "json-schema", id: "schema", manifestDigest: sha, ref: { artifactId: "schema", sha256: sha, byteLength: 2, mediaType: "application/json" } } }),
  readApprovedStateProbe: async () => { throw new Error("not called by this test"); },
};

describe("API application runtime", () => {
  it("allows the compiler's app:null API declaration while binding identity to selectedTarget", () => {
    const host = createAPIApplicationCliHost({ launchContext: launch, ports, declaration: {
      preparedEnvironmentDigest: sha, target: { targetId: "api-target", app: null },
      originByApplicationId: [{ applicationId: "orders-api", origin: "http://127.0.0.1:43124" }], cases: [],
    } });
    // The engine is Rovara's first-party HTTP engine: the runner sees exactly the pinned descriptor and its one fixture.
    const engine = host.engine as unknown as { name: string; version: string; spiVersion: number; platform: string; capabilities: ReadonlySet<string> };
    expect(isPinnedRovaraHttpEngine({ name: engine.name, version: engine.version, spiVersion: engine.spiVersion, platform: engine.platform, capabilities: [...engine.capabilities] })).toBe(true);
    expect(host.profileId).toBe("api-profile");
  });

  it("permits only exact same-origin relative API paths", () => {
    expect(validateE2EAPIApplicationPath("/api/orders")).toBe("/api/orders");
    for (const path of ["https://evil.invalid/api/orders", "//evil.invalid/path", "/api/../admin", "/api/orders?tenant=other", "/api/orders#x", "/\\evil.invalid"]) {
      expect(() => validateE2EAPIApplicationPath(path)).toThrow();
    }
  });

  it("aborts a slow owned request at the case cap and never dispatches the later step", async () => {
    let requests = 0;
    let finishes = 0;
    // The case cap is reached while the first request is outstanding: the request itself says when (no timer), so the cap cannot land before the request starts.
    const caseCap = new AbortController();
    const executionPorts: E2EApiRuntimePorts = { ...ports,
      actionWindows: { begin: async () => ({ actionId: "slow-action" }), finish: async () => { finishes += 1; return { confirmed: true as const }; } },
      evidence: { recordCaseEvidence: async ({ bytes, mediaType }) => ({ artifactId: `ref-${requests}-${bytes.byteLength}`,
        sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, mediaType }) },
      request: async (_input, signal) => {
        requests += 1;
        await new Promise<never>((_resolve, reject) => {
          const fail = () => reject(new Error("owned request cancelled"));
          if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
          caseCap.abort();
        });
        throw new Error("unreachable");
      },
    };
    const scenario = { scenarioId: "scenario", requirementId: "requirement", requestedTargetIds: ["api-target"], required: true,
      accountProfileId: "viewer", minimumEvidence: "runtime", requiredRealComponentIds: [],
      steps: [{ kind: "request", requestId: "first", method: "GET", path: "/orders", body: {} },
        { kind: "request", requestId: "later", method: "POST", path: "/orders", body: { create: true } }], assertions: [] };
    await expect(executeE2EAPIApplicationScenario({ caseId: "case-1", scenario: scenario as never, sessionRef: "session",
      origin: "http://127.0.0.1:43124", ports: executionPorts, plan: { expected: { assertionDigests: [] } } as never,
      binding: {} as never, signal: caseCap.signal })).rejects.toThrow(/cancelled/);
    expect(requests).toBe(1);
    expect(finishes).toBe(1);
  });

  it("prepares a native-only group without inventing a service, origin, or URL", async () => {
    const recipeBody = { schemaVersion: 1 as const, build: [], launch: { kind: "application" as const, appId: "native-app",
      artifactRef: "approved-native-artifact", arguments: [] }, serviceProfileIds: [], seedProfileId: "seed-v1",
      accountProfileIds: ["owner"], allowedOrigins: [] };
    const recipe = { ...recipeBody, recipeDigest: createHash("sha256").update(canonicalJson(recipeBody)).digest("hex") };
    const projectContract = { schemaVersion: "e2e-application-project/v1" as const, recipe, service: null,
      accountProfiles: [{ profileId: "owner", scope: "synthetic-test" as const, authProfileId: "auth-v1", seedProfileId: "seed-v1",
        tenantRef: "tenant", roleRef: "owner", identityProbeId: "identity-v1" }], targetAccounts: [] };
    const now = new Date(Date.now() + 10_000).toISOString();
    const preparation = { schemaVersion: "e2e-application-host-preparation/v1" as const,
      preparationId: "00000000-0000-4000-8000-000000000201", taskId: "00000000-0000-4000-8000-000000000202",
      workspaceId: "00000000-0000-4000-8000-000000000203", operationId: "00000000-0000-4000-8000-000000000204",
      operationFence: 1, workflowRevision: 1, candidateDigest: sha, planDigest: sha, intentDigest: sha, groupId: "native-group",
      runtimeProfileId: "native-profile", runtimeManifestDigest: sha, networkPolicyDigest: sha, admittedAt: now,
      preparationDeadlineAt: new Date(Date.parse(now) + 20_000).toISOString(), deadlineAt: new Date(Date.parse(now) + 30_000).toISOString() };
    const seen: unknown[][] = [];
    const ports = { services: { allocate: async () => { throw new Error("native-only group must not allocate a service"); },
      close: async () => ({ confirmed: true }) }, network: {
      allocate: async (input: { applications: readonly unknown[] }) => { seen.push([...input.applications]);
        return { leaseId: "native-network-lease", originByApplicationId: [], policyDigest: sha }; },
      observe: async () => ({ policyDigest: sha, deniedAttempts: [], observedRealComponentIds: [], observedMockComponentIds: [], receiptRefs: [] }),
      close: async () => ({ confirmed: true }),
    } } as never;
    const prepared = await prepareE2EApplicationEnvironment({ preparation, applications: [{ applicationId: "native-app", projectContract,
      recipe, buildManifestDigest: sha, artifactSha256: sha, sourceManifestDigest: sha, sourceArchiveSha256: sha }],
      approvedExternalConnectionRefs: [], accountDefinitions: [], mockManifest: [] }, ports, new AbortController().signal);
    expect(seen).toEqual([[]]);
    expect(prepared.services).toEqual([]);
    expect(prepared.originByApplicationId).toEqual([]);
  });

  it("composes allocated execution, owned close, and post-close readback from the sealed prepared group", async () => {
    const fixture = createCompiledApiApplicationFixture();
    const { compiled, binding } = fixture;
    const runtime = compiled.runtimeBindings.get(compiled.group.runtimeProfileId)!;
    const applicationId = compiled.originByApplicationId[0]!.applicationId;
    const approved = compiled.applicationBindings.get(applicationId)!;
    const selectedRecipe = approved.approval.applications.find((item) => item.applicationId === applicationId)!.recipe;
    const at = new Date(Date.now() + 5_000).toISOString();
    const preparation = { schemaVersion: "e2e-application-host-preparation/v1" as const,
      preparationId: "00000000-0000-4000-8000-000000000101", taskId: "00000000-0000-4000-8000-000000000103", workspaceId: "00000000-0000-4000-8000-000000000102",
      operationId: binding.operationId, operationFence: binding.operationFence, workflowRevision: binding.workflowRevision,
      candidateDigest: binding.candidateDigest, planDigest: binding.planDigest,
      intentDigest: compiled.runtimeAdmissionContext.selectionInput.intentDigest, groupId: binding.groupId,
      runtimeProfileId: compiled.group.runtimeProfileId, runtimeManifestDigest: runtime.manifestDigest,
      networkPolicyDigest: runtime.capabilities.networkPolicyDigest, admittedAt: binding.admittedAt,
      preparationDeadlineAt: new Date(Date.parse(binding.deadlineAt) - 1_000).toISOString(), deadlineAt: binding.deadlineAt };
    const processIdentity = { containerId: "owned-container", pid: 123, startTime: at, namespaceId: "owned-netns", incarnation: "process-1" };
    const service = { leaseId: "service-lease", applicationId, origin: compiled.originByApplicationId[0]!.origin, processIdentity,
      buildManifestDigest: approved.build.manifestDigest, artifactSha256: approved.build.outputs[0]!.sha256, recipeDigest: selectedRecipe.recipeDigest };
    const preparedBody = { preparation, authorityDigest: sha, networkLeaseId: "network-lease", services: [service],
      originByApplicationId: [{ applicationId, origin: service.origin }], receiptRefs: [] };
    const prepared = E2EApplicationPreparedEnvironmentSchema.parse({ ...preparedBody, preparedDigest: e2eApplicationPreparedEnvironmentDigest(preparedBody) });
    const runBinding = { ...binding, environmentDigest: prepared.preparedDigest };
    const order: string[] = [];
    const environment = { services: { observeIdentity: async () => ({ processIdentity, artifactSha256: service.artifactSha256,
      buildManifestDigest: service.buildManifestDigest, recipeDigest: service.recipeDigest }), seal: async () => { order.push("service-seal"); } },
    network: { observe: async () => ({ policyDigest: preparation.networkPolicyDigest, deniedAttempts: [], observedRealComponentIds: [],
      observedMockComponentIds: [], receiptRefs: [] }), seal: async () => { order.push("network-seal"); } } } as never;
    const admissionDigest = "c".repeat(64);
    await sealE2EApplicationEnvironment({ prepared, admissionDigest, binding: runBinding }, environment, new AbortController().signal);
    const compiledWithPrepared = { ...compiled, preparedEnvironmentDigest: prepared.preparedDigest };
    const runInput = { binding: runBinding, suite: { bundle: compiled.bundle, files: compiled.files, expectedCases: compiled.expectedCases },
      profile: { profileId: compiled.group.runtimeProfileId, runtimeManifestDigest: runtime.manifestDigest,
        networkPolicyDigest: preparation.networkPolicyDigest }, modelPermit: null } as never;
    const supervisor = {
      launch: async () => { order.push("allocate"); return { leaseId: "supervisor-lease" }; },
      observeEngineIdentity: async () => [],
      execute: async () => { order.push("execute"); return { process: { exitCode: 0, timedOut: false, aborted: false }, rawReport: null,
        observedUpstreamRunId: null, coverageByCase: new Map(), artifacts: [], modelReceiptIds: [], startedAt: at, finishedAt: at, cleanup: "confirmed" }; },
      close: async () => { order.push("owned-close"); return { confirmed: true }; },
    } as never;
    const ports = createE2EApplicationRuntimePorts({ compiled: compiledWithPrepared, runInput, prepared,
      admissionDigest, runnerToolchain: runtime.runnerToolchain, accountSessionRefs: [], modelProxyRef: null, supervisor,
      readActualRun: async () => { order.push("readback"); return { protocol: "actual" } as never; } });
    const lease = await ports.allocate(runInput, new AbortController().signal);
    const collection = await lease.execute(new AbortController().signal);
    await lease.close(new AbortController().signal);
    await ports.readActualRun(new AbortController().signal);
    expect(collection.process.exitCode).toBe(0);
    expect(order).toEqual(["network-seal", "service-seal", "allocate", "execute", "owned-close", "readback"]);
    expect(() => createE2EApplicationRuntimePorts({ compiled, runInput, prepared, admissionDigest,
      runnerToolchain: runtime.runnerToolchain, accountSessionRefs: [], modelProxyRef: null, supervisor,
      readActualRun: async () => ({}) as never })).toThrow(/prepared leases|compiled suite/i);
    expect(() => createE2EApplicationRuntimePorts({ compiled: compiledWithPrepared, runInput, prepared,
      admissionDigest: "d".repeat(64), runnerToolchain: runtime.runnerToolchain, accountSessionRefs: [], modelProxyRef: null,
      supervisor, readActualRun: async () => ({}) as never })).toThrow(/sealed admission/i);
  });

  it("binds repeated same-path assertions to the last approved request and preserves distinct observed response IDs", async () => {
    const at = "2026-10-17T12:00:00.000Z";
    // The state poll's budget is measured on this clock, which moves only when the code under test sleeps or a stand-in request "takes time": no
    // real timer or machine load can decide whether a sample arrived inside the budget.
    let clockMs = 1_000_000;
    const clock = { now: () => clockMs, sleep: async (milliseconds: number) => { clockMs += milliseconds; } };
    const proofBytes = (artifactId: string, bytes: Uint8Array, mediaType: "application/json" | "application/octet-stream" = "application/json") => ({
      ref: { artifactId, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, mediaType }, bytes });
    const schemaBytes = Buffer.from(canonicalJson({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false }));
    const schemaProof = proofBytes("schema-proof", schemaBytes);
    const evidenceRows: Array<{ input: unknown; proof: ReturnType<typeof proofBytes> }> = [];
    let responseIndex = 0;
    let statePolls = 0;
    const actionEvents: string[] = [];
    const executionPorts: E2EApiRuntimePorts = {
      ...ports,
      actionWindows: { begin: async (action) => { actionEvents.push(`begin:${action.actionIndex}:${action.actionDigest}`); return { actionId: `action-${action.actionIndex}` }; },
        finish: async (action) => { actionEvents.push(`finish:${action.actionIndex}:${action.actionDigest}`); return { confirmed: true as const }; } },
      evidence: { recordCaseEvidence: async (input) => {
        const body = Uint8Array.from(input.bytes); const proof = proofBytes(`evidence-${evidenceRows.length}`, body,
          input.mediaType === "application/octet-stream" ? "application/octet-stream" : "application/json");
        evidenceRows.push({ input, proof }); return proof.ref;
      } },
      request: async (input) => {
        responseIndex += 1;
        const stateRequest = input.path === "/api/orders/state";
        if (stateRequest) statePolls += 1;
        const body = Buffer.from(canonicalJson(stateRequest
          ? statePolls === 1 ? { version: 1, tenantId: "tenant-a", orderIds: ["a1"] }
            : { version: 1, tenantId: "tenant-a", orderIds: ["a1", "a2"] }
          : { ok: responseIndex === 2 }));
        return { requestId: `actual-request-${responseIndex}`, responseId: `actual-response-${responseIndex}`, method: input.method,
          path: input.path, status: stateRequest && statePolls === 1 ? 503 : responseIndex === 1 ? 503 : 200,
          body, contentType: "application/json", origin: input.origin, observedAt: at };
      },
      readApprovedJsonSchema: async ({ caseId, assertionIndex, schemaRef }) => ({ proof: schemaProof,
        assetBinding: { caseId, assertionIndex, kind: "json-schema", id: schemaRef, manifestDigest: sha, ref: schemaProof.ref } }),
      readApprovedStateProbe: async ({ caseId, assertionIndex, probeId }) => {
        const bytes = Buffer.from(canonicalJson({ type: "object", required: ["version", "tenantId", "orderIds"],
          properties: { version: { type: "integer" }, tenantId: { type: "string" }, orderIds: { type: "array", items: { type: "string" } } }, additionalProperties: false }));
        const proof = proofBytes("state-probe-schema", bytes);
        return { proof, assetBinding: { caseId, assertionIndex, kind: "state-probe", id: probeId, manifestDigest: sha, ref: proof.ref } };
      },
    };
    const producer = { producerId: "api-driver", receiptId: "receipt", lifecycleId: "api-life", operationId: "00000000-0000-4000-8000-000000000031",
      operationFence: 1, runtimeManifestDigest: sha, transportCorrelationId: launch.transportCorrelationId };
    const binding = { caseId: "case-1", subject: { kind: "service", processId: "service-1", origin: "http://127.0.0.1:43124" },
      caseProducer: producer, assertionProducers: [{ assertionIndex: 0, producer }, { assertionIndex: 1, producer }, { assertionIndex: 2, producer }],
      accountRef: { applicationId: "orders-api", profileId: "viewer", revision: 1, definitionDigest: sha }, sessionRef: "session", accountIdDigest: sha,
      identityReceiptRef: schemaProof.ref, subjectIdentityReceiptRef: schemaProof.ref,
      selectedArtifact: { appId: "orders-api", artifactId: "artifact", sha256: sha, platform: "api", buildManifestDigest: sha }, connection: null };
    const scenario = { scenarioId: "scenario", requirementId: "requirement", requestedTargetIds: ["api-target"], required: true,
      accountProfileId: "viewer", minimumEvidence: "runtime", requiredRealComponentIds: [],
      steps: [{ kind: "request", requestId: "first", method: "GET", path: "/orders", body: {} },
        { kind: "request", requestId: "second", method: "GET", path: "/orders", body: {} }],
      assertions: [{ kind: "http-status", method: "GET", path: "/orders", equals: 200 },
        { kind: "json", responseId: "second", schemaRef: "orders-v1", equals: { ok: true } },
        { kind: "state", probeId: "api-state-positive/v1", equals: { version: 1, tenantId: "tenant-a", orderIds: ["a1", "a2"] }, pollTimeoutMs: 1000 }] };
    const plan = { expected: { caseId: "case-1", accountContextId: "account-context", accountContextDigest: sha,
      assertionDigests: ["a".repeat(64), "b".repeat(64), "c".repeat(64)] } };
    const actual = await executeE2EAPIApplicationScenario({ caseId: "case-1", scenario: scenario as never, sessionRef: "session",
      origin: "http://127.0.0.1:43124", ports: executionPorts, plan: plan as never, binding: binding as never, signal: new AbortController().signal, clock });
    expect(actual.assertions.map((item) => item.outcome)).toEqual(["passed", "passed", "passed"]);
    expect(statePolls).toBe(2);
    expect(actionEvents).toHaveLength(4);
    expect(actionEvents.map((event) => event.split(":")[0])).toEqual(["begin", "finish", "begin", "finish"]);
    const statusFrame = JSON.parse(Buffer.from(evidenceRows.find((row) => (row.input as { kind: string }).kind === "assertion-observation")!.proof.bytes).toString()) as Record<string, unknown>;
    expect(statusFrame).toMatchObject({ requestId: "actual-request-2", responseId: "actual-response-2", status: 200 });
    expect(actual.steps.map((item) => item.evidenceRefs).flat()).toHaveLength(8);
    const failedPrefix = await executeE2EAPIApplicationScenario({ caseId: "case-1", scenario: { ...scenario,
      steps: [{ kind: "request" as const, requestId: "only", method: "GET" as const, path: "/orders", body: {} }],
      assertions: [{ kind: "http-status" as const, method: "GET" as const, path: "/orders", equals: 201 },
        { kind: "json" as const, responseId: "only", schemaRef: "orders-v1", equals: { ok: true } }] } as never,
      sessionRef: "session", origin: "http://127.0.0.1:43124", ports: executionPorts, plan: { expected: { ...plan.expected,
        assertionDigests: ["d".repeat(64), "e".repeat(64)] } } as never, binding: { ...binding,
        assertionProducers: [{ assertionIndex: 0, producer }, { assertionIndex: 1, producer }] } as never, signal: new AbortController().signal });
    expect(failedPrefix.assertions.map((item) => item.outcome)).toEqual(["failed", "unavailable"]);

    const matchingErrorPorts: E2EApiRuntimePorts = { ...executionPorts, request: async (input) => ({
      requestId: "pending-request", responseId: "pending-response", method: input.method, path: input.path,
      status: 503, body: Buffer.from(canonicalJson({ version: 1, tenantId: "tenant-a", orderIds: ["a1", "a2"] })),
      contentType: "application/json", origin: input.origin, observedAt: at,
    }) };
    const pendingScenario = { ...scenario, steps: [], assertions: [{ kind: "state" as const,
      probeId: "api-state-positive/v1", equals: { version: 1, tenantId: "tenant-a", orderIds: ["a1", "a2"] }, pollTimeoutMs: 1 }] };
    const pendingResult = await executeE2EAPIApplicationScenario({ caseId: "case-1", scenario: pendingScenario as never,
      sessionRef: "session", origin: "http://127.0.0.1:43124", ports: matchingErrorPorts,
      plan: { expected: { ...plan.expected, assertionDigests: ["f".repeat(64)] } } as never,
      binding: { ...binding, assertionProducers: [{ assertionIndex: 0, producer }] } as never,
      signal: new AbortController().signal, clock });
    expect(pendingResult.assertions[0]?.outcome).not.toBe("passed");
    expect(pendingResult.assertions[0]?.reason).not.toBe("assertion-observed");

    const latePorts: E2EApiRuntimePorts = { ...executionPorts, request: async (input) => {
      clockMs += 10; // the response arrives 10 ms into a 1 ms budget
      return { requestId: "late-request", responseId: "late-response", method: input.method, path: input.path,
        status: 200, body: Buffer.from(canonicalJson({ version: 1, tenantId: "tenant-a", orderIds: ["a1", "a2"] })),
        contentType: "application/json", origin: input.origin, observedAt: at };
    } };
    const lateResult = await executeE2EAPIApplicationScenario({ caseId: "case-1", scenario: pendingScenario as never,
      sessionRef: "session", origin: "http://127.0.0.1:43124", ports: latePorts,
      plan: { expected: { ...plan.expected, assertionDigests: ["1".repeat(64)] } } as never,
      binding: { ...binding, assertionProducers: [{ assertionIndex: 0, producer }] } as never,
      signal: new AbortController().signal, clock });
    expect(lateResult.assertions[0]?.outcome).not.toBe("passed");
    expect(lateResult.assertions[0]?.reason).not.toBe("assertion-observed");
  });
});
