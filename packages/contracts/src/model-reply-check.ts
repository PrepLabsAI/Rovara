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

export const REPLY_CHECK_NOT_RUN_REASONS = ["no_probe", "probe_does_not_match_reply", "streaming_probe_later", "rate_limit", "quota", "overloaded", "key_refused", "cap", "provider_error", "answer_unreadable", "run_cap_reached"] as const;
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
};
const Sha = z.string().regex(/^[0-9a-f]{64}$/u);
export const ReplyProbeSchema = z.object({ replyId: ReplyStoreReplyIdSchema, entrySha256: Sha, rowId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u), family: z.enum(SERVED_MODEL_FAMILIES), frame: ModelEgressFrameSchema }).strict();
export type ReplyProbe = z.infer<typeof ReplyProbeSchema>;
/** A scoped source: its implementation resolves company/project/branch before returning full customer prompts. */
export interface ReplyProbeSource { readProbes(): Promise<readonly ReplyProbe[]>; }
const Item = z.object({ replyId: ReplyStoreReplyIdSchema, entrySha256: Sha, verdict: z.enum(["still_fits", "drifted", "not_run"]), reasons: z.array(z.enum([...REPLY_DRIFT_REASONS, ...REPLY_CHECK_NOT_RUN_REASONS])).max(11) }).strict().refine((item) => {
  if (new Set(item.reasons).size !== item.reasons.length) return false;
  if (item.verdict === "still_fits") return item.reasons.length === 0;
  const permitted: readonly string[] = item.verdict === "drifted" ? REPLY_DRIFT_REASONS : REPLY_CHECK_NOT_RUN_REASONS;
  return item.reasons.length > 0 && item.reasons.every((reason) => permitted.includes(reason));
});
const Count = z.number().int().min(0).max(2000);
const labelPattern = /^scripted replies checked against real (?:[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}|the model) on [0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
export const ReplyCheckReportSchema = z.object({ schemaVersion: z.literal(1), label: z.string().max(220).regex(labelPattern), counts: z.object({ still_fits: Count, drifted: Count, not_run: Count }).strict(), items: z.array(Item).max(2000) }).strict().refine((report) => {
  const counts = { still_fits: 0, drifted: 0, not_run: 0 }; let previous = "";
  for (const item of report.items) { if (item.replyId <= previous) return false; previous = item.replyId; counts[item.verdict]++; }
  return counts.still_fits === report.counts.still_fits && counts.drifted === report.counts.drifted && counts.not_run === report.counts.not_run;
});
export type ReplyCheckReport = z.infer<typeof ReplyCheckReportSchema>;
type CheckItem = ReplyCheckReport["items"][number];
export interface ReplyCheckInput { set: ModelReplySet; probes: readonly ReplyProbe[]; egress: ModelEgress; scope: ModelEgressScope; today: string; limits?: { maxProbes?: number }; }
const label = (model: string | undefined, date: string) => `scripted replies checked against real ${model !== undefined && MODEL_ECHO_PATTERN.test(model) ? model : "the model"} on ${date}`;
const empty = (): ReplyCheckReport => ({ schemaVersion: 1, label: label(undefined, "0000-00-00"), counts: { still_fits: 0, drifted: 0, not_run: 0 }, items: [] });
const dateOk = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(s)) return false;
  const year = Number(s.slice(0, 4)); const month = Number(s.slice(5, 7)); const day = Number(s.slice(8));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
};

async function forwardOnce(input: ReplyCheckInput, probe: ReplyProbe): Promise<{ body?: string; reason?: ReplyCheckNotRunReason; stop: boolean; overrun?: boolean }> {
  let settle: ModelEgressSettle | undefined; let status: number | undefined; let size = 0; let events = 0; let bad = false;
  const chunks: Uint8Array[] = [];
  try {
    for await (const event of input.egress.forward(input.scope, probe.frame)) {
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
        if (status === undefined || status !== settle.status || !Number.isSafeInteger(settle.costMicros) || settle.costMicros < 0) bad = true;
      } else bad = true;
    }
    if (settle === undefined) return { reason: "answer_unreadable", stop: true };
    const stop = settle.overrun === true;
    if (settle.class !== "ok") {
      const reason = (REPLY_CHECK_NOT_RUN_REASONS as readonly string[]).includes(settle.class) ? settle.class as ReplyCheckNotRunReason : "provider_error";
      return { reason, stop, overrun: stop };
    }
    if (bad || status === undefined || status < 200 || status >= 300) return { reason: "answer_unreadable", stop: true, overrun: stop };
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(bytes), stop, overrun: stop };
  } catch { return { reason: "provider_error", stop: true }; }
}

/** Never throws or echoes errors, even for malformed runtime input. No clock, retries, real transport, evidence or provenance writes. */
export async function checkReplySetAgainstReal(input: ReplyCheckInput): Promise<ReplyCheckReport> {
  try {
    const parsed = ModelReplySetSchema.safeParse(input.set);
    if (!parsed.success || !dateOk(input.today) || !Array.isArray(input.probes) || input.probes.length > 2000) return empty();
    const set = parsed.data; const report = empty();
    const probes: readonly unknown[] = input.probes;
    const max = input.limits?.maxProbes ?? 50;
    const maxProbes = Number.isSafeInteger(max) && max >= 0 ? Math.min(max, 2000) : 0;
    let calls = 0; let stopped = false; let haltReason: ReplyCheckNotRunReason = "run_cap_reached";
    const models = new Set<string>();
    for (const reply of [...set.replies].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      const item: CheckItem = { replyId: reply.id, entrySha256: modelReplyEntrySha256(reply), verdict: "not_run", reasons: [] };
      const skip = (reason: ReplyCheckNotRunReason) => { item.reasons = [reason]; report.items.push(item); };
      if (stopped || calls >= maxProbes) { skip(stopped ? haltReason : "run_cap_reached"); continue; }
      const found = probes.filter((probe) => objectOf(probe)?.replyId === reply.id);
      if (found.length === 0) { skip("no_probe"); continue; }
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
      const model = typeof request.model === "string" ? request.model : route.model;
      models.add(model ?? "the model");
      if (route.stream !== "none") { skip("streaming_probe_later"); continue; }
      if (!supportedReplyCheckOperation(route.wire, route.operation, probe.frame.path)) { skip("answer_unreadable"); continue; }
      calls++;
      const forwarded = await forwardOnce(input, probe); stopped = forwarded.stop;
      haltReason = forwarded.overrun === true ? "run_cap_reached" : forwarded.reason ?? "run_cap_reached";
      if (forwarded.reason !== undefined) { skip(forwarded.reason); continue; }
      const answer = readReplyCheckAnswer(route.wire, forwarded.body ?? "");
      if (answer === undefined) { skip("answer_unreadable"); continue; }
      item.reasons = compareReplyCheckShape(reply.response, answer, request, route.wire);
      item.verdict = item.reasons.length === 0 ? "still_fits" : "drifted";
      report.items.push(item);
    }
    report.label = label(models.size === 1 ? [...models][0] : undefined, input.today);
    for (const item of report.items) report.counts[item.verdict]++;
    return report;
  } catch { return empty(); }
}
