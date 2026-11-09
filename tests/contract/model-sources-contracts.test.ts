// Plan 3 Task 24a: company AI source contracts. The kinds stay off until each one's real-key checklist passes.
import { describe, expect, it } from "vitest";
import { canonicalModelName } from "../../packages/contracts/src/models-node.js";
import {
  BEDROCK_ROLE_ARN_PATTERN,
  MAX_CUSTOM_SOURCES_PER_ORG,
  MAX_MODELS_PER_SOURCE,
  ModelSourceInputSchema,
  ModelSourceKindSchema,
  ModelSourceSchema,
  OrgModelSourcesSchema,
  SOURCE_KINDS_AT_LAUNCH,
  TRANSPORTS_AT_LAUNCH,
  bedrockExternalId,
  customSourceLimitProblem,
  defaultModelSourceOrder,
  modelSourceOrgProblem,
  modelSourceInputSchema,
  sourceAlias,
  sourceKindProblem,
} from "../../packages/contracts/src/model-sources.js";

const ORG = "org_abcdefghij0123456789";
const SRC = "src_abcdefghij0123456789";
const ROLE = "arn:aws:iam::123456789012:role/rovara/proxy-access";

const claude = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const anthropicInput = { kind: "anthropic", label: "Company Anthropic", models: [{ catalog: claude }] };
const bedrockInput = { kind: "bedrock", label: "Our AWS", roleArn: ROLE, region: "us-east-1", models: [{ catalog: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" } }] };
const endpointInput = { kind: "endpoint", label: "Gateway", baseUrl: "https://llm.example.com/v1", api: "openai-completions", models: [{ name: "our-model", catalog: claude }] };

describe("launch gates", () => {
  it("keeps every company source kind off until its checklist passes", () => {
    expect(SOURCE_KINDS_AT_LAUNCH).toEqual([]);
    expect([...TRANSPORTS_AT_LAUNCH]).toEqual(["anthropic-messages", "openai-responses", "openai-completions"]);
    expect(ModelSourceKindSchema.options).toEqual(["rovara", "personal-chatgpt", "anthropic", "openai", "openrouter", "bedrock", "endpoint"]);
  });

  it.each(["anthropic", "openai", "openrouter", "bedrock", "endpoint"] as const)("refuses a %s source with the exact text", (kind) => {
    expect(sourceKindProblem(kind)).toBe(`${kind} sources aren't available yet`);
  });

  it("does not treat Rovara's own models or a member's ChatGPT plan as a company source", () => {
    expect(sourceKindProblem("rovara")).toBeUndefined();
    expect(sourceKindProblem("personal-chatgpt")).toBeUndefined();
  });

  it("accepts a kind once it joins the launch list, and refuses an endpoint api outside the transports", () => {
    const launch = { kinds: ["anthropic", "endpoint"] as const };
    expect(sourceKindProblem("anthropic", undefined, launch)).toBeUndefined();
    expect(sourceKindProblem("openai", undefined, launch)).toBe("openai sources aren't available yet");
    expect(sourceKindProblem("endpoint", "openai-completions", launch)).toBeUndefined();
    expect(sourceKindProblem("endpoint", "anthropic-messages", launch)).toBeUndefined();
    expect(sourceKindProblem("endpoint", "bedrock-converse", launch)).toBe("endpoint sources aren't available yet");
    expect(sourceKindProblem("endpoint", undefined, launch)).toBe("endpoint sources aren't available yet");
  });

  it("refuses an endpoint api outside the transports even when the transports list is narrowed", () => {
    const launch = { kinds: ["endpoint"] as const, transports: ["openai-completions"] as const };
    expect(sourceKindProblem("endpoint", "openai-responses", launch)).toBe("endpoint sources aren't available yet");
  });
});

describe("client input", () => {
  it("accepts each kind's shape", () => {
    for (const input of [anthropicInput, bedrockInput, endpointInput, { ...anthropicInput, kind: "openai", models: [{ catalog: { provider: "openai", modelId: "gpt-5" } }] }, { ...anthropicInput, kind: "openrouter", models: [{ catalog: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" } }] }]) {
      expect(ModelSourceInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    }
  });

  it.each([
    ["sourceId", { sourceId: SRC }],
    ["externalId", { externalId: `rovara-${ORG}` }],
    ["tested", { tested: false }],
    ["tested", { tested: true }],
  ])("refuses a client-sent %s", (_field, extra) => {
    for (const base of [anthropicInput, bedrockInput, endpointInput]) {
      expect(ModelSourceInputSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });

  it("refuses an unknown field and an unknown kind, including the built-in ones", () => {
    expect(ModelSourceInputSchema.safeParse({ ...anthropicInput, apiKey: "sk-x" }).success).toBe(false);
    expect(ModelSourceInputSchema.safeParse({ ...anthropicInput, kind: "rovara" }).success).toBe(false);
    expect(ModelSourceInputSchema.safeParse({ ...anthropicInput, kind: "personal-chatgpt" }).success).toBe(false);
  });

  it("accepts a valid role ARN and refuses a wildcard, a user ARN or another account's shape", () => {
    expect(BEDROCK_ROLE_ARN_PATTERN.test(ROLE)).toBe(true);
    expect(BEDROCK_ROLE_ARN_PATTERN.test("arn:aws-us-gov:iam::123456789012:role/path/name+=,.@-_")).toBe(true);
    for (const roleArn of [
      "arn:aws:iam::123456789012:role/*",
      "arn:aws:iam::*:role/proxy",
      "arn:aws:iam::123456789012:user/alice",
      "arn:aws:iam::12345678901:role/short",
      "arn:aws:iam::123456789012:role/",
      "arn:aws:iam::123456789012:role/has space",
      `arn:aws:iam::123456789012:role/${"a".repeat(513)}`,
    ]) {
      expect(BEDROCK_ROLE_ARN_PATTERN.test(roleArn), roleArn).toBe(false);
      expect(ModelSourceInputSchema.safeParse({ ...bedrockInput, roleArn }).success, roleArn).toBe(false);
    }
  });

  it("requires a region for Bedrock and an http(s) base URL for an endpoint", () => {
    expect(ModelSourceInputSchema.safeParse({ ...bedrockInput, region: "" }).success).toBe(false);
    expect(ModelSourceInputSchema.safeParse({ ...bedrockInput, region: "us east" }).success).toBe(false);
    expect(ModelSourceInputSchema.safeParse({ ...endpointInput, baseUrl: "not a url" }).success).toBe(false);
    expect(ModelSourceInputSchema.safeParse({ ...endpointInput, baseUrl: "file:///etc/passwd" }).success).toBe(false);
    expect(ModelSourceInputSchema.safeParse({ ...endpointInput, baseUrl: "ftp://llm.example.com" }).success).toBe(false);
  });

  it("holds a kind's models to that kind's catalog provider", () => {
    expect(ModelSourceInputSchema.safeParse({ ...anthropicInput, models: [{ catalog: { provider: "openai", modelId: "gpt-5" } }] }).success).toBe(false);
    expect(ModelSourceInputSchema.safeParse({ ...bedrockInput, models: [{ catalog: claude }] }).success).toBe(false);
    // An endpoint serves its own model name; its catalog entry only says what the model is like.
    expect(ModelSourceInputSchema.safeParse({ ...endpointInput, models: [{ name: "x", catalog: { provider: "openai", modelId: "gpt-5" } }] }).success).toBe(true);
  });

  it("refuses duplicate canonical models", () => {
    const dated = { catalog: { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" } };
    expect(ModelSourceInputSchema.safeParse({ ...anthropicInput, models: [{ catalog: claude }, dated] }).success).toBe(false);
    expect(canonicalModelName(claude)).toBe(canonicalModelName(dated.catalog));
    const bedrockDup = [
      { catalog: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" } },
      { catalog: { provider: "amazon-bedrock", modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" } },
    ];
    expect(ModelSourceInputSchema.safeParse({ ...bedrockInput, models: bedrockDup }).success).toBe(false);
    const endpointDup = [{ name: "Our-Model", catalog: claude }, { name: "our-model", catalog: claude }];
    expect(ModelSourceInputSchema.safeParse({ ...endpointInput, models: endpointDup }).success).toBe(false);
    const sameCatalog = [{ name: "model-a", catalog: claude }, { name: "model-b", catalog: claude }];
    expect(ModelSourceInputSchema.safeParse({ ...endpointInput, models: sameCatalog }).success).toBe(false);
  });

  it("allows 20 models and refuses 21, and refuses none", () => {
    const models = (count: number) => Array.from({ length: count }, (_, index) => ({ catalog: { provider: "anthropic", modelId: `model-${index}` } }));
    expect(MAX_MODELS_PER_SOURCE).toBe(20);
    expect(ModelSourceInputSchema.safeParse({ ...anthropicInput, models: models(20) }).success).toBe(true);
    expect(ModelSourceInputSchema.safeParse({ ...anthropicInput, models: models(21) }).success).toBe(false);
    expect(ModelSourceInputSchema.safeParse({ ...anthropicInput, models: [] }).success).toBe(false);
  });

  it("checks each catalog entry with an injected predicate, and without one checks only the shape", () => {
    const known = modelSourceInputSchema({ isKnownCatalog: (model) => model.modelId === "claude-sonnet-4-5" });
    expect(known.safeParse(anthropicInput).success).toBe(true);
    expect(known.safeParse({ ...anthropicInput, models: [{ catalog: { provider: "anthropic", modelId: "made-up" } }] }).success).toBe(false);
    expect(known.safeParse({ ...endpointInput, models: [{ name: "x", catalog: { provider: "anthropic", modelId: "made-up" } }] }).success).toBe(false);
    expect(ModelSourceInputSchema.safeParse({ ...anthropicInput, models: [{ catalog: { provider: "anthropic", modelId: "made-up" } }] }).success).toBe(true);
  });
});

describe("stored source", () => {
  it("accepts a server-completed source of each kind", () => {
    expect(ModelSourceSchema.safeParse({ ...anthropicInput, sourceId: SRC }).success).toBe(true);
    expect(ModelSourceSchema.safeParse({ ...endpointInput, sourceId: SRC }).success).toBe(true);
    expect(ModelSourceSchema.safeParse({ ...bedrockInput, sourceId: SRC, externalId: bedrockExternalId(ORG), tested: false }).success).toBe(true);
  });

  it("needs a server-generated source id, and for Bedrock the server-set external id and tested flag", () => {
    expect(ModelSourceSchema.safeParse(anthropicInput).success).toBe(false);
    expect(ModelSourceSchema.safeParse({ ...anthropicInput, sourceId: "rovara" }).success).toBe(false);
    expect(ModelSourceSchema.safeParse({ ...anthropicInput, sourceId: "src_a.b" }).success).toBe(false);
    expect(ModelSourceSchema.safeParse({ ...bedrockInput, sourceId: SRC }).success).toBe(false);
    expect(ModelSourceSchema.safeParse({ ...bedrockInput, sourceId: SRC, externalId: "rovara-x", tested: false }).success).toBe(false);
    expect(ModelSourceSchema.safeParse({ ...bedrockInput, sourceId: SRC, tested: false }).success).toBe(false);
    expect(ModelSourceSchema.safeParse({ ...anthropicInput, sourceId: SRC, tested: false }).success).toBe(false);
  });

  it("defaults a stored Bedrock source to not tested", () => {
    const parsed = ModelSourceSchema.parse({ ...bedrockInput, sourceId: SRC, externalId: bedrockExternalId(ORG) });
    expect(parsed.kind === "bedrock" && parsed.tested).toBe(false);
  });

  it("checks a stored Bedrock external id against the org", () => {
    const own = ModelSourceSchema.parse({ ...bedrockInput, sourceId: SRC, externalId: bedrockExternalId(ORG) });
    expect(modelSourceOrgProblem(ORG, own)).toBeUndefined();
    expect(modelSourceOrgProblem("org_zzzzzzzzzz0123456789", own)).toMatch(/external id/);
    expect(modelSourceOrgProblem(ORG, ModelSourceSchema.parse({ ...anthropicInput, sourceId: SRC }))).toBeUndefined();
  });

  it("derives the external id from the org", () => {
    expect(bedrockExternalId(ORG)).toBe(`rovara-${ORG}`);
  });
});

describe("org limits", () => {
  it("allows 10 custom sources per org and refuses an 11th", () => {
    expect(MAX_CUSTOM_SOURCES_PER_ORG).toBe(10);
    expect(customSourceLimitProblem(0)).toBeUndefined();
    expect(customSourceLimitProblem(9)).toBeUndefined();
    expect(customSourceLimitProblem(10)).toMatch(/10/);
    expect(customSourceLimitProblem(9, 2)).toMatch(/10/);
    expect(customSourceLimitProblem(0, 10)).toBeUndefined();
  });
});

describe("order and alias", () => {
  it("defaults to the ChatGPT-first order only with the install-wide switch on", () => {
    expect(defaultModelSourceOrder(true)).toEqual(["personal-chatgpt", "rovara"]);
    expect(defaultModelSourceOrder(false)).toEqual(["rovara"]);
  });

  it("returns a fresh array each time", () => {
    const order = defaultModelSourceOrder(false);
    order.push("personal-chatgpt");
    expect(defaultModelSourceOrder(false)).toEqual(["rovara"]);
  });

  it("builds the alias from the canonical model name", () => {
    expect(sourceAlias(ORG, SRC, { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" })).toBe(`${ORG}.${SRC}.claude-haiku-4-5`);
    expect(sourceAlias(ORG, SRC, { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" })).toBe(`${ORG}.${SRC}.claude-sonnet-4-5`);
  });

  it("parses the org's sources record", () => {
    expect(OrgModelSourcesSchema.safeParse({ sources: [{ ...anthropicInput, sourceId: SRC }], order: [SRC, "rovara"] }).success).toBe(true);
    expect(OrgModelSourcesSchema.safeParse({ sources: [], order: ["rovara"], assistantModel: claude, chatgptPreferredModel: "gpt-6.1-sol" }).success).toBe(true);
    expect(OrgModelSourcesSchema.safeParse({ sources: [], order: ["rovara"], chatgptPreferredModel: { provider: "openai", modelId: "gpt-5" } }).success).toBe(false);
    expect(OrgModelSourcesSchema.safeParse({ sources: [], order: ["rovara"], chatgptPreferredModel: "not a model id" }).success).toBe(false);
    expect(OrgModelSourcesSchema.safeParse({ sources: [], order: ["nope"] }).success).toBe(false);
    expect(OrgModelSourcesSchema.safeParse({ sources: [], order: [SRC] }).success).toBe(false);
    expect(OrgModelSourcesSchema.safeParse({ sources: [], order: ["rovara", "rovara"] }).success).toBe(false);
  });
});
