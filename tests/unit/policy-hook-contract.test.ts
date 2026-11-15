// Lane H: contract H-1. The shared file contracts/shared/policy-hook.v1.json is byte-identical in Code and in the answering service's repo: its SHA-256 is
// pinned here as a literal, and the same literal is pinned there, so an edit to one copy fails until the other matches. The TypeScript module must agree.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as hook from "../../packages/contracts/src/policy-hook.js";
import { COMPANY, makeKey, sha256, signAnswer } from "./policy-hook-fixture.js";

const text = readFileSync(new URL("../../contracts/shared/policy-hook.v1.json", import.meta.url), "utf8");
const shared = JSON.parse(text) as {
  version: number; constants: Record<string, number | string>; patterns: Record<string, string>; words: Record<string, string>;
  question: { claims: Array<{ name: string; required: boolean }>; kinds: Record<string, Array<{ name: string; required: boolean }>> };
  answer: { claims: Array<{ name: string; required: boolean }>; kinds: Record<string, Array<{ name: string; required: boolean }>> };
  testVector: { question: { header: unknown; claims: Record<string, unknown> }; answer: { header: unknown; claims: Record<string, unknown> }; noAnswer: string[] };
};

const fields = (schema: z.ZodObject) => Object.entries(schema.shape).map(([name, value]) => ({ name, required: !(value as z.ZodType).safeParse(undefined).success }));

describe("contract H-1", () => {
  it("pins the shared bytes (the same literal is pinned in the answering service's repo)", () => {
    expect(sha256(text)).toBe("ad60a0f8ae7dd9a6b10959c06e4a6b600d9b388557ad066214a2ad1ea2ca2664");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.includes("\r")).toBe(false);
    expect(text).toBe(`${JSON.stringify(shared, null, 2)}\n`);
  });

  it("module constants, patterns and words match the shared file", () => {
    expect(shared.version).toBe(hook.POLICY_HOOK_VERSION);
    expect(shared.constants).toEqual({
      alg: hook.POLICY_HOOK_ALG, questionTyp: hook.POLICY_HOOK_QUESTION_TYP, answerTyp: hook.POLICY_HOOK_ANSWER_TYP,
      questionLifetimeSeconds: hook.POLICY_HOOK_QUESTION_SECONDS, answerMaxLifetimeSeconds: hook.POLICY_HOOK_ANSWER_MAX_SECONDS, clockSkewSeconds: hook.POLICY_HOOK_SKEW_SECONDS,
      maxBodyBytes: hook.POLICY_HOOK_MAX_BODY_BYTES, pinnedKeysMax: hook.POLICY_HOOK_PINNED_KEYS_MAX, requestTimeoutSeconds: hook.POLICY_HOOK_TIMEOUT_SECONDS,
      startHoldSeconds: hook.POLICY_HOOK_START_HOLD_SECONDS, valuesGraceSeconds: hook.POLICY_HOOK_VALUES_GRACE_SECONDS,
    });
    expect(Object.fromEntries(Object.entries(hook.POLICY_HOOK_PATTERNS).map(([name, pattern]) => [name, pattern.source]))).toEqual(shared.patterns);
    expect({ ...hook.POLICY_HOOK_WORDS }).toEqual(shared.words);
  });

  it("module claim lists match the shared file, name for name and required for required", () => {
    expect(fields(hook.PolicyHookQuestionClaimsSchema as unknown as z.ZodObject)).toEqual(shared.question.claims.map(({ name, required }) => ({ name, required })));
    expect(fields(hook.PolicyHookAnswerClaimsSchema as unknown as z.ZodObject)).toEqual(shared.answer.claims.map(({ name, required }) => ({ name, required })));
    const q = { start: hook.PolicyHookStartQuestionSchema, decide: hook.PolicyHookDecideQuestionSchema, values: hook.PolicyHookValuesQuestionSchema };
    const a = { start: hook.PolicyHookStartAnswerSchema, decide: hook.PolicyHookDecideAnswerSchema, values: hook.PolicyHookValuesAnswerSchema };
    for (const kind of hook.POLICY_HOOK_KINDS) {
      expect(fields(q[kind]), `question ${kind}`).toEqual(shared.question.kinds[kind]!.map(({ name, required }) => ({ name, required })));
      expect(fields(a[kind] as unknown as z.ZodObject), `answer ${kind}`).toEqual(shared.answer.kinds[kind]!.map(({ name, required }) => ({ name, required })));
    }
    expect(Object.keys(shared.question.kinds)).toEqual([...hook.POLICY_HOOK_KINDS]);
  });

  it("the test vector question is a valid question; its answer is accepted, and each listed change is no answer", () => {
    const vector = shared.testVector;
    const asker = makeKey("install-key-1");
    const pinned = makeKey("hook-key-1");
    const other = makeKey("hook-key-1");
    const unpinned = makeKey("hook-key-9");
    const questionText = signAnswer(asker, vector.question.claims, vector.question.header as Record<string, unknown>);
    const nowSeconds = Number(vector.answer.claims["iat"]) + 10;
    expect(hook.readPolicyHookQuestion(questionText, nowSeconds)?.claims).toEqual(vector.question.claims);
    expect(vector.question.claims["q"]).toMatchObject({ cid: COMPANY });
    const claims: Record<string, unknown> = { ...vector.answer.claims, qh: hook.policyHookQuestionHash(questionText) };
    const header = vector.answer.header as Record<string, unknown>;
    const check = (answer: string, overrides: Partial<{ requestId: string; questionJws: string; nowSeconds: number }> = {}): hook.PolicyHookAnswerCheck<"start"> => hook.checkPolicyHookAnswer({
      text: answer, pinned: [pinned.jwk], requestId: String(vector.question.claims["rid"]), questionJws: questionText, kind: "start" as const, nowSeconds, ...overrides,
    });
    expect(check(signAnswer(pinned, claims, header))).toMatchObject({ ok: true, answer: { allow: true } });
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const cases: Record<string, () => hook.PolicyHookAnswerCheck<"start">> = {
      unsigned: () => check(`${b64(header)}.${b64(claims)}.`),
      signedByOtherKey: () => check(signAnswer(other, claims, header)),
      expired: () => check(signAnswer(pinned, claims, header), { nowSeconds: Number(claims["exp"]) }),
      otherRequestId: () => check(signAnswer(pinned, claims, header), { requestId: "22222222-2222-4222-8222-222222222222" }),
      otherQuestionHash: () => check(signAnswer(pinned, claims, header), { questionJws: `${questionText}x` }),
      otherKind: () => check(signAnswer(pinned, { ...claims, kind: "values", a: { locks: {} } }, header)),
      unknownClaim: () => check(signAnswer(pinned, { ...claims, extra: 1 }, header)),
      lifetimeOver300: () => check(signAnswer(pinned, { ...claims, exp: Number(claims["iat"]) + 301 }, header)),
      typChanged: () => check(signAnswer(pinned, claims, { ...header, typ: "JWT" })),
      algNone: () => check(`${b64({ ...header, alg: "none" })}.${b64(claims)}.`),
      kidNotPinned: () => check(signAnswer(unpinned, claims)),
      extraHeaderField: () => check(signAnswer(pinned, claims, { ...header, jku: "https://x.example" })),
      bodyOver8192: () => check(signAnswer(pinned, { ...claims, a: { allow: true, code: "a" } }, header) + "A".repeat(8192)),
    };
    expect(Object.keys(cases)).toEqual(vector.noAnswer);
    for (const [name, run] of Object.entries(cases)) expect(run(), name).toEqual({ ok: false });
  });

  it("settings take one or two pinned keys, https (or loopback http), and nothing else", () => {
    const key = makeKey("hook-key-1").jwk;
    const second = makeKey("hook-key-2").jwk;
    const ok = (value: unknown) => hook.PolicyHookSettingsSchema.safeParse(value).success;
    expect(ok({ address: "https://rules.example/v1/policy-hook", keys: [key] })).toBe(true);
    expect(ok({ address: "https://rules.example/v1/policy-hook", keys: [key, second] })).toBe(true);
    expect(ok({ address: "http://127.0.0.1:9000/hook", keys: [key] })).toBe(true);
    expect(ok({ address: "https://rules.example/v1/policy-hook", keys: [] })).toBe(false);
    expect(ok({ address: "https://rules.example/v1/policy-hook", keys: [key, second, makeKey("hook-key-3").jwk] })).toBe(false);
    expect(ok({ address: "https://rules.example/v1/policy-hook", keys: [key, { ...second, kid: key.kid }] })).toBe(false);
    expect(ok({ address: "http://rules.example/v1/policy-hook", keys: [key] })).toBe(false);
    expect(ok({ address: "https://user:pw@rules.example/hook", keys: [key] })).toBe(false);
    expect(ok({ address: "https://rules.example/hook?x=1", keys: [key] })).toBe(false);
    expect(ok({ address: "https://rules.example/hook", keys: [{ ...key, d: "secret" }] })).toBe(false);
    expect(ok({ address: "https://rules.example/hook", keys: [{ ...key, n: "AQAB" }] })).toBe(false);
    expect(ok({ address: "https://rules.example/hook", keys: [key], extra: true })).toBe(false);
  });
});
