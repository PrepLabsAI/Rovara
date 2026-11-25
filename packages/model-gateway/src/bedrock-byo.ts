// Bring your own Bedrock (DEC 238, slice 1): the company connects its OWN AWS account's Bedrock for its agents. Nothing secret is
// stored. The company's AWS admin creates an invoke-only role (the CloudFormation template below, hosted on the docs site, DEC 238
// Q10) that trusts ONE fixed Rovara role, the "Bedrock broker", and only with:
//   - sts:ExternalId = the company's external id: `rvb-` + HMAC(install, company) under the gateway's own KMS HMAC key
//     (BedrockExternalIds). Rovara derives it from the VERIFIED company id each time; it is never typed, stored or taken from a
//     request, so company B can never send company A's external id;
//   - sts:RoleSessionName = the company id, so the customer's CloudTrail names the Rovara company that called.
// The gateway assumes broker -> customer role per call (bedrock-byo-sessions.ts) and signs Bedrock calls with that session. Bedrock
// bills the customer's account; Rovara's meter only enforces the one combined company cap (at list price, DEC 238 Q7).
//
// What the company connects (sealed in the product key store as provider "bedrock", company-level source only in slice 1):
//   {"scheme":"assume_role","roleArn":"arn:aws:iam::<acct>:role/RovaraBedrockInvoke-<company>","region":"us-west-2",
//    "models":{"claude-sonnet-5-5":"us.anthropic.claude-sonnet-5-5"},"allowGlobal":false}
// Parsing is strict and total: anything unexpected is refused as a whole.
import { createHash } from "node:crypto";
import { BEDROCK_CONVERSE_ID } from "./bedrock-converse.js";
import { BEDROCK_CLAUDE_ID } from "./bedrock-transport.js";
import { normalizeBedrockModel } from "./price-identity.js";
import { COMPANY, PROJECT, record, whole } from "./model-gateway-token.js";

/** Every customer role's name starts with this; the broker may assume nothing else (infra/lib/model-gateway.ts). */
export const BEDROCK_BYO_ROLE_PREFIX = "RovaraBedrockInvoke-";
/**
 * The customer's role: commercial partition only (the broker lives there), no path (the template makes none), the fixed prefix.
 * IAM role names are at most 64 characters.
 */
export const BEDROCK_BYO_ROLE_ARN = /^arn:aws:iam::([0-9]{12}):role\/(RovaraBedrockInvoke-[A-Za-z0-9+=,.@_-]{1,44})$/u;
/** A commercial Region the customer's Bedrock runs in (GovCloud and China are other partitions: not offered). */
export const BEDROCK_BYO_REGION = /^(?:us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-[1-9]$/u;
/** At most this many models per connection (each becomes up to three IAM resource ARNs in the template's 4,096-byte parameter). */
export const BEDROCK_BYO_MODELS_MAX = 8;
/**
 * Slice 2 (the product route): the Bedrock models a company's tests may call besides its agents' Claude picks (any family through
 * Converse, Claude through either, Titan text embeddings through InvokeModel). At most this many, and at most BEDROCK_BYO_ALL_MODELS_MAX
 * different ids in all, so the template's 4,096-byte ARN parameter always holds.
 */
export const BEDROCK_PRODUCT_MODELS_MAX = 8;
export const BEDROCK_BYO_ALL_MODELS_MAX = 12;
/** Amazon Titan Text Embeddings (V1, V2): the embedding models the product route serves (their answer carries the token count). */
export const BEDROCK_EMBEDDING_ID = /^amazon\.titan-embed-text-v(?:1|2:0)$/u;
const AGENT_MODEL = /^claude-[a-z0-9-]{1,80}$/u;
/** A region's inference-profile geographies (AWS system profile prefixes). `global.` is never one: global routing is off. */
export function geographiesOf(region: string): readonly string[] {
  if (region.startsWith("us-gov-")) return ["us-gov"];
  const area = region.split("-")[0];
  return area === "us" ? ["us"] : area === "eu" ? ["eu"] : area === "ap" ? ["apac", "jp", "au"] : area === "ca" ? ["ca"] : [];
}
/** `rvb-` + 40 hex characters (160 bits of the HMAC). AWS allows 2 to 1,224 characters of [\w+=,.@:/-]. */
export const BEDROCK_EXTERNAL_ID = /^rvb-[0-9a-f]{40}$/u;
export const BEDROCK_EXTERNAL_ID_PURPOSE = "rovara-bedrock-external-id/v1";

export interface BedrockConnection {
  scheme: "assume_role";
  roleArn: string;
  region: string;
  /** The agent's (Anthropic) model name to the Bedrock Claude id or system inference profile called for it: the allow-list. */
  models: Readonly<Record<string, string>>;
  /** Global cross-Region routing (`global.` profiles): data may leave the geography. Off unless the admin turns it on (DEC 238 Q3). */
  allowGlobal: boolean;
  /**
   * Slice 2: further Bedrock model ids (or system inference profiles of the Region's geography) the PRODUCT route may call: Claude
   * (also through Converse), any other family through Converse, and Titan text embeddings. They are in the role's IAM policy too.
   * Absent (every connection saved before slice 2): the product route may call only the agents' Claude picks (`models`).
   */
  productModels?: readonly string[];
}
/** The connection test's answer per model (bedrock-byo-sessions.ts). */
/**
 * `no_quota`: Bedrock throttled the $0 check itself, which an account whose tokens-per-minute quota for the model is 0 does for every call. A busy account can be
 * throttled too, so it is shown as "no room right now", never as a fact about the account's quota. It never stops a connection (a later test can clear it).
 */
export const BEDROCK_MODEL_CHECKS = ["ready", "not_enabled", "refused", "not_found", "no_quota", "unavailable"] as const;
export type BedrockModelCheck = typeof BEDROCK_MODEL_CHECKS[number];
/** What Settings may show (nothing here is secret; the sealed connection is the same plus the scheme). */
export interface BedrockSummary {
  roleArn: string; region: string; models: Readonly<Record<string, string>>; allowGlobal: boolean;
  productModels?: readonly string[];
  /** Each model's state at the last connection test, and when that test ran. */
  checks: Readonly<Record<string, BedrockModelCheck>>; checkedAt: number;
}

/** A geography prefix of a system inference profile, or undefined for an in-Region model id. */
const geographyOf = (id: string): string | undefined => /^(?:[a-z]{2,4}|global)\.anthropic\./u.test(id) ? id.slice(0, id.indexOf(".")) : undefined;
/** The same for any provider's profile (`us.amazon.nova-pro-v1:0`): only AWS's own geography prefixes count. */
const profileGeography = (id: string): string | undefined => /^(?:us|eu|apac|jp|au|ca|global)\.(?=[a-z][a-z0-9-]{1,30}\.)/u.test(id) ? id.slice(0, id.indexOf(".")) : undefined;
const anyGeography = (id: string): string | undefined => geographyOf(id) ?? profileGeography(id);
/** The Bedrock model id without its geography prefix (the foundation model a profile routes to). */
const baseModel = (id: string): string => anyGeography(id) === undefined ? id : id.slice(id.indexOf(".") + 1);

/** Whether `id` may be called from `region`: in-Region, a profile of the Region's geography, or `global.` only when allowed. */
export function allowedBedrockModel(id: string, region: string, allowGlobal: boolean): boolean {
  if (typeof id !== "string" || !BEDROCK_CLAUDE_ID.test(id)) return false;
  const geo = geographyOf(id);
  if (geo === undefined) return true;
  if (geo === "global") return allowGlobal;
  return geographiesOf(region).includes(geo);
}
/**
 * Whether the product route may be given `id` (slice 2): a Claude id as for agents, a Titan text embedding model, or any other
 * family's model or system profile (never `global.` for those: only Claude's global profiles are offered, and only when allowed).
 */
export function allowedProductModel(id: string, region: string, allowGlobal: boolean): boolean {
  if (typeof id !== "string") return false;
  if (BEDROCK_EMBEDDING_ID.test(id)) return true;
  if (BEDROCK_CLAUDE_ID.test(id)) return allowedBedrockModel(id, region, allowGlobal);
  if (!BEDROCK_CONVERSE_ID.test(id)) return false;
  const geo = profileGeography(id);
  return geo === undefined || geographiesOf(region).includes(geo);
}

function validModels(value: unknown, region: string, allowGlobal: boolean): value is Record<string, string> {
  const models = record(value);
  if (models === undefined) return false;
  const entries = Object.entries(models);
  return entries.length >= 1 && entries.length <= BEDROCK_BYO_MODELS_MAX
    && entries.every(([name, id]) => AGENT_MODEL.test(name) && typeof id === "string" && allowedBedrockModel(id, region, allowGlobal)
      // The agent's name must be the SAME model as the Bedrock id (dates, versions and the profile prefix aside), so a call is
      // never sent to, or priced as, a different model than the one the agent asked for.
      && normalizeBedrockModel(name) === normalizeBedrockModel(id));
}
/** The product models (slice 2): distinct, valid for the Region, and at most BEDROCK_BYO_ALL_MODELS_MAX different ids with the agents' picks. */
function validProductModels(value: unknown, models: Readonly<Record<string, string>>, region: string, allowGlobal: boolean): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > BEDROCK_PRODUCT_MODELS_MAX) return false;
  if (!value.every((id: unknown) => typeof id === "string" && allowedProductModel(id, region, allowGlobal)) || new Set(value).size !== value.length) return false;
  return new Set([...Object.values(models), ...(value as string[])]).size <= BEDROCK_BYO_ALL_MODELS_MAX;
}
/** Every Bedrock id the connection names: the agents' picks and the product models (one list for the IAM policy and the test). */
export function bedrockConnectionIds(c: Pick<BedrockConnection, "models" | "productModels">): string[] {
  return [...new Set([...Object.values(c.models), ...(c.productModels ?? [])])];
}

/** The connection a company admin sends (connect or rotate), or undefined. */
export function parseBedrockConnect(text: string): BedrockConnection | undefined {
  if (typeof text !== "string" || text.length > 4096) return undefined;
  let v: unknown;
  try { v = JSON.parse(text) as unknown; } catch { return undefined; }
  const r = record(v);
  if (r === undefined || r.scheme !== "assume_role") return undefined;
  const required = ["scheme", "roleArn", "region", "models", "allowGlobal"] as const;
  if (!required.every((k) => Object.hasOwn(r, k)) || Object.keys(r).some((k) => !(required as readonly string[]).includes(k) && k !== "productModels")) return undefined;
  if (typeof r.roleArn !== "string" || !BEDROCK_BYO_ROLE_ARN.test(r.roleArn) || typeof r.region !== "string" || !BEDROCK_BYO_REGION.test(r.region) || typeof r.allowGlobal !== "boolean") return undefined;
  if (!validModels(r.models, r.region, r.allowGlobal)) return undefined;
  if (Object.hasOwn(r, "productModels") && !validProductModels(r.productModels, r.models, r.region, r.allowGlobal)) return undefined;
  return { scheme: "assume_role", roleArn: r.roleArn, region: r.region, models: sortedModels(r.models), allowGlobal: r.allowGlobal, ...(Array.isArray(r.productModels) ? { productModels: [...(r.productModels as string[])].sort() } : {}) };
}
const sortedModels = (models: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The canonical text sealed in the key store (the same connection always seals the same text; no productModels key when there are none). */
export function serializeBedrockConnection(c: BedrockConnection): string {
  const product = c.productModels === undefined || c.productModels.length === 0 ? {} : { productModels: [...c.productModels].sort() };
  return JSON.stringify({ scheme: "assume_role", roleArn: c.roleArn, region: c.region, models: sortedModels(c.models), allowGlobal: c.allowGlobal, ...product });
}

export function bedrockSummary(c: BedrockConnection, checks: Readonly<Record<string, BedrockModelCheck>>, checkedAt: number): BedrockSummary {
  return { roleArn: c.roleArn, region: c.region, models: sortedModels(c.models), allowGlobal: c.allowGlobal, ...(c.productModels === undefined || c.productModels.length === 0 ? {} : { productModels: [...c.productModels].sort() }), checks: { ...checks }, checkedAt };
}
export function validBedrockSummary(v: unknown): v is BedrockSummary {
  const s = record(v); const checks = record(s?.checks);
  const required = ["roleArn", "region", "models", "allowGlobal", "checks", "checkedAt"];
  if (s === undefined || checks === undefined || !required.every((k) => Object.hasOwn(s, k)) || Object.keys(s).some((k) => !required.includes(k) && k !== "productModels")) return false;
  if (typeof s.roleArn !== "string" || !BEDROCK_BYO_ROLE_ARN.test(s.roleArn) || typeof s.region !== "string" || !BEDROCK_BYO_REGION.test(s.region) || typeof s.allowGlobal !== "boolean" || !whole(s.checkedAt)) return false;
  if (!validModels(s.models, s.region, s.allowGlobal)) return false;
  if (Object.hasOwn(s, "productModels") && !validProductModels(s.productModels, s.models, s.region, s.allowGlobal)) return false;
  const ids = new Set(bedrockConnectionIds({ models: s.models, ...(Array.isArray(s.productModels) ? { productModels: s.productModels as string[] } : {}) }));
  return Object.entries(checks).every(([id, state]) => ids.has(id) && BEDROCK_MODEL_CHECKS.some((c) => c === state));
}

/**
 * The claim on a customer role, unique across every Rovara company of this install (DEC 238 Q5: a role already connected by
 * another company is refused). IAM role names are unique per account ignoring case and path, so the claim is the account and the
 * lower-cased name: `RovaraBedrockInvoke-X` and `rovarabedrockinvoke-x` are the same role.
 */
export function bedrockRoleClaim(roleArn: string): string {
  const match = BEDROCK_BYO_ROLE_ARN.exec(roleArn);
  if (match === null) throw new Error("invalid bedrock role");
  return `${match[1]}:${match[2]!.toLowerCase()}`;
}

/** What the external id's HMAC covers: sha256 of [purpose, install, company] (32 bytes, far under KMS's message limit). */
export function bedrockExternalIdMessage(iss: string, cid: string): Uint8Array {
  return createHash("sha256").update(JSON.stringify([BEDROCK_EXTERNAL_ID_PURPOSE, iss, cid])).digest();
}
export interface MacGenerator { generateMac(input: { KeyId: string; Message: Uint8Array }): Promise<{ Mac?: Uint8Array }> }
const EXTERNAL_IDS_MAX = 5_000;
/**
 * The company's external id, from the gateway's own KMS HMAC key (only the gateway's serving role may GenerateMac with it). The
 * key must never be deleted or replaced: every customer role's trust policy names the ids it makes. Cached per install and
 * company (the id never changes); a failure is never cached.
 */
export class BedrockExternalIds {
  readonly #ids = new Map<string, string>();
  constructor(private readonly kms: MacGenerator, private readonly keyId: string) {}
  async of(iss: string, cid: string): Promise<string> {
    if (typeof iss !== "string" || iss.length === 0 || iss.length > 2048 || typeof cid !== "string" || !COMPANY.test(cid)) throw new Error("bedrock external id unavailable");
    const key = JSON.stringify([iss, cid]);
    const known = this.#ids.get(key);
    if (known !== undefined) return known;
    let mac: Uint8Array | undefined;
    try { mac = (await this.kms.generateMac({ KeyId: this.keyId, Message: bedrockExternalIdMessage(iss, cid) })).Mac; } catch { throw new Error("bedrock external id unavailable"); }
    if (mac === undefined || mac.length !== 32) throw new Error("bedrock external id unavailable");
    const id = `rvb-${Buffer.from(mac).subarray(0, 20).toString("hex")}`;
    while (this.#ids.size >= EXTERNAL_IDS_MAX) { const first = this.#ids.keys().next(); if (first.done === true) break; this.#ids.delete(first.value); }
    this.#ids.set(key, id);
    return id;
  }
}

// ---- The customer's role: template and set-up -------------------------------------------------------------------------------

/** The Regions a geography's system profiles may route to, as an IAM Region pattern (the foundation-model ARNs they need). */
const GEOGRAPHY_REGIONS: Readonly<Record<string, string>> = { us: "us-*", eu: "eu-*", apac: "ap-*", jp: "ap-northeast-*", au: "ap-southeast-*", ca: "ca-*" };
/**
 * The IAM resources the customer's role may invoke for these models (least privilege, AWS's inference-profile prerequisites):
 *   in-Region model    arn:aws:bedrock:<region>::foundation-model/<id>
 *   `<geo>.` profile   the profile in <region> (any account: a system profile exists in the caller's own account only), plus the
 *                      foundation model in every Region of that geography
 *   `global.` profile  the profile, plus the foundation model in every Region and the Region-less ARN global routing uses
 */
export function bedrockResourceArns(c: Pick<BedrockConnection, "region" | "models" | "productModels">): string[] {
  const arns = new Set<string>();
  for (const id of bedrockConnectionIds(c)) {
    const geo = anyGeography(id); const base = baseModel(id);
    if (geo === undefined) { arns.add(`arn:aws:bedrock:${c.region}::foundation-model/${id}`); continue; }
    arns.add(`arn:aws:bedrock:${c.region}:*:inference-profile/${id}`);
    if (geo === "global") { arns.add(`arn:aws:bedrock:*::foundation-model/${base}`); arns.add(`arn:aws:bedrock:::foundation-model/${base}`); }
    else arns.add(`arn:aws:bedrock:${GEOGRAPHY_REGIONS[geo] ?? c.region}::foundation-model/${base}`);
  }
  return [...arns].sort();
}

/**
 * The CloudFormation template the company's AWS admin runs (docs/bedrock/rovara-bedrock-role.json is this, byte for byte; a test
 * holds them equal). It is served from the docs site (DEC 238 Q10), never from a public S3 bucket.
 */
export function bedrockRoleTemplate(): Record<string, unknown> {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Rovara: lets Rovara's agents call Amazon Bedrock in this account, on the models you chose, and nothing else. Bedrock bills this account.",
    Parameters: {
      CompanyId: { Type: "String", AllowedPattern: "^org_[0-9a-z]{20}$", Description: "Your Rovara company id (Rovara's session name in your CloudTrail)." },
      ExternalId: { Type: "String", AllowedPattern: "^rvb-[0-9a-f]{40}$", Description: "Your company's external id, shown in Rovara's settings." },
      BrokerRoleArn: { Type: "String", AllowedPattern: "^arn:aws:iam::[0-9]{12}:role/RovaraBedrockBroker-[a-z0-9-]{1,32}$", Description: "Rovara's Bedrock broker role, shown in Rovara's settings." },
      ModelResourceArns: { Type: "CommaDelimitedList", Description: "The Bedrock models and inference profiles Rovara may call, shown in Rovara's settings." },
      AllowGlobalRouting: { Type: "String", AllowedValues: ["false", "true"], Default: "false", Description: "true lets calls route to any AWS Region (global profiles): data may leave your geography." },
    },
    Conditions: { DenyGlobalRouting: { "Fn::Equals": [{ Ref: "AllowGlobalRouting" }, "false"] } },
    Resources: {
      RovaraBedrockInvokeRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: { "Fn::Sub": `${BEDROCK_BYO_ROLE_PREFIX}\${CompanyId}` },
          Description: "Rovara agents call Bedrock with this role (invoke only, on the chosen models).",
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{
              Sid: "OnlyRovaraForThisCompany", Effect: "Allow", Principal: { AWS: { Ref: "BrokerRoleArn" } }, Action: "sts:AssumeRole",
              Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" }, "sts:RoleSessionName": { Ref: "CompanyId" } } },
            }],
          },
          Policies: [{
            PolicyName: "InvokeChosenModelsOnly",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                { Sid: "InvokeChosenModels", Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: { Ref: "ModelResourceArns" } },
                { "Fn::If": ["DenyGlobalRouting", { Sid: "NoGlobalRouting", Effect: "Deny", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": "unspecified" } } }, { Ref: "AWS::NoValue" }] },
              ],
            },
          }],
        },
      },
    },
    Outputs: { RoleArn: { Description: "Paste this into Rovara's settings.", Value: { "Fn::GetAtt": ["RovaraBedrockInvokeRole", "Arn"] } } },
  };
}
/** The template file's exact text (2-space JSON and a final newline). */
export const bedrockRoleTemplateText = (): string => `${JSON.stringify(bedrockRoleTemplate(), null, 2)}\n`;
/** Its SHA-256 (hex): the set-up command checks the downloaded file against it. */
export const bedrockRoleTemplateSha256 = (): string => createHash("sha256").update(bedrockRoleTemplateText()).digest("hex");

const TEMPLATE_URL = /^https:\/\/[a-z0-9.-]{1,253}\/[A-Za-z0-9._~/-]{1,512}\.json$/u;
/** A docs-site template URL: https, a plain path to a .json file, and never an S3 host (DEC 238 Q10). */
export function validTemplateUrl(url: unknown): url is string {
  if (typeof url !== "string" || !TEMPLATE_URL.test(url)) return false;
  const host = new URL(url).hostname;
  return !/(?:^|\.)s3[.-]|\.amazonaws\.com$/u.test(host);
}
export interface BedrockSetupInput { templateUrl: string; brokerRoleArn: string; externalId: string; cid: string; region: string; models: Readonly<Record<string, string>>; allowGlobal: boolean; productModels?: readonly string[];
  /** A project's OWN role (slice 2): its own stack, never the company's (a command must not update the company's stack). */ project?: string }
/** CloudFormation's limit on one parameter value (the ARN list). */
const PARAMETER_BYTES_MAX = 4_096;
/**
 * The set-up, run by the customer's AWS admin in AWS CloudShell (opened in their Region). CloudFormation's one-click quick-create
 * link only takes a template stored in Amazon S3 (checked in AWS's docs 2026-11-15), and DEC 238 Q10 rules out a public bucket,
 * so the one step is a single command: fetch the template from the docs site and deploy it with every parameter filled in.
 * Every value is checked first, so the command holds nothing a shell could read as more than one word.
 */
export function bedrockSetupCommand(input: BedrockSetupInput): { cloudShellUrl: string; command: string; stackName: string } {
  if (!validTemplateUrl(input.templateUrl) || !/^arn:aws:iam::[0-9]{12}:role\/RovaraBedrockBroker-[a-z0-9-]{1,32}$/u.test(input.brokerRoleArn)
    || !BEDROCK_EXTERNAL_ID.test(input.externalId) || !COMPANY.test(input.cid) || !BEDROCK_BYO_REGION.test(input.region)
    || typeof input.allowGlobal !== "boolean" || !validModels(input.models, input.region, input.allowGlobal)
    || (input.productModels !== undefined && !validProductModels(input.productModels, input.models, input.region, input.allowGlobal))) throw new Error("invalid bedrock setup");
  const arns = bedrockResourceArns({ region: input.region, models: input.models, ...(input.productModels === undefined ? {} : { productModels: input.productModels }) });
  // One parameter holds the list: a longer one would fail at AWS after the admin ran the command.
  if (Buffer.byteLength(arns.join(","), "utf8") > PARAMETER_BYTES_MAX) throw new Error("invalid bedrock setup");
  if (input.project !== undefined && !PROJECT.test(input.project)) throw new Error("invalid bedrock setup");
  // The company's stack is `rovara-bedrock-<company>`; a project's own role gets its own stack name, so this command can never
  // update the company's stack (and so never change the company role's policy). IAM role names are account-wide: a project's own
  // role (the template names it from the company id) needs another AWS account than the company's role, or the stack fails to create.
  const stackName = `rovara-bedrock-${input.cid.replace("_", "-")}${input.project === undefined ? "" : `-${input.project}`}`;
  // Each override single-quoted (the ARNs hold `*`, which zsh or bash's failglob would expand); no value holds a quote.
  const overrides = [`CompanyId=${input.cid}`, `ExternalId=${input.externalId}`, `BrokerRoleArn=${input.brokerRoleArn}`, `ModelResourceArns=${arns.join(",")}`, `AllowGlobalRouting=${String(input.allowGlobal)}`].map((v) => `'${v}'`).join(" ");
  const command = [
    `curl -fsSL '${input.templateUrl}' -o rovara-bedrock-role.json`,
    // The template is pinned: a changed file on the docs site (or its CDN) stops here, before any IAM role is made.
    `echo '${bedrockRoleTemplateSha256()}  rovara-bedrock-role.json' | sha256sum -c -`,
    `aws cloudformation deploy --region ${input.region} --stack-name ${stackName} --template-file rovara-bedrock-role.json --capabilities CAPABILITY_NAMED_IAM`
      + ` --parameter-overrides ${overrides}`,
    `aws cloudformation describe-stacks --region ${input.region} --stack-name ${stackName} --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text`,
  ].join(" && ");
  return { cloudShellUrl: `https://${input.region}.console.aws.amazon.com/cloudshell/home?region=${input.region}`, command, stackName };
}

/**
 * Presets for the model picker: every Claude model Rovara's AI offers (agent-ai.ts ROVARA_AI_US_MODELS), on the system profile of
 * the chosen Region's geography (the first one, e.g. `eu.` from eu-west-1). Empty for a Region with no geography.
 */
export function bedrockModelPresets(region: string, rovaraModels: string): Record<string, string> {
  const geo = BEDROCK_BYO_REGION.test(region) ? geographiesOf(region)[0] : undefined;
  if (geo === undefined) return {};
  const out: Record<string, string> = {};
  for (const pair of rovaraModels.split(",")) {
    const [name, id] = pair.split("=");
    if (name === undefined || id === undefined || !AGENT_MODEL.test(name) || !/^us\.anthropic\./u.test(id)) continue;
    out[name] = `${geo}.${id.slice(3)}`;
  }
  return out;
}
