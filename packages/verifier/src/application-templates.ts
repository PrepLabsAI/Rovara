import { createHash } from "node:crypto";
import { canonicalJson, APPLICATION_E2E_TEST_PATH, E2E_MODEL_ROUTE_DEFAULT_BUDGETS, type E2EExpectedCase, type E2EScenario } from "@agentx/contracts";
import type { E2EApplicationCliHostDescriptor, E2EApplicationLaunchTarget } from "@agentx/contracts";
import type { E2EApplicationSelectionPacket } from "./application-identity.js";

export const E2E_APPLICATION_COMPILER_PROTOCOL = "trusted-e2e-application-compiler/v1" as const;
export const E2E_APPLICATION_GROUP_COMPILER_PROTOCOL = "trusted-e2e-application-group-compiler/v1" as const;
export const E2E_APPLICATION_GENERATED_CONFIG_PATH = "e2e.config.mjs" as const;
export const E2E_APPLICATION_SELECTION_PACKET_PATH = ".agentx/e2e/application-selection-packet.json" as const;
export const E2E_APPLICATION_DECLARATION_PATH = ".agentx/e2e/application-cli-declaration.json" as const;
export type E2EApplicationCompiledFile = Readonly<{ path: string; sha256: string; byteLength: number; role: "test" | "config" | "selection-packet" | "declaration" }>;
export type E2EApplicationCompiledInventory = Readonly<{ schemaVersion: 1; compilerProtocol: typeof E2E_APPLICATION_COMPILER_PROTOCOL;
  upstream: { package: "e2e"; version: "0.20.0"; idAlgorithm: "e2e-0.20.0-test-id-result-id/v1"; configDigestAlgorithm: "e2e-0.20.0-sanitized-config/v1"; expectedConfigDigest: string };
  files: readonly E2EApplicationCompiledFile[]; digest: string }>;

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function sanitizeEngine(engine: E2EApplicationLaunchTarget["engine"]): unknown {
  if (engine === null) return undefined;
  return { name: engine.name, version: engine.version, spiVersion: engine.spiVersion, platform: engine.platform,
    ...(engine.workers === undefined ? {} : { workers: engine.workers }), capabilities: [...engine.capabilities].sort() };
}
function sanitizeApp(app: E2EApplicationLaunchTarget["app"]): unknown {
  if (app === null) return {};
  return { ...(app.url === undefined ? {} : { url: app.url }), ...(app.bundleId === undefined ? {} : { bundleId: app.bundleId }),
    ...(app.appPath === undefined ? {} : { appPath: app.appPath }), identity: app.identity, environment: app.environment,
    ...(app.launchArguments === undefined ? {} : { launchArguments: [...app.launchArguments] }) };
}

/**
 * What a group with an agent step puts into the sanitized config that e2e digests (Task 4.3b; the broker computes this digest too, so it is shared and pinned here): the agents entry names
 * Rovara's own executor (`rovara-e2e-agent`, version 1) and the per-request input ceiling the route allows, and the replay cache is the capture-only store (read-write, a store that writes).
 * Only a group whose admission names a model route has these; every other group keeps `cache: "off"` and no executor, so its digest does not move. A change to any of these moves the
 * digest of every agent-bearing group and needs the broker, the worker and the executor deployed together.
 */
export const E2E_AGENT_EXECUTOR_NAME = "rovara-e2e-agent" as const;
export const E2E_AGENT_EXECUTOR_VERSION = "1" as const;
export const E2E_AGENT_CONFIG_MAX_INPUT_TOKENS = E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxInputTokens;

export function expectedE2EApplicationConfigDigest(input: {
  projectId: string; tests: readonly string[]; target: E2EApplicationLaunchTarget; timeout: number;
  modelRoute: null | { routeId: string; routeRevision: string };
}): string {
  const target = input.target;
  const agents = input.modelRoute === null ? undefined : { default: { model: {
    provider: "agentx-e2e", modelId: input.modelRoute.routeId, specificationVersion: "v4",
  }, maxInputTokens: E2E_AGENT_CONFIG_MAX_INPUT_TOKENS, executor: { name: E2E_AGENT_EXECUTOR_NAME, version: E2E_AGENT_EXECUTOR_VERSION } } };
  const sanitized = {
    projectId: input.projectId, tests: [...input.tests], workers: 1, retries: 0, timeout: input.timeout,
    cache: input.modelRoute === null ? "off" : { mode: "read-write", store: { writable: true } }, reporters: [], ...(agents === undefined ? {} : { agents }),
    targets: [{ name: target.targetId, platform: target.engine?.platform ?? "api", app: sanitizeApp(target.app),
      ...(target.engine === null ? {} : { engine: sanitizeEngine(target.engine) }) }],
  };
  return sha256(canonicalJson(sanitized));
}

export function renderE2EApplicationGeneratedTest(input: {
  cases: readonly E2EExpectedCase[]; scenarios: readonly E2EScenario[]; timeoutMs: number;
  assertionsByCase: ReadonlyMap<string, readonly { index: number; kind: string; digest: string }[]>;
}): string {
  const scenarios = new Map(input.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const cases = input.cases.map((expected) => {
    const title = expected.upstreamTestId.slice(expected.upstreamTestId.lastIndexOf("::") + 2);
    if (expected.upstreamTestId !== `${APPLICATION_E2E_TEST_PATH}::${title}` || !/^case-[a-f0-9]{64}$/.test(title)) throw new Error("application upstream test ID does not follow the pinned identity format");
    const scenario = scenarios.get(expected.scenarioId);
    const assertions = input.assertionsByCase.get(expected.caseId);
    if (!scenario || !assertions || assertions.length !== scenario.assertions.length) throw new Error("application case assertion or scenario binding is incomplete");
    return { expected, title, assertions };
  });
  const lines = [`import { test } from "e2e";`, `declare global { var __agentxE2EApplication: { runCase(caseId: string, fixtures: unknown): Promise<void> } | undefined; }`];
  for (const { expected, title, assertions } of cases) {
    const timeout = Math.max(1, Math.min(input.timeoutMs, 300_000));
    // Each CLI shard contains exactly one target. Upstream platform filters match platform names
    // (for example, several browser targets are all "web"), so they cannot enforce target identity.
    lines.push(`test(${JSON.stringify(title)}, { timeout: ${timeout}, retries: 0 }, async (fixtures) => {`);
    lines.push(`  const bridge = globalThis.__agentxE2EApplication;`);
    lines.push(`  if (!bridge || typeof bridge.runCase !== "function") throw new Error("installed application bridge is unavailable");`);
    lines.push(`  await bridge.runCase(${JSON.stringify(expected.caseId)}, fixtures);`);
    lines.push(`});`);
    void assertions;
  }
  return `${lines.join("\n")}\n`;
}

export function renderE2EApplicationConfigWrapper(): string {
  return `import { prepareE2EApplicationCliConfig } from "@agentx/verifier";\nexport default await prepareE2EApplicationCliConfig({ configUrl: import.meta.url });\n`;
}

export function renderE2EApplicationDeclaration(input: {
  target: E2EApplicationLaunchTarget; cliHost: { profileId: string; descriptor: E2EApplicationCliHostDescriptor };
  preparedEnvironmentDigest: string; originByApplicationId: readonly { applicationId: string; origin: string }[];
  timeoutMs: number; modelRoute: null | { routeId: string; routeRevision: string };
  expectedConfigDigest: string; cases: readonly E2EExpectedCase[]; assertionsByCase: ReadonlyMap<string, readonly { index: number; kind: string; digest: string }[]>;
}): string {
  return `${JSON.stringify({ schemaVersion: "e2e-application-cli-declaration/v1", projectId: "rovara-application-e2e",
    testPath: APPLICATION_E2E_TEST_PATH, target: input.target, cliHost: input.cliHost, preparedEnvironmentDigest: input.preparedEnvironmentDigest,
    originByApplicationId: input.originByApplicationId, timeoutMs: input.timeoutMs, modelRoute: input.modelRoute,
    expectedConfigDigest: input.expectedConfigDigest,
    cases: input.cases.map((item) => ({ caseId: item.caseId, upstreamTestId: item.upstreamTestId, targetId: item.targetId,
      assertionBindings: input.assertionsByCase.get(item.caseId) ?? [] })) }, null, 2)}\n`;
}

export function renderE2EApplicationSelectionPacket(packet: E2EApplicationSelectionPacket): string { return `${JSON.stringify(packet, null, 2)}\n`; }
