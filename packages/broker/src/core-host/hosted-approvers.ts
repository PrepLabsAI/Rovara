// Engine host (switch-on lane L2a): the `approvers` point on a deployed install. Who may answer a core task's decision, and how they prove it was them.
//
// The rule is the broker's existing one, with no weakening: a task's decision is the task owner's (the old routes' `decide` is the owner's alone, task-access.ts; the core's
// `hostedTaskAccess.canAct` is the task's own person). So a verdict needs ALL of:
//   - the person is a LIVE member of the request's company (the deployed identity point, which reads membership: never a token claim);
//   - the request's subject is a core task of that company, and the person is its own person (`developerId` on the task record read from the store, never the caller's word);
//   - a proof of this one act, issued by the broker's own route for the signed-in person (below).
// DEC 254zzz73: there is no step-up ("confirm it's you"). The proof carries no step-up time or factor and no freshness window is checked: the person's ordinary sign-in, their live membership
// and the subject's own role rule decide. The method's wire name stays `rovara-step-up` only so stored pending requests and claim rows keep reading.
// Anything else (another subject type, another person, a company admin, a code host comment, a chat press) is refused: the install offers one method, `rovara-step-up` (HW5b: and, where the deployment serves a chat, the chat's press at low or medium risk, `hosted-chat-approval.ts`).
//
// L4-D (DEC 254z b): a project's SETUP CANDIDATE (`setup_proposal`, its id the project's name) is one other subject. Its proof is issued for that subject only (`issueSetupApprovalProof`,
// marked so a task proof can never stand for it and the other way round) and needs the same card binding and one-time part; the person must be a live member of the company.
// Who may decide at the candidate's risk (a project maintainer, or a company admin for high risk) is the setup subject's own rule, read live in the decision (apply.ts, the host's `approval`).
//
// L4-B3b (DEC 254zm item 4): a project's TEST ENVIRONMENT (`test-environment`, its id the project's name) is the third subject, with the same shape and its own marker: its proof is issued by
// `issueTestEnvironmentApprovalProof`, names the project, the proposal's digest, the revision its approval makes, the request id, the answer and the card `test-environment:<project>` at that
// digest, and needs the same one-time part. The marker is signed into the token, so a task, setup or test environment proof each stand for their own subject only. Who may
// decide at the proposal's risk is the test environment subject's own rule, read live in the decision (core/test-env/environment.ts, the host's `approval`).
//
// The proof. The broker's dev route authenticates the signed-in person on the VERIFIED access token; the deployment's decision performer
// (lane L11) then asks `issueApprovalProof` for a proof of that one act. The proof's token is signed with a key derived from the install's callback signing key (never stored or
// logged), and binds: the company, the person, the decision's request id and kind, the task, the revision and digest the person saw, the answer
// (approve / reject / request changes) and the decision card and its version (owner decision 211, gap G4). It lives two minutes. `verify` checks every part against the request the
// gate built from STORED state, and re-reads membership and the task's owner: the token is believed for nothing but its own signed words.
//
// One time (gap G3). Each proof carries a random one-time part (inside the signed token). `verify` serves only a caller that settles claims (`settlesClaims`, else
// `needs_settling_caller`) and CLAIMS the part in the company's own partition with a conditional write, so two containers can never both accept it. `commitClaim` spends it,
// `releaseClaim` gives a live claim back, and a claim not settled within a minute LAPSES TO SPENT (the row keeps its claimed state; the clock never frees it). Every refusal is
// decided before the claim, so a refused proof is never burnt.
//
// Refusals are fixed words (a reason code), never the token, the person or what was sent.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  INDEX_EXPIRY_ATTRIBUTE, NEEDS_SETTLING_CALLER, OrgIdSchema, companyScoped, isValidApprovalCardRef, when,
  type ApprovalAnswer, type ApprovalCardRef, type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalVerdict, type Approvers, type DocumentKey, type DocumentStore,
  type IdentityProvider, type OrgId, type Principal,
} from "@agentx/contracts";
import { decisionRequestIdOf } from "../core/decisions/approval-gate.js";
import { chatApprovalMethod, chatMethodsOf, verifyChatPress, type HostedChatApproval } from "./hosted-chat-approval.js"; export { chatApprovalMethod, type HostedChatApproval } from "./hosted-chat-approval.js";
import { taskKey } from "../core/task-flow/keys.js";

/** L4-D: the subject type of a project's setup candidate (apply.ts `createSetupProposalSubject`). */
export const SETUP_PROPOSAL_SUBJECT = "setup_proposal";
/** L4-B3b: the subject type of a project's test environment proposal (core/test-env/environment.ts `createTestEnvironmentSubject`). */
export const TEST_ENVIRONMENT_SUBJECT = "test-environment";
/** L4-SF (d): the subject type of a setup run's website ask (host-ask.ts `createSetupHostSubject`); its id is the ask's subject id (a hash of the company, project and host). */
export const SETUP_HOST_SUBJECT = "setup_host";
/** L4-EVC (DEC 254zzz20 D8): the subject type of a project's eval spend item (eval-spend.ts `createEvalSpendSubject`); named by its project, like a setup candidate. */
export const EVAL_SPEND_SUBJECT = "eval_spend";
/** The subject types a proof can be marked for besides a task (which has no marker). */
type ProofSubject = typeof SETUP_PROPOSAL_SUBJECT | typeof TEST_ENVIRONMENT_SUBJECT | typeof SETUP_HOST_SUBJECT | typeof EVAL_SPEND_SUBJECT;
/** The one way to answer a decision on a deployed install: the broker's proof of one act by the signed-in person (the wire name is historical, DEC 254zzz73). */
export const APPROVAL_PROOF_METHOD = "rovara-step-up";
/** How long an issued proof is good for: the act follows the route's check at once. */
export const APPROVAL_PROOF_LIFETIME_MS = 120_000;
/** How long a claim waits for its caller to commit or release it before it lapses to spent. */
export const APPROVAL_PROOF_CLAIM_MS = 60_000;
/** The record kind of a claimed or spent one-time part. */
export const APPROVAL_PROOF_CLAIM_ENTITY = "APPROVAL_STEP_UP_CLAIM";

const TOKEN_PREFIX = "su1.";
const TOKEN_MAX = 4_096;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const KIND = /^[A-Za-z0-9_.-]{1,64}$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const HOST_SUBJECT_ID = /^[a-f0-9]{32}$/u;
const CLAIM_ID = /^(org_[0-9a-z]{20})\.([a-f0-9]{64})\.([0-9a-f-]{36})$/u;
const ANSWERS: ReadonlySet<unknown> = new Set<ApprovalAnswer>(["approve", "reject", "request_changes"]);
/** Claim rows outlive the proof they hold by this much, then the store may sweep them (a swept row's proof has long expired). */
const CLAIM_ROW_KEEP_SECONDS = 86_400;

/** The proof key, derived from the install's callback signing key (the same derivation on every container of the broker). */
export function approvalProofKeyOf(callbackSigningKey: string): Buffer {
  return createHmac("sha256", callbackSigningKey).update("rovara:approver-step-up-proofs:v1").digest();
}

/** What one proof binds. Short names keep the token small; the token is opaque to everyone but this file. */
interface ProofClaims {
  c: string; // company
  p: string; // person
  r: string; // the decision's request id
  q: string; // the decision's kind (`ApprovalRequest.kind`)
  s: string; // the task
  v: number; // revision
  d: string; // artifact digest
  o: ApprovalAnswer; // the answer
  k: [string, string]; // card id, content version
  e: number; // expires (ms)
  n: string; // the one-time part
  t?: ProofSubject; // the subject type when it is not a task (L4-D setup, L4-B3b test environment, L4-SF website ask)
}

const b64 = (value: Buffer | string): string => Buffer.from(value).toString("base64url");
const sign = (key: Buffer, body: string): Buffer => createHmac("sha256", key).update(`${TOKEN_PREFIX}${body}`).digest();

export interface ApprovalProofInput {
  companyId: string;
  /** The person, as the broker's sign-in vouched for them (never a body). */
  personId: string;
  /** The decision's request id (the one the decision gate is given). */
  requestId: string;
  /**
   * What is being decided: the `ApprovalRequest.kind` the decision gate will ask about (the subject's `request.kind`, e.g. the plan's current document type; the gate's record keeps it as
   * `approvalKind`), NOT the gate's subject kind (`DecisionAttempt.kind`). A mismatch is refused (`other_kind`).
   */
  kind: string;
  /** The task the card is about. */
  taskId: string;
  revision: number;
  artifactDigest: string;
  outcome: ApprovalAnswer;
  card: ApprovalCardRef;
}

/**
 * A proof of one act, for the deployment's decision performer (lane L11), to present to the decision gate as `{ method: APPROVAL_PROOF_METHOD, token }`. Call it only after the route's
 * own checks; `verify` checks everything again. Throws (fixed words) on an input it cannot bind.
 */
export function issueApprovalProof(key: Buffer, input: ApprovalProofInput, nowMs: number): { method: typeof APPROVAL_PROOF_METHOD; token: string } {
  checkProofInput(input);
  return signProof(key, claimsOf(input, nowMs));
}

/** A well-formed task id, for checking the rest of a setup proof's input with the task proof's own check. */
const TASK_ID_FOR_CHECK = "00000000-0000-0000-0000-000000000000";

function checkProofInput(input: ApprovalProofInput): void {
  if (!OrgIdSchema.safeParse(input.companyId).success || typeof input.personId !== "string" || input.personId === "" || input.personId.length > 256
    || !REQUEST_ID.test(input.requestId) || typeof input.kind !== "string" || !KIND.test(input.kind) || !TASK_ID.test(input.taskId) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !DIGEST.test(input.artifactDigest)
    || !ANSWERS.has(input.outcome) || !isValidApprovalCardRef(input.card)) {
    throw new Error("an approval proof cannot be issued for this input");
  }
}

function claimsOf(input: ApprovalProofInput, nowMs: number): ProofClaims {
  return {
    c: input.companyId, p: input.personId, r: input.requestId, q: input.kind, s: input.taskId, v: input.revision, d: input.artifactDigest, o: input.outcome,
    k: [input.card.cardId, input.card.contentVersion], e: nowMs + APPROVAL_PROOF_LIFETIME_MS, n: b64(randomBytes(32)),
  };
}

function signProof(key: Buffer, claims: ProofClaims): { method: typeof APPROVAL_PROOF_METHOD; token: string } {
  const body = b64(JSON.stringify(claims));
  return { method: APPROVAL_PROOF_METHOD, token: `${TOKEN_PREFIX}${body}.${b64(sign(key, body))}` };
}

/** What one act on a project's setup candidate binds (L4-D): as `ApprovalProofInput`, with the project in place of the task. */
export type SetupApprovalProofInput = Omit<ApprovalProofInput, "taskId"> & { project: string };

/** A proof of one act on a project's setup candidate (L4-D), for the hosted setup route. Same rules as `issueApprovalProof`; the token names its subject type, so it never stands for a task. */
export function issueSetupApprovalProof(key: Buffer, input: SetupApprovalProofInput, nowMs: number): { method: typeof APPROVAL_PROOF_METHOD; token: string } {
  return issueProjectSubjectApproval(key, input, nowMs, SETUP_PROPOSAL_SUBJECT);
}

/** What one act on a project's test environment binds (L4-B3b): as a setup act, with the proposal's digest and the revision its approval makes. */
export type TestEnvironmentApprovalProofInput = SetupApprovalProofInput;

/** A proof of one act on a project's test environment (L4-B3b), for the hosted approve route. Same rules as the setup proof; the token's marker is its own, so it never stands for a task or a setup. */
export function issueTestEnvironmentApprovalProof(key: Buffer, input: TestEnvironmentApprovalProofInput, nowMs: number): { method: typeof APPROVAL_PROOF_METHOD; token: string } {
  return issueProjectSubjectApproval(key, input, nowMs, TEST_ENVIRONMENT_SUBJECT);
}

function issueProjectSubjectApproval(key: Buffer, input: SetupApprovalProofInput, nowMs: number, subject: ProofSubject): { method: typeof APPROVAL_PROOF_METHOD; token: string } {
  if (typeof input?.project !== "string" || !PROJECT_NAME.test(input.project)) throw new Error("an approval proof cannot be issued for this input");
  // The task id check is for a task proof; the rest of the input is checked as for one.
  const { project, ...rest } = input;
  checkProofInput({ ...rest, taskId: TASK_ID_FOR_CHECK });
  return signProof(key, { ...claimsOf({ ...rest, taskId: project }, nowMs), t: subject });
}

/** What one act on a setup run's website ask binds (L4-SF d): as `ApprovalProofInput`, with the ask's subject id in place of the task. The ask's digest (the host and when it was asked) is `artifactDigest`. */
export type SetupHostApprovalProofInput = Omit<ApprovalProofInput, "taskId"> & { subjectId: string };

/** A proof of one act on a website ask (L4-SF d), for the hosted setup route. Same rules as `issueSetupApprovalProof`; the token names its subject type, so it never stands for a task or a setup candidate. */
export function issueSetupHostApprovalProof(key: Buffer, input: SetupHostApprovalProofInput, nowMs: number): { method: typeof APPROVAL_PROOF_METHOD; token: string } {
  if (typeof input?.subjectId !== "string" || !HOST_SUBJECT_ID.test(input.subjectId)) throw new Error("an approval proof cannot be issued for this input");
  const { subjectId, ...rest } = input;
  checkProofInput({ ...rest, taskId: TASK_ID_FOR_CHECK });
  return signProof(key, { ...claimsOf({ ...rest, taskId: subjectId }, nowMs), t: SETUP_HOST_SUBJECT });
}

/** A proof of one act on a project's eval spend item (L4-EVC): as `issueSetupApprovalProof`, marked for the eval spend subject so neither a task's nor a setup candidate's proof can stand for it, nor the other way round. */
export function issueEvalSpendApprovalProof(key: Buffer, input: SetupApprovalProofInput, nowMs: number): { method: typeof APPROVAL_PROOF_METHOD; token: string } {
  if (typeof input?.project !== "string" || !PROJECT_NAME.test(input.project)) throw new Error("an approval proof cannot be issued for this input");
  const { project, ...rest } = input;
  checkProofInput({ ...rest, taskId: TASK_ID_FOR_CHECK });
  return signProof(key, { ...claimsOf({ ...rest, taskId: project }, nowMs), t: EVAL_SPEND_SUBJECT });
}

/** The signed claims of a token, or undefined for anything this file did not sign or cannot read whole. */
function readProof(key: Buffer, token: unknown): ProofClaims | undefined {
  if (typeof token !== "string" || token.length > TOKEN_MAX || !token.startsWith(TOKEN_PREFIX)) return undefined;
  const parts = token.slice(TOKEN_PREFIX.length).split(".");
  if (parts.length !== 2) return undefined;
  const [body, mac] = parts as [string, string];
  const presented = Buffer.from(mac, "base64url");
  // Canonical base64url only: a variant spelling of the same signature is a different string to the gate's markers, so it is refused. (The body needs no such check: the signature is over
  // the body's exact text.)
  if (b64(presented) !== mac) return undefined;
  const expected = sign(key, body);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return undefined; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const c = value as Record<string, unknown>;
  const card = c["k"];
  if (typeof c["c"] !== "string" || typeof c["p"] !== "string" || typeof c["r"] !== "string" || typeof c["q"] !== "string" || typeof c["s"] !== "string" || !Number.isSafeInteger(c["v"]) || typeof c["d"] !== "string"
    || !ANSWERS.has(c["o"]) || !Array.isArray(card) || card.length !== 2 || typeof card[0] !== "string" || typeof card[1] !== "string"
    || !Number.isSafeInteger(c["e"]) || typeof c["n"] !== "string" || !NONCE.test(c["n"])
    || (Object.hasOwn(c, "t") && c["t"] !== SETUP_PROPOSAL_SUBJECT && c["t"] !== TEST_ENVIRONMENT_SUBJECT && c["t"] !== SETUP_HOST_SUBJECT && c["t"] !== EVAL_SPEND_SUBJECT)) return undefined;
  return c as unknown as ProofClaims;
}

/** Where a one-time part's claim lives: the company's own partition, one row per part (by its hash; the part itself is never stored). */
export function approvalProofClaimKey(companyId: string, partHash: string): DocumentKey {
  return { pk: companyScoped(companyId, APPROVAL_PROOF_CLAIM_ENTITY), sk: partHash };
}

export interface HostedApproversOptions {
  /** The registry's store: the task records and the claim rows. */
  store: Pick<DocumentStore, "get" | "put" | "update" | "delete">;
  /** The deployed identity point (membership): names a live member of a company, or nobody. */
  identity: Pick<IdentityProvider, "getPrincipal">;
  /**
   * Who may decide as the task's owner besides what the stored record says (web task channel C6, D5): the deployment's live owner rule (the task's own person, or a People co-owner who is a live member
   * with the project grant and present under the live proof). Given: it decides, for every person (the record's `developerId` alone is then not enough); a throw refuses. Absent: only the task's own person.
   */
  taskOwner?: ((input: { companyId: OrgId; principal: Principal; task: { taskId: string; developerId: string; project: string } }) => Promise<boolean>) | undefined;
  /** The proof key (`approvalProofKeyOf`). Absent (a host that decides nothing for a person, the dispatcher): every proof is refused. */
  key?: Buffer | undefined;
  now: () => Date; /** HW5b (hosted-chat-approval.ts): the chat a press may approve a low or medium risk plan in. Absent: the install offers the proof method alone. */ chat?: HostedChatApproval | undefined;
}

/** The deployed `approvers` point (see the file comment). */
export function createHostedApprovers(options: HostedApproversOptions): Approvers {
  const { store, identity, key } = options;
  const nowMs = (): number => options.now().getTime();
  const method = [APPROVAL_PROOF_METHOD]; const chat = options.chat;

  /** A live claim, matched by its id, as the condition every settle writes under. */
  const liveClaim = (claimId: string, at: number) => when.and(when.eq("state", "claimed"), when.eq("claimId", claimId), when.gt("until", at));
  const claimOf = (claimId: unknown): { key: DocumentKey; claimId: string } | undefined => {
    if (typeof claimId !== "string") return undefined;
    const match = CLAIM_ID.exec(claimId);
    return match === null ? undefined : { key: approvalProofClaimKey(match[1]!, match[2]!), claimId };
  };

  return {
    async requirement(request: ApprovalRequest): Promise<ApprovalRequirement> {
      // One method for every answer: the broker's proof of one act. No sign-in freshness rule (DEC 254zzz73).
      const withChat = [...method, ...chatMethodsOf(chat, request)]; // HW5b: a chat press is offered for a task's plan of low or medium risk and nothing else (never a strong or a rejecting method)
      return {
        methods: withChat, minApprovers: 1, selfApprovalAllowed: true,
        strongMethods: [...method], rejectMethods: [...method], changesMethods: withChat,
      };
    },

    async verify(request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict> {
      const refuse = (reason: string): ApprovalVerdict => ({ approved: false, reason }); if (chat !== undefined && proof?.method === chatApprovalMethod(chat.channel)) return await verifyChatPress({ store, identity, now: nowMs }, chat, request, proof);
      if (proof?.method !== APPROVAL_PROOF_METHOD) return refuse("unknown_method");
      if (key === undefined) return refuse("method_not_available");
      // A read-only check of a one-time part would leave it replayable: only a caller that settles claims may use this method.
      if (request?.settlesClaims !== true) return refuse(NEEDS_SETTLING_CALLER);
      const companyId = request.companyId;
      const subject = request.subject;
      // A core task (its own person decides), a project's setup candidate (L4-D) or a project's test environment (L4-B3b): for those two a live member here, and the subject's own rule decides who
      // at the proposal's risk; or a setup run's website ask (L4-SF d: a live member here; the host subject's rule decides who, and the proof names the ask's own id). Nothing else.
      const marker: ProofSubject | undefined = subject?.type === SETUP_PROPOSAL_SUBJECT || subject?.type === TEST_ENVIRONMENT_SUBJECT || subject?.type === SETUP_HOST_SUBJECT || subject?.type === EVAL_SPEND_SUBJECT ? subject.type : undefined;
      const setup = marker !== undefined;
      // A setup candidate and a test environment proposal are both named by their project (#908 and #933 merged in batch 14).
      const setupProposal = marker === SETUP_PROPOSAL_SUBJECT || marker === TEST_ENVIRONMENT_SUBJECT || marker === EVAL_SPEND_SUBJECT;
      const setupHost = marker === SETUP_HOST_SUBJECT;
      if (typeof companyId !== "string" || !OrgIdSchema.safeParse(companyId).success || typeof subject?.id !== "string"
        || !(setupProposal ? PROJECT_NAME.test(subject.id) && request.projectName === subject.id
          : setupHost ? HOST_SUBJECT_ID.test(subject.id) && typeof request.projectName === "string" && PROJECT_NAME.test(request.projectName)
            : subject.type === "task" && TASK_ID.test(subject.id))) return refuse("no_rule_for_this_request");
      if (proof.requestId !== request.requestId || typeof request.requestId !== "string") return refuse("other_request");
      if (proof.revision !== request.revision) return refuse("other_revision");
      if (proof.artifactDigest !== request.artifactDigest) return refuse("other_content");
      const claims = readProof(key, proof.token);
      if (claims === undefined) return refuse("not_a_valid_proof");
      if (claims.c !== companyId) return refuse("wrong_company");
      if (claims.r !== decisionRequestIdOf(request.requestId)) return refuse("other_request");
      if (claims.q !== request.kind) return refuse("other_kind");
      if (claims.s !== subject.id || claims.t !== marker) return refuse("other_subject");
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
      if (!(at < claims.e) || claims.e - at > APPROVAL_PROOF_LIFETIME_MS) return refuse("proof_expired");
      if (request.expiresAt !== undefined && !(at < Date.parse(request.expiresAt))) return refuse("expired");

      // Who: a live member of the company, and for a task the task's own person (both read now, never from the token alone).
      let person: Principal | undefined;
      let task: Record<string, unknown> | undefined;
      try {
        person = await identity.getPrincipal(companyId, claims.p);
        task = person === undefined || setup ? undefined : await store.get(taskKey(subject.id));
      } catch {
        return refuse("people_unreadable");
      }
      if (person === undefined || person.companyId !== companyId || person.personId !== claims.p) return refuse("not_a_member");
      if (!setup) {
        if (task === undefined || task["companyId"] !== companyId || task["taskId"] !== subject.id || typeof task["developerId"] !== "string" || typeof task["project"] !== "string") return refuse("not_the_task_owner");
        if (request.projectName !== undefined && task["project"] !== request.projectName) return refuse("not_the_task_owner");
        if (options.taskOwner === undefined) {
          if (task["developerId"] !== claims.p) return refuse("not_the_task_owner");
        } else {
          // The live owner rule, read now (People, membership, grant, proof): only an answer of exactly `true` is a yes; a read that fails refuses.
          let owner: unknown;
          try { owner = await options.taskOwner({ companyId, principal: person, task: { taskId: subject.id, developerId: task["developerId"], project: task["project"] } }); } catch { return refuse("people_unreadable"); }
          if (owner !== true) return refuse("not_the_task_owner");
        }
      }

      // The one-time part, claimed last: nothing above burns it.
      const partHash = createHash("sha256").update(claims.n).digest("hex");
      const claimKey = approvalProofClaimKey(companyId, partHash);
      const claimId = `${companyId}.${partHash}.${randomUUID()}`;
      let claimed: boolean;
      try {
        const written = await store.put({
          item: { ...claimKey, entityType: APPROVAL_PROOF_CLAIM_ENTITY, companyId, state: "claimed", claimId, until: at + APPROVAL_PROOF_CLAIM_MS, [INDEX_EXPIRY_ATTRIBUTE]: Math.ceil(claims.e / 1000) + CLAIM_ROW_KEEP_SECONDS },
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
        approver: { ...person, methods: [APPROVAL_PROOF_METHOD] },
        method: APPROVAL_PROOF_METHOD, proofId: proof.proofId, claimId,
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
