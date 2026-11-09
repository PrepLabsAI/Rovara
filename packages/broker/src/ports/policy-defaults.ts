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
  approvalProofKey,
  type AuditSink,
  type AuthResult,
  type Cost,
  type ExternalAccountRef,
  type IdentityProvider,
  type MeterEntry,
  type MeterResult,
  type Metering,
  type ModelKeyStore,
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
    async stage() {
      return { decision: { allowed: true }, items: [] };
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
    async resolveExternalAccount(companyId: string, account: ExternalAccountRef) {
      if (companyId !== owner.companyId) return undefined;
      return linked.some((entry) => entry.provider === account.provider && entry.tenant === account.tenant && entry.accountId === account.accountId) ? owner : undefined;
    },
    async getPrincipal(companyId: string, personId: string) {
      return companyId === owner.companyId && personId === owner.personId ? owner : undefined;
    },
  };
}

export const LOCAL_SESSION_METHOD = "local-session";
export const CODE_HOST_COMMENT_METHOD = "code-host-comment";

/** What the code host adapter found when it looked a comment up by id. */
export interface VerifiedComment {
  /** Who wrote it, as the host reports it (not as the proof claims). */
  author: ExternalAccountRef;
  /** The author's permission on the repository. A read-only collaborator may not approve. */
  permission: "none" | "read" | "write" | "admin";
  /** The comment is on this request's change request, was posted after the revision it approves, and says approve. */
  approves: boolean;
}

export interface LocalOwnerApproversOptions {
  /** The local owner, for the `local-session` proof. */
  owner?: Principal;
  /** Checks a `local-session` proof token against the request it is for. The local review pages issue tokens signed over one request, revision and digest (`LocalPageSessions.verifyProof`); wire that here. Absent: `local-session` proofs are refused. */
  verifySession?: (token: string, request: ApprovalRequest) => boolean | Promise<boolean>;
  /**
   * Looks a comment up by id at the code host and says who wrote it and what they may do. The code host adapter provides it; the core
   * knows nothing about GitHub. Absent: comment proofs are refused.
   */
  verifyComment?: (commentId: string, request: ApprovalRequest) => VerifiedComment | undefined | Promise<VerifiedComment | undefined>;
  /** Turns a verified comment author into a principal. Default: a principal built from the account, vouched for by its own provider. */
  principalForAccount?: (account: ExternalAccountRef) => Principal;
  now?: () => Date;
}

/**
 * Decision 45.3: in Code a person's approval is proved by the local machine owner (their local session), or by a comment from a
 * repository collaborator with write permission on the change request. One approver is enough, and the person who asked may approve.
 * A proof is good for the one request, revision and digest it names, until the request expires, and once (in this process).
 */
export function createLocalOwnerApprovers(options: LocalOwnerApproversOptions = {}): Approvers {
  const owner = options.owner ?? localOwnerPrincipal();
  const now = options.now ?? (() => new Date());
  const used = new Set<string>();
  return {
    async requirement(): Promise<ApprovalRequirement> {
      const methods = [...(options.verifySession === undefined ? [] : [LOCAL_SESSION_METHOD]), ...(options.verifyComment === undefined ? [] : [CODE_HOST_COMMENT_METHOD])];
      return { methods, minApprovers: 1, selfApprovalAllowed: true };
    },
    async verify(request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict> {
      const refuse = (reason: string): ApprovalVerdict => ({ approved: false, reason });
      if (request.companyId !== owner.companyId) return refuse("wrong_company");
      if (proof.requestId !== request.requestId) return refuse("other_request");
      if (proof.revision !== request.revision) return refuse("other_revision");
      if (proof.artifactDigest !== request.artifactDigest) return refuse("other_content");
      if (request.expiresAt !== undefined && now().getTime() >= Date.parse(request.expiresAt)) return refuse("expired");
      if (used.has(approvalProofKey(proof))) return refuse("proof_already_used");
      let verdict: ApprovalVerdict;
      if (proof.method === LOCAL_SESSION_METHOD) {
        verdict = options.verifySession !== undefined && (await options.verifySession(proof.token, request))
          ? { approved: true, approver: owner, method: proof.method, proofId: proof.proofId }
          : refuse("not_the_local_owner");
      } else if (proof.method === CODE_HOST_COMMENT_METHOD) {
        if (options.verifyComment === undefined) return refuse("method_not_available");
        const comment = await options.verifyComment(proof.token, request);
        if (comment === undefined || !comment.approves) return refuse("no_approving_comment");
        if (comment.permission !== "write" && comment.permission !== "admin") return refuse("not_a_collaborator");
        const claimed = proof.claimedAccount;
        if (claimed !== undefined && (claimed.provider !== comment.author.provider || claimed.tenant !== comment.author.tenant || claimed.accountId !== comment.author.accountId)) return refuse("account_mismatch");
        const account = comment.author;
        const approver = options.principalForAccount?.(account) ?? { companyId: owner.companyId, personId: `${account.provider}:${account.tenant}:${account.accountId}`, displayName: account.accountId, roles: ["collaborator"], provider: account.provider };
        verdict = { approved: true, approver, method: proof.method, proofId: proof.proofId };
      } else {
        return refuse("unknown_method");
      }
      if (verdict.approved) {
        used.add(approvalProofKey(proof));
        // Bounded: a long-running process forgets the oldest; the caller's transaction is the real guarantee.
        if (used.size > 10_000) used.delete(used.values().next().value as string);
      }
      return verdict;
    },
  };
}

/** Metering that multiplies tokens by a price table. A model not in the table is priced `null` and recorded as `unknown`. A repeated `entryId` is counted once. */
export function createPriceTableMetering(table: PriceTable, onRecord?: (entry: MeterEntry, result: MeterResult) => void | Promise<void>): Metering {
  const recorded = new Map<string, MeterResult>();
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
      const key = `${entry.companyId}\u0000${entry.entryId}`;
      const earlier = recorded.get(key);
      if (earlier !== undefined) return earlier;
      const cost = price(entry.usage);
      const result: MeterResult = cost === null ? { cost: null, source: "unknown" } : { cost, source: "price-table" };
      recorded.set(key, result);
      await onRecord?.(entry, result);
      return result;
    },
  };
}

export interface CodeDefaultsOptions extends LocalOwnerIdentityOptions {
  priceTable: PriceTable;
  approvers?: LocalOwnerApproversOptions;
  onMeter?: (entry: MeterEntry, result: MeterResult) => void | Promise<void>;
  /** Code's model keys (environment, file). Absent: none is registered and the caller must configure one. */
  modelKeys?: ModelKeyStore;
}

/** Registers Code's policy defaults. Config-named adapters replace them. */
export function registerCodeDefaults(registry: AdapterRegistry, options: CodeDefaultsOptions): void {
  const owner = localOwnerPrincipal(options);
  registry.register("admission", "allow-all", createAllowAllAdmission(), { isDefault: true });
  registry.register("audit-sink", "none", createNoopAuditSink(), { isDefault: true });
  const verifySession = options.approvers?.verifySession ?? (options.isValidSession === undefined ? undefined : (token: string) => options.isValidSession!(token, undefined));
  registry.register("approvers", "local-owner", createLocalOwnerApprovers({ ...options.approvers, owner, ...(verifySession === undefined ? {} : { verifySession }) }), { isDefault: true });
  registry.register("identity", LOCAL_OWNER_PROVIDER, createLocalOwnerIdentity(options), { isDefault: true });
  registry.register("metering", "price-table", createPriceTableMetering(options.priceTable, options.onMeter), { isDefault: true });
  if (options.modelKeys !== undefined) registry.register("model-keys", "local", options.modelKeys, { isDefault: true });
}
