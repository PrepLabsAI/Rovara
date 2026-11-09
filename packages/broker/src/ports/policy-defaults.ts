// Port lane W0: Code's defaults for the policy seams. Each does nothing or allows what a lone developer on their own machine
// may do. Cloud registers its own adapters (budgets, an audit ledger, second approvers, members and single sign-on, proxy-key spend)
// on the same points.
import {
  IMPLICIT_COMPANY_ID,
  type Admission,
  type AdapterRegistry,
  type ApprovalProof,
  type ApprovalRequest,
  type ApprovalRequirement,
  type ApprovalVerdict,
  type Approvers,
  type AuditSink,
  type AuthResult,
  type Cost,
  type ExternalAccountRef,
  type IdentityProvider,
  type MeterEntry,
  type MeterResult,
  type Metering,
  type ModelUsage,
  type Principal,
  type PriceTable,
  type PresentedCredential,
} from "@agentx/contracts";

/** Admission that lets everything through and holds nothing back. */
export function createAllowAllAdmission(): Admission {
  return {
    async admit() {
      return { allowed: true };
    },
    async settle() {},
    async release() {},
  };
}

/** An audit sink that writes nothing: no transaction steps, no record. */
export function createNoopAuditSink(): AuditSink {
  return {
    stage() {
      return [];
    },
    async record() {},
  };
}

export const LOCAL_OWNER_PROVIDER = "local-owner";
export const LOCAL_SESSION_SCHEME = "local-session";

export interface LocalOwnerOptions {
  companyId?: string;
  personId?: string;
  displayName?: string;
}

export function localOwnerPrincipal(options: LocalOwnerOptions = {}): Principal {
  return {
    companyId: options.companyId ?? IMPLICIT_COMPANY_ID,
    personId: options.personId ?? "local-owner",
    displayName: options.displayName ?? "Local owner",
    roles: ["owner"],
    provider: LOCAL_OWNER_PROVIDER,
  };
}

export interface LocalOwnerIdentityOptions extends LocalOwnerOptions {
  /** Checks the secret of a local session (the one `rovara up` mints and puts in a cookie). Absent: no session is accepted. */
  isValidSession?: (value: string, remoteAddress: string | undefined) => boolean | Promise<boolean>;
  /** Outside accounts the owner linked in the config (decision: "only tracker accounts the owner linked"). Anyone else is unlinked. */
  linkedAccounts?: readonly ExternalAccountRef[];
}

/** Identity for one developer on one machine: the local owner, and any outside account the owner linked in config. */
export function createLocalOwnerIdentity(options: LocalOwnerIdentityOptions = {}): IdentityProvider {
  const owner = localOwnerPrincipal(options);
  const linked = options.linkedAccounts ?? [];
  return {
    capabilities: { interactiveSignIn: false, externalAccounts: linked.length > 0 },
    async authenticate(credential: PresentedCredential): Promise<AuthResult> {
      if (credential.scheme !== LOCAL_SESSION_SCHEME || options.isValidSession === undefined) return { ok: false, reason: "refused" };
      return (await options.isValidSession(credential.value, credential.remoteAddress)) ? { ok: true, principal: owner } : { ok: false, reason: "unknown" };
    },
    async resolveExternalAccount(account: ExternalAccountRef) {
      return linked.some((entry) => entry.provider === account.provider && entry.tenant === account.tenant && entry.accountId === account.accountId) ? owner : undefined;
    },
    async getPrincipal(personId: string) {
      return personId === owner.personId ? owner : undefined;
    },
  };
}

export const LOCAL_SESSION_METHOD = "local-session";
export const CODE_HOST_COMMENT_METHOD = "code-host-comment";

export interface LocalOwnerApproversOptions {
  /** The local owner, for the `local-session` proof. */
  owner?: Principal;
  /**
   * Whether the account that wrote a comment on the change request may approve it: the repository's owner or a collaborator. The code
   * host adapter answers this; the core knows nothing about GitHub. Absent: comment proofs are refused.
   */
  isCollaborator?: (account: ExternalAccountRef, request: ApprovalRequest) => boolean | Promise<boolean>;
  /** Turns a verified comment account into a principal (the owner's linked account, or a collaborator). Default: a principal built from the account. */
  principalForAccount?: (account: ExternalAccountRef) => Principal;
}

/**
 * Decision 45.3: in Code a person's approval is proved by the local machine owner (their local session), or by a comment from the
 * repository owner or a collaborator on the change request. One approver is enough, and the person who asked may approve.
 */
export function createLocalOwnerApprovers(options: LocalOwnerApproversOptions = {}): Approvers {
  const owner = options.owner ?? localOwnerPrincipal();
  return {
    async requirement(): Promise<ApprovalRequirement> {
      return { methods: options.isCollaborator === undefined ? [LOCAL_SESSION_METHOD] : [LOCAL_SESSION_METHOD, CODE_HOST_COMMENT_METHOD], minApprovers: 1, selfApprovalAllowed: true };
    },
    async verify(request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict> {
      if (request.companyId !== owner.companyId) return { approved: false, reason: "wrong_company" };
      if (proof.method === LOCAL_SESSION_METHOD) {
        return proof.principal !== undefined && proof.principal.provider === LOCAL_OWNER_PROVIDER && proof.principal.personId === owner.personId
          ? { approved: true, approver: owner, method: proof.method }
          : { approved: false, reason: "not_the_local_owner" };
      }
      if (proof.method === CODE_HOST_COMMENT_METHOD) {
        if (options.isCollaborator === undefined || proof.account === undefined) return { approved: false, reason: "method_not_available" };
        if (!(await options.isCollaborator(proof.account, request))) return { approved: false, reason: "not_a_collaborator" };
        const account = proof.account;
        const approver = options.principalForAccount?.(account) ?? { ...owner, personId: `${account.provider}:${account.tenant}:${account.accountId}`, displayName: account.accountId, roles: ["collaborator"] };
        return { approved: true, approver, method: proof.method };
      }
      return { approved: false, reason: "unknown_method" };
    },
  };
}

/** Metering that multiplies tokens by a price table. A model not in the table is priced `null` and recorded as `unknown`. */
export function createPriceTableMetering(table: PriceTable, onRecord?: (entry: MeterEntry, result: MeterResult) => void | Promise<void>): Metering {
  const price = (usage: ModelUsage): Cost | null => {
    const model = table.models[`${usage.provider}/${usage.modelId}`];
    if (model === undefined) return null;
    const perMillion =
      usage.tokens.input * model.inputMicrosPerMillionTokens +
      usage.tokens.output * model.outputMicrosPerMillionTokens +
      usage.tokens.cacheRead * (model.cacheReadMicrosPerMillionTokens ?? model.inputMicrosPerMillionTokens) +
      usage.tokens.cacheWrite * (model.cacheWriteMicrosPerMillionTokens ?? model.inputMicrosPerMillionTokens);
    return { micros: Math.round(perMillion / 1_000_000), currency: table.currency };
  };
  return {
    async price(usage) {
      return price(usage);
    },
    async record(entry) {
      const cost = price(entry.usage);
      const result: MeterResult = cost === null ? { cost: null, source: "unknown" } : { cost, source: "price-table" };
      await onRecord?.(entry, result);
      return result;
    },
  };
}

export interface CodeDefaultsOptions extends LocalOwnerIdentityOptions {
  priceTable: PriceTable;
  approvers?: LocalOwnerApproversOptions;
  onMeter?: (entry: MeterEntry, result: MeterResult) => void | Promise<void>;
}

/** Registers Code's policy defaults. Config-named adapters replace them. */
export function registerCodeDefaults(registry: AdapterRegistry, options: CodeDefaultsOptions): void {
  const owner = localOwnerPrincipal(options);
  registry.register("admission", "allow-all", createAllowAllAdmission(), { isDefault: true });
  registry.register("audit-sink", "none", createNoopAuditSink(), { isDefault: true });
  registry.register("approvers", "local-owner", createLocalOwnerApprovers({ ...options.approvers, owner }), { isDefault: true });
  registry.register("identity", LOCAL_OWNER_PROVIDER, createLocalOwnerIdentity(options), { isDefault: true });
  registry.register("metering", "price-table", createPriceTableMetering(options.priceTable, options.onMeter), { isDefault: true });
}
