// DEC 238 slice 1: bring your own Bedrock, the pieces with no network. The connection a company admin sends (strict parse), the
// external id (an HMAC of install and company that only the gateway makes), the customer role's template on the docs site, the
// one-command set-up, and the key store's rules: company-level only, one per company, a connection test that must pass, and a
// role already connected by another company refused (two companies throughout).
import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BedrockExternalIds, allowedBedrockModel, bedrockExternalIdMessage, bedrockModelPresets, bedrockResourceArns, bedrockRoleClaim, bedrockRoleTemplateSha256, bedrockRoleTemplateText, bedrockSetupCommand,
  parseBedrockConnect, serializeBedrockConnection, validTemplateUrl, type BedrockConnection,
} from "../../packages/model-gateway/src/bedrock-byo.js";
import { ROVARA_AI_US_MODELS } from "../../packages/model-gateway/src/agent-ai.js";
import { BEDROCK_ROLE_CLAIMS, BEDROCK_SOURCE_ID, InMemoryProductKeyTable, PRODUCT_COMPANY_OWNER, ProductKeyStore, type BedrockCheck, type ProductKeyError } from "../../packages/model-gateway/src/product-keys.js";
import { hmacFingerprinter, localProductKeyService, ProductKeySealer } from "../../packages/model-gateway/src/product-seal.js";

const ISS = "https://code.example.test/v1/auth";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const ROLE_A = `arn:aws:iam::111111111111:role/RovaraBedrockInvoke-${A}`;
const ROLE_B = `arn:aws:iam::222222222222:role/RovaraBedrockInvoke-${B}`;
const SONNET = "us.anthropic.claude-sonnet-5-5";
const conn = (over: Record<string, unknown> = {}) => JSON.stringify({ scheme: "assume_role", roleArn: ROLE_A, region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false, ...over });
const BROKER = "arn:aws:iam::123456789012:role/RovaraBedrockBroker-staging";
const EXT = `rvb-${"a1".repeat(20)}`;

describe("the connection a company admin sends", () => {
  it("takes exactly the scheme, an invoke role of the fixed prefix, a commercial Region and 1 to 8 picked Claude models", () => {
    expect(parseBedrockConnect(conn())).toEqual({ scheme: "assume_role", roleArn: ROLE_A, region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false });
    // Dates, versions and the profile prefix aside, the name and the id are one model.
    expect(parseBedrockConnect(conn({ models: { "claude-haiku-4-5-20251001": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5": "anthropic.claude-haiku-4-5-20251001-v1:0" } }))).toBeDefined();
    expect(parseBedrockConnect(conn({ models: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`claude-m${String(i)}`, `us.anthropic.claude-m${String(i)}`])) }))).toBeDefined();
    expect(parseBedrockConnect(conn({ region: "eu-west-1", models: { "claude-sonnet-5-5": "eu.anthropic.claude-sonnet-5-5", "claude-haiku-4-5": "anthropic.claude-haiku-4-5-20251001-v1:0" } }))).toBeDefined();
    const refused = [
      conn({ roleArn: "arn:aws:iam::111111111111:role/Admin" }), // not the template's role
      conn({ roleArn: `arn:aws:iam::111111111111:role/path/RovaraBedrockInvoke-${A}` }), // a path
      conn({ roleArn: `arn:aws-us-gov:iam::111111111111:role/RovaraBedrockInvoke-${A}` }), // another partition
      conn({ roleArn: `arn:aws:iam::11111111111:role/RovaraBedrockInvoke-${A}` }),
      conn({ region: "us-gov-west-1" }), conn({ region: "cn-north-1" }), conn({ region: "US-WEST-2" }),
      conn({ models: {} }), conn({ models: { "gpt-4": SONNET } }), conn({ models: { "claude-sonnet-5-5": "meta.llama3" } }),
      conn({ models: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`claude-m${String(i)}`, `us.anthropic.claude-m${String(i)}`])) }),
      // The agent's name must be the same model as the id: never a cheaper name for a dearer model (priced and sent as asked).
      conn({ models: { "claude-haiku-4-5": SONNET } }), conn({ models: { "claude-sonnet-5": SONNET } }),
      conn({ models: { "claude-sonnet-5-5": "eu.anthropic.claude-sonnet-5-5" } }), // another geography's profile
      conn({ models: { "claude-sonnet-5-5": "global.anthropic.claude-sonnet-5-5" } }), // global routing not allowed
      conn({ allowGlobal: "false" }), conn({ scheme: "access_key" }), conn({ extra: 1 }), "not json", JSON.stringify([conn()]),
    ];
    for (const text of refused) expect(parseBedrockConnect(text), text).toBeUndefined();
    const missing = JSON.parse(conn()) as Record<string, unknown>;
    delete missing.allowGlobal;
    expect(parseBedrockConnect(JSON.stringify(missing))).toBeUndefined();
  });

  it("global routing only when the admin turns it on; geography prefixes match the Region's geography", () => {
    expect(allowedBedrockModel("global.anthropic.claude-sonnet-5-5", "us-west-2", true)).toBe(true);
    expect(allowedBedrockModel("global.anthropic.claude-sonnet-5-5", "us-west-2", false)).toBe(false);
    expect(allowedBedrockModel("apac.anthropic.claude-sonnet-5-5", "ap-southeast-2", false)).toBe(true);
    expect(allowedBedrockModel("us.anthropic.claude-sonnet-5-5", "ap-southeast-2", false)).toBe(false);
    expect(allowedBedrockModel("anthropic.claude-sonnet-5-5", "sa-east-1", false)).toBe(true);
    expect(parseBedrockConnect(conn({ allowGlobal: true, models: { "claude-sonnet-5-5": "global.anthropic.claude-sonnet-5-5" } }))?.allowGlobal).toBe(true);
  });

  it("seals one canonical text whatever the order the models came in", () => {
    const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    const one = parseBedrockConnect(conn({ models: { "claude-sonnet-5-5": SONNET, "claude-haiku-4-5": HAIKU } }))!;
    const two = parseBedrockConnect(conn({ models: { "claude-haiku-4-5": HAIKU, "claude-sonnet-5-5": SONNET } }))!;
    expect(serializeBedrockConnection(one)).toBe(serializeBedrockConnection(two));
    expect(parseBedrockConnect(serializeBedrockConnection(one))).toEqual(one);
  });

  it("claims a role by account and lower-cased name (IAM role names ignore case): two spellings are one role", () => {
    expect(bedrockRoleClaim(ROLE_A)).toBe(bedrockRoleClaim(ROLE_A.replace("RovaraBedrockInvoke-org_aaaa", "RovaraBedrockInvoke-ORG_AAAA")));
    expect(bedrockRoleClaim(ROLE_A)).not.toBe(bedrockRoleClaim(ROLE_A.replace("111111111111", "333333333333")));
    expect(() => bedrockRoleClaim("arn:aws:iam::111111111111:role/Admin")).toThrow();
  });
});

describe("the external id", () => {
  const kms = () => {
    const key = randomBytes(32); const calls: Uint8Array[] = []; let fail = false;
    return {
      calls, set fail(v: boolean) { fail = v; },
      generateMac: async (input: { KeyId: string; Message: Uint8Array }) => {
        calls.push(input.Message);
        if (fail) throw new Error("kms down");
        const { createHmac } = await import("node:crypto");
        return { Mac: new Uint8Array(createHmac("sha256", key).update(input.Message).digest()) };
      },
    };
  };
  it("is rvb- plus 40 hex characters, different per company and per install, and the same each time for one company", async () => {
    const k = kms(); const ids = new BedrockExternalIds(k, "key-arn");
    const a = await ids.of(ISS, A); const b = await ids.of(ISS, B);
    expect(a).toMatch(/^rvb-[0-9a-f]{40}$/u);
    expect(b).not.toBe(a);
    expect(await ids.of("https://other.example.test/v1/auth", A)).not.toBe(a);
    expect(await new BedrockExternalIds(k, "key-arn").of(ISS, A)).toBe(a);
    // Cached: one KMS call per install and company.
    const before = k.calls.length; await ids.of(ISS, A);
    expect(k.calls.length).toBe(before);
    expect(Buffer.from(k.calls[0]!)).toEqual(Buffer.from(bedrockExternalIdMessage(ISS, A)));
  });
  it("refuses a malformed company, and never caches a KMS failure", async () => {
    const k = kms(); const ids = new BedrockExternalIds(k, "key-arn");
    await expect(ids.of(ISS, "org_x")).rejects.toThrow();
    k.fail = true;
    await expect(ids.of(ISS, A)).rejects.toThrow("bedrock external id unavailable");
    k.fail = false;
    expect(await ids.of(ISS, A)).toMatch(/^rvb-/u);
  });
  it("refuses a MAC that is not 32 bytes", async () => {
    const ids = new BedrockExternalIds({ generateMac: async () => ({ Mac: new Uint8Array(16) }) }, "k");
    await expect(ids.of(ISS, A)).rejects.toThrow();
  });
});

describe("the customer's role", () => {
  it("the docs-site template is exactly the generated one", () => {
    expect(readFileSync(new URL("../../docs/bedrock/rovara-bedrock-role.json", import.meta.url), "utf8")).toBe(bedrockRoleTemplateText());
  });

  it("trusts only the broker, with the company's external id AND its company id as the session name; invoke only, on the chosen ARNs", () => {
    const t = JSON.parse(bedrockRoleTemplateText()) as { Resources: { RovaraBedrockInvokeRole: { Properties: Record<string, unknown> } } };
    const role = t.Resources.RovaraBedrockInvokeRole.Properties as { RoleName: unknown; MaxSessionDuration: number; AssumeRolePolicyDocument: { Statement: unknown[] }; Policies: Array<{ PolicyDocument: { Statement: Array<Record<string, unknown>> } }> };
    expect(role.RoleName).toEqual({ "Fn::Sub": "RovaraBedrockInvoke-${CompanyId}" });
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([{ Sid: "OnlyRovaraForThisCompany", Effect: "Allow", Principal: { AWS: { Ref: "BrokerRoleArn" } }, Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" }, "sts:RoleSessionName": { Ref: "CompanyId" } } } }]);
    const [allow] = role.Policies[0]!.PolicyDocument.Statement;
    expect(allow).toEqual({ Sid: "InvokeChosenModels", Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: { Ref: "ModelResourceArns" } });
    // Nothing else: no Marketplace, no control plane, no bearer-token use.
    expect(bedrockRoleTemplateText()).not.toMatch(/aws-marketplace|CallWithBearerToken|bedrock:\*|"Action": "\*"/u);
  });

  it("lists the profile and the foundation model in every Region of its geography (or every Region for global)", () => {
    expect(bedrockResourceArns({ region: "us-west-2", models: { "claude-sonnet-5-5": SONNET, "claude-haiku-4-5": "anthropic.claude-haiku-4-5-20251001-v1:0" } })).toEqual([
      "arn:aws:bedrock:us-*::foundation-model/anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:us-west-2:*:inference-profile/us.anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
    ]);
    expect(bedrockResourceArns({ region: "eu-west-1", models: { "claude-sonnet-5-5": "global.anthropic.claude-sonnet-5-5" } })).toEqual([
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:eu-west-1:*:inference-profile/global.anthropic.claude-sonnet-5-5",
    ]);
  });

  it("the set-up is one CloudShell command with every parameter filled in, for each company its own (two companies)", () => {
    const input = { templateUrl: "https://docs.rovara.example/bedrock/rovara-bedrock-role.json", brokerRoleArn: BROKER, externalId: EXT, cid: A, region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false };
    const a = bedrockSetupCommand(input);
    expect(a.cloudShellUrl).toBe("https://us-west-2.console.aws.amazon.com/cloudshell/home?region=us-west-2");
    expect(a.command).toContain(`'CompanyId=${A}' 'ExternalId=${EXT}' 'BrokerRoleArn=${BROKER}'`);
    expect(a.command).toContain("'AllowGlobalRouting=false'");
    // Every ARN (they hold *) is inside single quotes: no shell expands them.
    expect(a.command).toContain(`'ModelResourceArns=${bedrockResourceArns({ region: "us-west-2", models: input.models }).join(",")}'`);
    expect(a.command.replace(/'[^']*'/gu, "")).not.toContain("*");
    // The downloaded template is checked against the docs file's own hash before anything is deployed.
    const sha = createHash("sha256").update(readFileSync(new URL("../../docs/bedrock/rovara-bedrock-role.json", import.meta.url))).digest("hex");
    expect(bedrockRoleTemplateSha256()).toBe(sha);
    const steps = a.command.split(" && ");
    expect(steps[1]).toBe(`echo '${sha}  rovara-bedrock-role.json' | sha256sum -c -`);
    expect(steps[2]).toMatch(/^aws cloudformation deploy /u);
    expect(a.command).toContain("--capabilities CAPABILITY_NAMED_IAM");
    const b = bedrockSetupCommand({ ...input, cid: B, externalId: `rvb-${"b2".repeat(20)}` });
    expect(b.command).not.toContain(A);
    expect(b.stackName).not.toBe(a.stackName);
    // Nothing that is not checked reaches the command (a shell word).
    for (const bad of [{ templateUrl: "https://bucket.s3.amazonaws.com/t.json" }, { templateUrl: "http://docs.example/t.json" }, { templateUrl: "https://docs.example/t.json;rm -rf ~" }, { externalId: "rvb-x" }, { cid: "org_a; ls" }, { region: "us-west-2;ls" }, { brokerRoleArn: "arn:aws:iam::1:role/x" }, { models: { "claude-x": "us.anthropic.claude-x;ls" } }]) {
      expect(() => bedrockSetupCommand({ ...input, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });

  it("the template is never served from S3 (DEC 238 Q10)", () => {
    expect(validTemplateUrl("https://docs.rovara.example/bedrock/rovara-bedrock-role.json")).toBe(true);
    for (const url of ["https://my-bucket.s3.us-west-2.amazonaws.com/t.json", "https://s3.us-west-2.amazonaws.com/b/t.json", "https://s3-us-west-2.amazonaws.com/b/t.json", "https://x.cloudfront.net/t.yaml", "ftp://docs/t.json"]) expect(validTemplateUrl(url), url).toBe(false);
  });

  it("presets follow the Region's geography", () => {
    expect(bedrockModelPresets("eu-central-1", ROVARA_AI_US_MODELS)["claude-sonnet-5-5"]).toBe("eu.anthropic.claude-sonnet-5-5");
    expect(bedrockModelPresets("us-east-2", ROVARA_AI_US_MODELS)["claude-opus-5-5"]).toBe("us.anthropic.claude-opus-5-5");
    expect(bedrockModelPresets("sa-east-1", ROVARA_AI_US_MODELS)).toEqual({});
  });
});

// ---- the key store ---------------------------------------------------------------------------------------------------------------

const ADMIN = { id: "d".repeat(64), role: "company_admin" as const };
function storeWith(check: BedrockCheck | undefined, at = { now: Date.parse("2026-11-16T00:00:00Z") }) {
  const table = new InMemoryProductKeyTable();
  const asked: Array<{ cid: string; connection: BedrockConnection }> = [];
  const store = new ProductKeyStore({
    table, sealer: new ProductKeySealer(localProductKeyService(randomBytes(32))), fingerprint: hmacFingerprinter(randomBytes(32)), now: () => at.now,
    ...(check === undefined ? {} : { bedrockCheck: async (cid, connection) => { asked.push({ cid, connection }); return check(cid, connection); } }),
  });
  return { store, table, asked, at };
}
const change = (cid: string, expectedRevision: number, owner = PRODUCT_COMPANY_OWNER) => ({ iss: ISS, cid, owner, requestId: randomUUID(), expectedRevision, actor: ADMIN });
const OK: BedrockCheck = async (_cid, c) => ({ result: "ok", models: Object.fromEntries(Object.values(c.models).map((id) => [id, "ready" as const])) });
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (error) { return (error as ProductKeyError).code; } };

describe("the key store: the company's own Bedrock", () => {
  it("connects one company-level source after the gateway's test, sealed; the view shows the role, Region and each model's state", async () => {
    const s = storeWith(async (_cid, c) => ({ result: "ok", models: { [Object.values(c.models)[0]!]: "not_enabled" } }));
    const v = await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    expect(s.asked.map((x) => x.cid)).toEqual([A]);
    const src = v.sources.find((x) => x.provider === "bedrock")!;
    expect(src.bedrock).toMatchObject({ roleArn: ROLE_A, region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false, checks: { [SONNET]: "not_enabled" } });
    const resolution = await s.store.companyBedrock(ISS, A);
    expect(resolution).toMatchObject({ owner: PRODUCT_COMPANY_OWNER, sourceId: BEDROCK_SOURCE_ID, provider: "bedrock" });
    expect(parseBedrockConnect((await s.store.useKey(ISS, A, resolution!))!)).toMatchObject({ roleArn: ROLE_A });
    // Company B has none, and can't open A's row.
    expect(await s.store.companyBedrock(ISS, B)).toBeUndefined();
    expect(await s.store.useKey(ISS, B, resolution!)).toBeUndefined();
  });

  it("a model the test did not answer is unavailable, never assumed ready", async () => {
    const s = storeWith(async () => ({ result: "ok", models: { "us.anthropic.claude-other": "ready" } }));
    const v = await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    expect(v.sources[0]!.bedrock?.checks).toEqual({ [SONNET]: "unavailable" });
  });

  it("a model the test found with no quota room is kept as no_quota (never clamped to unavailable), and the connection is still saved", async () => {
    const s = storeWith(async (_cid, c) => ({ result: "ok", models: { [Object.values(c.models)[0]!]: "no_quota" } }));
    const v = await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    expect(v.sources[0]!.bedrock?.checks).toEqual({ [SONNET]: "no_quota" });
    expect(await s.store.companyBedrock(ISS, A)).toMatchObject({ sourceId: BEDROCK_SOURCE_ID });
  });

  it("a model AWS did not answer is kept as no_answer (never clamped to unavailable, which is a model state), and the connection is still saved", async () => {
    const s = storeWith(async (_cid, c) => ({ result: "ok", models: { [Object.values(c.models)[0]!]: "no_answer" } }));
    const v = await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    expect(v.sources[0]!.bedrock?.checks).toEqual({ [SONNET]: "no_answer" });
    expect(await s.store.companyBedrock(ISS, A)).toMatchObject({ sourceId: BEDROCK_SOURCE_ID });
    // The stored word reads back (a document with it is valid).
    expect((await s.store.view(ISS, A, PRODUCT_COMPANY_OWNER)).sources[0]!.bedrock?.checks).toEqual({ [SONNET]: "no_answer" });
  });

  it("a check again re-runs the test for the SAVED connection: new states and time, a new revision, the same key and role claim", async () => {
    let answerWith: "not_enabled" | "ready" | "no_answer" = "no_answer";
    const s = storeWith(async (_cid, c) => ({ result: "ok", models: { [Object.values(c.models)[0]!]: answerWith } }));
    const first = await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    const resolution = await s.store.companyBedrock(ISS, A);
    const connectedAt = first.sources[0]!.bedrock!.checkedAt;
    s.at.now += 90_000; answerWith = "ready";
    const again = await s.store.recheckBedrock({ ...change(A, first.revision), sourceId: BEDROCK_SOURCE_ID });
    expect(s.asked).toHaveLength(2);
    expect(s.asked[1]).toEqual({ cid: A, connection: { scheme: "assume_role", roleArn: ROLE_A, region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false } });
    expect(again.revision).toBe(first.revision + 1);
    expect(again.sources[0]!.bedrock).toMatchObject({ roleArn: ROLE_A, checks: { [SONNET]: "ready" }, checkedAt: connectedAt + 90_000 });
    // No new key version, no new claim: the same sealed connection still opens for the same row.
    expect(await s.store.companyBedrock(ISS, A)).toEqual(resolution);
    expect(parseBedrockConnect((await s.store.useKey(ISS, A, resolution!))!)).toMatchObject({ roleArn: ROLE_A });
    expect(await code(s.store.connect({ ...change(B, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() }))).toBe("role_in_use");
  });

  it("a check again keeps the product models, is fenced by the revision and refuses what is not a connected Bedrock", async () => {
    const NOVA = "us.amazon.nova-pro-v1:0";
    const s = storeWith(OK);
    expect(await code(s.store.recheckBedrock({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID }))).toBe("not_found");
    const first = await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn({ productModels: [NOVA] }) });
    expect(await code(s.store.recheckBedrock({ ...change(A, first.revision + 5), sourceId: BEDROCK_SOURCE_ID }))).toBe("stale");
    expect(await code(s.store.recheckBedrock({ ...change(A, first.revision), sourceId: "src_other" }))).toBe("not_found");
    const again = await s.store.recheckBedrock({ ...change(A, first.revision), sourceId: BEDROCK_SOURCE_ID });
    expect(s.asked.at(-1)!.connection.productModels).toEqual([NOVA]);
    expect(Object.keys(again.sources[0]!.bedrock!.checks).sort()).toEqual([NOVA, SONNET].sort());
    // Company B never reaches A's connection.
    expect(await code(s.store.recheckBedrock({ ...change(B, 0), sourceId: BEDROCK_SOURCE_ID }))).toBe("not_found");
    // A project maintainer can't re-run a company source.
    expect(await code(s.store.recheckBedrock({ ...change(A, again.revision), actor: { id: "e".repeat(64), role: "project_maintainer" }, sourceId: BEDROCK_SOURCE_ID }))).toBe("forbidden");
  });

  it("a check again that finds the role too open, refused or the test down saves nothing and keeps the last result", async () => {
    for (const [result, expected] of [["too_open", "aws_too_open"], ["refused", "aws_refused"], ["unavailable", "unavailable"]] as const) {
      let next: BedrockCheck = OK;
      const s = storeWith((cid, c) => next(cid, c));
      const first = await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
      next = async () => ({ result });
      s.at.now += 60_000;
      expect(await code(s.store.recheckBedrock({ ...change(A, first.revision), sourceId: BEDROCK_SOURCE_ID })), result).toBe(expected);
      expect(await s.store.view(ISS, A, PRODUCT_COMPANY_OWNER)).toEqual(first);
    }
  });

  it("saves nothing when the role is too open, refused or the test is unavailable; without a test it refuses before anything", async () => {
    for (const [result, expected] of [["too_open", "aws_too_open"], ["refused", "aws_refused"], ["unavailable", "unavailable"]] as const) {
      const s = storeWith(async () => ({ result }));
      expect(await code(s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() }))).toBe(expected);
      expect(s.table.rows.size).toBe(0);
    }
    const thrown = storeWith(async () => { throw new Error("down"); });
    expect(await code(thrown.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() }))).toBe("unavailable");
    // No test configured: refused before anything else runs (no fingerprint, no KMS call, no claim read).
    const table = new InMemoryProductKeyTable(); let prints = 0;
    const none = new ProductKeyStore({ table, sealer: new ProductKeySealer(localProductKeyService(randomBytes(32))), fingerprint: async (input) => { prints += 1; return hmacFingerprinter(randomBytes(32))(input); } });
    expect(await code(none.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() }))).toBe("unavailable");
    expect(prints).toBe(0);
    expect(table.reads).toEqual([]);
    expect(table.rows.size).toBe(0);
  });

  it("no learning document, one per company document, an unparseable connection refused (slice 2 lets a project connect or link: see model-gateway-product-bedrock-keys)", async () => {
    const s = storeWith(OK);
    expect(await code(s.store.connect({ ...change(A, 0, "_learning"), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() }))).toBe("invalid");
    await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    expect(await code(s.store.connect({ ...change(A, 1), sourceId: "src_bedrock2", provider: "bedrock", key: conn({ roleArn: `${ROLE_A}2` }) }))).toBe("invalid");
    expect(await code(s.store.connect({ ...change(A, 1), sourceId: "src_x", provider: "bedrock", key: "not a connection" }))).toBe("invalid");
  });

  it("refuses a role another company connected (any case), before testing it; each company keeps its own (two companies)", async () => {
    const s = storeWith(OK);
    await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    const asked = s.asked.length;
    expect(await code(s.store.connect({ ...change(B, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() }))).toBe("role_in_use");
    expect(await code(s.store.connect({ ...change(B, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn({ roleArn: ROLE_A.replace("RovaraBedrockInvoke-org_aaaa", "RovaraBedrockInvoke-ORG_AAAA") }) }))).toBe("role_in_use");
    // The test never ran for B (no AWS call), and B saved nothing.
    expect(s.asked.length).toBe(asked);
    expect(await s.store.companyBedrock(ISS, B)).toBeUndefined();
    await s.store.connect({ ...change(B, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn({ roleArn: ROLE_B }) });
    expect((await s.store.view(ISS, B, PRODUCT_COMPANY_OWNER)).sources[0]!.bedrock?.roleArn).toBe(ROLE_B);
    // The claim rows live under the install's own prefix, never under a company's.
    const claims = [...s.table.rows.keys()].filter((k) => k.includes("#role#"));
    expect(claims).toHaveLength(2);
    expect(claims.every((k) => k.startsWith(`CO#${JSON.stringify([ISS, BEDROCK_ROLE_CLAIMS])}#role#`))).toBe(true);
  });

  it("a removed role stays the company's through its recovery window (recover gets it back), then another company may take it", async () => {
    const s = storeWith(OK);
    await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    await s.store.remove({ ...change(A, 1), sourceId: BEDROCK_SOURCE_ID });
    expect(await s.store.companyBedrock(ISS, A)).toBeUndefined();
    expect(await code(s.store.connect({ ...change(B, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() }))).toBe("role_in_use");
    await s.store.recover({ ...change(A, 2), sourceId: BEDROCK_SOURCE_ID });
    expect(await s.store.companyBedrock(ISS, A)).toBeDefined();
    await s.store.remove({ ...change(A, 3), sourceId: BEDROCK_SOURCE_ID });
    s.at.now += 7 * 86_400_000 + 1;
    await s.store.connect({ ...change(B, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    expect((await s.store.view(ISS, B, PRODUCT_COMPANY_OWNER)).sources[0]!.bedrock?.roleArn).toBe(ROLE_A);
  });

  it("a rotate to another role claims it and frees the old one at once; a rotate to a role B holds is refused", async () => {
    const s = storeWith(OK);
    await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    await s.store.connect({ ...change(B, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn({ roleArn: ROLE_B }) });
    expect(await code(s.store.rotate({ ...change(A, 1), sourceId: BEDROCK_SOURCE_ID, key: conn({ roleArn: ROLE_B }) }))).toBe("role_in_use");
    const ROLE_A2 = `${ROLE_A.slice(0, ROLE_A.lastIndexOf("-"))}-second`;
    await s.store.rotate({ ...change(A, 1), sourceId: BEDROCK_SOURCE_ID, key: conn({ roleArn: ROLE_A2 }) });
    expect((await s.store.view(ISS, A, PRODUCT_COMPANY_OWNER)).sources[0]!.bedrock?.roleArn).toBe(ROLE_A2);
    // A's first role is free now for B (after B removes its own and connects it).
    await s.store.rotate({ ...change(B, 1), sourceId: BEDROCK_SOURCE_ID, key: conn() });
    expect((await s.store.view(ISS, B, PRODUCT_COMPANY_OWNER)).sources[0]!.bedrock?.roleArn).toBe(ROLE_A);
    // A rotate re-runs the test for A only.
    expect(s.asked.filter((x) => x.cid === A)).toHaveLength(2);
  });

  it("two companies racing for one role: only one wins (the claim row fences the transaction)", async () => {
    const s = storeWith(OK);
    const results = await Promise.allSettled([
      s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() }),
      s.store.connect({ ...change(B, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [onA, onB] = [await s.store.companyBedrock(ISS, A), await s.store.companyBedrock(ISS, B)];
    expect([onA, onB].filter((x) => x !== undefined)).toHaveLength(1);
  });

  it("a state word a later release stored reads as no_answer, and the document is still read (older releases reject it: the rollback floor)", async () => {
    const s = storeWith(OK);
    await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    const key = [...s.table.rows.keys()].find((k) => k.endsWith("#doc#_company"))!;
    const row = s.table.rows.get(key)!;
    const withWord = (word: string) => { const doc = structuredClone(row.item) as { sources: Array<{ bedrock: { checks: Record<string, string> } }> }; doc.sources[0]!.bedrock.checks[SONNET] = word; s.table.rows.set(key, { ...row, item: doc }); };
    withWord("some_future_word");
    const view = await s.store.view(ISS, A, PRODUCT_COMPANY_OWNER);
    expect(view.sources[0]!.bedrock?.checks).toEqual({ [SONNET]: "no_answer" });
    expect(await s.store.companyBedrock(ISS, A)).toMatchObject({ sourceId: BEDROCK_SOURCE_ID });
    // A known word is kept as it is, and a value that is not a plain state word is still refused (never guessed).
    withWord("not_enabled");
    expect((await s.store.view(ISS, A, PRODUCT_COMPANY_OWNER)).sources[0]!.bedrock?.checks).toEqual({ [SONNET]: "not_enabled" });
    for (const bad of ["Not Enabled", "", "x".repeat(40), "arn:aws:iam::111111111111:role/x"]) { withWord(bad); expect(await code(s.store.view(ISS, A, PRODUCT_COMPANY_OWNER)), bad).toBe("unavailable"); }
  });

  it("a check again clears a call-time refusal marker: the role answered the test", async () => {
    const s = storeWith(OK);
    const first = await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    const resolution = (await s.store.companyBedrock(ISS, A))!;
    await s.store.recordWarning(ISS, A, resolution, 403);
    const warned = await s.store.view(ISS, A, PRODUCT_COMPANY_OWNER);
    expect(warned.sources[0]!.warning).toMatchObject({ status: 403 });
    const again = await s.store.recheckBedrock({ ...change(A, warned.revision), sourceId: BEDROCK_SOURCE_ID });
    expect(again.sources[0]!.warning).toBeUndefined();
    expect(first.revision).toBeLessThan(again.revision);
  });

  it("a stored document whose Bedrock summary is malformed is unavailable, never guessed", async () => {
    const s = storeWith(OK);
    await s.store.connect({ ...change(A, 0), sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key: conn() });
    const key = [...s.table.rows.keys()].find((k) => k.endsWith("#doc#_company"))!;
    const row = s.table.rows.get(key)!;
    const doc = structuredClone(row.item) as { sources: Array<{ bedrock: { roleArn: string } }> };
    doc.sources[0]!.bedrock.roleArn = "arn:aws:iam::111111111111:role/Admin";
    s.table.rows.set(key, { ...row, item: doc });
    expect(await code(s.store.companyBedrock(ISS, A))).toBe("unavailable");
  });
});
