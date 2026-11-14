// G1's prospective pure calculation. NOT an authorization, preview or admission API.
// Future server callers must load/revalidate org/project authority, locks, revisions and
// the payable policy snapshot. Raw browser proposals are not an authoritative snapshot.
// No caller may treat this result as paid-start permission: runtime enforcement is not wired.
import { z } from "zod";
export const TaskStopMicrousdSchema = z.number().int().min(0).max(1_000_000_000_000).transform(value => value === 0 ? 0 : value);
export const TaskStopCalculationInputSchema = z.object({
 companyDefaultMicrousd: TaskStopMicrousdSchema,
 ceilingMicrousd: TaskStopMicrousdSchema,
 projectStopMicrousd: TaskStopMicrousdSchema.optional(),
 agentStopMicrousd: TaskStopMicrousdSchema.optional(),
}).strict();
/** Version 2 is the M47 server/preview input. Version 1 remains the historical
 * prospective display calculation; it must never authorize an enrolled start. */
const limitedStop = z.object({ kind: z.literal("limited"), stopMicrousd: TaskStopMicrousdSchema }).strict();
const inheritedStop = z.object({ kind: z.literal("inherit") }).strict();
export const TaskStopAdmissionInputSchema = z.object({
 schemaVersion: z.literal(2),
 companyDefault: z.discriminatedUnion("kind", [limitedStop, z.object({ kind: z.literal("rovara_estimate") }).strict()]),
 projectStop: z.discriminatedUnion("kind", [limitedStop, inheritedStop]),
 agentStop: z.discriminatedUnion("kind", [limitedStop, inheritedStop]),
 ceilingMicrousd: TaskStopMicrousdSchema,
 pathLimitMicrousd: TaskStopMicrousdSchema,
 approvedRunLimitMicrousd: TaskStopMicrousdSchema.optional(),
 approvedMaxPerRunMicrousd: TaskStopMicrousdSchema.optional(),
 committedMaxPerRunMicrousd: TaskStopMicrousdSchema.optional(),
 requestedMicrousd: TaskStopMicrousdSchema.optional(),
 chainMicrousd: TaskStopMicrousdSchema.optional(),
 testingMicrousd: TaskStopMicrousdSchema.optional(),
}).strict().refine(value => value.approvedRunLimitMicrousd === undefined || value.approvedMaxPerRunMicrousd === undefined, { message: "A capture must name one approved limit kind." });
export type TaskStopAdmissionInput = z.infer<typeof TaskStopAdmissionInputSchema>;
export type TaskStopBindingScope = "company_ceiling" | "company_default" | "project" | "agent" | "path" | "approved_run" | "approved_max_per_run" | "committed_max_per_run" | "requested" | "chain" | "testing";
export type TaskStopCalculation =
 | { kind: "resolved"; effectiveStopMicrousd: number; bindingScopes: TaskStopBindingScope[]; usesCompanyDefault: boolean; enforcement: "not_connected" }
 | { kind: "resolved"; effectiveStopMicrousd: number; approvalCapMicrousd: number; bindingScopes: TaskStopBindingScope[]; usesCompanyDefault: boolean; enforcement: "not_connected" }
 | { kind: "refused"; reason: "TASK_STOP_APPROVAL_ABOVE_CEILING"; approvalCapMicrousd: number; enforcement: "not_connected" }
 | { kind: "unavailable"; reason: "INVALID_OR_MISSING_POLICY"; enforcement: "not_connected" };
/** Finite known policies only. Unset overrides inherit; zero remains an explicit stop. */
export function calculateTaskStop(input: unknown): TaskStopCalculation {
 const admission = TaskStopAdmissionInputSchema.safeParse(input);
 if (admission.success) {
  const policy = admission.data;
  if ((policy.approvedRunLimitMicrousd !== undefined && policy.approvedRunLimitMicrousd > policy.ceilingMicrousd) || (policy.approvedMaxPerRunMicrousd !== undefined && policy.approvedMaxPerRunMicrousd > policy.ceilingMicrousd)) {
   return { kind: "refused", reason: "TASK_STOP_APPROVAL_ABOVE_CEILING", approvalCapMicrousd: policy.ceilingMicrousd, enforcement: "not_connected" };
  }
  // The ceiling is NOT a general starting cap: seeded estimates/planning,
  // fallback windows, pinned chains and evals retain their existing allowance.
  const candidates: Array<{ scope: TaskStopBindingScope; value: number }> = [];
  if (policy.companyDefault.kind === "limited") candidates.push({ scope: "company_default", value: policy.companyDefault.stopMicrousd });
  if (policy.projectStop.kind === "limited") candidates.push({ scope: "project", value: policy.projectStop.stopMicrousd });
  if (policy.agentStop.kind === "limited") {
   // Preserve the pre-existing explicit-agent ceiling semantics, including ties.
   if (policy.ceilingMicrousd <= policy.agentStop.stopMicrousd) candidates.push({ scope: "company_ceiling", value: policy.ceilingMicrousd });
   if (policy.agentStop.stopMicrousd <= policy.ceilingMicrousd) candidates.push({ scope: "agent", value: policy.agentStop.stopMicrousd });
  }
  candidates.push({ scope: policy.approvedRunLimitMicrousd === undefined ? "path" : "approved_run", value: policy.approvedRunLimitMicrousd ?? policy.pathLimitMicrousd });
  if (policy.approvedMaxPerRunMicrousd !== undefined) candidates.push({ scope: "approved_max_per_run", value: policy.approvedMaxPerRunMicrousd });
  if (policy.committedMaxPerRunMicrousd !== undefined) candidates.push({ scope: "committed_max_per_run", value: policy.committedMaxPerRunMicrousd });
  for (const [scope, value] of [["requested", policy.requestedMicrousd], ["chain", policy.chainMicrousd], ["testing", policy.testingMicrousd]] as const) {
   if (value !== undefined) candidates.push({ scope, value });
  }
  const effectiveStopMicrousd = Math.min(...candidates.map(candidate => candidate.value));
  return { kind: "resolved", effectiveStopMicrousd, approvalCapMicrousd: policy.ceilingMicrousd,
   bindingScopes: candidates.filter(candidate => candidate.value === effectiveStopMicrousd).map(candidate => candidate.scope),
   usesCompanyDefault: policy.companyDefault.kind === "limited", enforcement: "not_connected" };
 }
 const parsed = TaskStopCalculationInputSchema.safeParse(input);
 if (!parsed.success) return { kind: "unavailable", reason: "INVALID_OR_MISSING_POLICY", enforcement: "not_connected" };
 const policy = parsed.data;
 const candidates: Array<{ scope: TaskStopBindingScope; value: number }> = [{ scope: "company_ceiling", value: policy.ceilingMicrousd }];
 if (policy.projectStopMicrousd !== undefined) candidates.push({ scope: "project", value: policy.projectStopMicrousd });
 if (policy.agentStopMicrousd !== undefined) candidates.push({ scope: "agent", value: policy.agentStopMicrousd });
 const usesCompanyDefault = candidates.length === 1;
 if (usesCompanyDefault) candidates.push({ scope: "company_default", value: policy.companyDefaultMicrousd });
 const effectiveStopMicrousd = Math.min(...candidates.map(candidate => candidate.value));
 return { kind: "resolved", effectiveStopMicrousd, bindingScopes: candidates.filter(candidate => candidate.value === effectiveStopMicrousd).map(candidate => candidate.scope), usesCompanyDefault, enforcement: "not_connected" };
}
