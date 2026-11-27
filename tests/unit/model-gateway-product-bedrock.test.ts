// DEC 238 slice 2: the product route's Bedrock pieces with no network: the path, the body guards (Converse, Claude's InvokeModel body,
// Titan embeddings), the usage readers for every answer shape, Bedrock's error classes, the passthrough transport, and the
// connection's product models. The route itself (two companies, money) is model-gateway-product-bedrock-route.test.ts.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { crc32 } from "node:zlib";
import type https from "node:https";
import { beforeAll, describe, expect, it } from "vitest";
import { allowedProductModel, bedrockResourceArns, bedrockSetupCommand, parseBedrockConnect, serializeBedrockConnection, validBedrockSummary, bedrockSummary } from "../../packages/model-gateway/src/bedrock-byo.js";
import {
  BedrockUsage, bedrockFailureKind, bedrockFamily, bedrockProductPath, createBedrockProductTransport, EMBEDDING_INPUT_MAX_BYTES, guardBedrockProduct, parseBedrockProductPath, PRODUCT_BEDROCK_FEATURE, PRODUCT_BEDROCK_MODEL, PRODUCT_BEDROCK_OPERATION,
  type BedrockProductPath,
} from "../../packages/model-gateway/src/product-bedrock.js";
import { BEDROCK_MODEL_ACCESS_WORDS } from "../../packages/model-gateway/src/bedrock-byo-sessions.js";
import { NotSentError } from "../../packages/model-gateway/src/provider.js";
import { claims } from "./model-gateway-fixture.js";

const CLAUDE = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const NOVA = "us.amazon.nova-pro-v1:0";
const LLAMA = "meta.llama3-1-70b-instruct-v1:0";
const TITAN = "amazon.titan-embed-text-v2:0";
const TITAN1 = "amazon.titan-embed-text-v1";
const connection = parseBedrockConnect(JSON.stringify({ scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-org_aaaaaaaaaaaaaaaaaaaa", region: "us-west-2", models: { "claude-sonnet-4-5-20250929": CLAUDE }, allowGlobal: false, productModels: [NOVA, LLAMA, TITAN, TITAN1] }))!;
const limits = { maxOutputTokens: (provider: string, model: string) => (provider === "bedrock" && model === CLAUDE ? 64_000 : provider === "bedrock" && model === NOVA ? 5_000 : undefined) };
const JSON_HEADERS = { "content-type": "application/json" };
const pathOf = (id: string, op: string): BedrockProductPath => parseBedrockProductPath(`/v1/product/bedrock/model/${encodeURIComponent(id)}/${op}`, "")!;
const guard = (id: string, op: string, body: unknown, headers: Record<string, string> = JSON_HEADERS) => guardBedrockProduct({ bytes: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), headers, path: pathOf(id, op), connection, claims: claims as never, modelLimits: limits });
const converseBody = { messages: [{ role: "user", content: [{ text: "hello" }] }] };
const anthropicBody = { anthropic_version: "bedrock-2023-05-31", max_tokens: 100, messages: [{ role: "user", content: "hello" }] };
const refusal = (result: unknown) => result as { ok: false; status: number; code: string; message: string };
const parsed = (call: unknown) => JSON.parse((call as { bytes: Buffer }).bytes.toString("utf8")) as unknown as Record<string, unknown>;

describe("the connection's product models", () => {
  it("are optional, any family, distinct, valid for the Region, and at most 12 ids in all; the sealed text is unchanged without them", () => {
    expect(connection.productModels).toEqual([LLAMA, NOVA, TITAN1, TITAN].sort());
    const base = { scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-org_aaaaaaaaaaaaaaaaaaaa", region: "us-west-2", models: { "claude-sonnet-4-5-20250929": CLAUDE }, allowGlobal: false };
    const withoutProduct = parseBedrockConnect(JSON.stringify(base))!;
    expect(withoutProduct.productModels).toBeUndefined();
    // Byte-identical to a connection saved before slice 2.
    expect(serializeBedrockConnection(withoutProduct)).toBe(JSON.stringify({ scheme: "assume_role", roleArn: base.roleArn, region: "us-west-2", models: base.models, allowGlobal: false }));
    expect(serializeBedrockConnection({ ...withoutProduct, productModels: [] })).toBe(serializeBedrockConnection(withoutProduct));
    const bad = (productModels: unknown) => parseBedrockConnect(JSON.stringify({ ...base, productModels }));
    for (const productModels of [[], [NOVA, NOVA], ["eu.amazon.nova-pro-v1:0"], ["global.amazon.nova-pro-v1:0"], ["arn:aws:bedrock:us-west-2:111111111111:provisioned-model/abc"], [42], "x", Array.from({ length: 9 }, (_, i) => `meta.llama${String(i)}-v1:0`)]) expect(bad(productModels), JSON.stringify(productModels)).toBeUndefined();
    // 8 product models and 5 agent models are 13 different ids: over the 12.
    const agents = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`claude-m${String(i)}`, `us.anthropic.claude-m${String(i)}`]));
    expect(parseBedrockConnect(JSON.stringify({ ...base, models: agents, productModels: Array.from({ length: 8 }, (_, i) => `meta.llama${String(i)}-v1:0`) }))).toBeUndefined();
    expect(parseBedrockConnect(JSON.stringify({ ...base, models: agents, productModels: Array.from({ length: 7 }, (_, i) => `meta.llama${String(i)}-v1:0`) }))).toBeDefined();
    expect(allowedProductModel("global.anthropic.claude-sonnet-5-5", "us-west-2", false)).toBe(false);
    expect(allowedProductModel("global.anthropic.claude-sonnet-5-5", "us-west-2", true)).toBe(true);
    expect(allowedProductModel("eu.meta.llama3-1-70b-instruct-v1:0", "us-west-2", false)).toBe(false);
  });
  it("go into the role's IAM resources (profiles and the geography's foundation models) and the setup command, and the summary", () => {
    const arns = bedrockResourceArns(connection);
    expect(arns).toContain("arn:aws:bedrock:us-west-2:*:inference-profile/us.amazon.nova-pro-v1:0");
    expect(arns).toContain("arn:aws:bedrock:us-*::foundation-model/amazon.nova-pro-v1:0");
    expect(arns).toContain("arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-embed-text-v2:0");
    expect(arns).toContain("arn:aws:bedrock:us-west-2::foundation-model/meta.llama3-1-70b-instruct-v1:0");
    const setup = bedrockSetupCommand({ templateUrl: "https://raw.githubusercontent.com/PrepLabsAI/Rovara-Code/0123456789abcdef0123456789abcdef01234567/docs/bedrock/rovara-bedrock-role.json", brokerRoleArn: "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging", externalId: `rvb-${"a1".repeat(20)}`, cid: "org_aaaaaaaaaaaaaaaaaaaa", region: "us-west-2", models: connection.models, allowGlobal: false, productModels: connection.productModels! });
    expect(setup.command).toContain("inference-profile/us.amazon.nova-pro-v1:0");
    // A project's own role gets its own stack name: its command can never update the company's stack (and so its role's policy).
    const forProject = bedrockSetupCommand({ templateUrl: "https://raw.githubusercontent.com/PrepLabsAI/Rovara-Code/0123456789abcdef0123456789abcdef01234567/docs/bedrock/rovara-bedrock-role.json", brokerRoleArn: "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging", externalId: `rvb-${"a1".repeat(20)}`, cid: "org_aaaaaaaaaaaaaaaaaaaa", region: "us-west-2", models: connection.models, allowGlobal: false, project: "web" });
    expect(setup.stackName).toBe("rovara-bedrock-org-aaaaaaaaaaaaaaaaaaaa");
    expect(forProject.stackName).toBe("rovara-bedrock-org-aaaaaaaaaaaaaaaaaaaa-web");
    expect(forProject.command).toContain("--stack-name rovara-bedrock-org-aaaaaaaaaaaaaaaaaaaa-web ");
    expect(forProject.command).not.toContain("--stack-name rovara-bedrock-org-aaaaaaaaaaaaaaaaaaaa ");
    expect(() => bedrockSetupCommand({ templateUrl: "https://raw.githubusercontent.com/PrepLabsAI/Rovara-Code/0123456789abcdef0123456789abcdef01234567/docs/bedrock/rovara-bedrock-role.json", brokerRoleArn: "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging", externalId: `rvb-${"a1".repeat(20)}`, cid: "org_aaaaaaaaaaaaaaaaaaaa", region: "us-west-2", models: connection.models, allowGlobal: false, project: "Web; rm" })).toThrow();
    expect(() => bedrockSetupCommand({ templateUrl: "https://raw.githubusercontent.com/PrepLabsAI/Rovara-Code/0123456789abcdef0123456789abcdef01234567/docs/bedrock/rovara-bedrock-role.json", brokerRoleArn: "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging", externalId: `rvb-${"a1".repeat(20)}`, cid: "org_aaaaaaaaaaaaaaaaaaaa", region: "us-west-2", models: connection.models, allowGlobal: false, productModels: ["eu.amazon.nova-pro-v1:0"] })).toThrow();
    const summary = bedrockSummary(connection, { [CLAUDE]: "ready", [NOVA]: "not_enabled", [TITAN]: "ready" }, 1);
    expect(validBedrockSummary(summary)).toBe(true);
    expect(validBedrockSummary({ ...summary, checks: { "meta.unknown-model": "ready" } })).toBe(false);
    expect(validBedrockSummary({ ...summary, productModels: ["eu.amazon.nova-pro-v1:0"] })).toBe(false);
  });
});

describe("the path", () => {
  it("takes the four operations on a plain or %3A-encoded id and nothing else", () => {
    expect(parseBedrockProductPath(`/v1/product/bedrock/model/${encodeURIComponent(CLAUDE)}/converse-stream`, "")).toEqual({ modelId: CLAUDE, op: "converse-stream", streaming: true, converse: true, arn: false });
    expect(parseBedrockProductPath(`/v1/product/bedrock/model/${CLAUDE}/invoke`, "")).toMatchObject({ modelId: CLAUDE, op: "invoke", streaming: false, converse: false });
    expect(parseBedrockProductPath(`/v1/product/bedrock/model/${TITAN}/invoke-with-response-stream`, "")).toMatchObject({ streaming: true });
    const refused = [
      [`/v1/product/bedrock/model/${CLAUDE}/converse`, "x=1"], [`/v1/product/bedrock/model/${CLAUDE}/count-tokens`, ""], [`/v1/product/bedrock/model/${CLAUDE}`, ""],
      ["/v1/product/bedrock/model//converse", ""], [`/v1/product/bedrock/model/${CLAUDE}/converse/extra`, ""], ["/v1/product/bedrock/model/UPPER.case/converse", ""],
      ["/v1/product/bedrock/model/a%2Fb/converse", ""], ["/v1/product/bedrock/model/a%00b/converse", ""], ["/v1/product/bedrock/model/..%2F..%2Fx/converse", ""], ["/v1/product/bedrock/model/a b/converse", ""],
      ["/v1/product/bedrock/model/x/converse", ""], [`/v1/product/bedrock/models/${CLAUDE}/converse`, ""], [`/v1/product/bedrock/model/${"a".repeat(300)}/converse`, ""],
    ];
    for (const [path, query] of refused) expect(parseBedrockProductPath(path!, query!), path).toBeUndefined();
  });
  it("an ARN (provisioned throughput, an application profile, a prompt) is a recognised request, refused by the guard", () => {
    for (const arn of ["arn:aws:bedrock:us-west-2:111111111111:provisioned-model/abc123", "arn:aws:bedrock:us-west-2:111111111111:application-inference-profile/abc123", "arn:aws:bedrock:us-west-2:111111111111:prompt/ABC123"]) {
      const path = parseBedrockProductPath(`/v1/product/bedrock/model/${encodeURIComponent(arn)}/converse`, "");
      expect(path?.arn, arn).toBe(true);
      expect(refusal(guardBedrockProduct({ bytes: Buffer.from(JSON.stringify(converseBody)), headers: JSON_HEADERS, path: path!, connection, claims: claims as never, modelLimits: limits })).message).toBe(PRODUCT_BEDROCK_FEATURE);
    }
  });
  it("families and the upstream path are rebuilt from the id", () => {
    expect([CLAUDE, NOVA, TITAN, "global.anthropic.claude-sonnet-5-5", "arn:aws:x", "abc123"].map(bedrockFamily)).toEqual(["claude", "converse", "embedding", "claude", undefined, undefined]);
    // Only Titan Text Embeddings V1 and V2 are embedding models here: any other embed id is no InvokeModel model at all.
    expect(["amazon.titan-embed-text-v3:0", "amazon.titan-embed-image-v1", "amazon.titan-embed-text-v2:0:8k", "amazon.titan-embed-text-v1:2"].map(bedrockFamily)).toEqual(["converse", "converse", "converse", "converse"]);
    expect(bedrockProductPath(CLAUDE, "converse")).toBe("/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse");
    expect(() => bedrockProductPath("arn:aws:bedrock:x", "converse")).toThrow();
    expect(() => bedrockProductPath(CLAUDE, "count-tokens" as never)).toThrow();
  });
});

describe("the guard: the model and the operation", () => {
  it("preserves cache-write exposure when importing the Anthropic guard", () => {
    const checked = guard(CLAUDE, "invoke", { anthropic_version: "bedrock-2023-05-31", max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }] });
    expect(checked).toMatchObject({ ok: true, inputBounded: true, usesPromptCache: true });
  });
  it("only a model the company picked, and only the operations its family is offered with", () => {
    expect(refusal(guard("us.anthropic.claude-opus-5-5", "converse", converseBody)).message).toBe(PRODUCT_BEDROCK_MODEL);
    expect(refusal(guard("meta.llama3-70b-instruct-v1:0", "converse", converseBody)).message).toBe(PRODUCT_BEDROCK_MODEL);
    // Another geography's profile of a picked model is another id.
    expect(refusal(guard("eu.anthropic.claude-sonnet-4-5-20250929-v1:0", "converse", converseBody)).message).toBe(PRODUCT_BEDROCK_MODEL);
    for (const [id, op] of [[NOVA, "invoke"], [NOVA, "invoke-with-response-stream"], [LLAMA, "invoke"], [TITAN, "converse"], [TITAN, "converse-stream"], [TITAN, "invoke-with-response-stream"]] as const) {
      expect(refusal(guard(id, op, converseBody)).message, `${id} ${op}`).toBe(PRODUCT_BEDROCK_OPERATION);
    }
    for (const [id, op] of [[CLAUDE, "converse"], [CLAUDE, "converse-stream"], [NOVA, "converse"], [LLAMA, "converse-stream"]] as const) expect((guard(id, op, converseBody) as { ok: boolean }).ok, `${id} ${op}`).toBe(true);
    expect((guard(CLAUDE, "invoke", anthropicBody) as { ok: boolean }).ok).toBe(true);
    expect((guard(TITAN, "invoke", { inputText: "hi" }) as { ok: boolean }).ok).toBe(true);
  });
  it("credential and feature headers are refused (guardrails, performance and service tiers, trace) before the body is read", () => {
    for (const name of ["authorization", "x-amz-security-token", "x-amzn-bedrock-guardrailidentifier", "x-amzn-bedrock-guardrailversion", "x-amzn-bedrock-performanceconfig-latency", "x-amzn-bedrock-service-tier", "x-amzn-bedrock-trace", "X-Amzn-Bedrock-Trace"]) {
      const result = refusal(guard(CLAUDE, "invoke", "not json", { ...JSON_HEADERS, [name]: "x" }));
      expect(result.message, name).toBe(PRODUCT_BEDROCK_FEATURE);
    }
  });
  it("the SDK's own accept and content-type negotiation headers are allowed (the transport sends its own), nothing else under x-amzn-bedrock-", () => {
    expect((guard(CLAUDE, "invoke-with-response-stream", anthropicBody, { ...JSON_HEADERS, "x-amzn-bedrock-accept": "application/json", "x-amzn-bedrock-content-type": "application/json" }) as { ok: boolean }).ok).toBe(true);
    expect(refusal(guard(CLAUDE, "invoke", anthropicBody, { ...JSON_HEADERS, "x-amzn-bedrock-accept": "application/json", "x-amzn-bedrock-trace": "ENABLED" })).message).toBe(PRODUCT_BEDROCK_FEATURE);
  });
  it("a content type that is not JSON, oversized headers, a body over 4 MiB and a body that is not UTF-8 JSON are refused", () => {
    expect(refusal(guard(CLAUDE, "converse", converseBody, { "content-type": "text/plain" })).code).toBe("invalid_request");
    expect(refusal(guard(CLAUDE, "converse", converseBody, { ...JSON_HEADERS, "x-big": "a".repeat(17_000) })).code).toBe("invalid_request");
    expect(refusal(guard(CLAUDE, "converse", `{"messages":"${"a".repeat(4 * 1024 * 1024)}"}`)).code).toBe("invalid_request");
    expect(refusal(guard(CLAUDE, "converse", "{")).code).toBe("invalid_request");
    expect(refusal(guard(CLAUDE, "converse", "[]")).code).toBe("invalid_request");
  });
});

describe("the guard: Converse", () => {
  it("sends the checked body with maxTokens held to the model's ceiling and the gateway's own requestMetadata, answered as an event stream when streaming", () => {
    const call = guard(CLAUDE, "converse-stream", { ...converseBody, system: [{ text: "be brief" }], inferenceConfig: { temperature: 0.2, topP: 0.9, stopSequences: ["END"] }, requestMetadata: { rovara_project: "someone-else", other: "x" }, additionalModelRequestFields: { top_k: 40 } }) as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ ok: true, model: CLAUDE, maxTokens: 64_000, streaming: true, hasTools: false, inputBounded: true, headers: { "content-type": "application/json" }, path: "/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse-stream", streamContentType: "application/vnd.amazon.eventstream" });
    expect(call.priceKind).toBeUndefined();
    expect(parsed(call).inferenceConfig).toEqual({ temperature: 0.2, topP: 0.9, stopSequences: ["END"], maxTokens: 64_000 });
    // The caller's metadata is overwritten, never merged.
    expect(parsed(call).requestMetadata).toEqual({ rovara_project: claims.pid, rovara_task: claims.tid });
    expect(parsed(call).additionalModelRequestFields).toEqual({ top_k: 40 });
    const whole = guard(NOVA, "converse", { ...converseBody, inferenceConfig: { maxTokens: 300 } }) as unknown as Record<string, unknown>;
    expect(whole.streamContentType).toBeUndefined(); expect(whole.maxTokens).toBe(300); expect(whole.streaming).toBe(false);
  });
  it("a request above the model's output ceiling is refused; a model with no row is held to 4,096", () => {
    expect(refusal(guard(CLAUDE, "converse", { ...converseBody, inferenceConfig: { maxTokens: 64_001 } })).code).toBe("invalid_request");
    expect((guard(CLAUDE, "converse", { ...converseBody, inferenceConfig: { maxTokens: 64_000 } }) as { ok: boolean }).ok).toBe(true);
    expect((guard(LLAMA, "converse", converseBody) as { maxTokens: number }).maxTokens).toBe(4_096);
    expect(refusal(guard(LLAMA, "converse", { ...converseBody, inferenceConfig: { maxTokens: 4_097 } })).code).toBe("invalid_request");
    for (const maxTokens of [0, -1, 1.5, "10", null]) expect(refusal(guard(NOVA, "converse", { ...converseBody, inferenceConfig: { maxTokens } })).code, String(maxTokens)).toBe("invalid_request");
  });
  it("guardrails, performance and service tiers are refused in the body with the feature words", () => {
    for (const extra of [{ guardrailConfig: { guardrailIdentifier: "g", guardrailVersion: "1" } }, { performanceConfig: { latency: "optimized" } }, { serviceTier: { type: "priority" } }, { service_tier: "priority" }]) {
      expect(refusal(guard(CLAUDE, "converse", { ...converseBody, ...extra })).message, JSON.stringify(extra)).toBe(PRODUCT_BEDROCK_FEATURE);
    }
  });
  it("every other field, block and tool kind is refused whole: nothing is dropped or guessed", () => {
    const bad = (body: unknown) => refusal(guard(CLAUDE, "converse", body)).code;
    for (const body of [
      { ...converseBody, promptVariables: {} }, { ...converseBody, outputConfig: {} }, { ...converseBody, additionalModelResponseFieldPaths: ["/x"] }, { ...converseBody, extra: 1 }, { messages: [] }, { messages: "x" }, {},
      { messages: [{ role: "system", content: [{ text: "x" }] }] }, { messages: [{ role: "user", content: [] }] }, { messages: [{ role: "user", content: "x" }] }, { messages: [{ role: "user", content: [{ text: 1 }] }] },
      { messages: [{ role: "user", content: [{ text: "x", image: {} }] }] }, { messages: [{ role: "user", content: [{ guardContent: { text: { text: "x" } } }] }] },
      { messages: [{ role: "user", content: [{ citationsContent: {} }] }] }, { messages: [{ role: "user", content: [{ searchResult: {} }] }] },
      { messages: [{ role: "user", content: [{ image: { format: "png", source: { s3Location: { uri: "s3://b/k" } } } }] }] },
      { messages: [{ role: "user", content: [{ image: { format: "exe", source: { bytes: "AAAA" } } }] }] },
      { messages: [{ role: "user", content: [{ toolResult: { toolUseId: "t", content: [{ unknown: 1 }] } }] }] },
      { ...converseBody, system: [{ guardContent: { text: { text: "x" } } }] }, { ...converseBody, system: "x" },
      { ...converseBody, toolConfig: { tools: [{ systemTool: { name: "nova_grounding" } }] } }, { ...converseBody, toolConfig: { tools: [] } }, { ...converseBody, toolConfig: { tools: [{ toolSpec: { name: "t", inputSchema: { json: {} } } }], toolChoice: { bogus: {} } } },
      { ...converseBody, inferenceConfig: { temperature: 2 } }, { ...converseBody, inferenceConfig: { topP: -0.1 } }, { ...converseBody, inferenceConfig: { stopSequences: Array.from({ length: 9 }, () => "x") } }, { ...converseBody, inferenceConfig: { seed: 1 } },
      { ...converseBody, additionalModelRequestFields: { service_tier: "priority" } }, { ...converseBody, additionalModelRequestFields: { anthropic_beta: ["computer-use-2025-01-24"] } }, { ...converseBody, additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: -1 } } },
      { ...converseBody, requestMetadata: "x" },
    ]) expect(bad(body), JSON.stringify(body).slice(0, 80)).toBe("invalid_request");
    for (const body of [
      { messages: [{ role: "user", content: [{ text: "x" }, { toolResult: { toolUseId: "t", status: "success", content: [{ text: "a" }, { json: { a: 1 } }] } }] }, { role: "assistant", content: [{ toolUse: { toolUseId: "t", name: "n", input: { a: 1 } } }, { reasoningContent: { reasoningText: { text: "hm", signature: "s" } } }] }] },
      { ...converseBody, toolConfig: { tools: [{ toolSpec: { name: "t", description: "d", inputSchema: { json: { type: "object" } } } }], toolChoice: { auto: {} } } },
      { ...converseBody, additionalModelRequestFields: { anthropic_beta: ["interleaved-thinking-2025-05-14"], thinking: { type: "enabled", budget_tokens: 1024 } } },
    ]) expect((guard(CLAUDE, "converse", body) as { ok: boolean }).ok, JSON.stringify(body).slice(0, 80)).toBe(true);
  });
  it("tools are counted; images, documents, video and cache points make the input not byte-bounded (the overrun rules), plain text and tool blocks do not", () => {
    expect(guard(CLAUDE, "converse", { ...converseBody, toolConfig: { tools: [{ toolSpec: { name: "t", inputSchema: { json: {} } } }] } })).toMatchObject({ hasTools: true, inputBounded: true });
    for (const block of [{ image: { format: "png", source: { bytes: "AAAA" } } }, { document: { format: "pdf", name: "d", source: { bytes: "AAAA" } } }, { video: { format: "mp4", source: { bytes: "AAAA" } } }, { cachePoint: { type: "default" } }]) {
      expect(guard(CLAUDE, "converse", { messages: [{ role: "user", content: [{ text: "x" }, block] }] }), JSON.stringify(block)).toMatchObject({ ok: true, inputBounded: false });
    }
    expect(guard(CLAUDE, "converse", { ...converseBody, system: [{ text: "s" }, { cachePoint: { type: "default" } }] })).toMatchObject({ inputBounded: false });
    expect(guard(CLAUDE, "converse", { ...converseBody, toolConfig: { tools: [{ toolSpec: { name: "t", inputSchema: { json: {} } } }, { cachePoint: { type: "default" } }] } })).toMatchObject({ inputBounded: false });
    expect(guard(CLAUDE, "converse", { messages: [{ role: "user", content: [{ toolResult: { toolUseId: "t", content: [{ image: { format: "png", source: { bytes: "AAAA" } } }] } }] }] })).toMatchObject({ inputBounded: false });
  });
  it("a body with more than a million values is refused by one total count, in bounded time", () => {
    const started = Date.now();
    const big = `{"messages":[{"role":"user","content":[{"toolUse":{"toolUseId":"t","name":"n","input":{"a":[${"0,".repeat(1_100_000)}0]}}}]}]}`;
    expect(Buffer.byteLength(big)).toBeLessThan(4 * 1024 * 1024);
    expect(refusal(guard(CLAUDE, "converse", big)).code).toBe("invalid_request");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("the guard: Claude's Anthropic body through InvokeModel", () => {
  it("sends Bedrock's body: the version field, the guard's own limits, the extra Bedrock fields, no model or stream field; the stream is the operation", () => {
    const call = guard(CLAUDE, "invoke-with-response-stream", { ...anthropicBody, top_p: 0.9, top_k: 5, stop_sequences: ["x"], anthropic_beta: ["interleaved-thinking-2025-05-14"], system: "s", temperature: 0.5, tools: [{ name: "t", input_schema: { type: "object" } }] }) as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ ok: true, model: CLAUDE, maxTokens: 100, streaming: true, hasTools: true, streamContentType: "application/vnd.amazon.eventstream", path: "/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke-with-response-stream" });
    expect(parsed(call)).toEqual({ anthropic_version: "bedrock-2023-05-31", max_tokens: 100, messages: anthropicBody.messages, system: "s", temperature: 0.5, tools: [{ name: "t", input_schema: { type: "object" } }], top_p: 0.9, top_k: 5, stop_sequences: ["x"], anthropic_beta: ["interleaved-thinking-2025-05-14"] });
    const whole = guard(CLAUDE, "invoke", { anthropic_version: "bedrock-2023-05-31", messages: anthropicBody.messages }) as unknown as Record<string, unknown>;
    expect(whole.maxTokens).toBe(64_000); expect(parsed(whole).max_tokens).toBe(64_000); expect(whole.streamContentType).toBeUndefined();
  });
  it("refuses a missing or other version, an output above the ceiling, a field the Bedrock body does not take, an unlisted beta, server tools and service tiers", () => {
    const bad = (body: unknown) => refusal(guard(CLAUDE, "invoke", body)).code;
    for (const body of [
      { max_tokens: 10, messages: anthropicBody.messages }, { ...anthropicBody, anthropic_version: "2023-06-01" }, { ...anthropicBody, max_tokens: 64_001 }, { ...anthropicBody, max_tokens: 0 },
      { ...anthropicBody, model: CLAUDE }, { ...anthropicBody, stream: true }, { ...anthropicBody, metadata: { user_id: "u" } }, { ...anthropicBody, container: "x" }, { ...anthropicBody, mcp_servers: [] },
      { ...anthropicBody, anthropic_beta: ["computer-use-2025-01-24"] }, { ...anthropicBody, top_p: 2 }, { ...anthropicBody, top_k: -1 }, { ...anthropicBody, stop_sequences: "x" },
      { ...anthropicBody, tools: [{ type: "web_search_20250305", name: "web_search" }] }, { ...anthropicBody, messages: [] },
    ]) expect(bad(body), JSON.stringify(body).slice(0, 90)).toBe("invalid_request");
    expect(refusal(guard(CLAUDE, "invoke", { ...anthropicBody, service_tier: "priority" })).message).toBe(PRODUCT_BEDROCK_FEATURE);
  });
  it("keeps cache markers bounded and media unbounded like the agent guard", () => {
    expect(guard(CLAUDE, "invoke", { ...anthropicBody, messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] })).toMatchObject({ ok: true, inputBounded: true, usesPromptCache: true });
    expect(guard(CLAUDE, "invoke", anthropicBody)).toMatchObject({ inputBounded: true });
    expect(guard(CLAUDE, "invoke", { ...anthropicBody, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] })).toMatchObject({ inputBounded: false });
  });
});

describe("the guard: Titan text embeddings", () => {
  it("one text in; priced as an embedding; V2 options only on V2", () => {
    const call = guard(TITAN, "invoke", { inputText: "hello", dimensions: 512, normalize: true, embeddingTypes: ["float"] }) as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ ok: true, model: TITAN, priceKind: "embedding", maxTokens: 1, streaming: false, inputBounded: true, hasTools: false, path: "/model/amazon.titan-embed-text-v2%3A0/invoke" });
    expect(parsed(call)).toEqual({ inputText: "hello", dimensions: 512, normalize: true, embeddingTypes: ["float"] });
    expect((guard(TITAN1, "invoke", { inputText: "hello" }) as { ok: boolean }).ok).toBe(true);
    for (const body of [{}, { inputText: "" }, { inputText: 1 }, { inputText: "x", dimensions: 128 }, { inputText: "x", normalize: "yes" }, { inputText: "x", embeddingTypes: [] }, { inputText: "x", embeddingTypes: ["int8"] }, { inputText: "x", extra: 1 }, { inputText: "x".repeat(EMBEDDING_INPUT_MAX_BYTES + 1) }]) {
      expect(refusal(guard(TITAN, "invoke", body)).code, JSON.stringify(body).slice(0, 60)).toBe("invalid_request");
    }
    expect(refusal(guard(TITAN1, "invoke", { inputText: "x", dimensions: 512 })).code).toBe("invalid_request");
  });
});

// ---- usage -----------------------------------------------------------------------------------------------------------------------
function frame(headers: Record<string, string>, payload: Buffer): Buffer {
  const head = Buffer.concat(Object.entries(headers).map(([name, value]) => {
    const n = Buffer.from(name); const v = Buffer.from(value); const h = Buffer.alloc(4 + n.length + v.length);
    h.writeUInt8(n.length, 0); n.copy(h, 1); h.writeUInt8(7, 1 + n.length); h.writeUInt16BE(v.length, 2 + n.length); v.copy(h, 4 + n.length); return h;
  }));
  const total = 12 + head.length + payload.length + 4;
  const prelude = Buffer.alloc(8); prelude.writeUInt32BE(total, 0); prelude.writeUInt32BE(head.length, 4);
  const pc = Buffer.alloc(4); pc.writeUInt32BE(crc32(prelude) >>> 0, 0);
  const body = Buffer.concat([prelude, pc, head, payload]); const mc = Buffer.alloc(4); mc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([body, mc]);
}
const converseEvent = (type: string, payload: unknown): Buffer => frame({ ":event-type": type, ":message-type": "event", ":content-type": "application/json" }, Buffer.from(JSON.stringify(payload)));
const chunk = (event: Record<string, unknown>): Buffer => frame({ ":event-type": "chunk", ":message-type": "event", ":content-type": "application/json" }, Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") })));
const usage = { inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadInputTokens: 3, cacheWriteInputTokens: 2 };
const converseStream = (u: unknown = usage): Buffer[] => [converseEvent("messageStart", { role: "assistant" }), converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hi" } }), converseEvent("contentBlockStop", { contentBlockIndex: 0 }), converseEvent("messageStop", { stopReason: "end_turn" }), converseEvent("metadata", { usage: u, metrics: { latencyMs: 1 } })];
function feed(reader: BedrockUsage, bytes: Buffer, step = bytes.length) { for (let i = 0; i < bytes.length; i += step) reader.push(bytes.subarray(i, i + step)); return reader.finish(); }

describe("the usage readers", () => {
  it("Converse JSON: input, output and cache read and write; an unreadable count leaves it unknown", () => {
    const r = new BedrockUsage("converse"); r.whole({ output: {}, usage }); expect(r.finish()).toEqual({ input: 11, output: 7, cacheRead: 3, cacheWrite: 2 });
    const plain = new BedrockUsage("converse"); plain.whole({ usage: { inputTokens: 1, outputTokens: 2 } }); expect(plain.finish()).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    for (const u of [undefined, {}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 1.5, outputTokens: 1 }, { inputTokens: "1", outputTokens: 1 }, { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: "x" }, { inputTokens: 2e9, outputTokens: 1 }]) {
      const bad = new BedrockUsage("converse"); bad.whole({ usage: u }); expect(bad.finish(), JSON.stringify(u)).toBeUndefined();
    }
  });
  it("ConverseStream: the final metadata event after messageStop, at any byte boundary", () => {
    const all = Buffer.concat(converseStream());
    for (const step of [all.length, 1, 7, 64]) expect(feed(new BedrockUsage("converse-stream"), all, step), String(step)).toEqual({ input: 11, output: 7, cacheRead: 3, cacheWrite: 2 });
  });
  it("ConverseStream: no metadata, metadata before messageStop, a second metadata, an exception, a bad CRC, a cut stream and unknown events leave it unknown", () => {
    const [start, delta, stop, stopMsg, meta] = converseStream() as [Buffer, Buffer, Buffer, Buffer, Buffer];
    const exception = frame({ ":exception-type": "throttlingException", ":message-type": "exception", ":content-type": "application/json" }, Buffer.from("{}"));
    const flipped = Buffer.from(meta); flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    for (const [name, bytes] of Object.entries({
      none: Buffer.concat([start, delta, stop, stopMsg]), early: Buffer.concat([start, meta, stopMsg]), earlyOnly: Buffer.concat([start, meta]), trailingCut: Buffer.concat([start, stopMsg, meta, delta.subarray(0, 9)]),
      exceptionAsEvent: Buffer.concat([start, frame({ ":event-type": "messageStart", ":message-type": "exception", ":content-type": "application/json" }, Buffer.from("{}")), stopMsg, meta]), twice: Buffer.concat([start, stopMsg, meta, meta]), exception: Buffer.concat([start, exception]),
      crc: Buffer.concat([start, stopMsg, flipped]), cut: Buffer.concat([start, stopMsg, meta.subarray(0, meta.length - 3)]), unknown: Buffer.concat([start, converseEvent("somethingNew", {}), stopMsg, meta]),
      badUsage: Buffer.concat([start, stopMsg, converseEvent("metadata", { usage: { inputTokens: -1, outputTokens: 1 } })]), noUsage: Buffer.concat([start, stopMsg, converseEvent("metadata", {})]),
    })) expect(feed(new BedrockUsage("converse-stream"), bytes), name).toBeUndefined();
  });
  it("Claude's InvokeModel: the message's usage, whole or from the event stream's chunks", () => {
    const whole = new BedrockUsage("anthropic"); whole.whole({ type: "message", content: [], usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } });
    expect(whole.finish()).toEqual({ input: 5, output: 6, cacheRead: 1, cacheWrite: 2 });
    const noUsage = new BedrockUsage("anthropic"); noUsage.whole({ type: "message" }); expect(noUsage.finish()).toBeUndefined();
    const events = Buffer.concat([chunk({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } }), chunk({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), chunk({ type: "message_delta", usage: { output_tokens: 9 } }), chunk({ type: "message_stop" })]);
    for (const step of [events.length, 1, 13]) expect(feed(new BedrockUsage("anthropic-stream"), events, step), String(step)).toMatchObject({ input: 5, output: 9 });
    expect(feed(new BedrockUsage("anthropic-stream"), events.subarray(0, events.length - 5))).toBeUndefined();
    expect(feed(new BedrockUsage("anthropic-stream"), Buffer.concat([chunk({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } }), chunk({ type: "message_stop" })]))).toBeUndefined();
    expect(feed(new BedrockUsage("anthropic-stream"), Buffer.from("not an event stream at all......"))).toBeUndefined();
  });
  it("Titan: the input token count; a missing or odd count is unknown; a stream is never read", () => {
    const r = new BedrockUsage("embedding"); r.whole({ embedding: [0.1], inputTextTokenCount: 12 }); expect(r.finish()).toEqual({ input: 12, output: 0, cacheRead: 0, cacheWrite: 0 });
    for (const answer of [{ embedding: [] }, { inputTextTokenCount: -1 }, { inputTextTokenCount: 1.5 }, { inputTextTokenCount: "12" }]) { const bad = new BedrockUsage("embedding"); bad.whole(answer); expect(bad.finish(), JSON.stringify(answer)).toBeUndefined(); }
    const stream = new BedrockUsage("embedding"); stream.push(Buffer.from("x")); expect(stream.finish()).toBeUndefined();
  });
});

describe("Bedrock's error classes", () => {
  const body = (text: string) => Buffer.from(text);
  it("tell not-enabled, refused, quota, throttled and invalid apart; everything else is unavailable (charged by the route)", () => {
    expect(bedrockFailureKind(403, body("AccessDeniedException\nYou don't have access to the model with the specified model ID."), BEDROCK_MODEL_ACCESS_WORDS)).toBe("not_enabled");
    expect(bedrockFailureKind(403, body("AccessDeniedException\nUser is not authorized to perform bedrock:InvokeModel"), BEDROCK_MODEL_ACCESS_WORDS)).toBe("refused");
    expect(bedrockFailureKind(401, undefined, BEDROCK_MODEL_ACCESS_WORDS)).toBe("refused");
    expect(bedrockFailureKind(400, body("ServiceQuotaExceededException\nquota"), BEDROCK_MODEL_ACCESS_WORDS)).toBe("quota");
    expect(bedrockFailureKind(429, body("ThrottlingException\nToo many requests"), BEDROCK_MODEL_ACCESS_WORDS)).toBe("throttled");
    expect(bedrockFailureKind(429, undefined, BEDROCK_MODEL_ACCESS_WORDS)).toBe("throttled");
    expect(bedrockFailureKind(400, body("ValidationException\nbad"), BEDROCK_MODEL_ACCESS_WORDS)).toBe("invalid");
    expect(bedrockFailureKind(404, undefined, BEDROCK_MODEL_ACCESS_WORDS)).toBe("invalid");
    for (const status of [408, 424, 500, 503, 529]) expect(bedrockFailureKind(status, body("ModelTimeoutException\nx"), BEDROCK_MODEL_ACCESS_WORDS), String(status)).toBe("unavailable");
    // The quota words count only as the error type (the first line), never from a customer's text deeper in the body.
    expect(bedrockFailureKind(400, body("ValidationException\nServiceQuotaExceededException"), BEDROCK_MODEL_ACCESS_WORDS)).toBe("invalid");
  });
});

// ---- transport -------------------------------------------------------------------------------------------------------------------
const credentials = { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "session-token-example", expiresAt: Date.UTC(2030, 0, 1) };
interface Sent { options: https.RequestOptions; body: Buffer }
function fakeRequest(status: number, chunks: Buffer[], headers: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const request = ((options: https.RequestOptions, onResponse: (response: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    const call = new EventEmitter() as EventEmitter & { end(body: Buffer): void; destroy(): void };
    call.destroy = () => undefined;
    call.end = (body: Buffer) => {
      sent.push({ options, body });
      const response = Object.assign(new PassThrough(), { statusCode: status, headers });
      setImmediate(() => { onResponse(response); for (const c of chunks) response.write(c); response.end(); });
    };
    return call;
  }) as unknown as typeof https.request;
  return { request, sent };
}
const readAll = async (body: AsyncIterable<Uint8Array>) => { const parts: Buffer[] = []; for await (const p of body) parts.push(Buffer.from(p)); return Buffer.concat(parts); };
const send = (transport: ReturnType<typeof createBedrockProductTransport>, path: string | undefined, body = Buffer.from("{}")) => transport({ body, headers: { "content-type": "application/json" }, key: "byo-bedrock-x", signal: new AbortController().signal, ...(path === undefined ? {} : { path }) });

describe("the passthrough transport", () => {
  const fixedNow = Date.UTC(2026, 10, 16, 12, 0, 0);
  it("signs for the connection's Region only, rebuilds nothing from the request, forwards the answer's bytes unchanged, and sends only the signed headers", async () => {
    const answer = Buffer.from('{"output":{},"usage":{"inputTokens":1,"outputTokens":1}}');
    const f = fakeRequest(200, [answer]);
    const transport = createBedrockProductTransport({ region: "eu-west-1", credentials: async () => credentials, request: f.request, now: () => fixedNow });
    const response = await send(transport, bedrockProductPath(CLAUDE, "converse"), Buffer.from('{"a":1}'));
    expect(response.status).toBe(200);
    expect((await readAll(response.body)).equals(answer)).toBe(true);
    const { options, body } = f.sent[0]!;
    expect(options).toMatchObject({ hostname: "bedrock-runtime.eu-west-1.amazonaws.com", port: 443, method: "POST", path: "/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse", rejectUnauthorized: true, agent: false });
    expect(body.toString()).toBe('{"a":1}');
    const headers = options.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["accept", "authorization", "content-length", "content-type", "host", "x-amz-date", "x-amz-security-token"]);
    expect(headers.authorization).toContain("Credential=ASIAEXAMPLE/20261116/eu-west-1/bedrock/aws4_request");
    expect(headers.accept).toBe("application/json");
  });
  it("a streamed operation asks for the event stream and returns it as it comes", async () => {
    const f = fakeRequest(200, [converseEvent("messageStart", { role: "assistant" })]);
    const transport = createBedrockProductTransport({ region: "us-west-2", credentials: async () => credentials, request: f.request, now: () => fixedNow });
    const response = await send(transport, bedrockProductPath(NOVA, "converse-stream"));
    expect((f.sent[0]!.options.headers as Record<string, string>).accept).toBe("application/vnd.amazon.eventstream");
    expect((await readAll(response.body)).length).toBeGreaterThan(0);
  });
  it("a failed answer carries Bedrock's error type first (so a quota is told from a validation error), without header injection", async () => {
    for (const [type, expected] of [["ServiceQuotaExceededException:http://internal.amazon.com/coral/", "ServiceQuotaExceededException\n"], ["bad\r\ntype", "Unknown\n"], [undefined, "Unknown\n"]] as const) {
      const f = fakeRequest(400, [Buffer.from('{"message":"x"}')], type === undefined ? {} : { "x-amzn-errortype": type });
      const response = await send(createBedrockProductTransport({ region: "us-west-2", credentials: async () => credentials, request: f.request }), bedrockProductPath(NOVA, "converse"));
      expect(response.status).toBe(400);
      expect((await readAll(response.body)).toString()).toBe(`${expected}{"message":"x"}`);
    }
  });
  it("sends nothing for a path or id the product route would not have built (not sent: free)", async () => {
    const f = fakeRequest(200, []);
    const transport = createBedrockProductTransport({ region: "us-west-2", credentials: async () => credentials, request: f.request });
    // The path must be exactly the one the route builds: a raw ":" or a lower-case escape is another spelling, not sent.
    for (const path of ["/model/us.amazon.nova-pro-v1:0/converse", "/model/us.amazon.nova-pro-v1%3a0/converse"]) await expect(send(transport, path), path).rejects.toBeInstanceOf(NotSentError);
    for (const path of [undefined, "/model/x/converse", "/model/arn%3Aaws%3Abedrock%3Aus-west-2%3A1%3Aprovisioned-model%2Fabc/converse", `/model/${NOVA}/invoke`, `/model/${encodeURIComponent(TITAN)}/converse`, `/model/${encodeURIComponent(NOVA)}/converse?x=1`, "/model/%2e%2e/converse", `/model/${encodeURIComponent(NOVA)}/invoke-with-response-stream`, "/v1/messages"]) {
      await expect(send(transport, path), String(path)).rejects.toBeInstanceOf(NotSentError);
    }
    expect(f.sent).toHaveLength(0);
    expect(() => createBedrockProductTransport({ region: "evil.example.com/x", credentials: async () => credentials })).toThrow();
    const aborted = new AbortController(); aborted.abort();
    await expect(transport({ body: Buffer.from("{}"), headers: {}, key: "k", signal: aborted.signal, path: bedrockProductPath(NOVA, "converse") })).rejects.toBeInstanceOf(NotSentError);
    const noCredentials = createBedrockProductTransport({ region: "us-west-2", credentials: async () => { throw new Error("none"); }, request: f.request });
    await expect(send(noCredentials, bedrockProductPath(NOVA, "converse"))).rejects.toBeInstanceOf(NotSentError);
  });
});

describe("the model limits the product route reads", () => {
  it("are the price snapshot's rows for Gemini and Bedrock only (other providers have none here)", async () => {
    const { productModelLimitsFrom } = await import("../../packages/model-gateway/src/product-route.js");
    const asked: string[] = [];
    const limits = productModelLimitsFrom({ maxOutputTokens: (provider, model) => { asked.push(`${provider}/${model}`); return 123; } });
    expect(limits.maxOutputTokens("bedrock", CLAUDE)).toBe(123);
    expect(limits.maxOutputTokens("gemini", "gemini-2.5-flash")).toBe(123);
    expect(limits.maxOutputTokens("anthropic", "claude")).toBeUndefined();
    expect(limits.maxOutputTokens("vertex", "x")).toBeUndefined();
    expect(asked).toEqual([`bedrock/${CLAUDE}`, "gemini/gemini-2.5-flash"]);
  });
});

describe("the engine bridge contract v2", () => {
  it("the shared JSON equals the module and its SHA-256 is pinned (Code's worker copies it); the Gemini and Vertex contracts are unchanged", async () => {
    const { readFileSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { PRODUCT_BEDROCK_BRIDGE, PRODUCT_VERTEX_BRIDGE } = await import("../../packages/model-gateway/src/product-bridge.js");
    const bytes = readFileSync("contracts/shared/model-gateway-product-bedrock.v2.json");
    expect(JSON.parse(bytes.toString())).toEqual(JSON.parse(JSON.stringify(PRODUCT_BEDROCK_BRIDGE)));
    expect(bytes.toString().endsWith("}\n")).toBe(true); expect(bytes.toString()).not.toContain("\r");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("56de3ce598616737dd4bec9fe74dd3ab01ef6b14d2171487c35c280117bc04ca");
    expect(PRODUCT_BEDROCK_BRIDGE.version).toBe(2);
    // The worker removes every credential the sandbox's SDK signed with; the gateway refuses what is left (the same names).
    for (const name of PRODUCT_BEDROCK_BRIDGE.provider.workerRemovesHeaders) expect(PRODUCT_BEDROCK_BRIDGE.provider.workerRemovesHeaders).toContain(name);
    expect(PRODUCT_BEDROCK_BRIDGE.provider.gatewayRefusesHeaders).toEqual(expect.arrayContaining(["authorization", "x-amz-security-token", "x-amzn-bedrock-*"]));
    expect(PRODUCT_BEDROCK_BRIDGE.bridge).toBe("model-gateway-product-ai.v1.json");
    expect(readFileSync("contracts/shared/model-gateway-product-vertex.v1.json").toString()).toEqual(JSON.stringify(PRODUCT_VERTEX_BRIDGE, null, 2) + "\n");
  });
});
