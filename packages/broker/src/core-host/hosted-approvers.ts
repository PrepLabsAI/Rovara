// Engine host (switch-on lane L2a): the `approvers` point on a deployed install. Who may answer a core task's decision, and how they prove it was them.
//
// The rule is the broker's existing one, with no weakening: a task's decision is the task owner's (the old routes' `decide` is the owner's alone, task-access.ts; the core's
// `hostedTaskAccess.canAct` is the task's own person). So a verdict needs ALL of:
//   - the person is a LIVE member of the request's company (the deployed identity point, which reads membership: never a token claim);
//   - the request's subject is a core task of that company, and the person is its own person (`developerId` on the task record read from the store, never the caller's word);
//   - a fresh STEP-UP (#662, merged via #695): the person proved it was them with a factor Code owns (an emailed code, a passkey, a company re-authentication) no longer ago than the
//     window (FRESH_SIGN_IN_SECONDS, ten minutes; the policy hook wrapper and the dev routes may only shorten it). A Slack, Google or GitHub round trip never counts.
// Anything else (another subject type, another person, a company admin, a code host comment, a chat press) is refused: the install offers one method, `rovara-step-up`.
//
// The proof. The broker's dev route checks the step-up on the VERIFIED access token (`DeployedCaller.stepUp`, `freshStepUp` in dev-routes.ts); the deployment's decision performer
// (lane L11) then asks `issueStepUpApproval` for a proof of that one act. The proof's token is signed with a key derived from the install's callback signing key (never stored or
// logged), and binds: the company, the person, the step-up's time and factor, the decision's request id, the task, the revision and digest the person saw, the answer
// (approve / reject / request changes) and the decision card and its version (owner decision 211, gap G4). It lives two minutes. `verify` checks every part against the request the
// gate built from STORED state, re-checks the step-up's age, and re-reads membership and the task's owner: the token is believed for nothing but its own signed words.
//
// One time (gap G3). Each proof carries a random one-time part (inside the signed token). `verify` serves only a caller that settles claims (`settlesClaims`, else
// `needs_settling_caller`) and CLAIMS the part in the company's own partition with a conditional write, so two containers can never both accept it. `commitClaim` spends it,
// `releaseClaim` gives a live claim back, and a claim not settled within a minute LAPSES TO SPENT (the row keeps its claimed state; the clock never frees it). Every refusal is
// decided before the claim, so a refused proof is never burnt.
//
// Refusals are fixed words (a reason code), never the token, the person or what was sent.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  APPROVAL_SIGN_IN_SKEW_SECONDS, FRESH_SIGN_IN_SECONDS, INDEX_EXPIRY_ATTRIBUTE, NEEDS_SETTLING_CALLER, OrgIdSchema, companyScoped, isValidApprovalCardRef, when,
  type ApprovalAnswer, type ApprovalCardRef, type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalVerdict, type Approvers, type DocumentKey, type DocumentStore,
  type IdentityProvider, type Principal,
} from "@agentx/contracts";
import { decisionRequestIdOf } from "../core/decisions/approval-gate.js";
import { STEP_UP_METHODS } from "../core/script-tokens/index.js";
import { taskKey } from "../core/task-flow/keys.js";

/** The one way to answer a decision on a deployed install: a fresh step-up, proved for one act. */
export const STEP_UP_APPROVAL_METHOD = "rovara-step-up";
/** How long an issued proof is good for: the act follows the step-up check at once. */
export const STEP_UP_PROOF_LIFETIME_MS = 120_000;
/** How long a claim waits for its caller to commit or release it before it lapses to spent. */
export const STEP_UP_CLAIM_MS = 60_000;
/** The record kind of a claimed or spent one-time part. */
export const STEP_UP_CLAIM_ENTITY = "APPROVAL_STEP_UP_CLAIM";

const TOKEN_PREFIX = "su1.";
const TOKEN_MAX = 4_096;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const CLAIM_ID = /^(org_[0-9a-z]{20})\.([a-f0-9]{64})\.([0-9a-f-]{36})$/u;
const ANSWERS: ReadonlySet<unknown> = new Set<ApprovalAnswer>(["approve", "reject", "request_changes"]);
const FACTORS: ReadonlySet<unknown> = new Set<unknown>(STEP_UP_METHODS);
/** Claim rows outlive the proof they hold by this much, then the store may sweep them (a swept row's proof has long expired). */
const CLAIM_ROW_KEEP_SECONDS = 86_400;

/** The proof key, derived from the install's callback signing key (the same derivation on every container of the broker). */
export function stepUpApprovalKeyOf(callbackSigningKey: string): Buffer {
  return createHmac("sha256", callbackSigningKey).update("rovara:approver-step-up-proofs:v1").digest();
}

/** What one proof binds. Short names keep the token small; the token is opaque to everyone but this file. */
interface ProofClaims {
  c: string; // company
  p: string; // person
  r: string; // the decision's request id
  s: string; // the task
  v: number; // revision
  d: string; // artifact digest
  o: ApprovalAnswer; // the answer
  k: [string, string]; // card id, content version
  a: string; // step-up time (ISO)
  m: string; // step-up factor
  e: number; // expires (ms)
  n: string; // the one-time part
}

const b64 = (value: Buffer | string): string => Buffer.from(value).toString("base64url");
const sign = (key: Buffer, body: string): Buffer => createHmac("sha256", key).update(`${TOKEN_PREFIX}${body}`).digest();

export interface StepUpApprovalInput {
  companyId: string;
  /** The person, as the broker's sign-in vouched for them (never a body). */
  personId: string;
  /** The step-up the route checked (`DeployedDecisionCaller.stepUp`). */
  stepUp: { at: string; method: string };
  /** The decision's request id (the one the decision gate is given). */
  requestId: string;
  /** The task the card is about. */
  taskId: string;
  revision: number;
  artifactDigest: string;
  outcome: ApprovalAnswer;
  card: ApprovalCardRef;
}

/**
 * A proof of one act, for the deployment's decision performer (lane L11), to present to the decision gate as `{ method: STEP_UP_APPROVAL_METHOD, token }`. Call it only after the route's
 * own step-up check; `verify` checks everything again. Throws (fixed words) on an input it cannot bind.
 */
export function issueStepUpApproval(key: Buffer, input: StepUpApprovalInput, nowMs: number): { method: typeof STEP_UP_APPROVAL_METHOD; token: string } {
  if (!OrgIdSchema.safeParse(input.companyId).success || typeof input.personId !== "string" || input.personId === "" || input.personId.length > 256
    || !REQUEST_ID.test(input.requestId) || !TASK_ID.test(input.taskId) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !DIGEST.test(input.artifactDigest)
    || !ANSWERS.has(input.outcome) || !isValidApprovalCardRef(input.card) || typeof input.stepUp?.at !== "string" || !ISO_INSTANT.test(input.stepUp.at) || !FACTORS.has(input.stepUp.method)) {
    throw new Error("a step-up approval cannot be issued for this input");
  }
  const claims: ProofClaims = {
    c: input.companyId, p: input.personId, r: input.requestId, s: input.taskId, v: input.revision, d: input.artifactDigest, o: input.outcome,
    k: [input.card.cardId, input.card.contentVersion], a: input.stepUp.at, m: input.stepUp.method, e: nowMs + STEP_UP_PROOF_LIFETIME_MS, n: b64(randomBytes(32)),
  };
  const body = b64(JSON.stringify(claims));
  return { method: STEP_UP_APPROVAL_METHOD, token: `${TOKEN_PREFIX}${body}.${b64(sign(key, body))}` };
}

/** The signed claims of a token, or undefined for anything this file did not sign or cannot read whole. */
function readProof(key: Buffer, token: unknown): ProofClaims | undefined {
  if (typeof token !== "string" || token.length > TOKEN_MAX || !token.startsWith(TOKEN_PREFIX)) return undefined;
  const parts = token.slice(TOKEN_PREFIX.length).split(".");
  if (parts.length !== 2) return undefined;
  const [body, mac] = parts as [string, string];
  const presented = Buffer.from(mac, "base64url");
  const expected = sign(key, body);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return undefined; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const c = value as Record<string, unknown>;
  const card = c["k"];
  if (typeof c["c"] !== "string" || typeof c["p"] !== "string" || typeof c["r"] !== "string" || typeof c["s"] !== "string" || !Number.isSafeInteger(c["v"]) || typeof c["d"] !== "string"
    || !ANSWERS.has(c["o"]) || !Array.isArray(card) || card.length !== 2 || typeof card[0] !== "string" || typeof card[1] !== "string" || typeof c["a"] !== "string"
    || typeof c["m"] !== "string" || !Number.isSafeInteger(c["e"]) || typeof c["n"] !== "string" || !NONCE.test(c["n"])) return undefined;
  return c as unknown as ProofClaims;
}

/** Where a one-time part's claim lives: the company's own partition, one row per part (by its hash; the part itself is never stored). */
export function stepUpClaimKey(companyId: string, partHash: string): DocumentKey {
  return { pk: companyScoped(companyId, STEP_UP_CLAIM_ENTITY), sk: partHash };
}

export interface HostedApproversOptions {
  /** The registry's store: the task records and the claim rows. */
  store: Pick<DocumentStore, "get" | "put" | "update" | "delete">;
  /** The deployed identity point (membership): names a live member of a company, or nobody. */
  identity: Pick<IdentityProvider, "getPrincipal">;
  /** The proof key (`stepUpApprovalKeyOf`). Absent (a host that decides nothing for a person, the dispatcher): every proof is refused. */
  key?: Buffer | undefined;
  /** The step-up window in seconds. Default FRESH_SIGN_IN_SECONDS. Only ever shortened by the policy hook in front of this adapter. */
  windowSeconds?: number;
  now: () => Date;
}

/** The deployed `approvers` point (see the file comment). */
export function createHostedApprovers(options: HostedApproversOptions): Approvers {
  const { store, identity, key } = options;
  const windowSeconds = options.windowSeconds ?? FRESH_SIGN_IN_SECONDS;
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > FRESH_SIGN_IN_SECONDS) throw new Error("the step-up window must be a whole number of seconds from 60 to the default");
  const nowMs = (): number => options.now().getTime();
  const method = [STEP_UP_APPROVAL_METHOD];

  /** A live claim, matched by its id, as the condition every settle writes under. */
  const liveClaim = (claimId: string, at: number) => when.and(when.eq("state", "claimed"), when.eq("claimId", claimId), when.gt("until", at));
  const claimOf = (claimId: unknown): { key: DocumentKey; claimId: string } | undefined => {
    if (typeof claimId !== "string") return undefined;
    const match = CLAIM_ID.exec(claimId);
    return match === null ? undefined : { key: stepUpClaimKey(match[1]!, match[2]!), claimId };
  };

  return {
    async requirement(): Promise<ApprovalRequirement> {
      // One method for every answer: a fresh step-up. The sign-in rule says the same to the decision gate (it checks `authTime`, the step-up's time).
      return {
        methods: [...method], minApprovers: 1, selfApprovalAllowed: true,
        strongMethods: [...method], rejectMethods: [...method], changesMethods: [...method],
        signIn: { mode: "window", seconds: windowSeconds },
      };
    },

    async verify(request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict> {
      const refuse = (reason: string): ApprovalVerdict => ({ approved: false, reason });
      if (proof?.method !== STEP_UP_APPROVAL_METHOD) return refuse("unknown_method");
      if (key === undefined) return refuse("method_not_available");
      // A read-only check of a one-time part would leave it replayable: only a caller that settles claims may use this method.
      if (request?.settlesClaims !== true) return refuse(NEEDS_SETTLING_CALLER);
      const companyId = request.companyId;
      const subject = request.subject;
      if (typeof companyId !== "string" || !OrgIdSchema.safeParse(companyId).success || subject?.type !== "task" || typeof subject.id !== "string" || !TASK_ID.test(subject.id)) return refuse("no_rule_for_this_request");
      if (proof.requestId !== request.requestId || typeof request.requestId !== "string") return refuse("other_request");
      if (proof.revision !== request.revision) return refuse("other_revision");
      if (proof.artifactDigest !== request.artifactDigest) return refuse("other_content");
      const claims = readProof(key, proof.token);
      if (claims === undefined) return refuse("not_a_valid_proof");
      if (claims.c !== companyId) return refuse("wrong_company");
      if (claims.r !== decisionRequestIdOf(request.requestId)) return refuse("other_request");
      if (claims.s !== subject.id) return refuse("other_subject");
      if (claims.v !== request.revision) return refuse("other_revision");
      if (claims.d !== request.artifactDigest) return refuse("other_content");
      if (claims.o !== (request.outcome ?? "approve")) return refuse("other_answer");
      // Gap G4: the card the gate names must be the one the proof was issued for, it must be this task's card, and its version must be the content the person saw.
      const card = request.card;
      if (!isValidApprovalCardRef(card)) return refuse("card_not_named");
      if (card.cardId !== claims.k[0] || card.contentVersion !== claims.k[1]) return refuse("other_card");
      const separator = card.cardId.indexOf(":");
      if (separator < 1 || card.cardId.slice(separator + 1) !== subject.id || card.contentVersion !== request.artifactDigest) return refuse("card_not_for_this_request");
      const at = nowMs();
      if (!(at < claims.e) || claims.e - at > STEP_UP_PROOF_LIFETIME_MS) return refuse("proof_expired");
      if (request.expiresAt !== undefined && !(at < Date.parse(request.expiresAt))) return refuse("expired");
      // The step-up itself: a factor Code owns, no older than the window, and not from the future beyond the clock-skew allowance.
      const stepUpAt = ISO_INSTANT.test(claims.a) ? Date.parse(claims.a) : Number.NaN;
      if (!FACTORS.has(claims.m) || !Number.isFinite(stepUpAt) || at - stepUpAt > windowSeconds * 1000 || stepUpAt - at > Math.min(APPROVAL_SIGN_IN_SKEW_SECONDS, windowSeconds) * 1000) return refuse("sign_in_not_fresh");

      // Who: a live member of the company, and the task's own person (both read now, never from the token alone).
      let person: Principal | undefined;
      let task: Record<string, unknown> | undefined;
      try {
        person = await identity.getPrincipal(companyId, claims.p);
        task = person === undefined ? undefined : await store.get(taskKey(subject.id));
      } catch {
        return refuse("people_unreadable");
      }
      if (person === undefined || person.companyId !== companyId || person.personId !== claims.p) return refuse("not_a_member");
      if (task === undefined || task["companyId"] !== companyId || task["taskId"] !== subject.id || typeof task["developerId"] !== "string" || task["developerId"] !== claims.p) return refuse("not_the_task_owner");
      if (request.projectName !== undefined && task["project"] !== request.projectName) return refuse("not_the_task_owner");

      // The one-time part, claimed last: nothing above burns it.
      const partHash = createHash("sha256").update(claims.n).digest("hex");
      const claimKey = stepUpClaimKey(companyId, partHash);
      const claimId = `${companyId}.${partHash}.${randomUUID()}`;
      let claimed: boolean;
      try {
        const written = await store.put({
          item: { ...claimKey, entityType: STEP_UP_CLAIM_ENTITY, companyId, state: "claimed", claimId, until: at + STEP_UP_CLAIM_MS, [INDEX_EXPIRY_ATTRIBUTE]: Math.ceil(claims.e / 1000) + CLAIM_ROW_KEEP_SECONDS },
          condition: when.absent(),
        });
        claimed = written.applied;
      } catch {
        // A write that may have applied is left to lapse to spent: never accepted, never freed.
        return refuse("claim_unavailable");
      }
      if (!claimed) return refuse("proof_already_used");
      return {
        approved: true,
        approver: { ...person, authTime: new Date(stepUpAt).toISOString(), methods: [claims.m] },
        method: STEP_UP_APPROVAL_METHOD, proofId: proof.proofId, claimId,
      };
    },

    async commitClaim(claimId: string): Promise<{ applied: boolean }> {
      const claim = claimOf(claimId);
      if (claim === undefined) return { applied: false };
      const at = nowMs();
      const written = await store.update({ key: claim.key, ops: [{ op: "set", path: ["state"], value: "spent" }, { op: "set", path: ["spentAt"], value: at }], condition: liveClaim(claim.claimId, at) });
      return { applied: written.applied };
    },

    async releaseClaim(claimId: string): Promise<void> {
      const claim = claimOf(claimId);
      if (claim === undefined) return;
      // Only a LIVE claim is given back; a lapsed one stays spent.
      await store.delete({ key: claim.key, condition: liveClaim(claim.claimId, nowMs()) });
    },
  };
}
