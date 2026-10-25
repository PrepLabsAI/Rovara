import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { e2eModelRouteRevision } from "../../packages/contracts/src/e2e-model-channel.js";
import { deriveE2EAgentRoute, e2eAgentInstallationFromEnvironment, resolveE2EAgentRouteForAdmission, scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { deriveE2EAgentRoute as brokerDerive, e2eAgentInstallationFromParameters } from "../../packages/broker/src/e2e/model-route-registry.js";
import { deriveE2EAgentRoute as installedDerive } from "@agentx/model-runtime/e2e-route-derive";
import { SECRET_ARN } from "../support/e2e-model-fixtures.js";

// Task 4.3a, test case 2 (Ruling DB-7): the worker re-derives the route an admission names from its own settings and holds it to the admission's revision.

const OTHER_SECRET = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/other-key-ZyXwVu";
const bedrockEnv = { AGENTX_MODEL_PROVIDER: "amazon-bedrock", AWS_REGION: "us-east-1" };
const anthropicEnv = { AGENTX_MODEL_PROVIDER: "anthropic", AGENTX_ANTHROPIC_SECRET_ARN: SECRET_ARN, AWS_REGION: "us-east-1" };

/** The reference a broker approved for the installation these settings describe. */
function approvedRoute(environment: NodeJS.ProcessEnv, revision = 1) {
  const derived = deriveE2EAgentRoute(e2eAgentInstallationFromEnvironment(environment), revision);
  if (derived.status !== "available") throw new Error("fixture installation has no route");
  return { routeId: derived.definition.routeId, routeRevision: e2eModelRouteRevision(derived.definition) };
}
const resolve = (route: { routeId: string; routeRevision: string }, environment: NodeJS.ProcessEnv, policyScope: "standard" | "qualification" = "standard") =>
  resolveE2EAgentRouteForAdmission(route, { environment, policyScope });

describe("resolveE2EAgentRouteForAdmission", () => {
  it("serves the route when the worker's settings reproduce the admission's revision exactly (positive control)", () => {
    for (const environment of [bedrockEnv, anthropicEnv]) {
      const route = approvedRoute(environment);
      const resolved = resolve(route, environment);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(e2eModelRouteRevision(resolved.definition)).toBe(route.routeRevision);
    }
    // A later revision number is derived under that number.
    const second = approvedRoute(anthropicEnv, 2);
    const resolved = resolve(second, anthropicEnv);
    expect(resolved.ok && resolved.definition.revision).toBe(2);
  });

  it("refuses with model-route-changed-reapprove when the provider, the secret ARN or the region differs from the revision", () => {
    const bedrock = approvedRoute(bedrockEnv);
    const anthropic = approvedRoute(anthropicEnv);
    const cases: Array<[string, { routeId: string; routeRevision: string }, NodeJS.ProcessEnv]> = [
      ["provider", anthropic, bedrockEnv],
      ["secret ARN", anthropic, { ...anthropicEnv, AGENTX_ANTHROPIC_SECRET_ARN: OTHER_SECRET }],
      ["region", bedrock, { ...bedrockEnv, AWS_REGION: "eu-west-1" }],
      ["keyed provider", bedrock, anthropicEnv],
    ];
    for (const [what, route, environment] of cases) {
      const resolved = resolve(route, environment);
      expect(resolved, what).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
    }
  });

  it("refuses a redelivered admission after a settings change, and one whose revision is unreadable", () => {
    const stored = approvedRoute(anthropicEnv);
    expect(resolve(stored, anthropicEnv).ok).toBe(true);
    // The administrator changed the worker's secret after the admission was stored; the redelivery is the same bytes.
    expect(resolve(stored, { ...anthropicEnv, AGENTX_ANTHROPIC_SECRET_ARN: OTHER_SECRET })).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
    expect(resolve({ ...stored, routeRevision: "r1-ffffffffffff" }, anthropicEnv)).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
    expect(resolve({ ...stored, routeRevision: "latest" }, anthropicEnv)).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
  });

  it("refuses with agent-route-not-approved a route the worker cannot make or does not serve, with a sentence that carries no value from the environment", () => {
    const stored = approvedRoute(anthropicEnv);
    const noSecret = resolve(stored, { AGENTX_MODEL_PROVIDER: "anthropic", AWS_REGION: "us-east-1" });
    expect(noSecret).toMatchObject({ ok: false, code: "agent-route-not-approved" });
    expect(resolve({ ...stored, routeId: "some-other-route" }, anthropicEnv)).toMatchObject({ ok: false, code: "agent-route-not-approved" });
    expect(resolve(stored, { AGENTX_MODEL_PROVIDER: "nonsense" })).toMatchObject({ ok: false, code: "agent-route-not-approved" });
    const leaked = resolve(stored, { AGENTX_MODEL_PROVIDER: "anthropic", AGENTX_ANTHROPIC_SECRET_ARN: "not-an-arn-SECRETVALUE" });
    expect(leaked.ok).toBe(false);
    if (!leaked.ok) expect(leaked.detail).not.toContain("SECRETVALUE");
  });

  it("maps a rovara-scripted/ route to the scripted definition, admitted only under a qualification policy or with ROVARA_E2E_SCRIPTED_MODEL=1", () => {
    const scripted = { routeId: "rovara-scripted/v1", routeRevision: e2eModelRouteRevision(scriptedE2ERouteDefinition()) };
    expect(resolve(scripted, {}, "standard")).toMatchObject({ ok: false, code: "agent-route-not-approved" });
    expect(resolve(scripted, { ROVARA_E2E_SCRIPTED_MODEL: "0" }, "standard")).toMatchObject({ ok: false, code: "agent-route-not-approved" });
    const flagged = resolve(scripted, { ROVARA_E2E_SCRIPTED_MODEL: "1" }, "standard");
    expect(flagged.ok && flagged.definition.provider).toBe("rovara-scripted");
    expect(resolve(scripted, {}, "qualification").ok).toBe(true);
    // The scripted route is judged by its own revision too, and no other scripted id is served.
    expect(resolve({ ...scripted, routeRevision: "r1-ffffffffffff" }, { ROVARA_E2E_SCRIPTED_MODEL: "1" })).toMatchObject({ ok: false, code: "model-route-changed-reapprove" });
    expect(resolve({ routeId: "rovara-scripted/v2", routeRevision: scripted.routeRevision }, { ROVARA_E2E_SCRIPTED_MODEL: "1" })).toMatchObject({ ok: false, code: "agent-route-not-approved" });
  });

  it("a non-scripted route never resolves to the scripted double, whatever ROVARA_E2E_SCRIPTED_MODEL says", () => {
    const real = approvedRoute(anthropicEnv);
    const resolved = resolve(real, { ...anthropicEnv, ROVARA_E2E_SCRIPTED_MODEL: "1" }, "qualification");
    expect(resolved.ok && resolved.definition.provider).toBe("anthropic");
  });
});

describe("the broker and the worker derive the same route", () => {
  const parameters = (values: Record<string, string>) => async (names: readonly string[]) => new Map(names.flatMap((name) => (values[name] === undefined ? [] : [[name, values[name]] as [string, string]])));
  const prefix = "/agentx/test/";

  it("byte-equal in parsed form, for Bedrock, a keyed provider and OpenRouter with an allowlist", async () => {
    const settings: Array<{ environment: NodeJS.ProcessEnv; values: Record<string, string> }> = [
      { environment: bedrockEnv, values: { [`${prefix}worker-model-provider`]: "amazon-bedrock" } },
      { environment: anthropicEnv, values: { [`${prefix}worker-model-provider`]: "anthropic", [`${prefix}worker-anthropic-secret-arn`]: SECRET_ARN } },
      { environment: { AGENTX_MODEL_PROVIDER: "openrouter", AGENTX_OPENROUTER_SECRET_ARN: SECRET_ARN, AGENTX_OPENROUTER_PROVIDERS: "anthropic, amazon-bedrock", AWS_REGION: "us-east-1" },
        values: { [`${prefix}worker-model-provider`]: "openrouter", [`${prefix}worker-openrouter-secret-arn`]: SECRET_ARN, [`${prefix}worker-openrouter-providers`]: "anthropic, amazon-bedrock" } },
    ];
    for (const { environment, values } of settings) {
      const fromBroker = brokerDerive(await e2eAgentInstallationFromParameters(prefix, parameters(values), "us-east-1"), 3);
      const fromWorker = deriveE2EAgentRoute(e2eAgentInstallationFromEnvironment(environment), 3);
      expect(fromBroker.status).toBe("available");
      expect(canonicalJson(fromWorker)).toBe(canonicalJson(fromBroker));
      if (fromBroker.status === "available" && fromWorker.status === "available") expect(e2eModelRouteRevision(fromWorker.definition)).toBe(e2eModelRouteRevision(fromBroker.definition));
    }
  });

  it("the broker's registry re-exports the model-runtime derivation: one function, not two", () => {
    // The broker (here its source, which imports the installed package) re-exports the function of the package's `./e2e-route-derive` subpath, which loads no pi-ai.
    expect(brokerDerive).toBe(installedDerive);
  });

  it("an unset AGENTX_MODEL_PROVIDER is Bedrock for the worker, as for the coding agent", () => {
    expect(e2eAgentInstallationFromEnvironment({ AWS_REGION: "us-east-1" })).toEqual({ provider: "amazon-bedrock", region: "us-east-1" });
    expect(e2eAgentInstallationFromEnvironment({ AGENTX_MODEL_PROVIDER: "none", AWS_DEFAULT_REGION: "us-west-2" })).toEqual({ provider: "amazon-bedrock", region: "us-west-2" });
  });
});

describe("the route derivation module", () => {
  it("imports nothing but contracts (and node:crypto for the route digest), so the broker that loads its subpath never loads pi-ai", () => {
    const source = readFileSync(new URL("../../packages/model-runtime/src/e2e-route-derive.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/^\s*(?:import|export)[^"']*from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    expect(specifiers).toEqual(["node:crypto", "@agentx/contracts"]);
    expect((JSON.parse(readFileSync(new URL("../../packages/model-runtime/package.json", import.meta.url), "utf8")) as { exports: Record<string, string> }).exports["./e2e-route-derive"]).toBe("./dist/e2e-route-derive.js");
  });
});
