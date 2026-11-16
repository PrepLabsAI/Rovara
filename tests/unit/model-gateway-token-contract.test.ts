import * as taskContract from "@agentx/contracts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectLinearScaling } from "../support/scaling.js";
import { TaskTokenClaimsSchema, parseTaskTokenClaims, taskTokenClaimsFor, TASK_TOKEN_AUDIENCE, TASK_TOKEN_TYP, TASK_TOKEN_ALGORITHM, TASK_TOKEN_SECONDS, TASK_TOKEN_CLAIMS, type TaskTokenClaims } from "@agentx/contracts";
const bytes = () => readFileSync(new URL("../../contracts/shared/model-gateway-token.v1.json", import.meta.url), "utf8");
const vector = () => JSON.parse(bytes()) as { constants: object; claims: Array<{ name: string; type: string; required: boolean }>; testVector: { claims: TaskTokenClaims } };
describe("TC-1 claims", () => {
  it("publishes the approved task key purpose and JWK member name", () => {
    expect(Reflect.get(taskContract, "TASK_KEY_PURPOSE")).toBe("task");
    expect(Reflect.get(taskContract, "TASK_KEY_PURPOSE_MEMBER")).toBe("rovara_purpose");
  });
  it("pins the shared bytes and module constants and field list", () => {
    expect(createHash("sha256").update(bytes()).digest("hex")).toBe("1ee6a661a46f3a79cf61989d7fe19061fedd3e435a3ab1dd06f056d9bc24e7b3");
    expect(vector().constants).toEqual({ typ: TASK_TOKEN_TYP, aud: TASK_TOKEN_AUDIENCE, alg: TASK_TOKEN_ALGORITHM, lifetime: TASK_TOKEN_SECONDS, keyPurpose: taskContract.TASK_KEY_PURPOSE, keyPurposeMember: taskContract.TASK_KEY_PURPOSE_MEMBER });
    expect(vector().claims).toEqual(TASK_TOKEN_CLAIMS);
    expect(Object.keys(TaskTokenClaimsSchema.shape)).toEqual(vector().claims.map(f => f.name));
  });
  it("accepts the vector and allows each optional field to be absent", () => {
    const claims = vector().testVector.claims;
    expect(parseTaskTokenClaims(claims)).toEqual(claims);
    for (const field of vector().claims) {
      const copy: Record<string, unknown> = { ...claims }; delete copy[field.name];
      expect(parseTaskTokenClaims(copy) !== undefined, field.name).toBe(!field.required);
    }
  });
  it.each([
    { iss: "" }, { aud: "agentx-developer" }, { cid: "bad" }, { per: "bad" }, { pid: "UPPER" }, { tid: "" }, { ws: "bad" }, { op: "bad" },
    { jti: "bad" }, { stp: "Build" }, { src: "other" }, { src: 1 }, { mdl: [] }, { mdl: ["with space"] }, { mdl: Array(17).fill("model") },
    { mdl: ["a".repeat(129)] }, { iat: 1.5 }, { iat: -1 }, { nbf: null }, { exp: Infinity }, { injected: "private-marker" }, { pay: { kind: "other" } },
    { pay: { kind: "member", developerId: "a".repeat(64), extra: true } },
  ])("refuses malformed claims without throwing or returning a partial result", (patch) => {
    expect(parseTaskTokenClaims({ ...vector().testVector.claims, ...patch })).toBeUndefined();
  });
  it("builds the exact lifetime and skew from the server's seconds clock", () => {
    expect(taskTokenClaimsFor({ ...vector().testVector.claims, iat: 1800000000 })).toMatchObject({ aud: "rovara-model-gateway", nbf: 1799999970, exp: 1800000900 });
  });
  it("accepts the declared model-count and model-length maximum", () => {
    expect(parseTaskTokenClaims({ ...vector().testVector.claims, mdl: Array(16).fill("a".repeat(128)) })).toBeDefined();
  });
  it("bounds a large model array before schema traversal", () => {
    // The array is refused on its length: the cost does not grow with it (4,000, then 32,000 entries of 8 bytes: the 8N input stays at or under 256 KiB so it stays in CPU cache; the full 250,000 entries run once, un-timed, below).
    const results = new Map<number, unknown>();
    expectLinearScaling((count) => {
      const input = { ...vector().testVector.claims, mdl: Array(count).fill("a") };
      return () => { results.set(count, parseTaskTokenClaims(input)); };
    }, { n: 4_000, unitBytes: 8, label: "task token claims: a huge model array" });
    expect([results.get(4_000), results.get(32_000), parseTaskTokenClaims({ ...vector().testVector.claims, mdl: Array(250_000).fill("a") })]).toEqual([undefined, undefined, undefined]);
  });
  it("does not visit any element of an over-limit model array", () => {
    const models = Array<string>(17).fill("model"); let reads = 0;
    Object.defineProperty(models, "0", { get() { reads += 1; return "model"; } });
    expect(parseTaskTokenClaims({ ...vector().testVector.claims, mdl: models })).toBeUndefined();
    expect(reads).toBe(0);
  });
  it.each([null, undefined, "marker", 1, [], { mdl: "model" }])("refuses non-object or non-array inputs", value => {
    expect(parseTaskTokenClaims(value)).toBeUndefined();
  });
});
