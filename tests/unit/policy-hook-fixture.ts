// Lane H test fixture: keys are made at runtime (never commit a key, a token or a PEM), a TokenSigner over one, and a fake answering service that signs
// answers the way the contract says. Each test changes one thing about an answer to prove it counts as no answer.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  POLICY_HOOK_ANSWER_TYP, policyHookQuestionHash, policyHookSigningInput, readPolicyHookQuestion,
  type AuditSink, type PolicyHookKind, type PolicyHookPinnedKey, type PolicyHookSettings,
} from "../../packages/contracts/src/index.js";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";

export interface TestKey { privateKey: KeyObject; jwk: PolicyHookPinnedKey }

export function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  return { privateKey, jwk: { kty: "RSA", n: String(exported.n), e: String(exported.e), kid, alg: "RS256", use: "sig" } };
}

export function signerOf(key: TestKey): TokenSigner {
  return {
    async publicJwk() { return { kty: "RSA", n: key.jwk.n, e: key.jwk.e, kid: key.jwk.kid, alg: "RS256", use: "sig" }; },
    async sign(input) { return sign("RSA-SHA256", input, key.privateKey); },
  };
}

export const ISSUER = "https://install-a.example/v1/auth";
export const ADDRESS = "https://rules.example/v1/policy-hook";
export const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";

export function settingsFor(...keys: TestKey[]): PolicyHookSettings {
  return { address: ADDRESS, keys: keys.map((key) => key.jwk) };
}

export function signAnswer(key: TestKey, claims: unknown, header: Record<string, unknown> = { alg: "RS256", typ: POLICY_HOOK_ANSWER_TYP, kid: key.jwk.kid }): string {
  const input = policyHookSigningInput(header as { alg: string; typ: string; kid: string }, claims);
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url")}`;
}

export interface Asked { text: string; rid: string; kind: PolicyHookKind; q: Record<string, unknown> }

/**
 * A fake answering service. `answer(asked)` gives the answer body `a`, or a `Response`/`Error` to return or throw instead. `mutate` changes the signed
 * answer's claims (or the whole text) before it is sent, for the no-answer cases.
 */
export function fakeService(options: {
  key: TestKey;
  now: () => number;
  answer: (asked: Asked) => unknown;
  lifetime?: number;
  mutate?: (claims: Record<string, unknown>, asked: Asked) => Record<string, unknown> | string;
}) {
  const asked: Asked[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const text = typeof init?.body === "string" ? init.body : "";
    const read = readPolicyHookQuestion(text, Math.floor(options.now() / 1000));
    if (read === undefined) return new Response("bad", { status: 400 });
    const entry: Asked = { text, rid: read.claims.rid, kind: read.claims.kind, q: read.claims.q };
    asked.push(entry);
    const a = options.answer(entry);
    if (a instanceof Error) throw a;
    if (a instanceof Response) return a;
    const iat = Math.floor(options.now() / 1000);
    let claims: Record<string, unknown> | string = { v: 1, rid: entry.rid, qh: policyHookQuestionHash(text), iat, exp: iat + (options.lifetime ?? 60), kind: entry.kind, a };
    if (options.mutate !== undefined) claims = options.mutate(claims, entry);
    const body = typeof claims === "string" ? claims : signAnswer(options.key, claims);
    return new Response(body, { status: 200, headers: { "content-type": "application/jose" } });
  };
  return { fetch, asked };
}

export function memoryAudit() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    sink: { stage: () => [], async record(event: Record<string, unknown>) { events.push(event); } } as unknown as AuditSink,
  };
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
