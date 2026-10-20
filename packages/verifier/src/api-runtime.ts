import { createHash, randomUUID } from "node:crypto";
import { E2EApplicationCliHostDescriptorSchema, E2EScenarioSchema, E2ERunBindingSchema, E2ERuntimeAccountRefSchema,
  canonicalJson, type E2ERuntimeAccountRef, type E2EScenario, type E2EApplicationAccountPorts,
  type E2EApplicationSupervisorPorts, type E2EApplicationPreparedEnvironment, type E2ERunInput, type ProjectSetupRunnerToolchain } from "@agentx/contracts";
import { createE2EApplicationCaseCaptureFrame, createE2EApplicationAssertionObservationHeader,
  readValidatedE2EApplicationCliCasePlan, recordE2EApplicationCliEvidence,
  readValidatedE2EApplicationCaseObservation, type E2EApplicationCliCasePlanReader,
  type E2EApplicationCliEvidenceWriter, type E2EApplicationProtectedCaseObservationReader } from "./application-services.js";
import type { E2EApplicationCliHost, E2EApplicationCliLaunchContext } from "./application-runtime-bootstrap.js";
import { prepareE2EApplicationEnvironment, sealE2EApplicationEnvironment, type E2EApplicationEnvironmentPorts,
  type E2EApplicationPreparationInputs } from "./application-services.js";
import { assertionStepsOf, runInsideAssertionSteps } from "./assertion-steps.js";
import { createRovaraHttpEngine } from "./rovara-http-engine.js";
import { runIsolatedE2EApplication, type E2EApplicationRuntimePorts } from "./application-runtime.js";
import { createE2EApplicationRuntimePorts } from "./application-services.js";
import type { E2ECompiledApplicationSuite } from "./application-scenarios.js";
import { E2EApplicationAssertionAssetBindingSchema, E2EApplicationAssertionObservationSchema, E2EApplicationProofBytesSchema,
  evaluateE2EApplicationAssertionObservation,
  type E2EApplicationCaseCapture, type E2EApplicationObservationBinding, type E2EApplicationProofBytes } from "./application-result-adapter.js";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const utc = () => new Date().toISOString();
const waitForNextStatePoll = async (signal: AbortSignal, milliseconds: number) => {
  const abortError = () => signal.reason instanceof Error ? signal.reason : new Error("state polling was cancelled");
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    signal.addEventListener("abort", abort, { once: true });
  });
};
export type E2EApiRuntimeResponse = Readonly<{ requestId: string; responseId: string; method: string; path: string; status: number;
  body: Uint8Array; contentType: string; origin: string; observedAt: string }>;
export type E2EApiRuntimePorts = Readonly<{
  casePlans: E2EApplicationCliCasePlanReader;
  caseObservations: E2EApplicationProtectedCaseObservationReader;
  evidence: E2EApplicationCliEvidenceWriter;
  /** One authenticated protected window per admitted action; never replayed. */
  actionWindows: Readonly<{
    begin(input: { caseId: string; actionIndex: number; actionDigest: string }, signal: AbortSignal): Promise<{ actionId: string }>;
    finish(input: { caseId: string; actionIndex: number; actionDigest: string }, signal: AbortSignal): Promise<{ confirmed: true }>;
  }>;
  /** Implemented by the installed private account/session composition. */
  openCaseSession(input: { binding: unknown; applicationId: string; profileId: string; approvedAccountRef: E2ERuntimeAccountRef; origin: string }, signal: AbortSignal): Promise<{
    sessionRef: string; accountIdDigest: string;
  }>;
  closeCaseSession(sessionRef: string, signal: AbortSignal): Promise<{ confirmed: boolean }>;
  /** Fixed owned request client; it receives no caller URL, headers, or ambient credentials. */
  request(input: { sessionRef: string; origin: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown;
    /** The approved scenario step's own request id: the client names the request it makes by it, which is how an observation is tied to its step. */
    requestId?: string }, signal: AbortSignal): Promise<E2EApiRuntimeResponse>;
  originFor(applicationId: string, preparedEnvironmentDigest: string): string;
  /** Reads only an installed, source-approved assertion schema asset by its exact approved ID. */
  readApprovedJsonSchema(input: { caseId: string; assertionIndex: number; schemaRef: string }, signal: AbortSignal): Promise<{
    proof: E2EApplicationProofBytes; assetBinding: unknown;
  }>;
  /** Returns the exact protected installed state-probe asset for this assertion, never its samples. */
  readApprovedStateProbe(input: { caseId: string; assertionIndex: number; probeId: string }, signal: AbortSignal): Promise<{
    proof: E2EApplicationProofBytes; assetBinding: unknown;
  }>;
}>;
type ApiDeclaration = Readonly<{ preparedEnvironmentDigest: string; target: { targetId: string; app: null };
  originByApplicationId: readonly { applicationId: string; origin: string }[];
  cases: readonly { caseId: string; upstreamTestId: string; targetId: string; assertionBindings: readonly { index: number; kind: string; digest: string }[] }[] }>;

export function validateE2EAPIApplicationPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")
    || [...path].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) throw new Error("API request path must be a fixed same-origin path");
  const parsed = new URL(path, "http://application.invalid");
  if (parsed.origin !== "http://application.invalid" || parsed.pathname !== path || parsed.search || parsed.hash) throw new Error("API request may not select an origin, query, fragment, or normalized path");
  return path;
}
async function writeJson(ports: E2EApiRuntimePorts, caseId: string, kind: "case-capture" | "step-observation" | "assertion-observation" | "http-request" | "http-response", value: unknown, signal: AbortSignal) {
  return recordE2EApplicationCliEvidence({ writer: ports.evidence, caseId, kind,
    bytes: Buffer.from(canonicalJson(value), "utf8"), mediaType: "application/json", signal });
}

export async function executeE2EAPIApplicationScenario(input: { caseId: string; scenario: E2EScenario; sessionRef: string; origin: string; ports: E2EApiRuntimePorts;
  plan: Parameters<typeof createE2EApplicationAssertionObservationHeader>[0]["plan"]; binding: E2EApplicationObservationBinding; signal: AbortSignal;
  /** Test seam: the clock and the pause between state polls. Production uses the wall clock; a test that bounds a poll in milliseconds supplies its own so no real time decides the verdict. */
  clock?: Readonly<{ now(): number; sleep(milliseconds: number, signal: AbortSignal): Promise<void> }> }):
  Promise<{ steps: E2EApplicationCaseCapture["steps"]; assertions: E2EApplicationCaseCapture["assertions"];
    artifacts: E2EApplicationCaseCapture["artifacts"] }> {
  const responses = new Map<string, { response: E2EApiRuntimeResponse; bodyRef: Awaited<ReturnType<typeof recordE2EApplicationCliEvidence>>;
    requestRef: Awaited<ReturnType<typeof recordE2EApplicationCliEvidence>>; responseFrameRef: Awaited<ReturnType<typeof recordE2EApplicationCliEvidence>> }>();
  const steps: E2EApplicationCaseCapture["steps"] = [];
  const assertions: E2EApplicationCaseCapture["assertions"] = [];
  const artifacts: E2EApplicationCaseCapture["artifacts"] = [];
  let stoppedReason: string | null = null;
  for (let index = 0; index < input.scenario.steps.length; index += 1) {
    if (input.signal.aborted) throw new Error("API case was cancelled before its next admitted step");
    const step = input.scenario.steps[index]!;
    if (step.kind !== "request") throw new Error(`API target cannot execute ${step.kind} steps; no UI or generic runtime fallback is installed`);
    const path = validateE2EAPIApplicationPath(step.path);
    const bodyText = canonicalJson(step.body);
    if (Buffer.byteLength(bodyText) > 256 * 1024) throw new Error("API request body exceeds the fixed bounded JSON limit");
    const requestRef = await writeJson(input.ports, input.caseId, "http-request", { caseId: input.caseId, index,
      requestId: `${input.caseId}:${index}`, method: step.method, path, body: step.body, bodySha256: sha(bodyText), observedAt: utc() }, input.signal);
    const action = { caseId: input.caseId, actionIndex: index, actionDigest: sha(canonicalJson(step)) };
    const window = await input.ports.actionWindows.begin(action, input.signal);
    if (!window || typeof window.actionId !== "string" || window.actionId.length < 1 || window.actionId.length > 160) {
      throw new Error("protected API action window did not return its exact current identity");
    }
    let response: E2EApiRuntimeResponse;
    try {
      response = await input.ports.request({ sessionRef: input.sessionRef, origin: input.origin,
        method: step.method, path, body: step.body, requestId: step.requestId }, input.signal);
    } catch (requestError) {
      const finished = await input.ports.actionWindows.finish(action, input.signal).catch(() => null);
      if (!finished || finished.confirmed !== true) throw new Error("protected API action outcome is uncertain because its action window did not finish", { cause: requestError });
      throw requestError;
    }
    const finished = await input.ports.actionWindows.finish(action, input.signal);
    if (!finished || finished.confirmed !== true) throw new Error("protected API action outcome is uncertain because its action window did not finish");
    if (response.origin !== input.origin || response.path !== path || response.method !== step.method
      || response.body.byteLength > 1_048_576 || !Number.isInteger(response.status) || response.status < 100 || response.status > 599
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(response.requestId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(response.responseId)
      || response.requestId === response.responseId || responses.has(step.requestId)) {
      throw new Error("owned API client returned a response outside its exact request, origin, identifier, or body bounds");
    }
    const bodyRef = await recordE2EApplicationCliEvidence({ writer: input.ports.evidence, caseId: input.caseId,
      kind: "http-response", bytes: response.body, mediaType: "application/octet-stream", signal: input.signal });
    const responseFrameRef = await writeJson(input.ports, input.caseId, "http-response", { schemaVersion: "e2e-application-http-response/v1",
      caseId: input.caseId, index,
      requestId: response.requestId, responseId: response.responseId, method: response.method, path: response.path,
      status: response.status, contentType: response.contentType, bodySha256: bodyRef.sha256, bodyRef, observedAt: response.observedAt }, input.signal);
    const observationId = randomUUID();
    const stepRef = await writeJson(input.ports, input.caseId, "step-observation", { schemaVersion: "e2e-application-step-observation/v1",
      caseId: input.caseId, index, declaredStepIndex: index, kind: step.kind, observationId, requestRef, responseRef: responseFrameRef,
      requestId: response.requestId, responseId: response.responseId, at: response.observedAt, outcome: "completed" }, input.signal);
    steps.push({ index, declaredStepIndex: index, kind: step.kind, actionDigest: sha(canonicalJson(step)), observationId,
      at: response.observedAt, outcome: "completed", evidenceRefs: [requestRef, bodyRef, responseFrameRef, stepRef], agentOperationRefs: [] });
    artifacts.push(requestRef, bodyRef, responseFrameRef, stepRef);
    responses.set(step.requestId, { response, bodyRef, requestRef, responseFrameRef });
  }
  for (let index = 0; index < input.scenario.assertions.length; index += 1) {
    const assertion = input.scenario.assertions[index]!;
    const observedAt = utc(); const observationId = randomUUID();
    const header = createE2EApplicationAssertionObservationHeader({ plan: input.plan, binding: input.binding, index, observedAt, observationId });
    if (stoppedReason) {
      assertions.push({ index, digest: input.plan.expected.assertionDigests[index]!, observedAt, observationId: null,
        value: null, evidenceRef: null, outcome: "unavailable", reason: stoppedReason, producer: header.producer });
      continue;
    }
    if (assertion.kind === "text" || assertion.kind === "visible" || assertion.kind === "csv" || assertion.kind === "file") {
      assertions.push({ index, digest: input.plan.expected.assertionDigests[index]!, observedAt, observationId: null,
        value: null, evidenceRef: null, outcome: "unavailable", reason: `unsupported-api-${assertion.kind}`,
        producer: header.producer });
      stoppedReason = "prior-assertion-observation-unavailable";
      continue;
    }
    let observation: unknown; const proofBytes = new Map<string, E2EApplicationProofBytes>();
    let assetBinding: ReturnType<typeof E2EApplicationAssertionAssetBindingSchema.parse> | null = null;
    if (assertion.kind === "http-status") {
      const lastRequest = input.scenario.steps.map((step, stepIndex) => ({ step, stepIndex }))
        .filter((item) => item.step.kind === "request" && item.step.method === assertion.method && item.step.path === assertion.path).at(-1);
      const captured = lastRequest?.step.kind === "request" ? responses.get(lastRequest.step.requestId) : undefined;
      if (!captured) {
        assertions.push({ index, digest: input.plan.expected.assertionDigests[index]!, observedAt, observationId: null, value: null,
          evidenceRef: null, outcome: "unavailable", reason: "no-preceding-approved-request-matches-status-assertion",
          producer: header.producer });
        stoppedReason = "prior-assertion-observation-unavailable";
        continue;
      }
      const response = captured.response;
      proofBytes.set(captured.bodyRef.artifactId, { ref: captured.bodyRef, bytes: response.body });
      observation = { ...header, kind: "http-status", requestId: response.requestId, responseId: response.responseId,
        method: response.method, path: response.path, origin: response.origin, status: response.status, bodyRef: captured.bodyRef,
        connectionRef: input.binding.connection?.ref ?? null };
    }
    if (assertion.kind === "json") {
      const captured = responses.get(assertion.responseId);
      if (!captured) {
        assertions.push({ index, digest: input.plan.expected.assertionDigests[index]!, observedAt, observationId: null, value: null,
          evidenceRef: null, outcome: "unavailable", reason: "json-assertion-response-handle-has-no-approved-request",
          producer: header.producer });
        stoppedReason = "prior-assertion-observation-unavailable";
        continue;
      }
      const response = captured.response;
      if (!/^application\/json(?:\s*;|$)/i.test(response.contentType)) throw new Error("API JSON assertion response has no JSON media type");
      const schema = await input.ports.readApprovedJsonSchema({ caseId: input.caseId, assertionIndex: index, schemaRef: assertion.schemaRef }, input.signal);
      const protectedProof = E2EApplicationProofBytesSchema.parse(schema.proof);
      const parsedAsset = E2EApplicationAssertionAssetBindingSchema.parse(schema.assetBinding);
      if (protectedProof.bytes.byteLength === 0 || protectedProof.bytes.byteLength > 65_536 || parsedAsset.caseId !== input.caseId
        || parsedAsset.assertionIndex !== index || parsedAsset.kind !== "json-schema" || parsedAsset.id !== assertion.schemaRef
        || canonicalJson(parsedAsset.ref) !== canonicalJson(protectedProof.ref)) throw new Error("approved API JSON schema asset is not bound to this exact assertion and protected proof bytes");
      assetBinding = parsedAsset;
      proofBytes.set(captured.bodyRef.artifactId, { ref: captured.bodyRef, bytes: response.body });
      proofBytes.set(protectedProof.ref.artifactId, protectedProof);
      artifacts.push(protectedProof.ref);
      observation = { ...header, kind: "json", responseId: response.responseId, schemaRef: assertion.schemaRef,
        schemaAssetRef: protectedProof.ref, bodyRef: captured.bodyRef };
    }
    if (assertion.kind === "state") {
      // The only installed API state probe is the pinned read-only orders-state probe.
      // The path comes from its approved asset identity, never from the caller or scenario.
      if (assertion.probeId !== "api-state-positive/v1") throw new Error("API state probe is not in the installed fixed probe inventory");
      const probe = await input.ports.readApprovedStateProbe({ caseId: input.caseId, assertionIndex: index, probeId: assertion.probeId }, input.signal);
      const protectedProof = E2EApplicationProofBytesSchema.parse(probe.proof);
      const parsedAsset = E2EApplicationAssertionAssetBindingSchema.parse(probe.assetBinding);
      const assetText = new TextDecoder("utf-8", { fatal: true }).decode(protectedProof.bytes);
      const probeSchema = JSON.parse(assetText) as unknown;
      if (protectedProof.bytes.byteLength === 0 || protectedProof.bytes.byteLength > 65_536
        || canonicalJson(probeSchema) !== assetText || parsedAsset.caseId !== input.caseId || parsedAsset.assertionIndex !== index
        || parsedAsset.kind !== "state-probe" || parsedAsset.id !== assertion.probeId
        || canonicalJson(parsedAsset.ref) !== canonicalJson(protectedProof.ref)) {
        throw new Error("protected state-probe schema asset is not bound to this exact assertion and proof bytes");
      }
      const samples: Array<{ observedAt: string; valueRef: Awaited<ReturnType<typeof recordE2EApplicationCliEvidence>>; disposition: "pending" | "ready" | "failed" | "timed-out"; httpStatus?: number }> = [];
      /** Whether the poll ended because its time budget ran out (not an attempt cap, a final answer, or a failure). */
      let budgetExhausted = false;
      const now = (): number => (input.clock ? input.clock.now() : Date.now());
      const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> => (input.clock ? input.clock.sleep(milliseconds, signal) : waitForNextStatePoll(signal, milliseconds));
      const pollStartedAt = now();
      const pollDeadline = pollStartedAt + assertion.pollTimeoutMs;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (now() > pollDeadline) { budgetExhausted = true; break; }
        if (input.signal.aborted) throw input.signal.reason ?? new Error("API state polling was cancelled");
        const remainingMs = pollDeadline - now();
        if (remainingMs <= 0) { budgetExhausted = true; break; }
        const requestDeadline = new AbortController();
        const requestTimer = setTimeout(() => requestDeadline.abort(new Error("API state request exceeded its remaining poll budget")), remainingMs);
        let response: Awaited<ReturnType<E2EApiRuntimePorts["request"]>>;
        try {
          response = await input.ports.request({ sessionRef: input.sessionRef, origin: input.origin, method: "GET", path: "/api/orders/state" },
            AbortSignal.any([input.signal, requestDeadline.signal]));
        } catch (error) {
          if (input.signal.aborted) throw input.signal.reason ?? error;
          if (now() >= pollDeadline) { budgetExhausted = true; break; }
          throw error;
        } finally { clearTimeout(requestTimer); }
        const arrivedWithinBudget = now() <= pollDeadline;
        if (response.origin !== input.origin || response.path !== "/api/orders/state" || response.method !== "GET"
          || response.body.byteLength > 1_048_576 || !Number.isInteger(response.status) || response.status < 100 || response.status > 599
          || !/^application\/json(?:\s*;|$)/i.test(response.contentType)
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(response.requestId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(response.responseId)
          || response.requestId === response.responseId) throw new Error("owned API state probe returned a response outside its exact read-only request or bounds");
        const bodyRef = await recordE2EApplicationCliEvidence({ writer: input.ports.evidence, caseId: input.caseId,
          kind: "http-response", bytes: response.body, mediaType: "application/octet-stream", signal: input.signal });
        proofBytes.set(bodyRef.artifactId, { ref: bodyRef, bytes: Uint8Array.from(response.body) });
        const observedAt = response.observedAt;
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) as unknown; }
        catch { samples.push({ observedAt, valueRef: bodyRef, disposition: "failed", httpStatus: response.status }); break; }
        const disposition = !arrivedWithinBudget ? "failed" : response.status >= 200 && response.status < 300
          ? canonicalJson(parsed) === canonicalJson(assertion.equals) ? "ready" : "pending"
          : response.status === 429 || response.status === 503 ? "pending" : "failed";
        samples.push({ observedAt, valueRef: bodyRef, disposition, httpStatus: response.status });
        if (disposition === "ready" || disposition === "failed") break;
        if (now() >= pollDeadline) { budgetExhausted = true; break; }
        if (attempt === 99) break;
        await sleep(Math.min(100, Math.max(1, pollDeadline - now())), input.signal);
      }
      if (samples.length === 0) throw new Error("API state probe deadline expired before an actual sample was read");
      // Ruling W: when the budget ran out while a well-formed 2xx answer still held another value, that answer is the poll's last word, a definite mismatch.
      // A 429 or 503 that kept the probe pending, or a poll that only ran out of attempts, is not.
      const lastSample = samples[samples.length - 1]!;
      if (budgetExhausted && lastSample.disposition === "pending" && lastSample.httpStatus !== undefined && lastSample.httpStatus >= 200 && lastSample.httpStatus < 300) {
        samples[samples.length - 1] = { ...lastSample, disposition: "timed-out" };
      }
      proofBytes.set(protectedProof.ref.artifactId, protectedProof);
      assetBinding = parsedAsset;
      artifacts.push(protectedProof.ref, ...samples.map((sample) => sample.valueRef));
      observation = { ...header, kind: "state", probeId: assertion.probeId, probeAssetRef: protectedProof.ref,
        samples };
    }
    const strictObservation = E2EApplicationAssertionObservationSchema.parse(observation);
    const outcome = evaluateE2EApplicationAssertionObservation({ assertion, observation: strictObservation, proofBytes, assetBinding });
    const frameRef = await writeJson(input.ports, input.caseId, "assertion-observation", strictObservation, input.signal);
    artifacts.push(frameRef);
    const assertionOutcome = !outcome.supported ? "unavailable" : outcome.passed ? "passed" : "failed";
    assertions.push({ index, digest: input.plan.expected.assertionDigests[index]!, observedAt, observationId,
      value: outcome.value, evidenceRef: frameRef, outcome: assertionOutcome,
      reason: !outcome.supported ? "observation-or-asset-not-supported" : outcome.passed ? "assertion-observed" : "source-approved-value-mismatch",
      producer: header.producer });
    if (assertionOutcome !== "passed") stoppedReason = assertionOutcome === "failed" ? "prior-assertion-failed" : "prior-assertion-observation-unavailable";
  }
  return { steps, assertions, artifacts };
}

/**
 * Construct an API host with no browser: all case effects remain on the installed owned session/request channel. Its engine is Rovara's
 * first-party HTTP engine, which drives nothing and contributes only the assertion-step fixture the case opens its approved assertions with.
 */
export function createAPIApplicationCliHost(input: { launchContext: E2EApplicationCliLaunchContext; declaration: ApiDeclaration; ports: E2EApiRuntimePorts }): Omit<E2EApplicationCliHost, "launchContext" | "installedModule"> {
  const { launchContext, declaration, ports } = input;
  if (launchContext.selectedTarget.kind !== "api" || declaration.target.app !== null
    || declaration.target.targetId !== launchContext.selectedTarget.targetId) throw new Error("API host requires the exact selected API target and a compiler declaration with no synthetic app or UI engine");
  const descriptor = E2EApplicationCliHostDescriptorSchema.parse(launchContext.cliHost.descriptor);
  const engine = createRovaraHttpEngine();
  return Object.freeze({ profileId: launchContext.cliHost.profileId, descriptor, engine,
    async runCase(caseId: string, rawFixtures: unknown): Promise<void> {
      const caseStartedAt = Date.now();
      const launchSignal = AbortSignal.timeout(Math.max(1, Date.parse(launchContext.deadlineAt) - caseStartedAt));
      const plan = await readValidatedE2EApplicationCliCasePlan({ reader: ports.casePlans, launchContext, declaration, caseId, signal: launchSignal });
      const scenario = E2EScenarioSchema.parse(plan.scenario);
      const caseDeadline = Math.min(Date.parse(launchContext.deadlineAt), caseStartedAt + plan.round.limits.caseTimeoutMs);
      const operationSignal = AbortSignal.any([launchSignal, AbortSignal.timeout(Math.max(1, caseDeadline - Date.now()))]);
      if (operationSignal.aborted) throw new Error("API case exceeded its original launch or approved case deadline before opening a session");
      const applicationId = launchContext.selectedTarget.applicationId;
      const preparedOrigin = declaration.originByApplicationId.find((item) => item.applicationId === applicationId)?.origin;
      const origin = ports.originFor(applicationId, plan.preparedEnvironmentDigest);
      let parsedOrigin: URL;
      try { parsedOrigin = new URL(origin); } catch { throw new Error("prepared API origin is not a concrete canonical origin"); }
      if (!preparedOrigin || origin !== preparedOrigin || !["http:", "https:"].includes(parsedOrigin.protocol)
        || parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== "/"
        || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.hostname.includes("*") || parsedOrigin.hostname.includes("%")) {
        throw new Error("API host origin differs from the exact source-compiled prepared owned origin");
      }
      const session = await ports.openCaseSession({ binding: plan.binding, applicationId: launchContext.selectedTarget.applicationId,
        profileId: plan.runtimeAccountRef.profileId, approvedAccountRef: plan.runtimeAccountRef, origin }, operationSignal);
      if (!session.sessionRef || !/^[a-f0-9]{64}$/.test(session.accountIdDigest)) {
        throw new Error("installed API account driver did not return an app-issued session and account digest");
      }
      let caseFailed = false;
      let caseError: unknown;
      let sessionClosed: boolean;
      try {
        const assertionSteps = assertionStepsOf(rawFixtures);
        const chain = await runInsideAssertionSteps(assertionSteps, scenario.assertions.length, async () => {
        const protectedObservation = await readValidatedE2EApplicationCaseObservation({ reader: ports.caseObservations,
          launchContext, plan, ownedClientRef: session.sessionRef, expectedSubjectKind: "service", signal: operationSignal });
        if (protectedObservation.binding.sessionRef !== session.sessionRef || protectedObservation.binding.accountIdDigest !== session.accountIdDigest
          || protectedObservation.identityEvidence.length < 3 || protectedObservation.identityEvidence.length > 4) {
          throw new Error("protected API observation binding differs from the just-opened app-issued session");
        }
        const result = await executeE2EAPIApplicationScenario({ caseId, scenario, sessionRef: session.sessionRef, origin, ports, plan,
          binding: protectedObservation.binding, signal: operationSignal });
        const failedIndex = result.assertions.findIndex((item) => item.outcome === "failed");
        const unavailableIndex = result.assertions.findIndex((item) => item.outcome === "unavailable");
        const at = utc();
        const terminal = failedIndex >= 0 ? { kind: "assertion-failed" as const, lastDeclaredStepIndex: result.steps.at(-1)?.declaredStepIndex ?? null,
          failedAssertionIndex: failedIndex, at, reason: "source-approved-assertion-mismatch" }
          : unavailableIndex >= 0 ? { kind: "unavailable" as const, lastDeclaredStepIndex: result.steps.at(-1)?.declaredStepIndex ?? null,
            failedAssertionIndex: unavailableIndex, at, reason: "assertion-observation-unavailable" }
            : { kind: "completed" as const, lastDeclaredStepIndex: result.steps.at(-1)?.declaredStepIndex ?? null,
              failedAssertionIndex: null, at, reason: "all-source-approved-assertions-passed" };
        const capture = createE2EApplicationCaseCaptureFrame({ plan, launchContext, binding: protectedObservation.binding,
          upstreamRunId: protectedObservation.upstreamRunId, observedAt: at, steps: result.steps, assertions: result.assertions,
          artifacts: [...protectedObservation.identityEvidence.map((item) => item.ref), ...result.artifacts], terminal });
        await writeJson(ports, caseId, "case-capture", capture, operationSignal);
        return { failedIndex, unavailableIndex };
        });
        if (chain.outcome === null) throw chain.error;
        const { failedIndex, unavailableIndex } = chain.outcome;
        if (failedIndex >= 0) throw new Error(`API assertion ${failedIndex} failed against the actual owned response bytes`);
        if (unavailableIndex >= 0) throw new Error(`API assertion ${unavailableIndex} is unavailable on the installed fixed API client`);
      } catch (error) {
        caseFailed = true;
        caseError = error;
      } finally {
        try { sessionClosed = (await ports.closeCaseSession(session.sessionRef, AbortSignal.timeout(5_000))).confirmed; }
        catch { sessionClosed = false; }
      }
      if (!sessionClosed) throw new Error("installed API account session cleanup is unconfirmed");
      if (caseFailed) throw caseError;
    } });
}

/** Compose the engine-less API adapter with the established lifecycle and protected preparation/account/supervisor ports. */
export function createAPIRuntime(input: { compiled: E2ECompiledApplicationSuite; runInput: E2ERunInput; prepared: E2EApplicationPreparedEnvironment;
  admissionDigest: string; runnerToolchain: ProjectSetupRunnerToolchain; accountSessionRefs: readonly string[]; modelProxyRef: string | null;
  readActualRun(signal: AbortSignal): ReturnType<E2EApplicationRuntimePorts["readActualRun"]>;
  environment: E2EApplicationEnvironmentPorts;
  accounts: E2EApplicationAccountPorts; supervisor: E2EApplicationSupervisorPorts;
  casePorts: Omit<E2EApiRuntimePorts, "openCaseSession" | "closeCaseSession"> }) {
  const ports: E2EApiRuntimePorts = Object.freeze({ ...input.casePorts,
    openCaseSession: ({ binding, applicationId, approvedAccountRef, origin }, signal) => input.accounts.open({
      binding: E2ERunBindingSchema.parse(binding), applicationId, approvedAccountRef: E2ERuntimeAccountRefSchema.parse(approvedAccountRef), origin,
    }, signal),
    closeCaseSession: (sessionRef, signal) => input.accounts.close(sessionRef, signal),
  });
  const lifecycle = createE2EApplicationRuntimePorts({ compiled: input.compiled, runInput: input.runInput, prepared: input.prepared,
    admissionDigest: input.admissionDigest, runnerToolchain: input.runnerToolchain, accountSessionRefs: input.accountSessionRefs,
    modelProxyRef: input.modelProxyRef, supervisor: input.supervisor, readActualRun: (signal) => input.readActualRun(signal) });
  return Object.freeze({ lifecycle, supervisor: input.supervisor,
    run: (signal: AbortSignal) => runIsolatedE2EApplication({ input: input.runInput, compiled: input.compiled, ports: lifecycle, signal }),
    prepare: (preparation: E2EApplicationPreparationInputs, signal: AbortSignal) => prepareE2EApplicationEnvironment(preparation, input.environment, signal),
    seal: (request: Parameters<typeof sealE2EApplicationEnvironment>[0], signal: AbortSignal) => sealE2EApplicationEnvironment(request, input.environment, signal),
    createCliHost: (host: { launchContext: E2EApplicationCliLaunchContext; declaration: ApiDeclaration }) =>
      createAPIApplicationCliHost({ ...host, ports }),
  });
}
