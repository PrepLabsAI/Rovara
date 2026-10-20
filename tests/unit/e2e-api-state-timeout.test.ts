import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, E2EAssertionSchema } from "@agentx/contracts";
import { executeE2EAPIApplicationScenario, type E2EApiRuntimePorts } from "../../packages/verifier/src/api-runtime.js";
import { E2EApplicationAssertionObservationSchema, evaluateE2EApplicationAssertionObservation } from "../../packages/verifier/src/application-result-adapter.js";

// Ruling W: a state assertion whose poll times out with a well-formed 2xx last sample of a different value is a definite mismatch (FAILED);
// anything that is not a well-formed 2xx answer stays unavailable.

const sha = "b".repeat(64);
const uuid = "22222222-2222-4222-8222-222222222222";
const expected = { version: 1, tenantId: "tenant-a", orderIds: ["a1", "a2"] };
const probeSchema = { type: "object", required: ["version", "tenantId", "orderIds"],
  properties: { version: { type: "integer" }, tenantId: { type: "string" }, orderIds: { type: "array", items: { type: "string" } } }, additionalProperties: false };

const frame = (artifactId: string, bytes: Uint8Array, mediaType = "application/json") =>
  ({ ref: { artifactId, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, mediaType }, bytes });
const json = (artifactId: string, value: unknown) => frame(artifactId, Buffer.from(canonicalJson(value)));

describe("state assertion evaluation after the poll times out (Ruling W)", () => {
  const assertion = E2EAssertionSchema.parse({ kind: "state", probeId: "api-state-positive/v1", equals: expected, pollTimeoutMs: 1_000 });
  const schema = json("probe-schema", probeSchema);
  const other = { version: 1, tenantId: "tenant-a", orderIds: ["a1"] };
  const samples = {
    pending: json("sample-pending", other), pendingAgain: json("sample-pending-2", other), ready: json("sample-ready", expected),
    malformedShape: json("sample-wrong-shape", { unexpected: true }),
  };
  const proofBytes = new Map([schema, ...Object.values(samples)].map((item) => [item.ref.artifactId, item]));
  const assetBinding = { caseId: "case-a", assertionIndex: 0, kind: "state-probe" as const, id: "api-state-positive/v1", manifestDigest: sha, ref: schema.ref };
  const at = (offsetMs: number) => new Date(Date.parse("2026-10-17T12:00:00.000Z") + offsetMs).toISOString();
  const sample = (offsetMs: number, valueRef: { artifactId: string; sha256: string; byteLength: number; mediaType: string }, disposition: string, httpStatus?: number) =>
    ({ observedAt: at(offsetMs), valueRef, disposition, ...(httpStatus === undefined ? {} : { httpStatus }) });
  const observation = (rows: unknown[]) => E2EApplicationAssertionObservationSchema.parse({ schemaVersion: "e2e-application-assertion-observation/v1", kind: "state",
    caseId: "case-a", assertionIndex: 0, assertionDigest: sha, observationId: "state-observation", lifecycleId: "lifecycle-a", observedAt: at(1_000),
    producer: { producerId: "installed-api", receiptId: "receipt-a", lifecycleId: "lifecycle-a", operationId: uuid, operationFence: 1, runtimeManifestDigest: sha,
      transportCorrelationId: "33333333-3333-4333-8333-333333333333" },
    subject: { kind: "service", processId: "owned-service-1", origin: "http://app:4317" }, accountContextId: "account-a", accountContextDigest: sha,
    sessionRef: "session-a", accountIdDigest: sha, probeId: "api-state-positive/v1", probeAssetRef: schema.ref, samples: rows });
  const evaluate = (rows: unknown[]) => evaluateE2EApplicationAssertionObservation({ assertion, observation: observation(rows), proofBytes, assetBinding });

  it("collects a definite mismatch when the last sample is a well-formed 2xx answer of a different value that was still pending at the timeout", () => {
    expect(evaluate([sample(0, samples.pending.ref, "pending", 200), sample(900, samples.pendingAgain.ref, "timed-out", 200)]))
      .toEqual({ supported: true, passed: false, value: other });
    expect(evaluate([sample(0, samples.pending.ref, "timed-out", 204)])).toMatchObject({ supported: true, passed: false });
  });

  it("keeps the other samples' ordering rules: only the last sample may be the timed-out one", () => {
    expect(evaluate([sample(0, samples.pending.ref, "timed-out", 200), sample(100, samples.pendingAgain.ref, "pending", 200)]).supported).toBe(false);
    expect(evaluate([sample(0, samples.pending.ref, "timed-out", 200), sample(100, samples.pendingAgain.ref, "timed-out", 200)]).supported).toBe(false);
  });

  it("stays unavailable when the last answer was not 2xx, or its status is not recorded", () => {
    expect(evaluate([sample(0, samples.pending.ref, "timed-out", 503)]).supported).toBe(false);
    expect(evaluate([sample(0, samples.pending.ref, "timed-out", 429)]).supported).toBe(false);
    expect(evaluate([sample(0, samples.pending.ref, "timed-out")]).supported).toBe(false);
    // A 503 that simply kept the probe pending when the budget ran out is not a mismatch either.
    expect(evaluate([sample(0, samples.pending.ref, "pending", 503)]).supported).toBe(false);
    expect(evaluate([sample(0, samples.pending.ref, "pending", 200)]).supported).toBe(false);
  });

  it("stays unavailable when a sample does not fit the approved probe shape", () => {
    expect(evaluate([sample(0, samples.malformedShape.ref, "timed-out", 200)]).supported).toBe(false);
    expect(evaluate([sample(0, samples.malformedShape.ref, "pending", 200), sample(100, samples.pending.ref, "timed-out", 200)]).supported).toBe(false);
  });

  it("never reads a timed-out sample that holds the approved value as a mismatch or as a pass", () => {
    expect(evaluate([sample(0, samples.ready.ref, "timed-out", 200)])).toMatchObject({ supported: false, passed: false });
  });

  it("still passes a pending-to-ready sequence and refuses an unknown disposition", () => {
    expect(evaluate([sample(0, samples.pending.ref, "pending", 200), sample(100, samples.ready.ref, "ready", 200)])).toMatchObject({ supported: true, passed: true });
    expect(evaluate([sample(0, samples.pending.ref, "pending", 200), sample(100, samples.ready.ref, "ready")])).toMatchObject({ supported: true, passed: true });
    expect(() => observation([sample(0, samples.pending.ref, "expired", 200)])).toThrow();
    expect(() => observation([sample(0, samples.pending.ref, "pending", 99)])).toThrow();
  });
});

describe("the API state poll records why it stopped (Ruling W)", () => {
  const caseId = "case-1";
  const origin = "http://127.0.0.1:43124";
  const producer = { producerId: "api-driver", receiptId: "receipt", lifecycleId: "api-life", operationId: "00000000-0000-4000-8000-000000000031",
    operationFence: 1, runtimeManifestDigest: sha, transportCorrelationId: "00000000-0000-4000-8000-000000000014" };
  const binding = { caseId, subject: { kind: "service", processId: "service-1", origin }, caseProducer: producer,
    assertionProducers: [{ assertionIndex: 0, producer }], accountRef: { applicationId: "orders-api", profileId: "viewer", revision: 1, definitionDigest: sha },
    sessionRef: "session", accountIdDigest: sha, identityReceiptRef: json("identity", {}).ref, subjectIdentityReceiptRef: json("subject", {}).ref,
    selectedArtifact: { appId: "orders-api", artifactId: "artifact", sha256: sha, platform: "api", buildManifestDigest: sha }, connection: null };
  const plan = { expected: { caseId, accountContextId: "account-context", accountContextDigest: sha, assertionDigests: ["a".repeat(64)] } };
  const scenario = (pollTimeoutMs: number) => ({ scenarioId: "scenario", requirementId: "requirement", requestedTargetIds: ["api-target"], required: true,
    accountProfileId: "viewer", minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [],
    assertions: [{ kind: "state", probeId: "api-state-positive/v1", equals: expected, pollTimeoutMs }] });

  type Answer = { status: number; body: Uint8Array; contentType?: string };
  async function poll(input: { pollTimeoutMs: number; answer: (index: number) => Answer; elapsedPerRequestMs?: number }) {
    // The poll budget is measured on this clock, which moves only when the code under test sleeps or a stand-in request takes time.
    let clockMs = 1_000_000;
    const clock = { now: () => clockMs, sleep: async (milliseconds: number) => { clockMs += milliseconds; } };
    const evidence: Array<{ kind: string; bytes: Uint8Array }> = [];
    let polls = 0;
    const ports: E2EApiRuntimePorts = {
      casePlans: { readCasePlan: async () => { throw new Error("unused"); } }, caseObservations: { readCaseObservationBinding: async () => { throw new Error("unused"); } },
      evidence: { recordCaseEvidence: async (item) => { const proof = frame(`evidence-${evidence.length}`, Uint8Array.from(item.bytes),
        item.mediaType === "application/octet-stream" ? "application/octet-stream" : "application/json"); evidence.push({ kind: item.kind, bytes: Uint8Array.from(item.bytes) }); return proof.ref; } },
      actionWindows: { begin: async () => ({ actionId: "action" }), finish: async () => ({ confirmed: true as const }) },
      openCaseSession: async () => ({ sessionRef: "session", accountIdDigest: sha }), closeCaseSession: async () => ({ confirmed: true }),
      originFor: () => origin, readApprovedJsonSchema: async () => { throw new Error("unused"); },
      readApprovedStateProbe: async ({ assertionIndex, probeId }) => { const proof = json("state-probe-schema", probeSchema);
        return { proof, assetBinding: { caseId, assertionIndex, kind: "state-probe", id: probeId, manifestDigest: sha, ref: proof.ref } }; },
      request: async (request) => {
        polls += 1;
        clockMs += input.elapsedPerRequestMs ?? 0;
        const answer = input.answer(polls);
        return { requestId: `request-${polls}`, responseId: `response-${polls}`, method: request.method, path: request.path, status: answer.status, body: Buffer.from(answer.body),
          contentType: answer.contentType ?? "application/json", origin: request.origin, observedAt: new Date(clockMs).toISOString() };
      },
    };
    const actual = await executeE2EAPIApplicationScenario({ caseId, scenario: scenario(input.pollTimeoutMs) as never, sessionRef: "session", origin, ports, plan: plan as never,
      binding: binding as never, signal: new AbortController().signal, clock });
    const frames = evidence.filter((item) => item.kind === "assertion-observation")
      .map((item) => JSON.parse(Buffer.from(item.bytes).toString("utf8")) as { samples: Array<{ disposition: string; httpStatus?: number }> });
    return { actual, polls, samples: frames[0]?.samples ?? [] };
  }
  const bytes = (value: unknown) => Buffer.from(canonicalJson(value));
  const different: Answer = { status: 200, body: bytes({ version: 1, tenantId: "tenant-a", orderIds: ["a1"] }) };

  it("collects FAILED when a 2xx answer of a different value is still the last sample at the timeout", async () => {
    const { actual, samples, polls } = await poll({ pollTimeoutMs: 1_000, answer: () => different });
    expect(polls).toBeGreaterThan(1);
    expect(actual.assertions[0]).toMatchObject({ outcome: "failed", reason: "source-approved-value-mismatch" });
    expect(samples.slice(0, -1).every((item) => item.disposition === "pending" && item.httpStatus === 200)).toBe(true);
    expect(samples.at(-1)).toMatchObject({ disposition: "timed-out", httpStatus: 200 });
  });

  it("also collects FAILED when slow answers use up the budget between polls", async () => {
    // Each answer takes 400 ms of a 1 s budget: two 2xx samples (at 400 ms and 900 ms) and a last sleep spend it, and no third request is made.
    const { actual, samples } = await poll({ pollTimeoutMs: 1_000, elapsedPerRequestMs: 400, answer: () => different });
    expect(actual.assertions[0]?.outcome).toBe("failed");
    expect(samples.map((item) => item.disposition)).toEqual(["pending", "timed-out"]);
  });

  it("keeps a probe that answered 503 until the timeout unavailable", async () => {
    const { actual, samples } = await poll({ pollTimeoutMs: 1_000, answer: () => ({ status: 503, body: different.body }) });
    expect(actual.assertions[0]).toMatchObject({ outcome: "unavailable", reason: "observation-or-asset-not-supported" });
    expect(samples.at(-1)).toMatchObject({ disposition: "pending", httpStatus: 503 });
  });

  it("keeps a 2xx answer that is not JSON unavailable", async () => {
    const { actual, samples } = await poll({ pollTimeoutMs: 1_000, answer: () => ({ status: 200, body: Buffer.from("not json") }) });
    expect(actual.assertions[0]?.outcome).toBe("unavailable");
    expect(samples.at(-1)?.disposition).toBe("failed");
  });

  it("keeps a 2xx answer that does not fit the approved probe shape unavailable", async () => {
    const { actual } = await poll({ pollTimeoutMs: 1_000, answer: () => ({ status: 200, body: bytes({ unexpected: true }) }) });
    expect(actual.assertions[0]?.outcome).toBe("unavailable");
  });

  it("does not call a poll that stopped at its attempt cap a timeout", async () => {
    // A budget (the 5 minute maximum) far beyond what 100 attempts can use: the poll ended because it ran out of attempts, not time.
    const { actual, samples, polls } = await poll({ pollTimeoutMs: 300_000, answer: () => different });
    expect(polls).toBe(100);
    expect(actual.assertions[0]?.outcome).toBe("unavailable");
    expect(samples.at(-1)?.disposition).toBe("pending");
  });

  it("still passes a poll that reaches the approved value", async () => {
    const { actual, samples } = await poll({ pollTimeoutMs: 1_000, answer: (index) => index < 3 ? different : { status: 200, body: bytes(expected) } });
    expect(actual.assertions[0]?.outcome).toBe("passed");
    expect(samples.at(-1)).toMatchObject({ disposition: "ready", httpStatus: 200 });
  });
});
