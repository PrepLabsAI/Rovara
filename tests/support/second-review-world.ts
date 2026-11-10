// A second review on the document-store fake, with the policy seams recorded and a model seam the test fills. One world is one company with one owner.
import { secondReviewModelKey, type Approvers, type ApprovalProof, type JsonValue, type ApprovalRequest, type AuditEvent, type AuditSink, type ModelIdentifier, type Principal, type SecondReviewModelRef, type SecondReviewReplayCase, type SecondReviewReplayRun, type SecondReviewVerdict, type TransactItem } from "@agentx/contracts";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAllowAllAdmission, createLocalOwnerApprovers, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { recordReplayRun, recordVerdict } from "../../packages/broker/src/core/second-review/evidence.js";
import { createSecondReview, secondReviewReplayKey, secondReviewVerdictKey, type SecondReview, type SecondReviewSeams } from "../../packages/broker/src/core/second-review/index.js";

/** Plain JSON of a value (a document the store holds), typed. */
export const plain = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export const COMPANY = IMPLICIT_COMPANY_ID;
export const OWNER: Principal = localOwnerPrincipal({ companyId: COMPANY });
export const OTHER: Principal = { companyId: COMPANY, personId: "second-admin", displayName: "Second admin", roles: ["admin"], provider: "test" };
export const MEMBER: Principal = { companyId: COMPANY, personId: "member", displayName: "Member", roles: [], provider: "test" };

export const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
export const OPUS: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-4-6" };
export const GPT: ModelIdentifier = { provider: "openai", modelId: "gpt-5.5" };
export const GEMINI: ModelIdentifier = { provider: "openrouter", modelId: "google/gemini-3-pro" };

export const BASELINE = { provider: "amazon-bedrock", modelId: "anthropic.claude-opus-4-1" };

/** 30 known defects and 20 planted bugs; the baseline catches 20 and the candidate all of those and 6 more; nothing dismissed. This passes the bar. */
export function passingCases(): SecondReviewReplayCase[] {
  return Array.from({ length: 50 }, (_, index) => ({
    caseId: `case-${String(index)}`, kind: index < 30 ? "known_defect" as const : "planted_bug" as const,
    baselineCaught: index < 20, candidateCaught: index < 26, candidateBlockingFindings: 0, candidateDismissedBlocking: 0,
  }));
}
export const replayRun = (model: SecondReviewModelRef, over: Partial<SecondReviewReplayRun> = {}): SecondReviewReplayRun =>
  ({ runId: "run-1", ranAt: "2026-10-01T00:00:00.000Z", candidate: model, baseline: BASELINE, cases: passingCases(), ...over });
export const verdictFor = (model: SecondReviewModelRef, over: Partial<SecondReviewVerdict> = {}): SecondReviewVerdict => ({
  model: secondReviewModelKey(model), replayRunId: "run-1", baseline: BASELINE,
  shadow: { startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2026-10-20T00:00:00.000Z", findings: 10, agreed: 5, reviews: 10 }, createdAt: "2026-10-21T00:00:00.000Z", createdBy: "owner:test", ...over,
});

export interface SecondReviewWorld {
  store: MemoryDocumentStore;
  audit: AuditEvent[];
  review: SecondReview;
  seams: SecondReviewSeams & { sources: (project: string) => Promise<readonly ModelIdentifier[]> };
  clock: { now: number };
  logs: Array<Record<string, unknown>>;
  /** The evidence writers beneath the service, called directly (no page, no approvers): what the service's `replay` and `verdict` actions do after their checks. */
  evidence: { replay(run: unknown): ReturnType<typeof recordReplayRun>; verdict(input: Omit<Parameters<typeof recordVerdict>[1], "by">): ReturnType<typeof recordVerdict> };
  /** Writes evidence that holds for `model` straight into the store (the real writers are `recordReplay` and `recordVerdict`). */
  seedHoldingEvidence(model: SecondReviewModelRef): Promise<void>;
}

export interface WorldOptions {
  /** The store the service runs on (default: its own). A flow test gives the flow's, so the task record and the settings live in one place. */
  store?: MemoryDocumentStore;
  sources?: readonly ModelIdentifier[];
  builds?: ReadonlyArray<ModelIdentifier | undefined>;
  firstReviewer?: ModelIdentifier | undefined;
  approvers?: Approvers;
  enabled?: () => boolean;
  admission?: Parameters<typeof createSecondReview>[0]["admission"] | undefined;
  /** Whether the audit sink stages a put (a transactional ledger) or nothing. */
  auditStages?: boolean;
  /** The models a route can be made for (default: every source). */
  routable?: (model: ModelIdentifier) => boolean;
}

/** A recording audit sink: every event it is told of, and a put in the caller's transaction (so an event and its change commit together). */
export function recordingAudit(events: AuditEvent[], stages = true): AuditSink {
  return {
    stage(event) {
      events.push(event);
      const step: TransactItem = { kind: "put", item: { pk: `AUDIT#${event.companyId}`, sk: `EVENT#${event.eventId}`, entityType: "AUDIT", action: event.action, at: event.at }, condition: { op: "notExists", path: ["pk"] } };
      return stages ? [step] : [];
    },
    async record(event) { events.push(event); },
  };
}

/** Approvers that need a different person for a `setting` (as a hosted adapter would): the proof token is `ok:<personId>`. */
export function secondPersonApprovers(): Approvers {
  const local = createLocalOwnerApprovers();
  return {
    async requirement(request: ApprovalRequest) {
      return request.kind === "setting" ? { methods: ["test-proof"], minApprovers: 2, selfApprovalAllowed: false } : local.requirement(request);
    },
    async verify(request: ApprovalRequest, proof: ApprovalProof) {
      const match = /^ok:(.+)$/u.exec(proof.token);
      if (match === null || proof.requestId !== request.requestId || proof.artifactDigest !== request.artifactDigest) return { approved: false as const, reason: "no" };
      return { approved: true as const, approver: { ...OTHER, personId: match[1]! }, method: "test-proof", proofId: proof.proofId };
    },
  };
}
export const proofFor = (request: ApprovalRequest, personId: string): ApprovalProof =>
  ({ proofId: `proof-${personId}`, method: "test-proof", requestId: request.requestId, revision: request.revision, artifactDigest: request.artifactDigest, token: `ok:${personId}` });

export function createWorld(options: WorldOptions = {}): SecondReviewWorld {
  const clock = { now: Date.parse("2026-11-10T10:00:00.000Z") };
  const store = options.store ?? new MemoryDocumentStore({ indexes: [], nowSeconds: () => Math.floor(clock.now / 1_000) });
  const audit: AuditEvent[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const sources = options.sources ?? [SONNET, OPUS, GPT, GEMINI];
  const seams: SecondReviewWorld["seams"] = {
    sources: async () => sources,
    route: async (model) => (options.routable?.(model) ?? true) ? { workerRoute: { alias: `${model.provider}/${model.modelId}`, api: "openai-responses", catalog: model.modelId }, alias: `${model.provider}/${model.modelId}` } : undefined,
    taskModels: async () => ({ builds: options.builds ?? [SONNET], firstReviewer: "firstReviewer" in options ? options.firstReviewer : SONNET }),
    price: () => ({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 }),
    projectExists: async (project) => project === "payments" || project === "web",
  };
  const review = createSecondReview({
    store, companyId: COMPANY, audit: recordingAudit(audit, options.auditStages !== false), approvers: options.approvers ?? createLocalOwnerApprovers(), admission: options.admission ?? createAllowAllAdmission(),
    seams, now: () => clock.now, log: (entry) => logs.push(entry), ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });
  return {
    store, audit, review, seams, clock, logs,
    evidence: {
      replay: (run) => recordReplayRun({ store, audit: recordingAudit(audit, options.auditStages !== false), companyId: COMPANY, now: () => clock.now }, { run, by: OWNER.personId }),
      verdict: (input) => recordVerdict({ store, audit: recordingAudit(audit, options.auditStages !== false), companyId: COMPANY, now: () => clock.now }, { ...input, by: OWNER.personId }),
    },
    async seedHoldingEvidence(model) {
      await store.put({ item: { ...secondReviewReplayKey(COMPANY, "run-1"), entityType: "SECOND_REVIEW_REPLAY", run: plain(replayRun(model)) } });
      await store.put({ item: { ...secondReviewVerdictKey(COMPANY, secondReviewModelKey(model)), entityType: "SECOND_REVIEW_VERDICT", verdict: plain(verdictFor(model)) } });
    },
  };
}
