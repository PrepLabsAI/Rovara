// Lane H (plan v3.2 section 7.5): the HTTP sender of the policy hook. It signs a question with the install's key, posts it to the policy address, and
// believes an answer only when it is signed by a pinned key and bound to this request id, this question and this kind (`checkPolicyHookAnswer`). Anything
// else (no reply, a timeout, a redirect, a status other than 200, a body over 8 KiB, an unsigned or foreign answer) is no answer. It never retries by
// itself: the caller decides (a task start holds and retries; an approval refuses at once). One audit line per question, with ids and fixed words only.
import { randomUUID } from "node:crypto";
import {
  POLICY_HOOK_ALG, POLICY_HOOK_CONTENT_TYPE, POLICY_HOOK_MAX_BODY_BYTES, POLICY_HOOK_QUESTION_SECONDS, POLICY_HOOK_QUESTION_TYP, POLICY_HOOK_TIMEOUT_SECONDS, POLICY_HOOK_VERSION,
  checkPolicyHookAnswer, parsePolicyHookQuestion, policyHookSigningInput,
  type AuditSink, type PolicyHookAnswers, type PolicyHookKind, type PolicyHookQuestions, type PolicyHookSettings,
} from "@agentx/contracts";
import type { TokenSigner } from "../../developer/tokens.js";

/** Who asks: the install's sign-in issuer (its install id, as in the task token) and the signer its public keys are published for. */
export interface PolicyHookInstall {
  issuer: string;
  signer: TokenSigner;
}

export interface PolicyHookClientOptions {
  settings: PolicyHookSettings;
  install: PolicyHookInstall;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. */
  now?: () => number;
  randomId?: () => string;
  timeoutMs?: number;
  audit?: AuditSink;
  log?: (event: Record<string, unknown>) => void;
}

/** A signed question, ready to send (again, for a held start: the same request id and the same text, so the answering side counts it once). */
export interface PreparedPolicyQuestion<K extends PolicyHookKind> {
  readonly kind: K;
  readonly requestId: string;
  readonly companyId: string;
  readonly text: string;
}

export type PolicyHookResult<K extends PolicyHookKind> = { answered: true; answer: PolicyHookAnswers[K]; expiresAt: number } | { answered: false };

export interface PolicyHookClient {
  /** Signs a question. Undefined when the question does not fit the contract (the caller refuses: nothing is asked). */
  prepare<K extends PolicyHookKind>(kind: K, question: PolicyHookQuestions[K]): Promise<PreparedPolicyQuestion<K> | undefined>;
  /** One attempt. Never throws. */
  send<K extends PolicyHookKind>(prepared: PreparedPolicyQuestion<K>): Promise<PolicyHookResult<K>>;
  /** Records the question's outcome in the audit record (one line per question). Never throws. */
  audit(prepared: PreparedPolicyQuestion<PolicyHookKind>, outcome: { answered: boolean; allow?: boolean; attempts: number }): Promise<void>;
}

async function readLimited(response: Response, limit: number): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createPolicyHookClient(options: PolicyHookClientOptions): PolicyHookClient {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  const timeoutMs = options.timeoutMs ?? POLICY_HOOK_TIMEOUT_SECONDS * 1000;
  const pinned = options.settings.keys;
  const address = options.settings.address;
  const log = options.log ?? (() => undefined);
  return {
    async prepare(kind, question) {
      const checked = parsePolicyHookQuestion(kind, question);
      if (checked === undefined) return undefined;
      try {
        const { kid } = await options.install.signer.publicJwk();
        const iat = Math.floor(now() / 1000);
        const claims = { v: POLICY_HOOK_VERSION, iss: options.install.issuer, rid: randomId(), iat, exp: iat + POLICY_HOOK_QUESTION_SECONDS, kind, q: checked };
        const signingInput = policyHookSigningInput({ alg: POLICY_HOOK_ALG, typ: POLICY_HOOK_QUESTION_TYP, kid }, claims);
        const signature = await options.install.signer.sign(Buffer.from(signingInput, "utf8"));
        return { kind, requestId: claims.rid, companyId: checked.cid, text: `${signingInput}.${signature.toString("base64url")}` };
      } catch {
        log({ component: "policy-hook", event: "question.unsigned" });
        return undefined;
      }
    },
    async send(prepared) {
      try {
        const response = await fetcher(address, {
          method: "POST",
          headers: { "content-type": POLICY_HOOK_CONTENT_TYPE, accept: POLICY_HOOK_CONTENT_TYPE },
          body: prepared.text,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return { answered: false };
        }
        const text = await readLimited(response, POLICY_HOOK_MAX_BODY_BYTES);
        if (text === undefined) return { answered: false };
        const checked = checkPolicyHookAnswer({ text: text.trim(), pinned, requestId: prepared.requestId, questionJws: prepared.text, kind: prepared.kind, nowSeconds: Math.floor(now() / 1000) });
        if (!checked.ok) return { answered: false };
        return { answered: true, answer: checked.answer, expiresAt: checked.expiresAt * 1000 };
      } catch {
        return { answered: false };
      }
    },
    async audit(prepared, outcome) {
      const details = { kind: prepared.kind, requestId: prepared.requestId, attempts: outcome.attempts, ...(outcome.allow === undefined ? {} : { allow: outcome.allow }) };
      log({ component: "policy-hook", event: outcome.answered ? "answered" : "no_answer", ...details });
      if (options.audit === undefined) return;
      try {
        await options.audit.record({
          eventId: `policy-hook:${prepared.requestId}`,
          companyId: prepared.companyId,
          at: new Date(now()).toISOString(),
          actor: { type: "system", id: "policy-hook" },
          action: outcome.answered ? "policy_hook.answered" : "policy_hook.no_answer",
          details,
        });
      } catch {
        log({ component: "policy-hook", event: "audit.failed", requestId: prepared.requestId });
      }
    },
  };
}
