// The Bedrock check on the wire (Cloud's gatewayBedrockCheck to the gateway's handler), and the handler's own per-company limit.
// The Bedrock check handler limits each company on its own: one probe at a time and BEDROCK_CHECK_COMPANY_PER_MINUTE a minute, whatever
// Cloud's own limits are (connect, rotate and Check again all pass through it), so one company can't use up the task-wide room that
// other companies' connects need. The service call is signed with a KMS-style MAC; here an HMAC stands in for KMS.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  answerBedrockCheck, BEDROCK_CHECK_COMPANY_PER_MINUTE, BEDROCK_CHECK_PATH, gatewayBedrockCheck, SERVICE_CALL_AT_HEADER, SERVICE_CALL_MAC_HEADER, serviceCallMessage,
  type BedrockServiceOptions, type MacSigner, type MacVerifier,
} from "../../packages/model-gateway/src/service-call.js";
import { bedrockConnectionIds, type BedrockConnection } from "../../packages/model-gateway/src/bedrock-byo.js";

const ISS = "https://code.example.test/v1/auth";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const MAC_KEY = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-0000000000aa";
const BROKER = "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging";
const SONNET = "us.anthropic.claude-sonnet-5-5";
const START = Date.parse("2026-11-25T12:00:00Z");
const secret = randomBytes(32);
const mac = (message: Uint8Array) => createHmac("sha256", secret).update(message).digest();
const verifier: MacVerifier = { async verifyMac(input) { if (input.KeyId !== MAC_KEY || input.Mac.length !== 32 || !timingSafeEqual(Buffer.from(input.Mac), mac(input.Message))) throw new Error("refused"); return true; } };
const conn = (cid: string) => ({ scheme: "assume_role", roleArn: `arn:aws:iam::111111111111:role/RovaraBedrockInvoke-${cid}`, region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false });
async function signed(cid: string, at: number) {
  const body = Buffer.from(JSON.stringify({ iss: ISS, cid, connection: conn(cid) }));
  const proof = mac(serviceCallMessage(BEDROCK_CHECK_PATH, at, body));
  return { method: "POST", headers: { [SERVICE_CALL_AT_HEADER]: String(at), [SERVICE_CALL_MAC_HEADER]: Buffer.from(proof).toString("base64url") }, body: (async function* () { yield body; })() };
}

describe("the Bedrock check's per-company limit", () => {
  it("one probe at a time and a few a minute per company; another company keeps its room; a minute later the first may again", async () => {
    const clock = { at: START }; const asked: string[] = [];
    let hold: Promise<void> | undefined;
    const options: BedrockServiceOptions = {
      issuer: ISS, kms: verifier, macKeyId: MAC_KEY, now: () => clock.at, brokerRoleArn: BROKER, externalIds: { of: async () => `rvb-${"a".repeat(40)}` },
      bedrock: { probe: async (cid) => { asked.push(cid); if (hold !== undefined) await hold; return { result: "ok", models: { [SONNET]: "ready" } }; } },
    };
    const check = async (cid: string) => answerBedrockCheck(options, await signed(cid, clock.at));
    let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; });
    const first = check(A);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await Promise.race([check(A), new Promise<{ status: number }>((resolve) => setTimeout(() => resolve({ status: -1 }), 300))]);
    expect(second.status).toBe(429);
    const other = check(B);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect((await first).status).toBe(200); expect((await other).status).toBe(200);
    expect(asked).toEqual([A, B]);
    hold = undefined;
    for (let i = 1; i < BEDROCK_CHECK_COMPANY_PER_MINUTE; i += 1) expect((await check(A)).status, `A ${String(i)}`).toBe(200);
    expect((await check(A)).status).toBe(429);
    expect((await check(B)).status).toBe(200);
    clock.at += 61_000;
    expect((await check(A)).status).toBe(200);
    expect(asked.filter((cid) => cid === A)).toHaveLength(BEDROCK_CHECK_COMPANY_PER_MINUTE + 1);
  });

  it("a refused call (unsigned, wrong company field) never takes a company's place", async () => {
    const clock = { at: START };
    const options: BedrockServiceOptions = { issuer: ISS, kms: verifier, macKeyId: MAC_KEY, now: () => clock.at, brokerRoleArn: BROKER, externalIds: { of: async () => `rvb-${"a".repeat(40)}` }, bedrock: { probe: async () => ({ result: "ok", models: { [SONNET]: "ready" } }) } };
    for (let i = 0; i < BEDROCK_CHECK_COMPANY_PER_MINUTE + 2; i += 1) expect((await answerBedrockCheck(options, { method: "POST", headers: {}, body: (async function* () { yield Buffer.from("{}"); })() })).status).toBe(401);
    expect((await answerBedrockCheck(options, await signed(A, clock.at))).status).toBe(200);
  });
});

describe("the Bedrock check on the wire", () => {
  it("tells the gateway the connection's product models and reads each one's own answer (a ready product model is ready, an unanswered one is unavailable)", async () => {
    const NOVA = "us.amazon.nova-pro-v1:0", TITAN = "amazon.titan-embed-text-v2:0";
    const clock = { at: START }; const probed: Array<readonly string[] | undefined> = [];
    const options: BedrockServiceOptions = {
      issuer: ISS, kms: verifier, macKeyId: MAC_KEY, now: () => clock.at, brokerRoleArn: BROKER, externalIds: { of: async () => `rvb-${"a".repeat(40)}` },
      bedrock: { probe: async (_cid, c) => { probed.push(c.productModels); return { result: "ok", models: Object.fromEntries(bedrockConnectionIds(c).filter((id) => id !== TITAN).map((id) => [id, "ready" as const])) }; } },
    };
    const signer: MacSigner = { async generateMac(input) { return { Mac: new Uint8Array(mac(input.Message)) }; } };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = Buffer.from(init!.body as Uint8Array);
      const answer = await answerBedrockCheck(options, { method: init!.method!, headers: init!.headers as Record<string, string>, body: (async function* () { yield body; })() });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch;
    const check = gatewayBedrockCheck({ address: "https://gateway.example.test", issuer: ISS, kms: signer, macKeyId: MAC_KEY, fetch: fetchImpl, now: () => clock.at });
    const connection: BedrockConnection = { ...conn(A), scheme: "assume_role", models: { "claude-sonnet-5-5": SONNET }, productModels: [NOVA, TITAN] };
    expect(await check(A, connection)).toEqual({ result: "ok", models: { [SONNET]: "ready", [NOVA]: "ready", [TITAN]: "unavailable" } });
    expect(probed).toEqual([[NOVA, TITAN].sort()]);
  });
});
