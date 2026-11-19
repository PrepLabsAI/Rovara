import { agentModelName } from "@agentx/contracts";
import type { PreviewRateReader } from "./start-estimates-rate-read.js";
import { createHash } from "node:crypto";
import { type DocumentStore, type OrgId, type InvocationModelRoute } from "@agentx/contracts";
import type { PreviewContext } from "../core/cost/start-estimates.js";
import { readDayLoad } from "../core/cost/holds.js";
import { companyDayKey } from "../core/cost/ledger.js";
import { modelSelectionPolicyKey } from "../core/model-selection/policy-store.js";
import { dispatcherStoredAgentModelChoice } from "./stored-agent-model-choice.js";
import type { HostedAdmissionSettings, ProjectTaskCap } from "./hosted-modules.js";
const av = <T>(value: T) => ({ state: "available" as const, value });
const un = { state: "unavailable", reason: "not_measured" } as const;
const unreadable = { state: "unavailable", reason: "unreadable" } as const;
export async function hostedPreviewContext(input: { store: DocumentStore; companyId: OrgId; project: string; now: () => Date; rateQuote?: PreviewRateReader | undefined; workflowVersion?: string; settings?: HostedAdmissionSettings | undefined; projectTaskCap?: ProjectTaskCap | undefined; defaultRoute: () => Promise<InvocationModelRoute | undefined> }): Promise<PreviewContext> {
 const { store, companyId, project, settings } = input;
 const stages: PreviewContext["stages"] = {};
 let policy: unknown = "unreadable";
 try { policy = await store.get(modelSelectionPolicyKey(companyId)) ?? null; } catch { /* Keep unavailable. */ }
 const chooser = dispatcherStoredAgentModelChoice({ store, companyId, now: () => input.now().getTime(), defaultRoute: input.defaultRoute, log: () => undefined });
 for (const stage of ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"] as const) {
  let model: PreviewContext["stages"][string]["model"] = unreadable;
  try {
   const selected = await chooser.choose({ stage });
   if (selected.ok) model = av(selected.step.model);
  } catch { /* No model is invented after a failed read. */ }
  stages[stage] = { model, source: un, price: { state: "unavailable", reason: "missing_price" } };
 }
 let expiresAt: string | undefined;
 if (input.rateQuote !== undefined) {
  const reads = new Map<string, ReturnType<PreviewRateReader>>();
  await Promise.all(Object.entries(stages).map(async ([stage, choice]) => {
   const alias = choice.model.state === "available" ? agentModelName(choice.model.value) : undefined;
   if (alias === undefined) return;
   let pending = reads.get(alias);
   if (pending === undefined) { pending = input.rateQuote!(companyId, alias).catch(() => undefined);reads.set(alias, pending); }
   const quote = await pending;
   if (quote === undefined) return;
   stages[stage] = { model: av(quote.model), source: av(quote.source), price: av(quote.ref) };
   if (expiresAt === undefined || Date.parse(quote.expiresAt) < Date.parse(expiresAt)) expiresAt = quote.expiresAt;
  }));
 }
 stages.designReview = { model: un, source: un, price: un }; stages.secondReview = { model: un, source: un, price: un }; stages.eval = { model: un, source: un, price: un };
 let ceiling: number | undefined;
 const limits: PreviewContext["limits"] = [];
 if (settings !== undefined) {
  let projectCap: number | undefined, projectReadable = true;
  try { projectCap = await input.projectTaskCap?.(companyId, project); if (projectCap !== undefined && (!Number.isSafeInteger(projectCap) || projectCap < 0)) projectReadable = false; } catch { projectReadable = false; }
  if (projectReadable) ceiling = Math.min(settings.taskCapMicros, settings.companyDayCapMicros, projectCap ?? settings.taskCapMicros);
  const day = input.now().toISOString().slice(0, 10);
  let room: number | undefined, held: number | undefined;
  try {
   const load = await readDayLoad(store, companyId, day);
   const row = await store.get(companyDayKey(companyId, day));
   if (load !== "unknown") room = Math.max(0, settings.companyDayCapMicros - load);
   const raw = row?.["reservedMicros"];
   if (row === undefined) held = 0;
   else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && load !== "unknown" && raw <= load) held = raw;
  } catch { /* Keep unavailable. */ }
  limits.push({ scope: "engine_day", maximumMicros: av(settings.companyDayCapMicros), availableMicros: room === undefined ? unreadable : av(room), heldMicros: held === undefined ? unreadable : av(held), resetAt: av(new Date(Date.parse(day + "T00:00:00.000Z") + 86_400_000).toISOString()) });
  limits.push({ scope: "engine_task", maximumMicros: av(settings.taskCapMicros), availableMicros: av(settings.taskCapMicros), heldMicros: av(0), resetAt: { state: "unavailable", reason: "not_applicable" } });
  if (!projectReadable || projectCap !== undefined) limits.push({ scope: "project_task", maximumMicros: !projectReadable ? unreadable : av(projectCap!), availableMicros: !projectReadable ? unreadable : av(projectCap!), heldMicros: av(0), resetAt: { state: "unavailable", reason: "not_applicable" } });
 }
 return { ...(input.workflowVersion === undefined ? {} : { workflowVersion: input.workflowVersion }), ...(expiresAt === undefined ? {} : { expiresAt }), policyRevision: createHash("sha256").update(JSON.stringify({ policy, settings: settings ?? null, stages })).digest("hex"), stages, limits, ...(ceiling === undefined ? {} : { initialHoldCeilingMicros: ceiling }) };
}
