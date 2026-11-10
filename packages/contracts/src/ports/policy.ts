// Port lane W0: the policy seams. Each does nothing, or allows everything, in Code, and is where Cloud plugs in its own rule
// (budgets, a second approver, members and single sign-on, money). The audit sink is in audit-sink.ts, the model key store in
// model-keys.ts.
//
// Decision 51: nothing here names a sign-in provider, a chat tool or a code host. A person's outside accounts are
// `ExternalAccountRef`s (a provider id and an opaque account id); a provider is an adapter.
import { createHash } from "node:crypto";
import type { TransactItem } from "./document-store.js";
import type { Cost } from "./json.js";

/** The thing a decision is about: a task, a plan, a design, a merge. */
export interface PolicySubject {
  type: string;
  id: string;
}

/** A person or a service, as the core knows it after sign-in. */
export interface Principal {
  companyId: string;
  /** Rovara's own stable id for the person. Opaque. */
  personId: string;
  displayName: string;
  /** Role names the company defines (Code has `owner`). The core tests only for the names it knows. */
  roles: readonly string[];
  /** The identity adapter that vouched for this principal, such as `local-owner`. */
  provider: string;
  /**
   * When this person last signed in interactively (ISO time), when the identity adapter knows (lane P3, items I1 and A1). It is the adapter's own fact: a rule that wants a fresh sign-in (`ApprovalRequirement.signIn`) reads it,
   * and Code's local owner has none. Never taken from anything a caller sends.
   */
  authTime?: string;
  /** The sign-in methods the person used for this sign-in, as open ids in the adapter's words (`password`, `company-sso`). Informational: no core rule branches on a name. */
  methods?: readonly string[];
}

/** An account at an outside system. `provider` is the adapter's id for that system; `accountId` is the system's own. */
export interface ExternalAccountRef {
  provider: string;
  /** The workspace, organisation or server the account lives in; empty text when the system has none. */
  tenant: string;
  accountId: string;
}

// ---- Admission ----

export interface AdmissionRequest {
  companyId: string;
  /** Names this request: asking twice with one key gives the same decision and holds the allowance once. */
  idempotencyKey: string;
  /** What is about to happen: `task.start`, `model.call`, `machine.start`, or a name a later lane adds. */
  action: string;
  actor?: Principal;
  projectName?: string;
  subject?: PolicySubject;
  /** What the caller expects it to use. */
  estimate?: { tokens?: number; cost?: Cost };
}

export type AdmissionDecision =
  | {
      allowed: true;
      /** Set when the decision holds some allowance back (a budget reservation). Pass it to `settle` or `release`. An adapter that really holds one expires it by itself: a caller that crashes before it records the id cannot give it back. */
      reservationId?: string;
    }
  | {
      allowed: false;
      /** A lower-case code (`budget_exhausted`) the caller can branch on. */
      code: string;
      /** A sentence for the person, fit to show. */
      message: string;
      retryAfterSeconds?: number;
    };

export interface Admission {
  /** Decides on its own. For a decision that must commit with the caller's change, use `stage`. */
  admit(request: AdmissionRequest): Promise<AdmissionDecision>;
  /**
   * The steps to add to the caller's `DocumentStore.transact` call so that the allowance is taken in the same commit as the change
   * (Cloud charges its limits inside the task-start transaction), and the decision that goes with them. A refused decision has no
   * steps. When the transaction fails on a charge step, the caller asks again with a new key.
   */
  stage(request: AdmissionRequest): Promise<{ decision: AdmissionDecision; items: readonly TransactItem[] }>;
  /** Replaces a reservation by what was actually used. A reservation settles or releases once; again is a no-op. */
  settle(reservationId: string, actual: { tokens?: number; cost?: Cost }): Promise<void>;
  /** Gives a reservation back unused. */
  release(reservationId: string): Promise<void>;
}

// ---- Approvers ----

export interface ApprovalRequest {
  companyId: string;
  /** Names this request. A proof is good for one request only. */
  requestId: string;
  /** What is being approved: `plan`, `design`, `merge`, `setting`, or a name a later lane adds. */
  kind: string;
  subject: PolicySubject;
  /** The project the subject belongs to; an adapter that asks the code host who may approve needs it. */
  projectName?: string;
  /** The exact revision and content the person saw, so an approval applies to that and nothing newer. */
  revision: number;
  artifactDigest: string;
  requestedBy?: Principal;
  risk?: "low" | "medium" | "high";
  /** After this time (ISO) no proof is accepted. */
  expiresAt?: string;
  /**
   * Which answer the proof is for, when the caller is a decision gate (lane L12, owner decision 66): a comment that says "approve" is not a proof for "request changes", and the other way round. Absent: an approval
   * (a merge press, the older callers).
   */
  outcome?: "approve" | "reject" | "request_changes";
}

/**
 * How recent an approver's sign-in must be (decision 62: a company setting, lane P3). `window`: the sign-in time (`Principal.authTime`) must be no older than `seconds`, and an approver with no sign-in time is refused.
 * `any-active`: any active company sign-in counts (the person is signed in now; for a company on its own single sign-on, so a high-risk approval needs no extra step). Only an approver adapter sets it; Code's local owner does not.
 */
export type ApprovalSignInRule = { mode: "window"; seconds: number } | { mode: "any-active" };

/** What the approver adapter says is needed, so a surface can offer the right way to answer. */
export interface ApprovalRequirement {
  /** Ways a person may prove who they are, in the adapter's words: `local-session`, `code-host-comment`, `browser-step-up`. */
  methods: readonly string[];
  minApprovers: number;
  /** Whether the person who asked may also approve. */
  selfApprovalAllowed: boolean;
  /**
   * The methods that may approve a HIGH-risk request (lane P3, item A3: the plug-in that knows its methods names them). A subset of `methods` is used. Absent: only the local session, so a plug-in whose strong method has another name
   * must say so. A method that proves one act by a code host comment is never strong, whatever is named here.
   */
  strongMethods?: readonly string[];
  /** The methods that may reject. Rejecting needs a signed-in session: a comment method is never one, whatever is named here. Absent: the local session. */
  rejectMethods?: readonly string[];
  /**
   * The methods that prove ONE act by a code host comment, in the plug-in's words (lane P3, review L1). The core never accepts a comment method as strong or for rejecting: the method `code-host-comment`, any method whose name starts with `code-host-`,
   * and every method listed here. Absent: only the first two.
   */
  commentMethods?: readonly string[];
  /** The methods that may ask for changes. Asking for changes by a comment is allowed (decision 62). Absent: the local session or a code host comment. */
  changesMethods?: readonly string[];
  /** How recent the approver's sign-in must be for a high-risk approval or a rejection (decision 62). Absent: no rule (Code). */
  signIn?: ApprovalSignInRule;
}

/**
 * What a surface presents with an approval. It names what it approves (`requestId`, `revision`, `artifactDigest`), which `verify`
 * checks against the request, and carries a `token` that the issuer of the method can check: the identity adapter's session for
 * `local-session`, the code host's comment (looked up by id, not trusted as presented) for `code-host-comment`. A proof is not
 * evidence by itself: `verify` never believes a principal or an account that the proof only claims.
 */
export interface ApprovalProof {
  /** Names this proof for the caller's records. Single use is keyed on `approvalProofKey(proof)`, which the caller stores with `when.absent()` in the decision's transaction. */
  proofId: string;
  method: string;
  requestId: string;
  revision: number;
  artifactDigest: string;
  /** Method-specific, checked by the method's issuer: a session secret, a comment id. A secret in it must not be logged. */
  token: string;
  /** The account the surface says answered. Checked against the token's issuer, never taken as given. */
  claimedAccount?: ExternalAccountRef;
}

/**
 * The key a proof is used up under: the same session or comment token cannot be used again for the same request under a fresh
 * `proofId`. The caller stores this key (not `proofId`) with `when.absent()` in the decision transaction.
 */
export function approvalProofKey(proof: Pick<ApprovalProof, "method" | "token" | "requestId">): string {
  return createHash("sha256").update(JSON.stringify([proof.method, proof.token, proof.requestId])).digest("hex");
}

export type ApprovalVerdict = { approved: true; approver: Principal; method: string; proofId: string } | { approved: false; reason: string };

export interface Approvers {
  requirement(request: ApprovalRequest): Promise<ApprovalRequirement>;
  /**
   * Whether this proof is an acceptable approval of this request from a person allowed to give it: the proof matches the request
   * (id, revision, digest), the request has not expired, the token checks out with its issuer, and the person holds the right.
   * With `minApprovers` above 1 the caller collects verdicts and counts distinct approvers. An adapter may remember proof ids it has
   * accepted and refuse a repeat; the caller's transaction is the guarantee.
   */
  verify(request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict>;
}

// ---- Identity ----

/** A credential as the surface received it, before anyone has checked it. `value` is a secret: do not log it. */
export interface PresentedCredential {
  /** How to read it, in the adapter's words: `local-session`, `bearer`, `api-key`. */
  scheme: string;
  value: string;
  /** Where the request came from, when the surface knows. */
  remoteAddress?: string;
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; reason: "unknown" | "expired" | "refused" };

export interface IdentityCapabilities {
  /** The adapter signs people in itself (a login page, single sign-on): it offers `beginSignIn`, `completeSignIn` and `signOut`. */
  interactiveSignIn: boolean;
  /** The adapter can map an outside account to a person, and a person to their outside accounts (`accountsOf`). */
  externalAccounts: boolean;
  /** The adapter can list the company's members (`listMembers`). Absent: it cannot. */
  members?: boolean;
  /** The adapter signs people in through the company's own single sign-on, so a company may choose "trust any active company sign-in" (`ApprovalSignInRule`). Absent: it does not. */
  companySignIn?: boolean;
}

/** Starts a sign-in: the adapter answers with where to send the person. */
export interface SignInStartRequest {
  companyId: string;
  /** Which of the adapter's sign-in methods, as an open id; absent: the adapter's default. */
  method?: string;
  /** Where the person returns to in Rovara afterwards. Rovara checks it is its own address; the adapter does not follow it. */
  returnTo?: string;
}
export interface SignInStart {
  /** The address the person is sent to. */
  redirectUrl: string;
  /** Names this attempt; `completeSignIn` gets it back with what the provider sent. Opaque. */
  attemptId: string;
  expiresAt: string;
}
/** Finishes a sign-in with what came back from the provider (query values). A value in it is a secret: do not log it. */
export interface SignInCompleteRequest {
  companyId: string;
  attemptId: string;
  params: Readonly<Record<string, string>>;
}
export type SignInResult =
  | { ok: true; principal: Principal; /** The credential the surface presents from now on. A secret. */ credential: PresentedCredential; expiresAt?: string }
  | { ok: false; reason: "unknown" | "expired" | "refused" };

export interface IdentityMemberPage {
  members: readonly Principal[];
  /** Pass it back to read the next page; absent on the last. */
  nextCursor?: string;
}

export interface IdentityProvider {
  readonly capabilities: IdentityCapabilities;
  authenticate(credential: PresentedCredential): Promise<AuthResult>;
  /** The person an outside account is linked to in this company, or undefined when it is not linked (the surface then asks the person to link it). */
  resolveExternalAccount(companyId: string, account: ExternalAccountRef): Promise<Principal | undefined>;
  /** A person of this company by Rovara id, or undefined. */
  getPrincipal(companyId: string, personId: string): Promise<Principal | undefined>;
  // ---- Optional abilities (lane P3, items I1 and I2; owner decision 60). An adapter offers only what its capability flag says; a caller checks the flag, never the adapter's name.
  /** Needs `capabilities.interactiveSignIn`. */
  beginSignIn?(request: SignInStartRequest): Promise<SignInStart>;
  /** Needs `capabilities.interactiveSignIn`. */
  completeSignIn?(request: SignInCompleteRequest): Promise<SignInResult>;
  /** Ends the session a credential stands for. Needs `capabilities.interactiveSignIn`. Ending one that is already over succeeds. */
  signOut?(credential: PresentedCredential): Promise<void>;
  /** The company's members, a page at a time. Needs `capabilities.members`. */
  listMembers?(companyId: string, page?: { cursor?: string; limit?: number }): Promise<IdentityMemberPage>;
  /** The outside accounts a person is linked to in this company (the other way round from `resolveExternalAccount`). Needs `capabilities.externalAccounts`. */
  accountsOf?(companyId: string, personId: string): Promise<readonly ExternalAccountRef[]>;
}

// ---- Metering ----

export interface ModelUsage {
  provider: string;
  modelId: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface MeterEntry {
  companyId: string;
  /** Names this entry: recording one id twice counts it once (this is money). */
  entryId: string;
  at: string;
  usage: ModelUsage;
  taskId?: string;
  projectName?: string;
  /** The cost the provider reported, when it did. The adapter decides which to trust. */
  reportedCost?: Cost;
}

export interface MeterResult {
  /** The cost the adapter charged to this usage, or null when it cannot price it (an unknown model). */
  cost: Cost | null;
  source: "price-table" | "provider-reported" | "unknown";
}

export interface Metering {
  /** What this usage costs, without recording it (null when unknown). */
  price(usage: ModelUsage): Promise<Cost | null>;
  /** Records the usage and answers its cost. Recording the same `entryId` twice counts it once. */
  record(entry: MeterEntry): Promise<MeterResult>;
}

/** Price per million tokens, in millionths of the currency, for one model. */
export interface ModelPrice {
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  cacheReadMicrosPerMillionTokens?: number;
  cacheWriteMicrosPerMillionTokens?: number;
}
export interface PriceTable {
  currency: string;
  /** Keyed by `provider/modelId`. */
  models: Readonly<Record<string, ModelPrice>>;
}
