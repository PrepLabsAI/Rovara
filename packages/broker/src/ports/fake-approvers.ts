// Owner decision 211: a fake approvers plug-in that speaks every part of the Approvers port, for conformance suites and for a provider's own tests. It answers as a company plug-in would (its own method names,
// people found by a session token, a step-up with a one-time part), so the gaps Cloud's adapter listed (G1-G4) can be exercised in Code without Cloud:
//   G1  it states scoped sign-in rules (`signInRules`). Like every plug-in today it does not enforce them itself: that is the caller's (`checkApprovalSignInFor`).
//   G2  it may offer the sole-approver exception (`soleApproverAllowed`) and marks the verdict of a person configured as a sole approver, only when that person asked (`requestedBy`). Every verdict carries the
//       membership `fence` it read (`membershipVersion`).
//   G3  a one-time method needs `parts[FAKE_ONE_TIME_PART]` and a caller that settles claims (`settlesClaims`; any other is refused, `needs_settling_caller`). verify CLAIMS the part and answers a `claimId`;
//       `commitClaim` spends it, `releaseClaim` gives a live claim back, and a claim not settled within `claimSeconds` lapses to SPENT (as Cloud's claimed session keeps its used time): the clock never frees a part.
//   G4  a one-time secret may be bound to one decision card and version; the request must then name exactly that card (`ApprovalRequest.card`).
// Never register it in a production build: its people and secrets are whatever the test hands it.
import { randomUUID } from "node:crypto";
import {
  NEEDS_SETTLING_CALLER, approvalProofKey, isValidApprovalCardRef,
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
  /** How long a claim waits to be settled before it lapses to spent. Default 300. */
  claimSeconds?: number;
  /** The membership version every verdict is fenced on (`ApprovalVerdict.fence`). Default 1. */
  membershipVersion?: number;
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
    // A claim nobody settled in time lapses to spent: the part is never given back by the clock (a slow commit could otherwise share it with a second decision).
    if (state?.state === "claimed" && state.until <= now()) {
      parts.set(secret, { state: "spent" });
      claims.delete(state.claimId);
      return { state: "spent" };
    }
    return state;
  };

  /** Settles a live claim; true when it was live. An unknown, lapsed or settled claim changes nothing. */
  const settle = (claimId: string, to: "spent" | "free"): boolean => {
    const secret = claims.get(claimId);
    if (secret === undefined) return false;
    const state = stateOf(secret);
    claims.delete(claimId);
    if (state?.state !== "claimed" || state.claimId !== claimId) return false;
    if (to === "spent") parts.set(secret, { state: "spent" });
    else parts.delete(secret);
    return true;
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
        // A read-only check of a one-time secret would leave it replayable: only a caller that settles claims may use the method.
        if (request.settlesClaims !== true) return refuse(NEEDS_SETTLING_CALLER);
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
        claimId = randomUUID();
        parts.set(secret.secret, { state: "claimed", claimId, until: now() + claimMs });
        claims.set(claimId, secret.secret);
      }

      used.add(approvalProofKey(proof));
      const asked = request.requestedBy;
      const sole = options.soleApproverAllowed === true && person.soleApprover === true && asked !== undefined && asked.provider === person.principal.provider && asked.personId === person.principal.personId;
      return {
        approved: true, approver: person.principal, method: proof.method, proofId: proof.proofId, fence: { membershipVersion: options.membershipVersion ?? 1 },
        ...(sole ? { soleApprover: true as const } : {}), ...(claimId === undefined ? {} : { claimId }),
      };
    },

    async commitClaim(claimId: string): Promise<{ applied: boolean }> {
      return { applied: settle(claimId, "spent") };
    },

    async releaseClaim(claimId: string): Promise<void> {
      settle(claimId, "free");
    },
  };
}
