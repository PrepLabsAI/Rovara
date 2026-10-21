import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { E2EApplicationEvidenceRefSchema, canonicalJson, type E2EApplicationEvidenceRef, type E2EExecutorPlan } from "@agentx/contracts";
import type { E2EApplicationCliLaunchContext } from "../application-runtime-bootstrap.js";
import type { E2EApplicationCliCasePlan } from "../application-services.js";
import type { E2EApplicationObservationBinding, E2EApplicationOwnedSubject, E2EApplicationProofBytes } from "../application-result-adapter.js";
import { E2EApplicationObservationBindingSchema, type E2EApplicationAssertionAssetBinding } from "../application-result-adapter.js";
import type { E2EWebRuntimePorts } from "../web-runtime.js";
import { createCaptureRecorder, type CaptureRecorder } from "./capture.js";
import { createCredentialRedactor } from "./redact.js";
import { casePlanFor, resolveE2EExecutorSuite, shardOf } from "./suite.js";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const MAX_EVIDENCE_BYTES = 256 * 1024;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA = /^[a-f0-9]{64}$/;
const evidenceKinds: readonly string[] = ["case-capture", "step-observation", "assertion-observation", "agent-operation", "agent-operation-source",
  "http-request", "http-response", "download", "identity-observation", "state-sample", "approved-asset"];
type EvidenceMediaType = "application/json" | "text/plain" | "text/csv" | "application/octet-stream";
const mediaTypes: readonly string[] = ["application/json", "text/plain", "text/csv", "application/octet-stream"];

/** What the account and browser ports know about the session that ran a case. It never carries a credential or a cookie. */
export type ExecutorSessionFacts = Readonly<{
  sessionRef: string;
  accountIdDigest: string;
  observedAt: string;
  login: Readonly<{ status: number; role: string }>;
  identity: Readonly<{ status: number; subjectIdDigest: string; tenantId: string; role: string }>;
  subject: E2EApplicationOwnedSubject;
}>;
export type ExecutorObservationSource = Readonly<{
  sessionFacts(ownedClientRef: string, kind: "browser" | "service"): ExecutorSessionFacts;
  /** The upstream runner's run id, from the first-party run-start capture of the launch. */
  upstreamRunId(launchContext: E2EApplicationCliLaunchContext): Promise<string> | string;
}>;
export type FileCaseLedgerOptions = Readonly<{ observations?: ExecutorObservationSource; clock?: () => Date }>;
export type FileCaseLedger = Pick<E2EWebRuntimePorts, "casePlans" | "caseObservations" | "evidence" | "actionWindows"> & Readonly<{
  /** Records bytes the executor itself produced (installed assertion assets); same custody as case evidence. */
  recordApprovedAsset(input: { caseId: string; assetId: string; bytes: Uint8Array }): Promise<E2EApplicationEvidenceRef>;
  /** Persists the protected binding of an approved assertion asset, so the host can hand it to the collector. */
  recordAssetBinding(binding: E2EApplicationAssertionAssetBinding): Promise<void>;
  /** Screenshots and traces of failed cases, taken only for the kinds the admission's capture policy approved (Ruling BZ); with both off nothing is ever written. */
  capture: CaptureRecorder;
  /** Teaches the ledger a secret the run created (the session cookie), so evidence that carries it is refused and a trace has it scrubbed. */
  registerSessionSecret(value: string): void;
}>;

export function uuidFor(value: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
  const hex = sha(`rovara-executor-operation:${value}`).slice(0, 32).split("");
  hex[12] = "4"; hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function isUtf8(bytes: Uint8Array): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
}

/**
 * The executor's custody of case facts: one directory it never leaves, one write per evidence item, one action window per
 * case action. Nothing here decides pass or fail; it stores what the fixed web and API adapters observed and checks every
 * case id against the compiled suite the plan carries.
 */
export function createFileCaseLedger(root: string, plan: E2EExecutorPlan, options: FileCaseLedgerOptions = {}): FileCaseLedger {
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error("case ledger root must be a canonical absolute path");
  const resolved = resolveE2EExecutorSuite(plan);
  const redactor = createCredentialRedactor(plan.accounts);
  const admittedCapture = resolved.suite.runtimeAdmissionContext.selectionInput.policy.capture;
  const capture = createCaptureRecorder({ root, redactor, caseIds: resolved.suite.expectedCases.map((item) => item.caseId),
    policy: { screenshots: admittedCapture.screenshots, traces: admittedCapture.traces } });
  const clock = options.clock ?? (() => new Date());
  const instance = randomBytes(4).toString("hex");
  const knownCases = new Set(resolved.suite.expectedCases.map((item) => item.caseId));
  let sequence = 0;

  function inside(path: string): string {
    const rel = relative(root, path);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("case ledger path escapes its root");
    return path;
  }
  function requireCase(caseId: unknown): string {
    if (typeof caseId !== "string" || !SAFE_CASE_ID.test(caseId) || !knownCases.has(caseId)) throw new Error("unknown case: it is not in the compiled plan");
    return caseId;
  }
  function requireLive(): void {
    if (clock().getTime() >= resolved.deadlineAtMs) throw new Error("case ledger is closed: the run deadline elapsed");
  }
  async function exclusiveWrite(path: string, data: Uint8Array | string): Promise<void> {
    const handle = await open(inside(path), "wx", 0o644);
    try { await handle.writeFile(data); } finally { await handle.close(); }
  }

  /** The host-readable binding facts: `binding-<case>.json` and `asset-<case>-<index>.json`, each bound to its own digest. */
  async function persistBinding(file: string, schemaVersion: string, caseId: string, binding: unknown): Promise<void> {
    await mkdir(join(root, "observations"), { recursive: true, mode: 0o755 });
    await writeFile(inside(join(root, "observations", file)), `${JSON.stringify({ schemaVersion, caseId, sha256: sha(canonicalJson(binding)), binding }, null, 2)}\n`);
  }

  async function record(input: { caseId: string; kind: string; bytes: Uint8Array; mediaType?: string; name?: string }): Promise<E2EApplicationEvidenceRef> {
    requireLive();
    const caseId = requireCase(input.caseId);
    if (!evidenceKinds.includes(input.kind)) throw new Error("evidence kind is outside the fixed producer set");
    if (input.name !== undefined && (typeof input.name !== "string" || !SAFE_NAME.test(input.name) || input.name.includes(".."))) {
      throw new Error("evidence name must be a plain file name that cannot leave the ledger");
    }
    const mediaType = (input.mediaType ?? (input.kind === "download" ? "application/octet-stream" : "application/json")) as EvidenceMediaType;
    if (!mediaTypes.includes(mediaType)) throw new Error("evidence media type is outside the fixed producer set");
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) throw new Error("evidence must be non-empty bytes");
    const download = input.kind === "download";
    if (input.bytes.byteLength > (download ? MAX_DOWNLOAD_BYTES : MAX_EVIDENCE_BYTES)) throw new Error("evidence exceeds the fixed producer bound");
    if (redactor.contains(input.bytes)) throw new Error("evidence contains an account credential and cannot be stored");
    const bytes = Uint8Array.from(input.bytes);
    const digest = sha(bytes);
    sequence += 1;
    const artifactId = `ev-${instance}-${String(sequence).padStart(4, "0")}-${digest.slice(0, 12)}`;
    await mkdir(join(root, "observations"), { recursive: true, mode: 0o755 });
    let file: string | null = null;
    if (download) {
      await mkdir(join(root, "downloads"), { recursive: true, mode: 0o755 });
      file = `downloads/${artifactId}-${input.name ?? (mediaType === "text/csv" ? "download.csv" : "download.bin")}`;
      await exclusiveWrite(join(root, file), bytes);
    }
    const utf8 = !download && isUtf8(bytes);
    await exclusiveWrite(join(root, "observations", `${artifactId}.json`), `${JSON.stringify({
      schemaVersion: "e2e-executor-observation/v1", artifactId, caseId, kind: input.kind, mediaType, sha256: digest,
      byteLength: bytes.byteLength, ...(input.name === undefined ? {} : { name: input.name }), recordedAt: clock().toISOString(),
      ...(download ? { file } : utf8 ? { encoding: "utf8", content: Buffer.from(bytes).toString("utf8") }
        : { encoding: "base64", content: Buffer.from(bytes).toString("base64") }),
    }, null, 2)}\n`);
    return E2EApplicationEvidenceRefSchema.parse({ artifactId, sha256: digest, byteLength: bytes.byteLength, mediaType });
  }

  const evidence: FileCaseLedger["evidence"] = Object.freeze({
    recordCaseEvidence: async (input: Parameters<FileCaseLedger["evidence"]["recordCaseEvidence"]>[0] & { name?: string }, signal: AbortSignal) => {
      if (signal?.aborted) throw new Error("case evidence write was cancelled");
      return record(input);
    },
  });

  const windowPath = (caseId: string, actionIndex: number) => join(root, "observations", `action-${caseId.replaceAll(":", "_")}-${actionIndex}.json`);
  function checkAction(input: { caseId: string; actionIndex: number; actionDigest: string }): string {
    const caseId = requireCase(input.caseId);
    if (!Number.isSafeInteger(input.actionIndex) || input.actionIndex < 0 || input.actionIndex > 99 || !SHA.test(input.actionDigest)) {
      throw new Error("action window input is outside its bounds");
    }
    return caseId;
  }
  const actionWindows: FileCaseLedger["actionWindows"] = Object.freeze({
    async begin(input: { caseId: string; actionIndex: number; actionDigest: string }, signal: AbortSignal) {
      if (signal?.aborted) throw new Error("action window was cancelled before it opened");
      requireLive();
      const caseId = checkAction(input);
      await mkdir(join(root, "observations"), { recursive: true, mode: 0o755 });
      const actionId = `aw-${randomUUID()}`;
      try {
        await exclusiveWrite(windowPath(caseId, input.actionIndex), `${JSON.stringify({ schemaVersion: "e2e-executor-action-window/v1", state: "open",
          actionId, caseId, actionIndex: input.actionIndex, actionDigest: input.actionDigest, beganAt: clock().toISOString() }, null, 2)}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("action window already used for this case action", { cause: error });
        throw error;
      }
      return { actionId };
    },
    async finish(input: { caseId: string; actionIndex: number; actionDigest: string }, signal: AbortSignal) {
      if (signal?.aborted) throw new Error("action window finish was cancelled");
      const caseId = checkAction(input);
      let row: { state?: string; actionId?: string; actionDigest?: string };
      try { row = JSON.parse(await readFile(windowPath(caseId, input.actionIndex), "utf8")) as typeof row; }
      catch (cause) { throw new Error("action window was never opened", { cause }); }
      if (row.state !== "open" || row.actionDigest !== input.actionDigest) throw new Error("action window is not open for this exact action");
      await writeFile(windowPath(caseId, input.actionIndex), `${JSON.stringify({ ...row, state: "finished", finishedAt: clock().toISOString() }, null, 2)}\n`);
      return { confirmed: true as const };
    },
  });

  const casePlans: FileCaseLedger["casePlans"] = Object.freeze({
    async readCasePlan(input: { launchContext: E2EApplicationCliLaunchContext; caseId: string; upstreamTestId: string; targetId: string }, signal: AbortSignal) {
      if (signal?.aborted) throw new Error("case plan read was cancelled");
      const caseId = requireCase(input.caseId);
      if (input.launchContext.runId !== resolved.binding.runId || input.launchContext.bindingDigest !== resolved.bindingDigest) {
        throw new Error("case plan request is foreign to this executor run");
      }
      shardOf(resolved, input.launchContext.shardId);
      const casePlan = casePlanFor(resolved, { shardId: input.launchContext.shardId, caseId });
      if (casePlan.expected.upstreamTestId !== input.upstreamTestId || casePlan.expected.targetId !== input.targetId) {
        throw new Error("case plan request differs from the compiled case identity");
      }
      return casePlan;
    },
  });

  async function proof(caseId: string, kind: string, value: unknown): Promise<E2EApplicationProofBytes> {
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    const ref = await record({ caseId, kind, bytes, mediaType: "application/json" });
    return Object.freeze({ ref, bytes: Uint8Array.from(bytes) });
  }

  const caseObservations: FileCaseLedger["caseObservations"] = Object.freeze({
    async readCaseObservationBinding(input: { launchContext: E2EApplicationCliLaunchContext; plan: E2EApplicationCliCasePlan; ownedClientRef: string }, signal: AbortSignal) {
      if (signal?.aborted) throw new Error("case observation read was cancelled");
      const source = options.observations;
      if (!source) throw new Error("no owned session source is attached to this ledger");
      const { launchContext, plan: casePlan } = input;
      const caseId = requireCase(casePlan.expected.caseId);
      const kind = launchContext.selectedTarget.kind === "web" ? "browser" as const : launchContext.selectedTarget.kind === "api" ? "service" as const : null;
      if (!kind) throw new Error("executor observations exist only for web and API targets");
      const facts = source.sessionFacts(input.ownedClientRef, kind);
      const upstreamRunId = await source.upstreamRunId(launchContext);
      const lifecycleId = `rovara-executor-${casePlan.binding.runId}`;
      const producer = (receiptId: string) => ({ producerId: "rovara-executor/v1", receiptId, lifecycleId,
        operationId: uuidFor(casePlan.binding.operationId), operationFence: casePlan.binding.operationFence,
        runtimeManifestDigest: casePlan.binding.runtimeManifestDigest, transportCorrelationId: launchContext.transportCorrelationId });
      const caseProducer = producer(`${caseId}:case`);
      const accountSource = await proof(caseId, "identity-observation", { schemaVersion: "e2e-executor-account-observation/v1", caseId,
        accountRef: casePlan.runtimeAccountRef, sessionRef: facts.sessionRef, accountIdDigest: facts.accountIdDigest,
        observedAt: facts.observedAt, login: facts.login, identity: facts.identity });
      const subjectSource = await proof(caseId, "identity-observation", { schemaVersion: "e2e-executor-subject-observation/v1", caseId,
        subject: facts.subject, observedAt: facts.observedAt });
      const common = { caseId, bindingDigest: resolved.bindingDigest, upstreamRunId, lifecycleId, producer: caseProducer, observedAt: clock().toISOString() };
      const accountProjection = await proof(caseId, "identity-observation", { ...common, schemaVersion: "e2e-application-account-identity/v1",
        sourceReceiptRef: accountSource.ref, accountRef: casePlan.runtimeAccountRef, sessionRef: facts.sessionRef, accountIdDigest: facts.accountIdDigest });
      const subjectProjection = await proof(caseId, "identity-observation", { ...common, schemaVersion: "e2e-application-subject-identity/v1",
        sourceReceiptRef: subjectSource.ref, subject: facts.subject });
      const artifact = resolved.suite.applicationBindings.get(casePlan.runtimeAccountRef.applicationId)?.artifacts
        .find((candidate) => candidate.platform === launchContext.selectedTarget.kind);
      if (!artifact) throw new Error("the admitted build has no artifact for the selected target platform");
      const observationBinding: E2EApplicationObservationBinding = E2EApplicationObservationBindingSchema.parse({ caseId, subject: facts.subject,
        caseProducer, assertionProducers: casePlan.scenario.assertions.map((_, index) => ({ assertionIndex: index,
          producer: producer(`${caseId}:assertion:${index}`) })),
        accountRef: casePlan.runtimeAccountRef, sessionRef: facts.sessionRef, accountIdDigest: facts.accountIdDigest,
        identityReceiptRef: accountProjection.ref, subjectIdentityReceiptRef: subjectProjection.ref, selectedArtifact: artifact, connection: null });
      await persistBinding(`binding-${caseId.replaceAll(":", "_")}.json`, "e2e-executor-observation-binding/v1", caseId, observationBinding);
      return { observationBinding, upstreamRunId, identityEvidence: [accountProjection, subjectProjection, accountSource, subjectSource] };
    },
  });

  return Object.freeze({ casePlans, caseObservations, evidence, actionWindows, capture,
    registerSessionSecret: (value: string) => redactor.addSessionSecret(value),
    recordAssetBinding: (binding: E2EApplicationAssertionAssetBinding) => persistBinding(
      `asset-${requireCase(binding.caseId).replaceAll(":", "_")}-${binding.assertionIndex}.json`, "e2e-executor-asset-binding/v1", binding.caseId, binding),
    recordApprovedAsset: (input: { caseId: string; assetId: string; bytes: Uint8Array }) => {
      if (!SAFE_NAME.test(input.assetId.replaceAll("/", "-"))) throw new Error("approved asset id is not a plain identifier");
      return record({ caseId: input.caseId, kind: "approved-asset", bytes: input.bytes, mediaType: "application/json" });
    } });
}
