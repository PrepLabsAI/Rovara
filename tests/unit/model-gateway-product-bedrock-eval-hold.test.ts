// RF-5 review (Opus, 2026-11-25): the eval hold's "the project's product key is connected" read counted only Gemini and Vertex keys, so an
// eval on a project whose only product source is Bedrock (its own role, or a link to the company's saved role) was refused at the hold
// ("Not run") before any call. A saved Bedrock source now counts; no source at all, or a Bedrock source on a gateway that has no Bedrock
// built, still does not. Nothing opens a socket.
import { beforeAll, describe, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import type { BedrockCheck } from "../../packages/model-gateway/src/product-keys.js";
import type { AssumeResult, BedrockSessionSource } from "../../packages/model-gateway/src/bedrock-byo-sessions.js";
import { EVAL_HOLD_PATH, ProductEvalStages } from "../../packages/model-gateway/src/product-eval.js";
import { handleGateway, type GatewayDependencies } from "../../packages/model-gateway/src/server.js";
import { MemorySink, mint, now } from "./model-gateway-fixture.js";
import { admin, cid, maintainer, pid, productGateway, storeKit, PRODUCT_COMPANY_OWNER, iss } from "./model-gateway-product-fixture.js";
beforeAll(denyNetwork);

const DIGEST = "d".repeat(64);
const CLAUDE = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const approval = { selection: "all-questions", inputsDigest: DIGEST, maxCalls: 400, maxCostMicros: 4_000_000, approver: { personId: "p1", provider: "github" } };
const grant = { company: cid, project: pid, selection: "all-questions", role: "maintainer", inputsDigest: DIGEST, provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };
const roleArn = `arn:aws:iam::111111111111:role/RovaraBedrockInvoke-${cid}`;
const connectionText = JSON.stringify({ scheme: "assume_role", roleArn, region: "us-west-2", models: { "claude-sonnet-4-5": CLAUDE }, allowGlobal: false });
const OK: BedrockCheck = async (_cid, c) => ({ result: "ok", models: Object.fromEntries(Object.values(c.models).map((id) => [id, "ready" as const])) });
const sessions: BedrockSessionSource = {
  async credentials(): Promise<AssumeResult> { return { ok: true, credentials: { accessKeyId: "ASIAXXXXXXXXXXXXXXXX", secretAccessKey: "s", sessionToken: "t", expiresAt: Date.now() + 3_600_000 } }; },
  forget() { /* none */ },
};

type How = "own" | "link" | "none" | "linkThenCompanyRemoved";
async function gatewayWith(how: How, options: { bedrockBuilt?: boolean } = {}) {
  const kit = storeKit({ bedrockCheck: OK });
  const base = { iss, cid, requestId: crypto.randomUUID(), actor: admin };
  if (how === "own") await kit.store.connect({ ...base, owner: pid, expectedRevision: 0, actor: maintainer, sourceId: "src_bdr", provider: "bedrock", key: connectionText });
  if (how === "link" || how === "linkThenCompanyRemoved") {
    await kit.store.connect({ ...base, owner: PRODUCT_COMPANY_OWNER, expectedRevision: 0, sourceId: "src_bedrock", provider: "bedrock", key: connectionText });
    await kit.store.link({ ...base, requestId: crypto.randomUUID(), owner: pid, expectedRevision: 0, actor: maintainer, sourceId: "src_bdrlink", companySourceId: "src_bedrock" });
  }
  if (how === "linkThenCompanyRemoved") await kit.store.remove({ ...base, requestId: crypto.randomUUID(), owner: PRODUCT_COMPANY_OWNER, expectedRevision: 1, sourceId: "src_bedrock" });
  const stages = new ProductEvalStages({ approvals: { current: async () => approval, roleOf: async () => "maintainer" }, now: () => now });
  return productGateway({
    kit, connect: false, evalStages: stages, companyCaps: new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: 1_000_000_000 }),
    ...(options.bedrockBuilt === false ? {} : { bedrock: { sessions, transport: () => async () => ({ status: 200, body: (async function* () { yield new Uint8Array(); })() }) } }),
  });
}
async function hold(deps: GatewayDependencies) {
  const sink = new MemorySink();
  const bytes = Buffer.from(JSON.stringify({ grant, calls: 10, costMicros: 100_000 }));
  await handleGateway(deps, { method: "POST", url: EVAL_HOLD_PATH, headers: { "content-type": "application/json", "x-api-key": mint() }, body: (async function* () { yield bytes; })() }, sink);
  return sink.status;
}

describe("the eval hold counts a saved Bedrock source as the project's connected product key", () => {
  it("the project's own role: the hold is granted", async () => { expect(await hold((await gatewayWith("own")).deps)).toBe(200); });
  it("a link to the company's saved role: the hold is granted", async () => { expect(await hold((await gatewayWith("link")).deps)).toBe(200); });
  it("no source at all: still refused", async () => { expect(await hold((await gatewayWith("none")).deps)).not.toBe(200); });
  it("a link whose company role was removed: refused (the link resolves to nothing)", async () => { expect(await hold((await gatewayWith("linkThenCompanyRemoved")).deps)).not.toBe(200); });
  it("a saved Bedrock source on a gateway without Bedrock built: refused (it could not serve a call)", async () => { expect(await hold((await gatewayWith("own", { bedrockBuilt: false })).deps)).not.toBe(200); });
});
