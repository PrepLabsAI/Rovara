import { createHash } from "node:crypto";
import { copyBoundedE2EJsonData, copyBoundedE2ESourceBytes } from "@agentx/contracts";
import { z } from "zod";
import { E2EReportSchema } from "./report-schema.js";

const count = z.number().int().nonnegative();
const text = z.string().max(16_384);
const sha = /^[a-f0-9]{64}$/;
const usage = z.object({ discoveredResults: count, maxAgentContextBytes: count, maxLedgerBytes: count, maxObservationBytes: count,
  artifactBytes: count, downloads: count, events: count, modelTokens: count, modelCachedTokens: count.optional(),
  maxModelCallsInStep: count, maxActionStepsInStep: count, estimatedCostUsd: z.number().finite().nonnegative().optional() }).strict();
const source = z.object({ file: z.string().min(1).max(1024), line: z.number().int().positive(), column: z.number().int().positive() }).strict();
const error = E2EReportSchema.shape.run.shape.results.element.shape.attempts.element.shape.secondaryErrors.element;
const event = z.object({ kind: z.enum(["poll", "observation", "model", "policy", "engine", "schema", "navigation"]),
  startedAt: z.string().max(128), durationMs: z.number().finite().nonnegative(), status: z.enum(["passed", "failed", "cancelled"]),
  name: text.optional(), count: count.optional(), inputTokens: count.optional(), outputTokens: count.optional(), bytes: count.optional(),
  decision: z.enum(["allowed", "denied"]).optional(), code: z.string().max(256).optional(), detail: text.optional(), reasoning: text.optional() }).strict();
const metrics = z.object({ modelCalls: count, actionSteps: count, observationBytes: count, contextBytes: count, ledgerBytes: count, pixelBytes: count.optional() }).strict();
const cache = z.object({ mode: z.enum(["self-finalized", "agent-concluded", "missed"]),
  reason: z.enum(["retry", "no-entry", "invalid-entry", "truncated", "wrong-context", "gap", "target-not-found", "target-ambiguous", "viewport-changed", "action-failed", "action-uncertain", "end-mismatch"]).optional(),
  derived: z.enum(["pixels", "whole-node", "minted-token", "date"]).optional(), notRecorded: z.literal("param-collision").optional(),
  replayedActions: count, totalActions: count, entry: text.optional(), detail: text.optional(),
  write: z.enum(["saved", "kept", "unconfirmed", "evicted", "no-change", "not-written"]).optional() }).strict();
const model = z.object({ provider: text, model: text, endpoint: text, adapterVersion: text, policyVersion: text, calls: count,
  tokenAccounting: z.enum(["provider", "adapter-upper-bound"]), peakTokensPerCall: count, inputTokens: count, outputTokens: count,
  cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(), estimatedCostUsd: z.number().finite().nonnegative().optional() }).strict();
const step = z.object({ id: z.string().min(1).max(256), index: count, kind: z.enum(["agent", "locator", "assertion", "screen", "app", "session", "resource"]),
  api: z.string().min(1).max(256), label: text, source, status: z.enum(["passed", "failed", "blocked", "timed-out", "cancelled"]),
  startedAt: z.string().max(128), durationMs: z.number().finite().nonnegative(), observationRevision: text.optional(), explanation: text.optional(),
  visionInput: z.boolean().optional(), visionDegraded: z.enum(["PIXEL_TAINTED", "MASKING_UNPROVEN", "UNSUPPORTED_CAPABILITY"]).optional(), visionOnly: z.boolean().optional(),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive(), scale: z.number().positive() }).strict().optional(), metrics: metrics.optional(), cache: cache.optional(),
  events: z.array(event).max(1000), turns: z.array(z.object({ index: z.number().int().positive(), calls: z.array(text).max(100), outcome: text }).strict()).max(100).optional(),
  model: model.optional(), agent: z.string().min(1).max(256).optional(), phase: z.enum(["beforeEach", "afterEach"]).optional(),
  screen: z.object({ location: text.optional(), nodes: count, since: count.optional(), changes: z.array(text).max(256), more: count.optional() }).strict().optional(),
  error: error.optional(), artifacts: z.array(z.string().min(1).max(256)).max(200) }).strict();
const artifact = z.object({ id: z.string().min(1).max(256), kind: z.enum(["screenshot", "video", "download", "log"]), mediaType: z.string().min(1).max(256),
  path: text.optional(), url: z.string().url().max(8192).optional(), size: count.optional(), sha256: z.string().regex(sha).optional(), ref: text.optional(),
  startedAt: text.optional(), redaction: z.enum(["complete", "incomplete"]), producer: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("step"), stepId: z.string().min(1).max(256) }).strict(), z.object({ kind: z.literal("attempt") }).strict()]) }).strict();
const failure = z.object({ url: z.string().url().max(8192).optional(), viewport: z.object({ width: z.number().positive(), height: z.number().positive() }).strict().optional(),
  nodes: count.optional(), screen: text.optional(), screenshot: text.optional(), candidates: z.array(text).max(128).optional() }).strict();
const skip = z.object({ cause: z.enum(["explicit", "filtered", "platform-unavailable", "capability-unavailable", "setup-failed", "serial-predecessor-failed", "hook-failed", "infrastructure-unavailable", "failure-limit"]),
  reason: text, relatedId: text.optional() }).strict();
const attempt = E2EReportSchema.shape.run.shape.results.element.shape.attempts.element.extend({
  environment: z.record(z.string().max(256), z.string().max(2048)).optional(), artifacts: z.array(artifact).max(200), steps: z.array(step).max(256),
  appLog: z.array(z.object({ source: z.enum(["console", "error", "network", "system"]), level: z.enum(["debug", "info", "warn", "error"]), text, at: text, step: count.optional() }).strict()).max(1000),
  failure: failure.optional(), skip: skip.optional(),
});
const result = E2EReportSchema.shape.run.shape.results.element.extend({ attempts: z.array(attempt).max(3), skip: skip.optional() });
const target = E2EReportSchema.shape.run.shape.targets.element.extend({ baseOrigin: z.string().url().max(512).optional() });
export const E2EApplicationReportSchema = E2EReportSchema.extend({ run: E2EReportSchema.shape.run.extend({
  targets: z.array(target).max(12), results: z.array(result).max(192), usage,
}) });
export type E2EApplicationReport = z.infer<typeof E2EApplicationReportSchema>;
export type ParsedE2EApplicationReport = { kind: "parsed"; report: E2EApplicationReport; rawSha256: string } | { kind: "unavailable"; reason: string };
export const E2E_APPLICATION_REPORT_MAX_BYTES = 4 * 1024 * 1024;

export function parseE2EApplicationReport(input: Uint8Array): ParsedE2EApplicationReport {
  try {
    const bytes = copyBoundedE2ESourceBytes(input, E2E_APPLICATION_REPORT_MAX_BYTES);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const bounded = copyBoundedE2EJsonData(value, { maxBytes: E2E_APPLICATION_REPORT_MAX_BYTES, maxDepth: 64, maxNodes: 65_536 });
    const parsed = E2EApplicationReportSchema.safeParse(bounded);
    if (!parsed.success) return { kind: "unavailable", reason: "application report does not match pinned report-1 structure" };
    return { kind: "parsed", report: parsed.data, rawSha256: createHash("sha256").update(bytes).digest("hex") };
  } catch { return { kind: "unavailable", reason: "application report is not bounded UTF-8 JSON" }; }
}
