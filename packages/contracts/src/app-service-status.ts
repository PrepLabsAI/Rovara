import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { ErrorRefSchema } from "./live-interaction.js";
const check = z.object({ kind: z.enum(["web", "api"]), state: z.enum(["ready", "parked", "unavailable", "unknown"]), observation: z.enum(["qualified", "warning", "expired", "unknown"]), reason: z.enum(["qualified", "expiring", "expired", "not_ready", "not_observed", "invalid_evidence", "not_configured", "unavailable"]), expiresAt: z.string().datetime().optional(), errorRef: ErrorRefSchema.optional() }).strict().superRefine((row, ctx) => {
 if (row.observation === "unknown" ? row.state !== "unknown" || row.expiresAt !== undefined || !["not_observed", "invalid_evidence", "not_configured", "unavailable"].includes(row.reason) : row.state === "unknown" || row.expiresAt === undefined) ctx.addIssue({ code: "custom", message: "Invalid service evidence." });
 if (row.observation === "qualified" && (row.state !== "ready" || row.reason !== "qualified")) ctx.addIssue({ code: "custom", message: "Invalid qualified observation." });
 if (row.observation === "expired" && row.reason !== "expired") ctx.addIssue({ code: "custom", message: "Invalid expired observation." });
 if (row.observation === "warning" && !["expiring", "not_ready"].includes(row.reason)) ctx.addIssue({ code: "custom", message: "Invalid warning observation." });
});
export const OrgServiceStatusSchema = z.object({ orgId: OrgIdSchema, source: z.literal("stored_runtime_qualification"), checkedAt: z.string().datetime(), configured: z.boolean(), checks: z.array(check).length(2), teamRecord: z.object({ status: z.enum(["ok", "warn", "unknown"]), detail: z.string().max(300) }).strict().optional() }).strict().superRefine((value, ctx) => {
 if (value.checks[0]?.kind !== "web" || value.checks[1]?.kind !== "api" || (!value.configured && value.checks.some(row => row.reason !== "not_configured"))) ctx.addIssue({ code: "custom", message: "Invalid service status scope." });
});
export const OrgServiceStatusReaderSchema = OrgServiceStatusSchema.strip();
export type OrgServiceStatus = z.infer<typeof OrgServiceStatusSchema>;
