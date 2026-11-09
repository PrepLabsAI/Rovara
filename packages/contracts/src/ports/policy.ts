// Port lane W0: the policy seams. Each does nothing, or allows everything, in Code, and is where Cloud plugs in its own rule
// (budgets, a second approver, members and single sign-on, money). The audit sink is in audit-sink.ts, the model key store in
// model-keys.ts.
//
// Decision 51: nothing here names a sign-in provider, a chat tool or a code host. A person's outside accounts are
// `ExternalAccountRef`s (a provider id and an opaque account id); a provider is an adapter.
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
      /** Set when the decision holds some allowance back (a budget reservation). Pass it to `settle` or `release`. */
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
  admit(request: AdmissionRequest): Promise<AdmissionDecision>;
  /** Replaces a reservation by what was actually used. A reservation settles or releases once; again is a no-op. */
  settle(reservationId: string, actual: { tokens?: number; cost?: Cost }): Promise<void>;
  /** Gives a reservation back unused. */
  release(reservationId: string): Promise<void>;
}

// ---- Approvers ----

export interface ApprovalRequest {
  companyId: string;
  /** What is being approved: `plan`, `design`, `merge`, `setting`, or a name a later lane adds. */
  kind: string;
  subject: PolicySubject;
  /** The exact revision and content the person saw, so an approval applies to that and nothing newer. */
  revision?: number;
  artifactDigest?: string;
  requestedBy?: Principal;
  risk?: "low" | "medium" | "high";
}

/** What the approver adapter says is needed, so a surface can offer the right way to answer. */
export interface ApprovalRequirement {
  /** Ways a person may prove who they are, in the adapter's words: `local-session`, `code-host-comment`, `browser-step-up`. */
  methods: readonly string[];
  minApprovers: number;
  /** Whether the person who asked may also approve. */
  selfApprovalAllowed: boolean;
}

/** What a person (or the surface speaking for them) presents with an approval. The `method` says how to read `evidence`. */
export interface ApprovalProof {
  method: string;
  /** The account that answered, as the surface saw it. */
  account?: ExternalAccountRef;
  /** The principal, when the surface already signed the person in. */
  principal?: Principal;
  /** Method-specific facts (a comment id, a session id). Never a secret in clear. */
  evidence: Record<string, string>;
}

export type ApprovalVerdict = { approved: true; approver: Principal; method: string } | { approved: false; reason: string };

export interface Approvers {
  requirement(request: ApprovalRequest): Promise<ApprovalRequirement>;
  /**
   * Whether this proof is an acceptable approval of this request, from a person allowed to give it. Called once per proof;
   * with `minApprovers` above 1 the caller collects verdicts and counts distinct approvers.
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
  /** The adapter signs people in itself (a login page, single sign-on). */
  interactiveSignIn: boolean;
  /** The adapter can map an outside account to a person. */
  externalAccounts: boolean;
}

export interface IdentityProvider {
  readonly capabilities: IdentityCapabilities;
  authenticate(credential: PresentedCredential): Promise<AuthResult>;
  /** The person an outside account is linked to, or undefined when it is not linked (the surface then asks the person to link it). */
  resolveExternalAccount(account: ExternalAccountRef): Promise<Principal | undefined>;
  /** A person by Rovara id, or undefined. */
  getPrincipal(personId: string): Promise<Principal | undefined>;
}

// ---- Metering ----

export interface ModelUsage {
  provider: string;
  modelId: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface MeterEntry {
  companyId: string;
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
  /** Records the usage and answers its cost. Recording the same entry twice is the caller's concern, not the adapter's. */
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
