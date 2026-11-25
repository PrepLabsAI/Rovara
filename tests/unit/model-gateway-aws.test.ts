import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { beforeAll, describe, expect, it } from "vitest";
import { AwsError, AwsJsonClient, AwsNotSentError, AwsUnknownError, credentialsFromEnvironment, nodeWireTransport, signRequest, type WireRequest } from "../../packages/model-gateway/src/aws.js";
import { Dynamo, TransactionRefused, marshal, unmarshal } from "../../packages/model-gateway/src/dynamo.js";
import { createSecretsManagerKeys, PROVIDER_KEY_CACHE_MS } from "../../packages/model-gateway/src/secrets.js";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "session-token-example" };

describe("AWS wire client", () => {
  it("signs exactly as the AWS SDK's Signature V4 signer does", async () => {
    const body = Buffer.from(JSON.stringify({ TableName: "t", Key: { pk: { S: "CO#x" } } }));
    const now = new Date(Date.UTC(2026, 10, 15, 12, 30, 45));
    const ours = signRequest({ method: "POST", host: "dynamodb.us-west-2.amazonaws.com", region: "us-west-2", service: "dynamodb", body, credentials, now, headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.GetItem" } });
    const signer = new SignatureV4({ credentials, region: "us-west-2", service: "dynamodb", sha256: Sha256, applyChecksum: false });
    const theirs = await signer.sign({ method: "POST", protocol: "https:", hostname: "dynamodb.us-west-2.amazonaws.com", path: "/", headers: { host: "dynamodb.us-west-2.amazonaws.com", "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.GetItem" }, body }, { signingDate: now });
    expect(ours["x-amz-date"]).toBe("20261115T123045Z");
    expect(ours["x-amz-security-token"]).toBe(theirs.headers["x-amz-security-token"]);
    expect(ours.authorization).toBe(theirs.headers.authorization);
  });

  it("answers errors with the AWS error name only, never the service's message, and 5xx as unknown", async () => {
    const requests: WireRequest[] = [];
    let answer = { status: 400, body: Buffer.from(JSON.stringify({ __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException", message: "secret-looking detail sk-ant-123456" })) };
    const client = new AwsJsonClient({ region: "us-west-2", service: "dynamodb", targetPrefix: "DynamoDB_20120810", contentType: "application/x-amz-json-1.0", credentials: async () => credentials, transport: async (request) => { requests.push(request); return answer; } });
    const error = await client.call("GetItem", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AwsError);
    expect(error).toMatchObject({ code: "ConditionalCheckFailedException", status: 400, message: "aws request refused" });
    expect(JSON.stringify(error) + String(error)).not.toContain("sk-ant");
    answer = { status: 503, body: Buffer.from("{}") };
    await expect(client.call("GetItem", {})).rejects.toBeInstanceOf(AwsUnknownError);
    expect(requests[0]!.url).toBe("https://dynamodb.us-west-2.amazonaws.com/");
    expect(requests[0]!.headers["x-amz-target"]).toBe("DynamoDB_20120810.GetItem");
    expect(requests[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/dynamodb\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/u);
    const noCredentials = new AwsJsonClient({ region: "us-west-2", service: "dynamodb", targetPrefix: "x", contentType: "y", credentials: () => Promise.reject(new Error("nope")), transport: async () => answer });
    await expect(noCredentials.call("GetItem", {})).rejects.toBeInstanceOf(AwsNotSentError);
    expect(() => new AwsJsonClient({ region: "evil.example/", service: "dynamodb", targetPrefix: "x", contentType: "y", credentials: async () => credentials })).toThrow("invalid aws region");
  });

  it("takes the task role's credentials from the ECS address, refreshes them before expiry, else the environment's", async () => {
    let clock = Date.UTC(2026, 10, 15);
    const asked: string[] = [];
    const expiry = (ms: number) => new Date(clock + ms).toISOString();
    const source = credentialsFromEnvironment({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc", AWS_ACCESS_KEY_ID: "IGNORED" }, {
      now: () => clock,
      fetch: async (path) => { asked.push(path); return { status: 200, body: Buffer.from(JSON.stringify({ AccessKeyId: `AK${String(asked.length)}`, SecretAccessKey: "s", Token: "t", Expiration: expiry(60 * 60_000) })) }; },
    });
    const [a, b] = await Promise.all([source(), source()]);
    expect([a.accessKeyId, b.accessKeyId, asked.length]).toEqual(["AK1", "AK1", 1]);
    clock += 50 * 60_000;
    expect((await source()).accessKeyId).toBe("AK1");
    clock += 6 * 60_000;
    expect((await source()).accessKeyId).toBe("AK2");
    const bad = credentialsFromEnvironment({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/c" }, { fetch: async () => ({ status: 200, body: Buffer.from("{\"AccessKeyId\":\"x\"}") }) });
    await expect(bad()).rejects.toBeInstanceOf(AwsNotSentError);
    expect(await credentialsFromEnvironment({ AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "S" })()).toEqual({ accessKeyId: "A", secretAccessKey: "S" });
    await expect(credentialsFromEnvironment({})()).rejects.toBeInstanceOf(AwsNotSentError);
    await expect(credentialsFromEnvironment({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "http://evil.example/" })()).rejects.toBeInstanceOf(AwsNotSentError);
  });

  it("sends plain HTTP only to a loopback endpoint (DynamoDB Local), never elsewhere", async () => {
    const transport = nodeWireTransport();
    await expect(transport({ url: "http://dynamodb.us-west-2.amazonaws.com/", headers: {}, body: Buffer.alloc(0), timeoutMs: 10, maxBytes: 10 })).rejects.toBeInstanceOf(AwsNotSentError);
  });

  it("marshals DynamoDB values both ways and refuses an unsafe number", () => {
    const value = { s: "x", n: 9_007_199_254_740_991, b: true, z: null, l: [1, "a"], m: { k: new Uint8Array([1, 2]) } };
    expect(unmarshal(marshal(value))).toEqual(value);
    expect(() => marshal(0.5)).toThrow();
    expect(() => unmarshal({ N: "9007199254740993" })).toThrow();
    expect(() => unmarshal({ S: "a", N: "1" })).toThrow();
  });

  it("retries a transaction whose answer was lost once with the same token, and reports a cancel as refused", async () => {
    const bodies: string[] = [];
    let mode: "lost" | "cancel" = "lost";
    const db = new Dynamo({ region: "us-west-2", credentials: async () => credentials, transport: async (request) => {
      bodies.push(request.body.toString());
      if (mode === "lost") { if (bodies.length === 1) throw new AwsUnknownError(); return { status: 200, body: Buffer.from("{}") }; }
      return { status: 400, body: Buffer.from(JSON.stringify({ __type: "x#TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] })) };
    } });
    const actions = [{ kind: "Put" as const, table: "t", item: { pk: "CO#a", sk: "x" } }];
    await db.transact(actions, "token-1");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ ClientRequestToken: "token-1" });
    // Unknown, then the same-token retry is throttled: still unknown (the first may have applied), never "refused".
    let calls = 0;
    const flaky = new Dynamo({ region: "us-west-2", credentials: async () => credentials, transport: async () => {
      if (++calls === 1) throw new AwsUnknownError();
      return { status: 400, body: Buffer.from(JSON.stringify({ __type: "x#ThrottlingException" })) };
    } });
    await expect(flaky.transact(actions, "token-3")).rejects.toBeInstanceOf(AwsUnknownError);
    mode = "cancel";
    const refused = await db.transact(actions, "token-2").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TransactionRefused);
    expect((refused as TransactionRefused).conditionFailed(1)).toBe(true);
  });
});

describe("Secrets Manager provider keys", () => {
  const ARN = "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/staging/model-gateway/provider/anthropic-AbCdEf";
  const claims = {} as never;
  it("reads the key by ARN at run time, caches it briefly, coalesces reads, and never echoes it in an error", async () => {
    let clock = 0; const bodies: Array<{ target: string; body: unknown }> = [];
    let value = "fixture-provider-key-1";
    let fail = false;
    const keys = createSecretsManagerKeys({ region: "us-west-2", credentials: async () => credentials, secretArns: { anthropic: ARN }, now: () => clock, transport: async (request) => {
      bodies.push({ target: request.headers["x-amz-target"]!, body: JSON.parse(request.body.toString()) });
      if (fail) return { status: 400, body: Buffer.from(JSON.stringify({ __type: "AccessDeniedException", message: `denied ${value}` })) };
      return { status: 200, body: Buffer.from(JSON.stringify({ ARN, Name: "n", SecretString: `${value}\n` })) };
    } });
    const [a, b] = await Promise.all([keys.keyFor(claims, "anthropic"), keys.keyFor(claims, "anthropic")]);
    expect([a, b]).toEqual(["fixture-provider-key-1", "fixture-provider-key-1"]);
    expect(bodies).toEqual([{ target: "secretsmanager.GetSecretValue", body: { SecretId: ARN } }]);
    value = "fixture-provider-key-2";
    clock += PROVIDER_KEY_CACHE_MS - 1;
    expect(await keys.keyFor(claims, "anthropic")).toBe("fixture-provider-key-1");
    clock += 1;
    expect(await keys.keyFor(claims, "anthropic")).toBe("fixture-provider-key-2");
    fail = true; clock += PROVIDER_KEY_CACHE_MS;
    const error = await keys.keyFor(claims, "anthropic").catch((e: unknown) => e);
    expect(String(error)).toBe("ProviderKeyUnavailable: provider key unavailable");
    expect(JSON.stringify(error)).not.toContain("fixture-provider-key");
    const stopped = new AbortController(); stopped.abort();
    await expect(keys.keyFor(claims, "anthropic", stopped.signal)).rejects.toThrow("provider key unavailable");
    expect(() => createSecretsManagerKeys({ region: "us-west-2", credentials: async () => credentials, secretArns: { anthropic: "sk-ant-not-an-arn" } })).toThrow("invalid provider key secret");
  });
});
