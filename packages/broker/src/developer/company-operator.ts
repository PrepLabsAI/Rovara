// Imported only by the sign-in Lambda's server. No broker route builds operator-only events.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { IMPLICIT_COMPANY_ID, SignInClientRecordSchema, OrgIdSchema } from "@agentx/contracts";
import { CompanyEmail, CompanyExpiryHours, CompanyPersonId, type CompanySignInStore } from "./company-membership.js";
import { emailIndexKey, type DeveloperSignInStore } from "./store.js";
import { CompanyIssuerSettings } from "./company-issuer.js";

const request = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company-create"), name: z.string().trim().min(1).max(80), firstAdminEmail: CompanyEmail, expiresInHours: CompanyExpiryHours }).strict(),
  z.object({ kind: z.literal("company-preapprove"), companyId: OrgIdSchema, email: CompanyEmail, role: z.enum(["admin", "member"]), expiresInHours: CompanyExpiryHours, createdBy: CompanyPersonId.optional() }).strict(),
  z.object({ kind: z.literal("company-preapproval-withdraw"), companyId: OrgIdSchema, email: CompanyEmail.optional(), emailHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), createdBy: CompanyPersonId.optional() }).strict().refine((value) => (value.email === undefined) !== (value.emailHash === undefined)),
  z.object({ kind: z.literal("company-preapprovals-list"), companyId: OrgIdSchema }).strict(),
  z.object({ kind: z.literal("company-member-revoke"), companyId: OrgIdSchema, personId: CompanyPersonId }).strict(),
  z.object({ kind: z.literal("company-member-restore"), companyId: OrgIdSchema, personId: CompanyPersonId }).strict(),
  z.object({ kind: z.literal("company-signin-client-set"), client: SignInClientRecordSchema }).strict(),
  CompanyIssuerSettings.extend({ kind: z.literal("company-issuer-set"), companyId: OrgIdSchema.refine((id) => id !== IMPLICIT_COMPANY_ID) }).strict(),
]);
export type CompanyOperatorRequest = z.infer<typeof request>;
export type CompanyOperatorResponse = { ok: true; companyId?: string; preapprovals?: Awaited<ReturnType<CompanySignInStore["list"]>>["preapprovals"]; more?: boolean }
  | { ok: false; error: "invalid_request" | "unavailable" | "not_found" };
export async function companyOperator(deps: { store: CompanySignInStore; clients?: DeveloperSignInStore; now: () => number; log: (entry: Record<string, unknown>) => void; newCompanyId?: () => string }, event: unknown): Promise<CompanyOperatorResponse> {
  const parsed = request.safeParse(event);
  if (!parsed.success) return { ok: false, error: "invalid_request" };
  try {
    const input = parsed.data;
    if (input.kind === "company-signin-client-set") {
      const companyId = input.client.companyId ?? IMPLICIT_COMPANY_ID;
      if (deps.clients === undefined || !await deps.store.companyExists(companyId)) return { ok: false, error: "invalid_request" };
      await deps.clients.putClient(input.client, companyId, { operator: true, commit: (writes) => deps.store.operatorWrite(companyId, input.kind, writes) });
      deps.log({ event: input.kind, companyId });
      return { ok: true };
    }
    const companyId = input.kind === "company-create" ? (deps.newCompanyId?.() ?? `org_${BigInt(`0x${randomBytes(16).toString("hex")}`).toString(36).padStart(20, "0").slice(-20)}`) : input.companyId;
    switch (input.kind) {
      case "company-create": await deps.store.create(companyId, input.name, input.firstAdminEmail, input.expiresInHours); break;
      case "company-preapprove": await deps.store.preapprove(companyId, input.email, input.role, input.expiresInHours, input.createdBy); break;
      case "company-preapproval-withdraw": if (!await deps.store.withdraw(companyId, (input.emailHash ?? emailIndexKey(input.email!).pk.slice(6)), input.createdBy)) return { ok: false, error: "not_found" }; break;
      case "company-preapprovals-list": {
        const listed = await deps.store.list(companyId);
        await deps.store.operatorWrite(companyId, input.kind, []);
        deps.log({ event: input.kind, companyId });
        return { ok: true, ...listed };
      }
      case "company-member-revoke": case "company-member-restore": if (!await deps.store.setRevoked(companyId, input.personId, input.kind === "company-member-revoke")) return { ok: false, error: "not_found" }; break;
      case "company-issuer-set": {
        const settings = { issuer: input.issuer, clientId: input.clientId, displayName: input.displayName,
          requiredValues: input.requiredValues, enabled: input.enabled,
          ...(input.since === undefined ? {} : { since: input.since }),
          ...(input.requiredClaim === undefined ? {} : { requiredClaim: input.requiredClaim }) };
        await deps.store.setIssuer(companyId, settings); break;
      }
    }
    deps.log({ event: input.kind, companyId });
    return input.kind === "company-create" ? { ok: true, companyId } : { ok: true };
  } catch { return { ok: false, error: "unavailable" }; }
}
