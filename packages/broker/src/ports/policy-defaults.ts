// Port lane W0: Code's defaults for the policy seams. Each does nothing or allows what a lone developer on their own machine
// may do. Cloud registers its own adapters (budgets, an audit ledger, second approvers, members and single sign-on, proxy-key spend)
// on the same points.
import { createUnavailableImageRegistry } from "./fake-image-registry.js";
import { createUnavailableScheduler } from "./fake-scheduler.js";
import { costMicrosOf, type ModelPrices } from "../core/cost/price-table.js";
import { checkCommentProof, type CommentRequestContext, type FetchedComment } from "../core/pr-commands/comment-checks.js";
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
  type SecretStore,
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
  /** Checks the secret of a local session (the one `rovara up` mints and puts in a cookie). Absent: no session is accepted. This signs the owner IN; it is never an approval proof (see `registerCodeDefaults`). */
  isValidSession?: (value: string, remoteAddress: string | undefined) => boolean | Promise<boolean>;
  /** Outside accounts the owner linked in the config (decision: "only tracker accounts the owner linked"). Anyone else is unlinked. */
  linkedAccounts?: readonly ExternalAccountRef[];
}

/** Identity for one developer on one machine: the local owner, and any outside account the owner linked in config. */
export function createLocalOwnerIdentity(options: LocalOwnerIdentityOptions = {}): IdentityProvider {
  const owner = localOwnerPrincipal(options);
  const linked = options.linkedAccounts ?? [];
  return {
    capabilities: { interactiveSignIn: false, externalAccounts: linked.length > 0, members: true, companySignIn: false },
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
    // Lane P3 (item I1): one company, one member. There is no sign-in flow (`interactiveSignIn` is off): the owner's session is minted by `rovara up`.
    async listMembers(companyId: string) {
      return { members: companyId === owner.companyId ? [owner] : [] };
    },
    async accountsOf(companyId: string, personId: string) {
      return companyId === owner.companyId && personId === owner.personId ? linked.map((entry) => ({ ...entry })) : [];
    },
  };
}

export const LOCAL_SESSION_METHOD = "local-session";
export const CODE_HOST_COMMENT_METHOD = "code-host-comment";

export interface LocalOwnerApproversOptions {
  /** The local owner, for the `local-session` proof. */
  owner?: Principal;
  /** Checks a `local-session` proof token against the request it is for. The local review pages issue tokens signed over one request, revision and digest (`LocalPageSessions.verifyProof`); wire that here. Absent: `local-session` proofs are refused. */
  verifySession?: (token: string, request: ApprovalRequest) => boolean | Promise<boolean>;
  /**
   * Fetches a comment by id from the code host: its text, author, times, the change request it is on and its author's permission (`FetchedComment`). FETCH ONLY (owner decision 66): the checks on it are Rovara's
   * (`checkCommentProof`). Absent: comment proofs are refused.
   */
  fetchComment?: (commentId: string, request: ApprovalRequest) => FetchedComment | undefined | Promise<FetchedComment | undefined>;
  /** Whether comments can be fetched right now (a code host that reads them is registered). Absent: yes, whenever `fetchComment` is given. The way is offered only while it is on. */
  commentsOn?: () => boolean;
  /** Where Rovara's own record says the request was posted, and since when (`CommentRequestContext`). Absent or undefined: a comment answers nothing. */
  commentContext?: (request: ApprovalRequest) => CommentRequestContext | undefined | Promise<CommentRequestContext | undefined>;
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
      const methods = [...(options.verifySession === undefined ? [] : [LOCAL_SESSION_METHOD]), ...(options.fetchComment === undefined || options.commentsOn?.() === false ? [] : [CODE_HOST_COMMENT_METHOD])];
      // The plug-in names its own strong methods (lane P3, item A3): a high-risk approval and every rejection need the local session, never a comment (decisions 45.3 and 62); asking for changes may use either.
      const session = methods.filter((method) => method === LOCAL_SESSION_METHOD);
      return { methods, minApprovers: 1, selfApprovalAllowed: true, strongMethods: session, rejectMethods: session, changesMethods: methods };
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
        if (options.fetchComment === undefined) return refuse("method_not_available");
        const comment = await options.fetchComment(proof.token, request);
        // Every check on the comment is Rovara's (owner decision 66); the host only reported what it holds.
        const checked = checkCommentProof({ comment, context: await options.commentContext?.(request), outcome: request.outcome, artifactDigest: request.artifactDigest });
        if (!checked.ok || comment === undefined) return refuse(checked.ok ? "no_approving_comment" : checked.reason);
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

/**
 * Metering that multiplies tokens by a price table. A model not in the table is priced `null` and recorded as `unknown`. A repeated `entryId` is counted once.
 * `prices` (the layered lookup of `core/cost/price-table.ts`: the provider's own table, then the catalog) is asked after the static table, so a table a caller fills by hand still wins. `price` (what a call could cost, held against a
 * budget) never assumes less than the catalog's list price; `record` (what a call did cost) is the model's own price.
 */
export function createPriceTableMetering(table: PriceTable, onRecord?: (entry: MeterEntry, result: MeterResult) => void | Promise<void>, prices?: ModelPrices): Metering {
  const recorded = new Map<string, MeterResult>();
  /** `capped`: the price a budget must assume (never below the catalog's list price). A cost that is recorded is the model's own price. */
  const priceOf = (usage: ModelUsage, capped: boolean): Cost | null => {
    const own = table.models[`${usage.provider}/${usage.modelId}`];
    if (own !== undefined) return { micros: costMicrosOf(own, usage.tokens), currency: table.currency };
    const model = { provider: usage.provider, modelId: usage.modelId };
    const found = capped ? prices?.findCap(model) : prices?.find(model);
    return found === undefined ? null : { micros: costMicrosOf(found.price, usage.tokens), currency: found.currency };
  };
  return {
    // What a call could cost, for a reservation against a budget: the capped price.
    async price(usage) {
      return priceOf(usage, true);
    },
    async record(entry) {
      const key = `${entry.companyId}\u0000${entry.entryId}`;
      const earlier = recorded.get(key);
      if (earlier !== undefined) return earlier;
      const cost = priceOf(entry.usage, false);
      const result: MeterResult = cost === null ? { cost: null, source: "unknown" } : { cost, source: "price-table" };
      recorded.set(key, result);
      await onRecord?.(entry, result);
      return result;
    },
  };
}

export interface CodeDefaultsOptions extends LocalOwnerIdentityOptions {
  priceTable: PriceTable;
  /** The layered price lookup (the providers' own tables, then the catalog). Absent: only `priceTable`. */
  prices?: ModelPrices;
  approvers?: LocalOwnerApproversOptions;
  onMeter?: (entry: MeterEntry, result: MeterResult) => void | Promise<void>;
  /** Code's model keys (environment, file). Absent: none is registered and the caller must configure one. */
  modelKeys?: ModelKeyStore;
  /** Port lane P6 (item L2): a local audit log to register as the default instead of the one that writes nothing. Absent: the no-op sink. */
  auditSink?: { name: string; sink: AuditSink };
  /** Code's secrets adapter (owner decision 60). Absent: none is registered. */
  secrets?: SecretStore;
}

/** Registers Code's policy defaults. Config-named adapters replace them. */
export function registerCodeDefaults(registry: AdapterRegistry, options: CodeDefaultsOptions): void {
  const owner = localOwnerPrincipal(options);
  registry.register("admission", "allow-all", createAllowAllAdmission(), { isDefault: true });
  if (options.auditSink === undefined) registry.register("audit-sink", "none", createNoopAuditSink(), { isDefault: true });
  else registry.register("audit-sink", options.auditSink.name, options.auditSink.sink, { isDefault: true });
  // The identity adapter's `isValidSession` is the owner's SIGN-IN (the `rovara up` cookie). It is never an approval proof: a raw session secret would approve any request. Approval proofs come only from a verifier
  // bound to one request, revision and digest (`options.approvers.verifySession`, for example `localSessionProofVerifier` over the local pages' sessions). Absent: `local-session` proofs are refused.
  const verifySession = options.approvers?.verifySession;
  registry.register("approvers", "local-owner", createLocalOwnerApprovers({ ...options.approvers, owner, ...(verifySession === undefined ? {} : { verifySession }) }), { isDefault: true });
  registry.register("identity", LOCAL_OWNER_PROVIDER, createLocalOwnerIdentity(options), { isDefault: true });
  registry.register("metering", "price-table", createPriceTableMetering(options.priceTable, options.onMeter, options.prices), { isDefault: true });
  if (options.modelKeys !== undefined) registry.register("model-keys", "local", options.modelKeys, { isDefault: true });
  if (options.secrets !== undefined) registry.register("secrets", "local", options.secrets, { isDefault: true });
  // Saved environments and the nightly test run need these two; until a real one is registered they say plainly that none is set up (they never pretend).
  registry.register("image-registry", "none", createUnavailableImageRegistry(), { isDefault: true });
  registry.register("scheduler", "none", createUnavailableScheduler(), { isDefault: true });
}
