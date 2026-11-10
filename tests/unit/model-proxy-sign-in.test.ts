// Port lane P5 (item K2): signing a call to a provider. SigV4 is checked against AWS's own published example, so a change that breaks the signature fails here and not in an account.
import { describe, expect, it } from "vitest";
import { SecretValue, type ModelProviderAdapter } from "@agentx/contracts";
import { SignInProblem, needsCredential, parseAwsCredentials, signCall, signV4 } from "../../packages/broker/src/local/model-proxy/sign-in.js";
import { NATIVE_CHAT_CAPABILITIES } from "../../packages/broker/src/plugins/model-provider/index.js";

const provider = (signIn: ModelProviderAdapter["signIn"], address = "https://models.example.test"): ModelProviderAdapter => ({
  kind: "gateway", name: "Gateway", address, signIn, formats: [{ format: "openai-completions", capabilities: NATIVE_CHAT_CAPABILITIES }],
});
const call = (row: ModelProviderAdapter, secret: string | undefined) => signCall({ provider: row, url: new URL("https://models.example.test/v1/chat/completions"), headers: { "content-type": "application/json" }, body: "{}", secret: secret === undefined ? undefined : new SecretValue(secret), now: new Date("2026-11-10T12:00:00Z") });

describe("signing a call", () => {
  const key = ["sk", "test", "never", "real", "abcdef0123"].join("-");

  it("puts a bearer key in Authorization", () => {
    expect(call(provider({ kind: "bearer-key" }), key)).toEqual({ headers: { authorization: `Bearer ${key}` }, sensitive: [key] });
  });

  it("puts a key in the header the provider names", () => {
    expect(call(provider({ kind: "named-header", header: "api-key" }), key)).toEqual({ headers: { "api-key": key }, sensitive: [key] });
  });

  it("sends a Google or Entra access token as a bearer token", () => {
    expect(call(provider({ kind: "google-oauth" }), "ya29.token-never-real").headers).toEqual({ authorization: "Bearer ya29.token-never-real" });
    expect(call(provider({ kind: "microsoft-entra", scope: "https://ai.azure.com/.default" }), "eyJ.token-never-real").headers).toEqual({ authorization: "Bearer eyJ.token-never-real" });
  });

  it("adds nothing for none, and needs no credential", () => {
    expect(call(provider({ kind: "none" }, "http://127.0.0.1:11434"), undefined)).toEqual({ headers: {}, sensitive: [] });
    expect(needsCredential(provider({ kind: "none" }, "http://127.0.0.1:1"))).toBe(false);
    expect(needsCredential(provider({ kind: "bearer-key" }))).toBe(true);
  });

  it("fails by a fixed sentence when a credential is missing", () => {
    expect(() => call(provider({ kind: "bearer-key" }), undefined)).toThrow(SignInProblem);
  });

  it("signs with SigV4 from a JSON credential and lists the secret key and session token as things an answer must not hold", () => {
    const secretAccessKey = "wJalrXUtnFEMI-never-real-secret", sessionToken = "session-token-never-real";
    const signed = call(provider({ kind: "aws-sigv4", region: "us-west-2", service: "bedrock" }), JSON.stringify({ accessKeyId: "AKIAEXAMPLE", secretAccessKey, sessionToken }));
    expect(signed.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20261110\/us-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/u);
    expect(signed.headers["x-amz-date"]).toBe("20261110T120000Z");
    expect(signed.headers["x-amz-security-token"]).toBe(sessionToken);
    expect(signed.sensitive).toEqual([secretAccessKey, sessionToken]);
    expect(JSON.stringify(signed.headers)).not.toContain(secretAccessKey);
  });

  it("refuses an AWS credential of the wrong shape without quoting it", () => {
    for (const text of ["not json", "[]", JSON.stringify({ accessKeyId: "A" }), JSON.stringify({ accessKeyId: "A", secretAccessKey: "S", extra: 1 }), JSON.stringify({ accessKeyId: "A B", secretAccessKey: "S" })]) {
      try {
        parseAwsCredentials(text);
        throw new Error(`accepted ${text}`);
      } catch (error) {
        expect(error).toBeInstanceOf(SignInProblem);
        expect((error as Error).message).not.toContain("A B");
      }
    }
  });
});

describe("Signature Version 4", () => {
  // AWS's published example (Signature Version 4 signing process, "Create a signed request": ListUsers on IAM). The signature is the one the documentation shows.
  it("matches the documented example", () => {
    const headers = signV4({
      method: "GET",
      url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      region: "us-east-1",
      service: "iam",
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
  });

  it("changes when the body, the path, the region or the time changes", () => {
    const base = { method: "POST", url: new URL("https://bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/messages"), headers: { "content-type": "application/json" }, body: "{}", credentials: { accessKeyId: "A", secretAccessKey: "S" }, region: "us-west-2", service: "bedrock", now: new Date("2026-11-10T00:00:00Z") };
    const signature = (over: Partial<typeof base>) => /Signature=([0-9a-f]+)/u.exec(signV4({ ...base, ...over }).authorization!)![1];
    const original = signature({});
    expect(signature({ body: "{ }" })).not.toBe(original);
    expect(signature({ url: new URL("https://bedrock-runtime.us-west-2.amazonaws.com/anthropic/v1/other") })).not.toBe(original);
    expect(signature({ region: "us-east-1" })).not.toBe(original);
    expect(signature({ now: new Date("2026-11-10T00:00:01Z") })).not.toBe(original);
    expect(signature({})).toBe(original);
  });

  it("encodes a path a second time, as services other than S3 do", () => {
    const sign = (path: string) => signV4({ method: "POST", url: new URL(`https://h.example.test${path}`), headers: {}, body: "", credentials: { accessKeyId: "A", secretAccessKey: "S" }, region: "r", service: "s", now: new Date("2026-11-10T00:00:00Z") }).authorization;
    expect(sign("/model/a:b/invoke")).not.toBe(sign("/model/a%3Ab/invoke"));
  });
});
