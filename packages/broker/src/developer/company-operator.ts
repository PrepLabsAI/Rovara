// Imported only by the sign-in Lambda's server. No broker route builds operator-only events.
import { z } from "zod";
import { CompanySelfServeNameSchema, CompanyInviteCodeHashSchema, CompanyInviteCodeIdSchema, CompanyInviteExpiryHoursSchema, IMPLICIT_COMPANY_ID, SignInClientRecordSchema, OrgIdSchema, type CompanyInviteList } from "@agentx/contracts";
import { CompanyEmail, CompanyExpiryHours, CompanyPersonId, generateCompanyId, type CompanySignInStore } from "./company-membership.js";
import { emailIndexKey, type DeveloperSignInStore } from "./store.js";
import { CompanyMemberRefusal, MemberListInput, type CompanyMemberReply } from "./company-member-contract.js";
import { CompanyIssuerSettings } from "./company-issuer.js";
import type { CompanyInviteStore, SelfCreateResult } from "./company-invites.js";
import { InstallCompanyName, type EnsureInstallCompanyResult, type InstallCompanyStore } from "./install-company.js";

const request = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company-create"), name: z.string().trim().min(1).max(80), firstAdminEmail: CompanyEmail, expiresInHours: CompanyExpiryHours }).strict(),
  // DEC 254h: `inviteHash`, the SHA-256 of the invite link secret the broker made for this pre-approval (never the secret).
  z.object({ kind: z.literal("company-preapprove"), companyId: OrgIdSchema, email: CompanyEmail, role: z.enum(["admin", "member"]), expiresInHours: CompanyExpiryHours, createdBy: CompanyPersonId.optional(), inviteHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ kind: z.literal("company-preapproval-withdraw"), companyId: OrgIdSchema, email: CompanyEmail.optional(), emailHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), createdBy: CompanyPersonId.optional() }).strict().refine((value) => (value.email === undefined) !== (value.emailHash === undefined)),
  z.object({ kind: z.literal("company-preapproval-resend"), companyId: OrgIdSchema, emailHash: z.string().regex(/^[a-f0-9]{64}$/), expiresInHours: CompanyExpiryHours, createdBy: CompanyPersonId, inviteHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("company-preapprovals-list"), companyId: OrgIdSchema }).strict(),
  // DEC 254zzz84 (5): a removal with a hand-over fences the role the remover saw and a live successor inside its own transaction (both optional: an operator's revoke names neither).
  z.object({ kind: z.literal("company-member-revoke"), companyId: OrgIdSchema, personId: CompanyPersonId, createdBy: CompanyPersonId.optional(), expectedRole: z.enum(["member", "admin", "owner"]).optional(), successorId: CompanyPersonId.optional() }).strict(),
  z.object({ kind: z.literal("company-member-restore"), companyId: OrgIdSchema, personId: CompanyPersonId, createdBy: CompanyPersonId.optional() }).strict(),
  z.object({ kind: z.literal("company-member-role-set"), companyId: OrgIdSchema, personId: CompanyPersonId, role: z.enum(["member", "admin", "owner"]), createdBy: CompanyPersonId.optional() }).strict(),
  MemberListInput.extend({ kind: z.literal("company-member-list") }).strict(),
  z.object({ kind: z.literal("company-signin-client-set"), client: SignInClientRecordSchema }).strict(),
  CompanyIssuerSettings.extend({ kind: z.literal("company-issuer-set"), companyId: OrgIdSchema.refine((id) => id !== IMPLICIT_COMPANY_ID) }).strict(),
  // DEC 254a: the install's invite codes and self-serve switch (an install administrator's applied change, or a direct operator invoke). Hashes only.
  z.object({ kind: z.literal("company-invite-create"), codeHash: CompanyInviteCodeHashSchema, expiresInHours: CompanyInviteExpiryHoursSchema, createdBy: CompanyPersonId.optional() }).strict(),
  z.object({ kind: z.literal("company-invite-list") }).strict(),
  z.object({ kind: z.literal("company-invite-revoke"), codeId: CompanyInviteCodeIdSchema, createdBy: CompanyPersonId.optional() }).strict(),
  z.object({ kind: z.literal("company-self-serve-set"), open: z.boolean(), createdBy: CompanyPersonId.optional() }).strict(),
  // DEC 253z: a signed-in person with no company makes their own, with a code. The broker pins the person; the name is checked again here.
  z.object({ kind: z.literal("company-self-create"), personId: CompanyPersonId, name: CompanySelfServeNameSchema, codeHash: CompanyInviteCodeHashSchema }).strict(),
  // #1612: the install's own company: made once (or adopted, when an operator already moved the install into a named company) and read. Idempotent.
  z.object({ kind: z.literal("company-install-ensure"), name: InstallCompanyName, ownerEmail: CompanyEmail.optional(), adoptCompanyId: OrgIdSchema.refine((id) => id !== IMPLICIT_COMPANY_ID).optional() }).strict(),
  z.object({ kind: z.literal("company-install-read") }).strict(),
]);
export type CompanyOperatorRequest = z.infer<typeof request>;
export type CompanyOperatorResponse = { ok: true; companyId?: string; expiresAt?: number; preapprovals?: Awaited<ReturnType<CompanySignInStore["list"]>>["preapprovals"]; more?: boolean }
  | CompanyMemberReply | { ok: true; codeId: string } | ({ ok: true } & CompanyInviteList) | SelfCreateResult | ({ ok: true } & EnsureInstallCompanyResult);
export async function companyOperator(deps: { store: CompanySignInStore; invites?: CompanyInviteStore; installCompany?: InstallCompanyStore; clients?: DeveloperSignInStore; now: () => number; log: (entry: Record<string, unknown>) => void; newCompanyId?: () => string }, event: unknown): Promise<CompanyOperatorResponse> {
  const parsed = request.safeParse(event);
  if (!parsed.success) return { ok: false, error: "invalid_request" };
  try {
    const input = parsed.data;
    if (isInviteRequest(input)) {
      const invites = deps.invites;
      if (invites === undefined) return { ok: false, error: "unavailable" };
      switch (input.kind) {
        case "company-invite-create": {
          const codeId = await invites.create(input.codeHash, input.expiresInHours, input.createdBy);
          deps.log({ event: input.kind, codeId });
          return { ok: true, codeId };
        }
        case "company-invite-list": return { ok: true, ...await invites.list() };
        case "company-invite-revoke": {
          if (!await invites.revoke(input.codeId, input.createdBy)) return { ok: false, error: "not_found" };
          deps.log({ event: input.kind, codeId: input.codeId });
          return { ok: true };
        }
        case "company-self-serve-set": await invites.setSelfServe(input.open, input.createdBy); deps.log({ event: input.kind, open: input.open }); return { ok: true };
        case "company-self-create": {
          const result = await invites.selfCreate({ personId: input.personId, name: input.name, codeHash: input.codeHash });
          // Only fixed outcomes and opaque ids: never the name or the code's hash.
          deps.log(result.ok ? { event: input.kind, companyId: result.companyId, personId: input.personId } : { event: input.kind, refused: result.error, personId: input.personId });
          return result;
        }
      }
    }
    if (isInstallRequest(input)) return await installCompanyOperator(deps, input);
    if (input.kind === "company-signin-client-set") {
      const companyId = input.client.companyId ?? IMPLICIT_COMPANY_ID;
      if (deps.clients === undefined || !await deps.store.companyExists(companyId)) return { ok: false, error: "invalid_request" };
      await deps.clients.putClient(input.client, companyId, { operator: true, commit: (writes) => deps.store.operatorWrite(companyId, input.kind, writes) });
      deps.log({ event: input.kind, companyId });
      return { ok: true };
    }
    const companyId = input.kind === "company-create" ? (deps.newCompanyId?.() ?? generateCompanyId()) : input.companyId;
    switch (input.kind) {
      case "company-create": await deps.store.create(companyId, input.name, input.firstAdminEmail, input.expiresInHours); break;
      case "company-preapprove": {
        const expiresAt = await deps.store.preapprove(companyId, input.email, input.role, input.expiresInHours, input.createdBy, input.inviteHash);
        deps.log({ event: input.kind, companyId });
        // DEC 254h: the broker answers the link's expiry, which is the pre-approval's.
        return input.inviteHash === undefined ? { ok: true } : { ok: true, expiresAt };
      }
      case "company-preapproval-withdraw": if (!await deps.store.withdraw(companyId, (input.emailHash ?? emailIndexKey(input.email!).pk.slice(6)), input.createdBy)) return { ok: false, error: "not_found" }; break;
      case "company-preapproval-resend": {
        const expiresAt = await deps.store.resend(companyId, input.emailHash, input.expiresInHours, input.createdBy, input.inviteHash);
        deps.log({ event: input.kind, companyId });
        return { ok: true, expiresAt };
      }
      case "company-preapprovals-list": {
        const listed = await deps.store.list(companyId);
        await deps.store.operatorWrite(companyId, input.kind, []);
        deps.log({ event: input.kind, companyId });
        return { ok: true, ...listed };
      }
      case "company-member-revoke": case "company-member-restore": {
        // Only a revoke's schema carries the fences (a restore's has neither field).
        const fence = { ...("expectedRole" in input && input.expectedRole !== undefined ? { expectedRole: input.expectedRole } : {}), ...("successorId" in input && input.successorId !== undefined ? { successorId: input.successorId } : {}) };
        if (!await deps.store.setRevoked(companyId, input.personId, input.kind === "company-member-revoke", input.createdBy, fence)) return { ok: false, error: "not_found" };
        break;
      }
      case "company-member-role-set": {
        const result = await deps.store.setRole(companyId, input.personId, input.role, input.createdBy);
        if (result === "not_found") return { ok: false, error: "not_found" };
        if (result === "unchanged") return { ok: true };
        break;
      }
      case "company-member-list": return { ok: true, ...await deps.store.listMembers(companyId, input.cursor, input.limit) };
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
  } catch (error) { return error instanceof CompanyMemberRefusal ? error.response : { ok: false, error: "unavailable" }; }
}

type InviteRequest = Extract<CompanyOperatorRequest, { kind: "company-invite-create" | "company-invite-list" | "company-invite-revoke" | "company-self-serve-set" | "company-self-create" }>;
type InstallRequest = Extract<CompanyOperatorRequest, { kind: "company-install-ensure" | "company-install-read" }>;
const INVITE_KINDS: ReadonlySet<string> = new Set<InviteRequest["kind"]>(["company-invite-create", "company-invite-list", "company-invite-revoke", "company-self-serve-set", "company-self-create"]);
const INSTALL_KINDS: ReadonlySet<string> = new Set<InstallRequest["kind"]>(["company-install-ensure", "company-install-read"]);
const isInviteRequest = (input: CompanyOperatorRequest): input is InviteRequest => INVITE_KINDS.has(input.kind);
const isInstallRequest = (input: CompanyOperatorRequest): input is InstallRequest => INSTALL_KINDS.has(input.kind);

/** #1612: the install's company events. A read before the company is made answers `not_found`. */
async function installCompanyOperator(
  deps: { installCompany?: InstallCompanyStore; log: (entry: Record<string, unknown>) => void },
  input: InstallRequest,
): Promise<CompanyOperatorResponse> {
  const store = deps.installCompany;
  if (store === undefined) return { ok: false, error: "unavailable" };
  if (input.kind === "company-install-read") {
    const companyId = await store.companyId();
    return companyId === undefined ? { ok: false, error: "not_found" } : { ok: true, companyId, outcome: "existing" };
  }
  const result = await store.ensure({ name: input.name, ...(input.ownerEmail === undefined ? {} : { ownerEmail: input.ownerEmail }), ...(input.adoptCompanyId === undefined ? {} : { adoptCompanyId: input.adoptCompanyId }) });
  // Only the outcome and the opaque id: never the name or the email.
  deps.log({ event: input.kind, companyId: result.companyId, outcome: result.outcome });
  return { ok: true, ...result };
}
