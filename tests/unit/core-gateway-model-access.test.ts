// Switch-on lane L2b (DEC 236): the core engine's model keys live in the model gateway. Code holds no key: the model-keys point is a store that never gives
// one, every core step is dispatched to the gateway's agent model, and the broker's core callback layer answers a worker's model-access request with a task
// token (purpose `task`) for the gateway. Neither setting: nothing changes (the point stays empty and the registry refuses by name, as before).
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { TASK_KEY_PURPOSE, type OrgId } from "@agentx/contracts";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { brokerCoreModuleDeps, createBrokerCoreRoot, taskTokensFromEnvironment, type BrokerCoreRootInputs } from "../../packages/broker/src/aws/core-engine-root.js";
import { hostedDispatcherFlow } from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import { mintTaskToken } from "../../packages/broker/src/core/model-gateway/token.js";
import { MODEL_ACCESS_PATH } from "../../packages/broker/src/core/model-gateway/route.js";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import {
  AGENT_MODEL_INVALID, CORE_AGENT_MODEL_VARIABLE, GATEWAY_TASK_TOKENS_MISSING, coreModelGatewayWiring, CORE_MODEL_GATEWAY_URL_VARIABLE, GATEWAY_MODEL_KEYS, GATEWAY_SETTINGS_PARTIAL, GATEWAY_URL_INVALID,
  gatewayForCallbacks, gatewayModelAccessFromEnvironment, gatewayModelKeyStore, gatewayModelKeysModules, gatewayModelRoute, readGatewayModelAccess, taskKeySigner,
} from "../../packages/broker/src/core-host/gateway-model-access.js";

const ORG_A = "org_staging0000000000001" as OrgId;
const ORG_B = "org_staging0000000000002" as OrgId;
const URL_ = "https://gateway.staging.example";
const MODEL = "claude-sonnet-4-5";
const ENV = { [CORE_MODEL_GATEWAY_URL_VARIABLE]: URL_, [CORE_AGENT_MODEL_VARIABLE]: MODEL };
const context = { installCompanyId: "default", now: () => new Date(), env: {}, clients: {}, log: () => undefined };
const registry = { get: () => undefined, require: () => { throw new Error("unused"); }, names: () => [] } as never;

describe("the gateway settings", () => {
  it("neither set: nothing (today's behaviour)", () => {
    expect(readGatewayModelAccess({})).toBeUndefined();
    expect(readGatewayModelAccess({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: " ", [CORE_AGENT_MODEL_VARIABLE]: "" })).toBeUndefined();
    expect(gatewayModelKeysModules({})).toEqual([]);
    expect(gatewayModelAccessFromEnvironment({})).toBeUndefined();
  });
  it("both set: the gateway's origin and the agent model on the Anthropic Messages route", () => {
    expect(readGatewayModelAccess(ENV)).toEqual({ gatewayUrl: URL_, route: { alias: MODEL, api: "anthropic-messages", catalog: MODEL } });
    expect(readGatewayModelAccess({ ...ENV, [CORE_MODEL_GATEWAY_URL_VARIABLE]: `${URL_}/` })).toEqual({ gatewayUrl: URL_, route: { alias: MODEL, api: "anthropic-messages", catalog: MODEL } });
  });
  it("one without the other refuses in fixed words", () => {
    expect(readGatewayModelAccess({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: URL_ })).toEqual({ problem: GATEWAY_SETTINGS_PARTIAL });
    expect(readGatewayModelAccess({ [CORE_AGENT_MODEL_VARIABLE]: MODEL })).toEqual({ problem: GATEWAY_SETTINGS_PARTIAL });
  });
  it("refuses anything but an https origin, without echoing it", () => {
    for (const bad of ["http://gateway.example", "https://u:p@gateway.example", "https://gateway.example/v1", "https://gateway.example?x=1", "https://gateway.example#f", "not a url", "https://gateway.example//", `https://${"a".repeat(600)}.example`]) {
      const read = readGatewayModelAccess({ ...ENV, [CORE_MODEL_GATEWAY_URL_VARIABLE]: bad });
      expect(read, bad).toEqual({ problem: GATEWAY_URL_INVALID });
      expect(() => gatewayModelAccessFromEnvironment({ ...ENV, [CORE_MODEL_GATEWAY_URL_VARIABLE]: bad })).toThrow(GATEWAY_URL_INVALID);
    }
  });
  it("refuses anything but an Anthropic model id (the gateway's agent route is Anthropic Messages)", () => {
    for (const bad of ["gpt-6", "Claude-sonnet", "claude-", "claude-sonnet 4", `claude-${"a".repeat(120)}`, "claude-x/../y"]) {
      expect(readGatewayModelAccess({ ...ENV, [CORE_AGENT_MODEL_VARIABLE]: bad }), bad).toEqual({ problem: AGENT_MODEL_INVALID });
    }
  });
});

describe("the model-keys point (Code holds no key)", () => {
  it("never gives a key, for any company or provider, and says the gateway holds them", async () => {
    const store = gatewayModelKeyStore();
    expect(store.heldBy).toBe(GATEWAY_MODEL_KEYS);
    for (const company of [ORG_A, ORG_B, "default"]) for (const provider of ["anthropic", "openai", "google"]) expect(await store.get(company, provider)).toBeUndefined();
    expect(await store.providers(ORG_A)).toEqual([]);
  });
  it("is one deployed module (never a laptop default) where the gateway is configured, and refuses the registry when broken", async () => {
    const [module, ...rest] = gatewayModelKeysModules(ENV);
    expect(rest).toEqual([]);
    expect(module!.point).toBe("model-keys");
    expect(module!.name).toBe(GATEWAY_MODEL_KEYS);
    expect(module!.isDefault).toBeUndefined();
    expect(await (await module!.create(context, registry) as ReturnType<typeof gatewayModelKeyStore>).get(ORG_A, "anthropic")).toBeUndefined();
    const [broken] = gatewayModelKeysModules({ [CORE_MODEL_GATEWAY_URL_VARIABLE]: URL_ });
    expect(() => broken!.create(context, registry)).toThrow(GATEWAY_SETTINGS_PARTIAL);
  });
});

describe("the dispatcher's flow inputs", () => {
  it("declare the gateway's agent model as every core step's route where configured, and no route otherwise", async () => {
    expect(hostedDispatcherFlow({})).toEqual({ standingInstructions: null, modelAccess: null, learned: null });
    const flow = hostedDispatcherFlow(ENV);
    expect(flow?.standingInstructions).toBeNull();
    expect(flow?.learned).toBeNull();
    expect(await flow?.modelAccess?.route()).toEqual({ alias: MODEL, api: "anthropic-messages", catalog: MODEL });
  });
  it("declare nothing (every core record comes back) for a broken setting, and nothing while lessons are on, as before", () => {
    expect(hostedDispatcherFlow({ [CORE_AGENT_MODEL_VARIABLE]: MODEL })).toBeUndefined();
    expect(hostedDispatcherFlow({ ...ENV, [CORE_MODEL_GATEWAY_URL_VARIABLE]: "http://x.example" })).toBeUndefined();
    expect(hostedDispatcherFlow({ ...ENV, ROVARA_CORE_LESSONS: "on" })).toBeUndefined();
  });
  it("hands out a copy of the route: a caller cannot change the next step's model", async () => {
    const access = gatewayModelRoute(gatewayModelAccessFromEnvironment(ENV)!);
    const first = await access.route();
    first.alias = "claude-other";
    expect((await access.route()).alias).toBe(MODEL);
  });
});

// ---- the task token for the gateway
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.publicKey.export({ type: "spki", format: "der" });
const exported = pair.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const kmsLike: TokenSigner = {
  publicJwk: async () => ({ kty: "RSA", n: exported.n, e: exported.e, kid: createHash("sha256").update(der).digest("base64url").slice(0, 16), alg: "RS256", use: "sig" }),
  sign: async (input) => sign("sha256", input, pair.privateKey),
};
const operation = { workspaceId: randomUUID(), operationId: randomUUID(), fence: 1 };
const describer = (companyId: OrgId) => ({ describe: async () => ({ companyId, project: "web", person: "a".repeat(64), payer: { kind: "member" as const, developerId: "a".repeat(64) }, taskId: `task_${"1".repeat(26)}`, step: "build", models: [MODEL] }) });
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

describe("the broker's model gateway for core callbacks", () => {
  it("mints a task token for the company's own operation and the agent model, signed by the task key with purpose `task`", async () => {
    const settings = gatewayModelAccessFromEnvironment(ENV)!;
    const gateway = gatewayForCallbacks(settings, { issuer: "https://api.staging.example/v1/auth", signer: taskKeySigner(kmsLike), describer: describer(ORG_A) });
    expect(gateway.gatewayUrl).toBe(URL_);
    expect((await gateway.signer.publicJwk()).rovara_purpose).toBe(TASK_KEY_PURPOSE);
    const minted = await mintTaskToken({ ...gateway, now: () => 1_800_000_000_000 }, operation);
    const claims = claimsOf(minted.token);
    expect(claims).toMatchObject({ iss: "https://api.staging.example/v1/auth", aud: "rovara-model-gateway", cid: ORG_A, pid: "web", mdl: [MODEL], ws: operation.workspaceId, op: operation.operationId });
    // The token's company is the describer's (the checked records'), never a setting of the gateway wiring.
    const other = await mintTaskToken({ ...gatewayForCallbacks(settings, { issuer: "https://api.staging.example/v1/auth", signer: taskKeySigner(kmsLike), describer: describer(ORG_B) }), now: () => 1_800_000_000_000 }, operation);
    expect(claimsOf(other.token).cid).toBe(ORG_B);
  });
  it("the broker's wiring: none without settings; configured without the task-token key or issuer, refused (so no task starts)", async () => {
    expect(coreModelGatewayWiring({}, undefined)).toBeUndefined();
    expect(coreModelGatewayWiring({}, () => { throw new Error("not asked"); })).toBeUndefined();
    for (const tokens of [undefined, () => undefined, () => ({ signer: taskKeySigner(kmsLike), issuer: "" }), () => ({ signer: {} as TokenSigner, issuer: "https://api.example/v1/auth" })]) {
      expect(() => coreModelGatewayWiring(ENV, tokens)).toThrow(GATEWAY_TASK_TOKENS_MISSING);
    }
    expect(() => coreModelGatewayWiring({ [CORE_AGENT_MODEL_VARIABLE]: MODEL }, () => ({ signer: taskKeySigner(kmsLike), issuer: "https://api.example/v1/auth" }))).toThrow(GATEWAY_SETTINGS_PARTIAL);
    const wiring = coreModelGatewayWiring(ENV, () => ({ signer: taskKeySigner(kmsLike), issuer: "https://api.staging.example/v1/auth" }))!;
    expect(await wiring.flowOptions.modelAccess.route()).toEqual({ alias: MODEL, api: "anthropic-messages", catalog: MODEL });
    const gateway = wiring.callbackGateway(describer(ORG_A));
    expect(gateway.gatewayUrl).toBe(URL_);
    expect(claimsOf((await mintTaskToken({ ...gateway, now: () => 1_800_000_000_000 }, operation)).token)).toMatchObject({ cid: ORG_A, mdl: [MODEL], iss: "https://api.staging.example/v1/auth" });
  });
  it("the broker's task tokens from its environment: the KMS task key stamped with purpose `task`, or nothing without the key or the issuer", async () => {
    // A fake KMS by the command's input shape (a Sign carries the message; GetPublicKey only the key id).
    const kms = { send: async (command: unknown) => {
      const input = (command as { input: { Message?: Uint8Array } }).input;
      return input.Message === undefined ? { PublicKey: new Uint8Array(der), KeyUsage: "SIGN_VERIFY" } : { Signature: new Uint8Array(sign("sha256", Buffer.from(input.Message), pair.privateKey)) };
    } };
    expect(taskTokensFromEnvironment({}, kms)).toBeUndefined();
    expect(taskTokensFromEnvironment({ TASK_TOKEN_KEY_ARN: "arn:aws:kms:us-west-2:111122223333:key/k" }, kms)).toBeUndefined();
    expect(taskTokensFromEnvironment({ DEVELOPER_TOKEN_ISSUER: "https://api.example/v1/auth" }, kms)).toBeUndefined();
    const tokens = taskTokensFromEnvironment({ TASK_TOKEN_KEY_ARN: "arn:aws:kms:us-west-2:111122223333:key/k", DEVELOPER_TOKEN_ISSUER: "https://api.example/v1/auth" }, kms)!;
    expect(tokens.issuer).toBe("https://api.example/v1/auth");
    expect((await tokens.signer.publicJwk()).rovara_purpose).toBe(TASK_KEY_PURPOSE);
    const minted = await mintTaskToken({ ...coreModelGatewayWiring(ENV, () => tokens)!.callbackGateway(describer(ORG_A)), now: () => 1_800_000_000_000 }, operation);
    expect(claimsOf(minted.token).cid).toBe(ORG_A);
  });
  it("the bare KMS key (no purpose) is refused by the minter: the purpose is what the wrapper adds", async () => {
    await expect(mintTaskToken({ signer: kmsLike, issuer: "https://api.staging.example/v1/auth", describer: describer(ORG_A), now: () => 1_800_000_000_000 }, operation)).rejects.toThrow();
    const wrapped = taskKeySigner(kmsLike);
    expect((await wrapped.sign(Buffer.from("x"))).equals(await kmsLike.sign(Buffer.from("x")))).toBe(true);
  });
});

// ---- the root routes a core worker's model-access request
const SIGNING = "k".repeat(32);
function tables() {
  const reads: string[] = [];
  return { reads, client: { async send(command: unknown) { if (!(command instanceof GetCommand)) throw new Error("only reads"); reads.push(String((command.input.Key as { pk?: unknown } | undefined)?.pk)); return { Item: undefined }; } } };
}
function root(env: NodeJS.ProcessEnv, client: BrokerCoreRootInputs["documentClient"]) {
  return createBrokerCoreRoot({
    env, documentClient: client, stateTableName: "state", signInTableName: "signin", callbackSigningKey: SIGNING, repositoryGrantKey: Buffer.alloc(32, 1),
    repositoryCredential: async () => { throw new Error("unused"); }, codeModules: () => brokerCoreModuleDeps(env), origin: () => "https://api.example", log: () => undefined,
  });
}
const ON = { ROVARA_CORE_ENGINE: "on", ROVARA_CORE_ALLOWED_COMPANIES: ORG_A, ...ENV };
const capability = (workspaceId: string, actions: string[] = ["model-access"]) => new CallbackCapabilities(Buffer.from(SIGNING)).issue({ workspaceId, operationId: randomUUID(), fence: 1, actions: actions as never, expiresInSeconds: 600 });

describe("the broker's core root: a worker's model-access request", () => {
  it("is looked up only when its capability verifies for model access; a workflow workspace's request is not the core's", async () => {
    const t = tables();
    const r = root(ON, t.client);
    const workspaceId = randomUUID();
    const get = (token: string | undefined, path = MODEL_ACCESS_PATH, method = "GET") => r.callback({ method, path, headers: token === undefined ? {} : { "x-agentx-callback-capability": token } });
    // Forged, foreign-key, wrong action, wrong method or path: not even read.
    const forged = `${Buffer.from(JSON.stringify({ workspaceId, operationId: randomUUID(), fence: 1, actions: ["model-access"], expiresAt: 9_999_999_999 })).toString("base64url")}.AAAA`;
    expect(await get(forged)).toBeUndefined();
    expect(await get(new CallbackCapabilities(Buffer.from("z".repeat(32))).issue({ workspaceId, operationId: randomUUID(), fence: 1, actions: ["model-access"], expiresInSeconds: 600 }))).toBeUndefined();
    expect(await get(capability(workspaceId, ["events"]))).toBeUndefined();
    expect(await get(capability(workspaceId), MODEL_ACCESS_PATH, "POST")).toBeUndefined();
    expect(await get(capability(workspaceId), "/v1/internal/model-accessx")).toBeUndefined();
    expect(await get(undefined)).toBeUndefined();
    const expired = `${Buffer.from(JSON.stringify({ workspaceId, operationId: randomUUID(), fence: 1, actions: ["model-access"], expiresAt: 1 })).toString("base64url")}`;
    const { createHmac } = await import("node:crypto");
    expect(await get(`${expired}.${createHmac("sha256", Buffer.from(SIGNING)).update(expired).digest("base64url")}`)).toBeUndefined();
    expect(t.reads).toEqual([]);
    // A verified one: its workspace is looked up (a workspace with no core task is the old routes').
    expect(await get(capability(workspaceId))).toBeUndefined();
    expect(t.reads).toEqual([`WORKSPACE#${workspaceId}`]);
  });
  it("is never looked up while the switch is off", async () => {
    const t = tables();
    expect(await root(ENV, t.client).callback({ method: "GET", path: MODEL_ACCESS_PATH, headers: { "x-agentx-callback-capability": capability(randomUUID()) } })).toBeUndefined();
    expect(t.reads).toEqual([]);
  });
});
