// Owner decision 211: a fake approvers plug-in that speaks every part of the Approvers port, for conformance suites and for a provider's own tests. It answers as a company plug-in would (its own method names,
// people found by a session token, a step-up with a one-time part), so the gaps Cloud's adapter listed (G1-G4) can be exercised in Code without Cloud:
//   G1  it states scoped sign-in rules (`signInRules`). Like every plug-in today it does not enforce them itself: that is the caller's (`checkApprovalSignInFor`).
//   G2  it may offer the sole-approver exception (`soleApproverAllowed`) and marks the verdict of a person configured as a sole approver.
//   G3  a one-time method needs `parts[FAKE_ONE_TIME_PART]`. For a caller that settles claims (`settlesClaims`) verify CLAIMS the part and answers a `claimId`; `commitClaim` spends it, `releaseClaim` gives it back, and an
//       unsettled claim lapses after `claimSeconds`. For any other caller verify only checks that the part is neither claimed nor spent (read-only, as before).
//   G4  a one-time secret may be bound to one decision card and version; the request must then name exactly that card (`ApprovalRequest.card`).
// Never register it in a production build: its people and secrets are whatever the test hands it.
import { randomUUID } from "node:crypto";
import {
  approvalProofKey, isValidApprovalCardRef,
  type ApprovalCardRef, type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalSignInScope, type ApprovalVerdict, type Approvers, type Principal,
} from "@agentx/contracts";

export const FAKE_SESSION_METHOD = "fake-session";
/** The name of the one-time part of a step-up proof (`ApprovalProof.parts`). */
export const FAKE_ONE_TIME_PART = "once";

export interface FakeApproverPerson {
  /** The session token that stands for this person. */
  token: string;
  principal: Principal;
  /** This person may decide alone (the company's only eligible approver). Marked on the verdict only when `soleApproverAllowed`. */
  soleApprover?: boolean;
}

export interface FakeOneTimeSecret {
  /** The method that needs it. */
  method: string;
  /** The session token it goes with. */
  token: string;
  /** The one-time secret, presented as `parts[FAKE_ONE_TIME_PART]`. */
  secret: string;
  /** The card and version it was issued for. Absent: not bound to a card. */
  card?: ApprovalCardRef;
}

export interface FakeApproversOptions {
  people: readonly FakeApproverPerson[];
  /** Default: the fake session method and every one-time method. */
  methods?: readonly string[];
  strongMethods?: readonly string[];
  rejectMethods?: readonly string[];
  changesMethods?: readonly string[];
  minApprovers?: number;
  selfApprovalAllowed?: boolean;
  signInRules?: readonly ApprovalSignInScope[];
  soleApproverAllowed?: boolean;
  oneTime?: readonly FakeOneTimeSecret[];
  /** How long an unsettled claim holds a one-time part. Default 300. */
  claimSeconds?: number;
  now?: () => number;
}

type PartState = { state: "claimed"; claimId: string; until: number } | { state: "spent" };

export function createFakeApprovers(options: FakeApproversOptions): Approvers {
  const now = options.now ?? (() => Date.now());
  const claimMs = (options.claimSeconds ?? 300) * 1000;
  const oneTime = options.oneTime ?? [];
  const methods = options.methods ?? [FAKE_SESSION_METHOD, ...new Set(oneTime.map((entry) => entry.method))];
  const used = new Set<string>();
  /** The state of each one-time secret, by secret. Absent: free. */
  const parts = new Map<string, PartState>();
  /** Which secret each live claim holds. */
  const claims = new Map<string, string>();

  const stateOf = (secret: string): PartState | undefined => {
    const state = parts.get(secret);
    if (state?.state === "claimed" && state.until <= now()) {
      parts.delete(secret);
      claims.delete(state.claimId);
      return undefined;
    }
    return state;
  };

  const settle = (claimId: string, to: "spent" | "free"): void => {
    const secret = claims.get(claimId);
    if (secret === undefined) return;
    claims.delete(claimId);
    const state = stateOf(secret);
    if (state?.state !== "claimed" || state.claimId !== claimId) return;
    if (to === "spent") parts.set(secret, { state: "spent" });
    else parts.delete(secret);
  };

  return {
    async requirement(): Promise<ApprovalRequirement> {
      return {
        methods: [...methods],
        minApprovers: options.minApprovers ?? 1,
        selfApprovalAllowed: options.selfApprovalAllowed ?? true,
        ...(options.strongMethods === undefined ? {} : { strongMethods: [...options.strongMethods] }),
        ...(options.rejectMethods === undefined ? {} : { rejectMethods: [...options.rejectMethods] }),
        ...(options.changesMethods === undefined ? {} : { changesMethods: [...options.changesMethods] }),
        ...(options.signInRules === undefined ? {} : { signInRules: options.signInRules.map((scope) => ({ ...scope })) }),
        ...(options.soleApproverAllowed === undefined ? {} : { soleApproverAllowed: options.soleApproverAllowed }),
      };
    },

    async verify(request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict> {
      const refuse = (reason: string): ApprovalVerdict => ({ approved: false, reason });
      if (proof.requestId !== request.requestId) return refuse("other_request");
      if (proof.revision !== request.revision) return refuse("other_revision");
      if (proof.artifactDigest !== request.artifactDigest) return refuse("other_content");
      if (request.expiresAt !== undefined && !(now() < Date.parse(request.expiresAt))) return refuse("expired");
      if (!methods.includes(proof.method)) return refuse("unknown_method");
      if (used.has(approvalProofKey(proof))) return refuse("proof_already_used");
      const person = options.people.find((entry) => entry.token === proof.token && proof.token !== "");
      if (person === undefined) return refuse("not_a_known_session");
      if (person.principal.companyId !== request.companyId) return refuse("wrong_company");

      let claimId: string | undefined;
      const secrets = oneTime.filter((entry) => entry.method === proof.method);
      if (secrets.length > 0) {
        const presented = proof.parts?.[FAKE_ONE_TIME_PART];
        const secret = secrets.find((entry) => entry.token === proof.token && presented !== undefined && entry.secret === presented);
        if (secret === undefined) return refuse("one_time_part_missing");
        if (secret.card !== undefined) {
          if (!isValidApprovalCardRef(request.card)) return refuse("card_not_named");
          if (request.card.cardId !== secret.card.cardId || request.card.contentVersion !== secret.card.contentVersion) return refuse("other_card");
        }
        const state = stateOf(secret.secret);
        if (state?.state === "spent") return refuse("one_time_part_spent");
        if (state?.state === "claimed") return refuse("one_time_part_claimed");
        if (request.settlesClaims === true) {
          claimId = randomUUID();
          parts.set(secret.secret, { state: "claimed", claimId, until: now() + claimMs });
          claims.set(claimId, secret.secret);
        }
      }

      used.add(approvalProofKey(proof));
      const sole = options.soleApproverAllowed === true && person.soleApprover === true;
      return { approved: true, approver: person.principal, method: proof.method, proofId: proof.proofId, ...(sole ? { soleApprover: true as const } : {}), ...(claimId === undefined ? {} : { claimId }) };
    },

    async commitClaim(claimId: string): Promise<void> {
      settle(claimId, "spent");
    },

    async releaseClaim(claimId: string): Promise<void> {
      settle(claimId, "free");
    },
  };
}
