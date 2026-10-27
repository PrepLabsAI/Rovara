import { describe, expect, it, vi } from "vitest";
import { e2eAgentModelsFor } from "../../packages/contracts/src/e2e-agent-models.js";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { E2EModelRouteDefinitionSchema, e2eModelRouteRevision } from "../../packages/contracts/src/e2e-model-channel.js";
import {
  E2E_AGENT_ROUTE_SEARCH_LIMIT, deriveE2EAgentRoute, deriveE2EAgentRouteForModel, e2eAgentInstallationFromEnvironment, e2eAgentRouteDefinitionDigest, resolveE2EAgentRouteForAdmission, searchE2EAgentRoute,
  type E2EAgentInstallation,
} from "../../packages/model-runtime/src/e2e-route-derive.js";
import { bedrockRoute } from "../support/e2e-model-fixtures.js";

// The search's give-up is proved by counting: the harness can swap in a synthetic model list longer than the limit and counts every table lookup the search makes.
const searchHarness = vi.hoisted(() => ({ syntheticModelIds: undefined as string[] | undefined, lookups: 0 }));
vi.mock("@agentx/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentx/contracts")>();
  return {
    ...actual,
    e2eAgentModelsFor: (...args: Parameters<typeof actual.e2eAgentModelsFor>) =>
      searchHarness.syntheticModelIds === undefined ? actual.e2eAgentModelsFor(...args) : searchHarness.syntheticModelIds.map((modelId) => ({ modelId })),
    eligibleE2EAgentModel: (...args: Parameters<typeof actual.eligibleE2EAgentModel>) => {
      searchHarness.lookups += 1;
      return actual.eligibleE2EAgentModel(...args);
    },
  };
});

/** The secret ARN the pinned digests below were computed with at 38b55645 (a route's digest covers its secret ARN). */
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/key-AbCdEf";

// M1.4 Task 4.10A, tests 1, 2, 3 (the setting), 6 (the schema) and 7 (the worker's search).

const HAIKU_45_US = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_45_GLOBAL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const bedrock: E2EAgentInstallation = { provider: "amazon-bedrock", region: "us-east-1" };
const installations = {
  "amazon-bedrock": bedrock,
  anthropic: { provider: "anthropic", secretArn: SECRET_ARN, region: "us-east-1" },
  openai: { provider: "openai", secretArn: SECRET_ARN, region: "us-east-1" },
  openrouter: { provider: "openrouter", secretArn: SECRET_ARN, region: "us-east-1" },
} as const satisfies Record<string, E2EAgentInstallation>;

/** The digest of each provider's default route, as 38b55645 computed it for these installations (printed once at that head; they must never move). */
const OLD_DEFAULT_DIGESTS = {
  "amazon-bedrock": { digest: "01552c0c27e0b584697a1eeb8e5eb9570d46adfda8d7d5a58798ea9ebf59e71d", revision: "r1-1ca517bbc9f9" },
  anthropic: { digest: "4d8bc013017cf1a53eacc38c95914f59cbbddf66143b3acba9ea392a024f8076", revision: "r1-57566e285d01" },
  openai: { digest: "6213c1182264616c80aa565c22c90057c081f91a34e503c5673142a229605b7c", revision: "r1-bc75f4ca98e9" },
  openrouter: { digest: "b4444494c0b141c6c6b072aff1f27f014f3c4acacc72948078a5da341f582f65", revision: "r1-36ff8da2c130" },
} as const;
const OLD_OPENROUTER_ALLOWLIST_DIGEST = "4446050df130270828108dfa14e476aa0e0b9f9696d6b71812e7b27099c72035";

const available = (installation: E2EAgentInstallation, revision = 1) => {
  const derived = deriveE2EAgentRoute(installation, revision);
  if (derived.status !== "available") throw new Error(`not available: ${derived.detail}`);
  return derived.definition;
};

describe("default route digests do not move (test 1)", () => {
  it.each(Object.keys(installations) as Array<keyof typeof installations>)("%s: no setting, default, none and the empty string all give the digest 38b55645 computed", (provider) => {
    for (const e2eModel of [undefined, "default", "none", "", "  default  "]) {
      const definition = available({ ...installations[provider], ...(e2eModel === undefined ? {} : { e2eModel }) });
      expect(e2eAgentRouteDefinitionDigest(definition), `${provider} ${JSON.stringify(e2eModel)}`).toBe(OLD_DEFAULT_DIGESTS[provider].digest);
      expect(e2eModelRouteRevision(definition)).toBe(OLD_DEFAULT_DIGESTS[provider].revision);
      expect(definition).not.toHaveProperty("payloadShape");
    }
  });

  it("names the recommended model as the setting and still gives the same digest, and pins OpenRouter's allowlist route", () => {
    expect(e2eAgentRouteDefinitionDigest(available({ ...bedrock, e2eModel: "us.anthropic.claude-haiku-5-5" }))).toBe(OLD_DEFAULT_DIGESTS["amazon-bedrock"].digest);
    expect(e2eAgentRouteDefinitionDigest(available({ ...installations.openrouter, openRouterProviders: "amazon-bedrock,anthropic" }))).toBe(OLD_OPENROUTER_ALLOWLIST_DIGEST);
  });

  it("keeps a default Bedrock install in another geography on the route it has always had (the recommended model is not held to the region rule)", () => {
    const definition = available({ provider: "amazon-bedrock", region: "eu-west-1" });
    expect(definition).toMatchObject({ modelId: "us.anthropic.claude-haiku-5-5", region: "eu-west-1", effort: "low" });
  });
});

describe("a chosen model (test 2)", () => {
  it("gives Bedrock Haiku 4.5 US-only no effort and no payloadShape, under a digest of its own", () => {
    const us = available({ ...bedrock, e2eModel: HAIKU_45_US });
    expect(us).toMatchObject({ modelId: HAIKU_45_US, effort: null, provider: "amazon-bedrock", region: "us-east-1", inferenceProfileArn: null });
    expect(us).not.toHaveProperty("payloadShape");
    const global = available({ ...bedrock, e2eModel: HAIKU_45_GLOBAL });
    const digests = [e2eAgentRouteDefinitionDigest(available(bedrock)), e2eAgentRouteDefinitionDigest(us), e2eAgentRouteDefinitionDigest(global)];
    expect(new Set(digests).size).toBe(3);
    expect(global).toMatchObject({ modelId: HAIKU_45_GLOBAL, effort: null });
  });

  it("pins the digests of the two Haiku 4.5 profiles, so a change to either is a deliberate one", () => {
    expect(e2eAgentRouteDefinitionDigest(available({ ...bedrock, e2eModel: HAIKU_45_US }))).toBe("2bbb13a3688841551e211645314caaa2af5d57ad3b6020511537917f547dc208");
    expect(e2eAgentRouteDefinitionDigest(available({ ...bedrock, e2eModel: HAIKU_45_GLOBAL }))).toBe("d0beee86026652cd2bd79e493949b53bfa8d7965218dea2fa49bbcc4c7721968");
  });

  it("gives the request shape of the metadata: Haiku 5.5 low, gpt-5.4-mini none, and minimal sends no effort at all", () => {
    expect(available({ ...bedrock, e2eModel: "global.anthropic.claude-haiku-5-5" }).effort).toBe("low");
    expect(available({ ...installations.openai, e2eModel: "gpt-5.4" }).effort).toBeNull();
    const minimal = available({ ...bedrock, e2eModel: "us.anthropic.claude-haiku-5-5", payloadShape: "minimal" });
    expect(minimal).toMatchObject({ effort: null, payloadShape: "minimal" });
    expect(e2eAgentRouteDefinitionDigest(minimal)).not.toBe(OLD_DEFAULT_DIGESTS["amazon-bedrock"].digest);
  });

  it("refuses a model that is not eligible with a fixed sentence that does not carry the setting's value", () => {
    for (const e2eModel of ["anthropic.claude-haiku-4-5-20251001-v1:0", "us.anthropic.not-a-model-SECRETVALUE", "eu.anthropic.claude-haiku-5-5"]) {
      const derived = deriveE2EAgentRoute({ ...bedrock, e2eModel }, 1);
      expect(derived.status, e2eModel).toBe("unavailable");
      if (derived.status === "unavailable") {
        expect(derived).toMatchObject({ reason: "agent-route-not-approved" });
        expect(derived.detail).toBe("the chosen AI navigation model is not one Rovara can use with Amazon Bedrock in this region");
        expect(derived.detail).not.toContain("SECRETVALUE");
      }
    }
    const keyed = deriveE2EAgentRoute({ ...installations.anthropic, e2eModel: "us.anthropic.claude-haiku-5-5" }, 1);
    expect(keyed).toMatchObject({ status: "unavailable", detail: "the chosen AI navigation model is not one Rovara can use with Anthropic in this region" });
    expect(deriveE2EAgentRoute({ ...bedrock, e2eModel: "eu.anthropic.claude-haiku-5-5", region: "eu-west-1" }, 1).status).toBe("available");
  });

  it("builds the route of a named model in a named shape whatever the setting says", () => {
    const derived = deriveE2EAgentRouteForModel({ ...bedrock, e2eModel: "global.anthropic.claude-haiku-5-5" }, HAIKU_45_US, "minimal", 4);
    expect(derived).toMatchObject({ status: "available", definition: { modelId: HAIKU_45_US, revision: 4, effort: null, payloadShape: "minimal" } });
    expect(deriveE2EAgentRouteForModel(bedrock, "anthropic.claude-haiku-4-5-20251001-v1:0", "standard", 1).status).toBe("unavailable");
  });
});

describe("the route schema's payloadShape (test 6)", () => {
  it("parses a definition from 38b55645, which has no such field, and hashes it as before", () => {
    const stored = bedrockRoute();
    expect(stored).not.toHaveProperty("payloadShape");
    const old = {
      routeId: "rovara-e2e-default", revision: 1, scope: "standard", provider: "amazon-bedrock", region: "us-east-1", modelId: "us.anthropic.claude-haiku-5-5", inferenceProfileArn: null,
      secretArn: null, openRouter: null, budgets: stored.budgets, promptProtocol: "e2e-0.20.0-act/v1", sampling: "provider-default", thinking: "off", effort: "low", vision: false,
    };
    const parsed = E2EModelRouteDefinitionSchema.parse(old);
    expect(Object.keys(parsed)).not.toContain("payloadShape");
    expect(canonicalJson(parsed)).toBe(canonicalJson(old));
    expect(e2eModelRouteRevision(parsed)).toBe("r1-1ca517bbc9f9");
    expect(e2eAgentRouteDefinitionDigest(parsed)).toBe(OLD_DEFAULT_DIGESTS["amazon-bedrock"].digest);
  });

  it("refuses the minimal shape with an effort, and a shape other than minimal", () => {
    const raw = (overrides: Record<string, unknown>) => ({ ...bedrockRoute(), ...overrides });
    expect(E2EModelRouteDefinitionSchema.safeParse(raw({ payloadShape: "minimal", effort: "low" })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(raw({ payloadShape: "minimal", effort: null })).success).toBe(true);
    expect(E2EModelRouteDefinitionSchema.safeParse(raw({ payloadShape: "standard", effort: null })).success).toBe(false);
    expect(E2EModelRouteDefinitionSchema.safeParse(raw({ payloadShape: undefined })).success).toBe(true);
  });
});

describe("the worker finds the route of the admission's revision among the eligible models (test 7)", () => {
  const environment = { AGENTX_MODEL_PROVIDER: "amazon-bedrock", AWS_REGION: "us-east-1" };
  const revisionOf = (installation: E2EAgentInstallation, revision = 1) => ({ routeId: "rovara-e2e-default", routeRevision: e2eModelRouteRevision(available(installation, revision)) });
  const resolve = (route: { routeId: string; routeRevision: string }, env: NodeJS.ProcessEnv = environment) => resolveE2EAgentRouteForAdmission(route, { environment: env, policyScope: "standard" });

  it("serves a chosen model at its revision, in the standard and the minimal shape, with no model variable in the environment", () => {
    for (const shape of [undefined, "minimal"] as const) {
      const installation = { ...bedrock, e2eModel: HAIKU_45_US, ...(shape === undefined ? {} : { payloadShape: shape }) };
      const resolved = resolve(revisionOf(installation, 3));
      expect(resolved.ok, String(shape)).toBe(true);
      if (resolved.ok) {
        expect(resolved.definition).toMatchObject({ modelId: HAIKU_45_US, revision: 3, effort: null });
        expect(resolved.definition.payloadShape).toBe(shape);
      }
    }
    expect(Object.keys(environment).some((name) => name.startsWith("AGENTX_E2E_"))).toBe(false);
    const recommended = resolve(revisionOf(bedrock));
    expect(recommended.ok && recommended.definition.modelId).toBe("us.anthropic.claude-haiku-5-5");
  });

  it("serves a keyed provider's chosen model, and a Global profile", () => {
    const env = { AGENTX_MODEL_PROVIDER: "openai", AGENTX_OPENAI_SECRET_ARN: SECRET_ARN, AWS_REGION: "us-east-1" };
    const resolved = resolve(revisionOf({ ...installations.openai, e2eModel: "gpt-5.4" }), env);
    expect(resolved.ok && resolved.definition.modelId).toBe("gpt-5.4");
    const global = resolve(revisionOf({ ...bedrock, e2eModel: HAIKU_45_GLOBAL }));
    expect(global.ok && global.definition.modelId).toBe(HAIKU_45_GLOBAL);
  });

  it("refuses with model-route-changed-reapprove a revision hand-built from an ineligible id, from another provider's model, or another region's profile", () => {
    const handBuilt = (modelId: string, extra: Record<string, unknown> = {}) => ({
      routeId: "rovara-e2e-default", routeRevision: e2eModelRouteRevision(bedrockRoute({ modelId, ...extra })),
    });
    expect(resolve(handBuilt("anthropic.claude-haiku-4-5-20251001-v1:0", { effort: null }))).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
    expect(resolve(handBuilt("us.anthropic.no-such-model", { effort: null }))).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
    expect(resolve(handBuilt("eu.anthropic.claude-haiku-5-5"))).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
    // An eligible model at the wrong effort is not what the worker would make either.
    expect(resolve(handBuilt(HAIKU_45_US, { effort: "low" }))).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
    // The approval of an eu profile is served by a worker in eu, and not by one in us.
    const eu = revisionOf({ provider: "amazon-bedrock", region: "eu-west-1", e2eModel: "eu.anthropic.claude-haiku-5-5" });
    expect(resolve(eu, { AGENTX_MODEL_PROVIDER: "amazon-bedrock", AWS_REGION: "eu-west-1" }).ok).toBe(true);
    expect(resolve(eu)).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
  });

  it("never takes a definition from the admission: only the route id and revision are read, and a definition that is not derivable cannot be served", () => {
    const route = { ...revisionOf({ ...bedrock, e2eModel: HAIKU_45_US }), definition: bedrockRoute({ modelId: "us.anthropic.not-eligible", effort: null }) };
    const resolved = resolve(route);
    expect(resolved.ok && resolved.definition.modelId).toBe(HAIKU_45_US);
  });

  it("searches every eligible model of the provider in both shapes, and gives up after 1,000 candidates (counted, not timed)", () => {
    const installation = e2eAgentInstallationFromEnvironment({ AGENTX_MODEL_PROVIDER: "openrouter", AGENTX_OPENROUTER_SECRET_ARN: SECRET_ARN, AWS_REGION: "us-east-1" });
    // Today's table: every eligible model is tried in both shapes and nothing matches. The recommended model's row needs no lookup, so it costs two candidates and no lookup.
    searchHarness.lookups = 0;
    expect(searchE2EAgentRoute(installation, "openrouter", 1, "r1-ffffffffffff")).toBeUndefined();
    const eligibleCount = e2eAgentModelsFor("openrouter", "us-east-1").length;
    expect(eligibleCount).toBeGreaterThan(1);
    expect(searchHarness.lookups).toBe(2 * (eligibleCount - 1));
    expect(searchHarness.lookups).toBeLessThan(E2E_AGENT_ROUTE_SEARCH_LIMIT);

    // A list far longer than the limit: the search stops at exactly 1,000 candidates (two of them the recommended model, which needs no lookup).
    searchHarness.syntheticModelIds = Array.from({ length: 2_000 }, (_, index) => `synthetic/model-${index}`);
    searchHarness.lookups = 0;
    try {
      expect(searchE2EAgentRoute(installation, "openrouter", 1, "r1-ffffffffffff")).toBeUndefined();
    } finally {
      searchHarness.syntheticModelIds = undefined;
    }
    expect(searchHarness.lookups).toBe(E2E_AGENT_ROUTE_SEARCH_LIMIT - 2);
  });

  it("finds the minimal shape only through the shape loop (mutation: with no minimal candidates the minimal revision is not found)", () => {
    const route = revisionOf({ ...bedrock, e2eModel: HAIKU_45_US, payloadShape: "minimal" }, 2);
    const installation = e2eAgentInstallationFromEnvironment(environment);
    const found = searchE2EAgentRoute(installation, "amazon-bedrock", 2, route.routeRevision);
    expect(found?.payloadShape).toBe("minimal");
    // The same model in the standard shape is another revision.
    const standard = revisionOf({ ...bedrock, e2eModel: HAIKU_45_US }, 2);
    expect(searchE2EAgentRoute(installation, "amazon-bedrock", 2, standard.routeRevision)?.payloadShape).toBeUndefined();
    expect(standard.routeRevision).not.toBe(route.routeRevision);
  });
});
