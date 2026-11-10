// Lane P3 (owner decision 62): the company's "fresh sign-in" setting, stored once per company. The approvers plug-in reads it (`readApprovalSignInRule`) and puts it in `ApprovalRequirement.signIn`; the decision gate and the merge
// press then enforce it for high-risk approvals and rejections. Code's local approvers do not read it (the local owner has no sign-in time), so the setting changes nothing there; it is stored so a company moving to Cloud keeps it.
//
// Two rules live here and nowhere else: only an owner or admin changes it, and "trust any active company sign-in" is accepted only when the identity adapter signs people in through the company's own single sign-on
// (`IdentityCapabilities.companySignIn`, read from the adapter here, never from a caller's flag). A stored `any-active` is read back as the default window when the company no longer has its own sign-in (fail closed).
import {
  DEFAULT_APPROVAL_SIGN_IN_SETTING, ApprovalSignInSettingSchema, checkApprovalSignInSetting, companyScoped, isKnownOrgRole, when,
  type ApprovalSignInRule, type ApprovalSignInSetting, type AuditSink, type DocumentKey, type DocumentStore, type IdentityProvider, type Principal,
} from "@agentx/contracts";

export function approvalSignInSettingKey(companyId: string): DocumentKey {
  return { pk: companyScoped(companyId, "SETTING#approval-sign-in"), sk: "SETTING" };
}

export interface StoredApprovalSignIn {
  setting: ApprovalSignInSetting;
  /** 0 when the company never chose. Pass it back as `expectedRevision` to change it. */
  revision: number;
  /** True when no choice is stored (or the stored one cannot be used now) and `setting` is the default. */
  isDefault: boolean;
}

/** The company's setting. Missing, unreadable, or `any-active` without the company's own sign-in: the default window. */
export async function readApprovalSignInSetting(store: Pick<DocumentStore, "get">, companyId: string, identity: Pick<IdentityProvider, "capabilities">): Promise<StoredApprovalSignIn> {
  const row = await store.get(approvalSignInSettingKey(companyId));
  const revision = typeof row?.["revision"] === "number" && Number.isSafeInteger(row["revision"]) ? row["revision"] : 0;
  const parsed = ApprovalSignInSettingSchema.safeParse(row?.["setting"]);
  if (row === undefined || !parsed.success || (parsed.data.mode === "any-active" && identity.capabilities.companySignIn !== true)) return { setting: DEFAULT_APPROVAL_SIGN_IN_SETTING, revision, isDefault: true };
  return { setting: parsed.data, revision, isDefault: false };
}

/** The rule an approvers plug-in puts in its requirement. */
export async function readApprovalSignInRule(store: Pick<DocumentStore, "get">, companyId: string, identity: Pick<IdentityProvider, "capabilities">): Promise<ApprovalSignInRule> {
  return (await readApprovalSignInSetting(store, companyId, identity)).setting;
}

export type ApprovalSignInChange =
  | { ok: true; setting: ApprovalSignInSetting; revision: number }
  | { ok: false; reason: "invalid" | "needs_company_sign_in" | "not_allowed" | "stale" };

/** Who may change the setting: an owner or an admin of the company. A role the core does not know has no say. */
const mayChange = (person: Principal, companyId: string): boolean => person.companyId === companyId && person.roles.some((role) => isKnownOrgRole(role) && role !== "member");

export async function changeApprovalSignInSetting(
  deps: { store: DocumentStore; audit: AuditSink; identity: Pick<IdentityProvider, "capabilities">; now?: () => Date },
  input: { companyId: string; by: Principal; setting: unknown; expectedRevision: number },
): Promise<ApprovalSignInChange> {
  if (!mayChange(input.by, input.companyId)) return { ok: false, reason: "not_allowed" };
  const checked = checkApprovalSignInSetting(input.setting, { companyOwnSignIn: deps.identity.capabilities.companySignIn === true });
  if (!checked.ok) return checked;
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return { ok: false, reason: "invalid" };
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const revision = input.expectedRevision + 1;
  const key = approvalSignInSettingKey(input.companyId);
  // What it was before, for the audit record (the revision condition below makes this read the one the change replaces, or the change is refused).
  const before = await readApprovalSignInSetting(deps.store, input.companyId, deps.identity);
  if (before.revision !== input.expectedRevision) return { ok: false, reason: "stale" };
  const committed = await deps.store.transact([
    {
      kind: "put",
      item: { ...key, entityType: "APPROVAL_SIGN_IN_SETTING", companyId: input.companyId, setting: { ...checked.setting }, revision, changedAt: at, changedBy: input.by.personId },
      condition: input.expectedRevision === 0 ? when.absent() : when.eq("revision", input.expectedRevision),
    },
    ...deps.audit.stage({
      eventId: `setting:approval-sign-in:${input.companyId}:${String(revision)}`, companyId: input.companyId, at, actor: { type: "person", id: input.by.personId },
      action: "setting.approval_sign_in_changed", subject: { type: "setting", id: "approval-sign-in" }, details: { mode: checked.setting.mode, ...(checked.setting.mode === "window" ? { seconds: checked.setting.seconds } : {}), revision, previous: { ...before.setting, isDefault: before.isDefault } },
    }),
  ]);
  return committed.applied ? { ok: true, setting: checked.setting, revision } : { ok: false, reason: "stale" };
}
