// TE-F11, additive: reply health only. No evidence fields, provenance changes, scheduler or production callers.
import { z } from "zod";
import { MODEL_ECHO_PATTERN } from "./model-family-common.js";
import { MODEL_FAMILY_REGISTRY } from "./model-families.js";
import { readModelRequestFacts } from "./model-request-facts.js";
import { ModelReplySetSchema, modelReplyEntrySha256, selectModelReply, type ModelReplySet } from "./model-reply-set.js";
import { ReplyStoreReplyIdSchema } from "./model-reply-store.js";
import { SERVED_MODEL_FAMILIES } from "./model-served-family.js";
import { ModelEgressFrameSchema } from "./model-egress/frame.js";
import { NOT_RUN_SENTENCES, capSentence } from "./model-egress/classify.js";
import type { ModelEgress, ModelEgressScope, ModelEgressSettle } from "./ports/model-egress.js";
import { boundedJson, objectOf, readReplyCheckAnswer, supportedReplyCheckOperation, REPLY_CHECK_MAX_BYTES } from "./model-reply-check-read.js";
import { compareReplyCheckShape, REPLY_DRIFT_REASONS } from "./model-reply-check-shape.js";

export const REPLY_CHECK_NOT_RUN_REASONS = ["no_probe", "probe_does_not_match_reply", "streaming_probe_later", "rate_limit", "quota", "overloaded", "key_refused", "cap", "provider_error", "answer_unreadable", "run_cap_reached", "run_halted"] as const;
export type ReplyCheckNotRunReason = (typeof REPLY_CHECK_NOT_RUN_REASONS)[number];
export const REPLY_CHECK_NOT_RUN_SENTENCES: Readonly<Record<ReplyCheckNotRunReason, string>> = {
  ...NOT_RUN_SENTENCES,
  no_probe: "not run: no stored probe request",
  probe_does_not_match_reply: "not run: probe does not match this reply",
  streaming_probe_later: "not run: streaming probes are not supported",
  cap: capSentence(),
  provider_error: "not run: provider error",
  answer_unreadable: "not run: answer could not be read",
  run_cap_reached: "not run: reply check run cap reached",
  run_halted: "not run: reply check run halted",
};
const Sha = z.string().regex(/^[0-9a-f]{64}$/u);
export const ReplyProbeSchema = z.object({ replyId: ReplyStoreReplyIdSchema, entrySha256: Sha, rowId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u), family: z.enum(SERVED_MODEL_FAMILIES), frame: ModelEgressFrameSchema }).strict();
export type ReplyProbe = z.infer<typeof ReplyProbeSchema>;
/** Resolve company/project/branch before returning full customer prompts. Refusals are never empty success. */
export interface ReplyProbeSource {
  readProbes(): Promise<{ ok: true; companyId: string; probes: readonly ReplyProbe[] } | { ok: false }>;
}
/** Trusted caller must resolve both this capability and the source from the SAME company (and project/branch).
 * The port capability is opaque: this explicit binding can detect mismatched resolutions, not forged caller claims. */
export interface ReplyCheckScope { companyId: string; egressScope: ModelEgressScope; }
export const ReplyCheckCompanyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const Item = z.object({ replyId: ReplyStoreReplyIdSchema, entrySha256: Sha, verdict: z.enum(["still_fits", "drifted", "not_run"]), reasons: z.array(z.enum([...REPLY_DRIFT_REASONS, ...REPLY_CHECK_NOT_RUN_REASONS])).max(12) }).strict().refine((item) => {
  if (new Set(item.reasons).size !== item.reasons.length) return false;
  if (item.verdict === "still_fits") return item.reasons.length === 0;
  const permitted: readonly string[] = item.verdict === "drifted" ? REPLY_DRIFT_REASONS : REPLY_CHECK_NOT_RUN_REASONS;
  return item.reasons.length > 0 && item.reasons.every((reason) => permitted.includes(reason));
});
const Count = z.number().int().min(0).max(2000);
const labelPattern = /^scripted replies checked against real (?:[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}|the model) on [0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const uncheckedLabels = ["not checked: no answers", "not checked: invalid input", "not checked: store unavailable", "not checked: scope mismatch"] as const;
export const ReplyCheckReportSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(["checked", "not_checked", "invalid_input"]),
  label: z.union([z.string().max(220).regex(labelPattern), z.enum(uncheckedLabels)]),
  counts: z.object({ still_fits: Count, drifted: Count, not_run: Count }).strict(), items: z.array(Item).max(2000),
  spend: z.object({ attempted: Count, costMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), complete: z.boolean() }).strict(),
}).strict().refine((report) => {
  const counts = { still_fits: 0, drifted: 0, not_run: 0 }; let previous = "";
  for (const item of report.items) { if (item.replyId <= previous) return false; previous = item.replyId; counts[item.verdict]++; }
  if (counts.still_fits !== report.counts.still_fits || counts.drifted !== report.counts.drifted || counts.not_run !== report.counts.not_run) return false;
  const answered = counts.still_fits + counts.drifted;
  if (answered > report.spend.attempted) return false;
  if (report.status === "checked") return answered > 0 && labelPattern.test(report.label) && dateOk(report.label.slice(-10));
  if (report.status === "invalid_input") return report.label === "not checked: invalid input";
  return answered === 0 && (uncheckedLabels as readonly string[]).includes(report.label);
});
export type ReplyCheckReport = z.infer<typeof ReplyCheckReportSchema>;
type CheckItem = ReplyCheckReport["items"][number];
export interface ReplyCheckInput { set: ModelReplySet; probes: ReplyProbeSource; egress: ModelEgress; scope: ReplyCheckScope; today: string; limits?: { maxProbes?: number }; }
const label = (model: string | undefined, date: string) => `scripted replies checked against real ${model !== undefined && MODEL_ECHO_PATTERN.test(model) ? model : "the model"} on ${date}`;
const empty = (): ReplyCheckReport => ({ schemaVersion: 1, status: "invalid_input", label: "not checked: invalid input", counts: { still_fits: 0, drifted: 0, not_run: 0 }, items: [], spend: { attempted: 0, costMicros: 0, complete: true } });
const dateOk = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(s)) return false;
  const year = Number(s.slice(0, 4)); const month = Number(s.slice(5, 7)); const day = Number(s.slice(8));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
};

async function forwardOnce(input: ReplyCheckInput, probe: ReplyProbe, spend: ReplyCheckReport["spend"]): Promise<{ body?: string; reason?: ReplyCheckNotRunReason; stop: boolean; overrun?: boolean; exception?: boolean }> {
  let settle: ModelEgressSettle | undefined; let status: number | undefined; let size = 0; let events = 0; let bad = false;
  const chunks: Uint8Array[] = []; let accounted = false;
  try {
    for await (const event of input.egress.forward(input.scope.egressScope, probe.frame)) {
      if (++events > 4096) return { reason: "answer_unreadable", stop: true };
      if (settle !== undefined) { bad = true; continue; }
      if (event.kind === "head") {
        if (status !== undefined || !Number.isInteger(event.status) || event.status < 100 || event.status > 599) bad = true;
        status = event.status;
      } else if (event.kind === "chunk") {
        if (status === undefined || !(event.bytes instanceof Uint8Array)) return { reason: "answer_unreadable", stop: true };
        size += event.bytes.byteLength;
        if (size > REPLY_CHECK_MAX_BYTES) bad = true; else chunks.push(event.bytes.slice());
      } else if (event.kind === "settle") {
        settle = event;
        const cost = settle.costMicros;
        if (Number.isSafeInteger(cost) && cost >= 0 && Number.isSafeInteger(spend.costMicros + cost)) { spend.costMicros += cost; accounted = true; }
        if (status === undefined || status !== settle.status || !accounted) bad = true;
      } else bad = true;
    }
    if (settle === undefined) return { reason: "answer_unreadable", stop: true };
    const stop = settle.overrun === true;
    if (settle.class !== "ok") {
      const reason = (REPLY_CHECK_NOT_RUN_REASONS as readonly string[]).includes(settle.class) ? settle.class as ReplyCheckNotRunReason : "provider_error";
      return { reason, stop: stop || ["key_refused", "quota", "rate_limit", "cap"].includes(reason), overrun: stop || reason === "cap" };
    }
    if (bad || status === undefined || status < 200 || status >= 300) return { reason: "answer_unreadable", stop: true, overrun: stop };
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(bytes), stop, overrun: stop };
  } catch { return { reason: "provider_error", stop: true, exception: true }; }
  finally { if (!accounted) spend.complete = false; }
}

/** Never throws or echoes errors, even for malformed runtime input. No clock, retries, real transport, evidence or provenance writes. */
export async function checkReplySetAgainstReal(input: ReplyCheckInput): Promise<ReplyCheckReport> {
  const report = empty();
  const finish = (): ReplyCheckReport => {
    report.counts = { still_fits: 0, drifted: 0, not_run: 0 };
    for (const item of report.items) report.counts[item.verdict]++;
    return report;
  };
  try {
    const parsed = ModelReplySetSchema.safeParse(input.set); const today = input.today;
    if (!parsed.success || !dateOk(today) || !ReplyCheckCompanyIdSchema.safeParse(input.scope.companyId).success) return report;
    const set = parsed.data;
    const source = await input.probes.readProbes();
    if (!source.ok || !Array.isArray(source.probes) || source.probes.length > 2000) {
      report.status = "not_checked"; report.label = "not checked: store unavailable"; return report;
    }
    if (source.companyId !== input.scope.companyId) {
      report.status = "not_checked"; report.label = "not checked: scope mismatch"; return report;
    }
    const probes: readonly unknown[] = source.probes;
    const max = input.limits?.maxProbes ?? 50;
    const maxProbes = Number.isSafeInteger(max) && max >= 0 ? Math.min(max, 2000) : 0;
    let calls = 0; let stopped = false; let exception = false; let haltReason: ReplyCheckNotRunReason = "run_cap_reached";
    const models = new Set<string>();
    for (const reply of [...set.replies].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      const item: CheckItem = { replyId: reply.id, entrySha256: modelReplyEntrySha256(reply), verdict: "not_run", reasons: [] };
      const skip = (reason: ReplyCheckNotRunReason) => { item.reasons = [reason]; report.items.push(item); };
      const found = probes.filter((probe) => objectOf(probe)?.replyId === reply.id);
      if (found.length === 0) { skip("no_probe"); continue; }
      if (stopped || calls >= maxProbes) { skip(stopped ? haltReason : "run_cap_reached"); continue; }
      const probeParsed = ReplyProbeSchema.safeParse(found[0]);
      if (found.length !== 1 || !probeParsed.success) { skip("probe_does_not_match_reply"); continue; }
      const probe = probeParsed.data;
      if (probe.entrySha256 !== item.entrySha256 || probe.family !== set.family || probe.rowId !== probe.frame.row) { skip("probe_does_not_match_reply"); continue; }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(probe.frame.body);
      const request = objectOf(boundedJson(text)?.value);
      if (request === undefined) { skip("probe_does_not_match_reply"); continue; }
      const facts = readModelRequestFacts(text);
      // F2-A substitutes unknown-model for unsafe body names; that is not the checked name.
      const bodyModel = typeof request.model === "string" && MODEL_ECHO_PATTERN.test(request.model) ? facts.model : undefined;
      const headers: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [name, value] of probe.frame.headers) Object.defineProperty(headers, name, { value, enumerable: true, configurable: true });
      const route = MODEL_FAMILY_REGISTRY[probe.family].route({ method: probe.frame.method, path: probe.frame.path, query: probe.frame.query, headers, pathPrefix: undefined, streamRequested: facts.stream }, { id: probe.rowId, family: probe.family });
      if (!route.ok || selectModelReply({ ...set, replies: [reply] }, { model: bodyModel ?? route.model, operation: route.operation, promptText: facts.promptText }, new Map(), probe.family).reply?.id !== reply.id) { skip("probe_does_not_match_reply"); continue; }
      if (route.stream !== "none") { skip("streaming_probe_later"); continue; }
      if (!supportedReplyCheckOperation(route.wire, route.operation, probe.frame.path)) { skip("answer_unreadable"); continue; }
      calls++; report.spend.attempted++;
      const forwarded = await forwardOnce(input, probe, report.spend); stopped = forwarded.stop; exception ||= forwarded.exception === true;
      haltReason = forwarded.overrun === true ? "run_cap_reached" : "run_halted";
      if (forwarded.reason !== undefined) { skip(forwarded.reason); continue; }
      const answer = readReplyCheckAnswer(route.wire, forwarded.body ?? "");
      if (answer === undefined) { skip("answer_unreadable"); continue; }
      item.reasons = compareReplyCheckShape(reply.response, answer, request, route.wire);
      item.verdict = item.reasons.length === 0 ? "still_fits" : "drifted";
      report.items.push(item);
      // Only answered probes contribute model names; body model text is never a display source.
      models.add(route.model ?? "the model");
    }
    finish();
    report.status = exception ? "invalid_input" : report.counts.still_fits + report.counts.drifted > 0 ? "checked" : "not_checked";
    report.label = report.status === "checked" ? label(models.size === 1 ? [...models][0] : undefined, today) : report.status === "invalid_input" ? "not checked: invalid input" : "not checked: no answers";
    return report;
  } catch { report.status = "invalid_input"; report.label = "not checked: invalid input"; return finish(); }
}
