import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DRIVING_TEST_BUDGET, DRIVING_TEST_FIRST_CALL_CASE_ID, E2EModelCheckRequestSchema, E2EModelCheckResultSchema, E2E_AGENT_RECOMMENDED_MODELS, E2E_MODEL_CHANNEL_SCHEMA_VERSION, E2E_MODEL_CHECK_RESULT_SCHEMA,
  e2eAgentModelsFor, e2eModelRouteRevision, isKeyedModelProvider,
  type E2EModelCheckRefusal, type E2EModelCheckRequest, type E2EModelCheckResult, type E2EModelRouteDefinition, type ModelProvider,
} from "@agentx/contracts";
import {
  E2EPayloadRefusedError, assertE2EEnvironmentCannotRedirect, assertE2ESharedAwsConfigCannotRedirect, createE2EProviderInvoke, createGovernedE2EModelRoute, deriveE2EAgentRoute,
  deriveE2EAgentRouteForModel, e2eAgentInstallationFromEnvironment, e2eAgentRouteDefinitionDigest, readProviderKey, searchE2EAgentRouteByDigest,
  type E2EDayBudget, type E2EInvoke, type E2EInvokeInput,
} from "@agentx/model-runtime";
import { discoverModels, type DiscoveryDependencies, type ModelDiscoveryReport } from "@agentx/model-runtime/model-discovery";
import { WEB_API_BUILD_IMAGE, containedRuntimeProfileForHost, createDrivingNavigator, createProcessDockerCli, runModelDrivingTest, type DockerApplicationModelChannel, type DrivingChannelRequest, type DrivingShape, type NavigationOutcome } from "@agentx/verifier";
import { awsBedrockDiscoveryClient, awsQuotaClient } from "./e2e-model-discovery-aws.js";
import { createE2ECredentialGuard } from "./e2e-model-credential-guard.js";
import { createE2EModelEvidenceCollector, openE2EModelChannelSession } from "./e2e-model-channel-session.js";

/**
 * The worker's side of the on-account model check (M1.4 Task 4.10C), run on the qualified runner inside the worker container.
 *
 * `discover` lists the models the account sees (read-only, no model call). `drive` is the driving test: the single first call (with the one minimal-shape retry after a rejected
 * request), then a short navigation of the built-in fixture through the real executor and the governed model channel, all under ONE budget that the request cannot raise
 * (`DRIVING_TEST_BUDGET`): at most 6 calls, 36,000 input tokens and 512 output tokens per call, counted across the first call, the retry and the navigation. The route is the worker's
 * own derivation of the digest the request names (a definition is never taken from the request). Nothing returned or logged carries a prompt, an answer, a key or a provider message.
 */

// ---------------------------------------------------------------------------------------------------------------------
// The whole test's budget
// ---------------------------------------------------------------------------------------------------------------------

export interface DrivingTestLedger extends E2EDayBudget {
  snapshot(): { calls: number; inputTokens: number };
}

/**
 * The budget of one driving test as a day budget the governed routes reserve from: every call of every route of the test (first call, retry, navigation) shares it. A reserve that
 * would pass 6 calls or 36,000 input tokens in all is refused, which the route turns into a `budget` receipt (`model-route-budget-exhausted`), and the case is UNKNOWN, never a pass.
 * The route's own day limits are ignored: this budget is the test's.
 */
export function createDrivingTestLedger(): DrivingTestLedger {
  let calls = 0;
  let inputTokens = 0;
  return {
    reserve(reservedTokens) {
      if (calls + 1 > DRIVING_TEST_BUDGET.maxCalls || inputTokens + reservedTokens > DRIVING_TEST_BUDGET.maxInputTokensTotal) return null;
      calls += 1;
      inputTokens += reservedTokens;
      let done = false;
      return {
        settle(actual) { if (done) return; done = true; inputTokens += actual - reservedTokens; },
        release() { if (done) return; done = true; calls -= 1; inputTokens -= reservedTokens; },
      };
    },
    snapshot: () => ({ calls, inputTokens }),
  };
}

/** The invoke with its output cap held to the driving test's, whatever the call asks for. It keeps the invoke's secrets and endpoint, which the route's credential scan reads. */
export function withOutputCap(invoke: E2EInvoke, maxOutputTokens: number): E2EInvoke {
  const capped = (input: E2EInvokeInput) => invoke({ ...input, maxOutputTokens: Math.min(input.maxOutputTokens, maxOutputTokens) });
  return Object.assign(capped, { secrets: (invoke as { secrets?: readonly string[] }).secrets ?? [], ...((invoke as { endpoint?: string }).endpoint === undefined ? {} : { endpoint: (invoke as { endpoint?: string }).endpoint }) });
}

// ---------------------------------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------------------------------

/** The fixed first call: a short system sentence and a short question, no tools. Nothing from the page, the run or the operator is in it. */
const FIRST_CALL = Object.freeze({
  prompt: [
    { role: "system", content: "You are the Rovara model check, a connectivity check. Answer with the single word OK." },
    { role: "user", content: [{ type: "text", text: "Reply with OK." }] },
  ],
  maxOutputTokens: 64,
}) as unknown as Parameters<ReturnType<typeof createGovernedE2EModelRoute>["generate"]>[0]["call"];
const FIRST_CALL_DEADLINE_MS = 60_000;

export interface E2EModelCheckDependencies {
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  /** The provider call of a route; a test seam. Production builds the real one from the definition. */
  invokeFor?: (definition: E2EModelRouteDefinition) => Promise<E2EInvoke>;
  /** The navigation of the fixture; a test seam. Production runs the real executor on the Docker host. */
  navigate?: (input: { definition: E2EModelRouteDefinition; runId: string; ledger: DrivingTestLedger; invoke: E2EInvoke; collector: ReturnType<typeof createE2EModelEvidenceCollector>; signal: AbortSignal }) => Promise<NavigationOutcome>;
  /** The discovery transports; a test seam. Production builds the real ones. */
  discoveryDependencies?: (input: { provider: ModelProvider; region: string | undefined }) => DiscoveryDependencies;
  assertSharedConfig?: () => void;
  newReceiptId?: () => string;
}

const refusal = (code: E2EModelCheckRefusal, checkId: string | null): E2EModelCheckResult => ({ schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "refused", code, checkId });

/** The id of a request in whatever version, if it has one the server can key on (never the rest of it). */
export function requestIdOf(raw: unknown): string | undefined {
  const value = typeof raw === "object" && raw !== null ? (raw as { checkId?: unknown; canaryId?: unknown }) : {};
  const id = typeof value.checkId === "string" ? value.checkId : typeof value.canaryId === "string" ? value.canaryId : undefined;
  return id !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : undefined;
}

export async function runE2EModelCheck(raw: unknown, dependencies: E2EModelCheckDependencies = {}): Promise<E2EModelCheckResult> {
  const parsed = E2EModelCheckRequestSchema.safeParse(raw);
  if (!parsed.success) return refusal("check-request-invalid", requestIdOf(raw) ?? null);
  const request = parsed.data;
  const environment = dependencies.environment ?? process.env;
  try {
    return request.kind === "discover" ? await discover(request, environment, dependencies) : await drive(request, environment, dependencies);
  } catch {
    // A fault outside what the model and the app can do (the route answers every provider failure with a receipt). Only a fixed reason is kept, never the error.
    return E2EModelCheckResultSchema.parse({ schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "failed", reason: "check-run-failed", checkId: request.checkId });
  }
}

async function discover(request: E2EModelCheckRequest, environment: NodeJS.ProcessEnv, dependencies: E2EModelCheckDependencies): Promise<E2EModelCheckResult> {
  const installation = e2eAgentInstallationFromEnvironment(environment);
  const provider = (installation.provider ?? "amazon-bedrock") as ModelProvider;
  const candidates = [...new Set([E2E_AGENT_RECOMMENDED_MODELS[provider], ...e2eAgentModelsFor(provider, installation.region ?? null).map((row) => row.modelId)])];
  const deps = dependencies.discoveryDependencies?.({ provider, region: installation.region })
    ?? realDiscoveryDependencies(provider, installation.region, installation.secretArn, dependencies.now);
  const report: ModelDiscoveryReport = await discoverModels({ provider, ...(installation.region === undefined ? {} : { region: installation.region }),
    ...(installation.openRouterProviders === undefined ? {} : { openRouterProviders: installation.openRouterProviders.split(",").map((name) => name.trim()).filter(Boolean) }), candidates }, deps);
  return E2EModelCheckResultSchema.parse({ schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "discovered", checkId: request.checkId, discovery: report });
}

function realDiscoveryDependencies(provider: ModelProvider, region: string | undefined, secretArn: string | undefined, now: (() => number) | undefined): DiscoveryDependencies {
  const base: DiscoveryDependencies = { now: now ?? Date.now, fetch: globalThis.fetch };
  if (provider === "amazon-bedrock") return region === undefined ? base : { ...base, bedrock: awsBedrockDiscoveryClient(region), quotas: awsQuotaClient(region) };
  if (!isKeyedModelProvider(provider) || secretArn === undefined) return base;
  // The key is read when a request is made and never kept; it is not part of any result.
  return { ...base, apiKey: () => readProviderKey(provider, secretArn) };
}

async function drive(request: E2EModelCheckRequest, environment: NodeJS.ProcessEnv, dependencies: E2EModelCheckDependencies): Promise<E2EModelCheckResult> {
  const checkId = request.checkId;
  const installation = e2eAgentInstallationFromEnvironment(environment);
  const base = deriveE2EAgentRoute(installation, 1);
  if (base.status === "unavailable") return refusal("agent-route-not-approved", checkId);
  const requested = searchE2EAgentRouteByDigest(installation, base.definition.provider as ModelProvider, request.definitionDigest!);
  if (requested === undefined || requested.routeId !== request.routeId) return refusal("model-route-changed-reapprove", checkId);
  try {
    assertE2EEnvironmentCannotRedirect(environment);
    (dependencies.assertSharedConfig ?? (() => assertE2ESharedAwsConfigCannotRedirect()))();
  } catch {
    return refusal("model-environment-unsafe", checkId);
  }
  const startShape: DrivingShape = requested.payloadShape === "minimal" ? "minimal" : "standard";
  const minimalRoute = deriveE2EAgentRouteForModel(installation, requested.modelId, "minimal", 1);
  const standardRoute = deriveE2EAgentRouteForModel(installation, requested.modelId, "standard", 1);
  if (minimalRoute.status !== "available" || standardRoute.status !== "available") return refusal("model-route-changed-reapprove", checkId);
  const definitions = { standard: standardRoute.definition, minimal: minimalRoute.definition };

  const now = dependencies.now ?? Date.now;
  const ledger = createDrivingTestLedger();
  const collector = createE2EModelEvidenceCollector();
  const invokes = new Map<DrivingShape, E2EInvoke>();
  const invokeOf = async (shape: DrivingShape): Promise<E2EInvoke> => {
    const known = invokes.get(shape);
    if (known !== undefined) return known;
    const definition = definitions[shape];
    const made = withOutputCap(await (dependencies.invokeFor?.(definition) ?? createE2EProviderInvoke(definition, { environment })), DRIVING_TEST_BUDGET.maxOutputTokensPerCall);
    invokes.set(shape, made);
    return made;
  };
  const testSignal = AbortSignal.timeout(DRIVING_TEST_BUDGET.testDeadlineMs);

  const outcome = await runModelDrivingTest({
    async firstCall(shape, callIndex) {
      const definition = definitions[shape];
      const route = createGovernedE2EModelRoute(definition, { invoke: await invokeOf(shape), now, dayBudget: ledger, newReceiptId: dependencies.newReceiptId ?? (() => `rcpt-check-${randomUUID()}`) });
      // The proxy's last scan: the provider key the invoke holds (none for Bedrock) and credential-shaped text never leave in a payload.
      const guard = createE2ECredentialGuard({ passwords: [...route.secretValues], emails: [], cookieValues: [] });
      const result = await route.generate(
        { schemaVersion: E2E_MODEL_CHANNEL_SCHEMA_VERSION, runId: checkId, caseId: DRIVING_TEST_FIRST_CALL_CASE_ID, stepIndex: 0, callIndex, call: FIRST_CALL },
        { deadlineAt: now() + FIRST_CALL_DEADLINE_MS, signal: testSignal, budgets: { maxInputTokens: 32_000, maxOutputTokens: DRIVING_TEST_BUDGET.maxOutputTokensPerCall },
          inspectPayload: (payload) => { if (guard.containsSecret(payload)) throw new E2EPayloadRefusedError(); } },
      );
      return result.receipt;
    },
    async navigate(shape) {
      const definition = definitions[shape];
      const navigate = dependencies.navigate ?? realNavigator(environment);
      return navigate({ definition, runId: checkId, ledger, invoke: await invokeOf(shape), collector, signal: testSignal });
    },
  }, startShape);

  const tested = definitions[outcome.payloadShape];
  const receipts = outcome.receipts;
  return E2EModelCheckResultSchema.parse({
    schemaVersion: E2E_MODEL_CHECK_RESULT_SCHEMA, status: "driven", checkId,
    drive: {
      routeId: tested.routeId, routeRevision: e2eModelRouteRevision(tested), definitionDigest: e2eAgentRouteDefinitionDigest(tested), provider: tested.provider, modelId: tested.modelId,
      payloadShape: outcome.payloadShape, outcome: outcome.outcome, failure: outcome.failure, calls: receipts.filter((item) => item.outcome !== "budget").length,
      inputTokens: receipts.reduce((total, item) => total + item.inputTokens, 0), outputTokens: receipts.reduce((total, item) => total + item.outputTokens, 0),
      caseVerdict: outcome.caseVerdict, caseCode: outcome.caseCode, receipts, reported: outcome.reported,
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The navigation on this runner's Docker host
// ---------------------------------------------------------------------------------------------------------------------

/** The executor image, the build image and the run root, read from the worker's own configuration exactly as the qualification reads them. */
export function drivingTestHostConfig(environment: NodeJS.ProcessEnv, platform: string = process.platform, arch: string = process.arch): { executorImage: string; buildImage: string; runRoot: string } {
  const executorImage = environment["EXECUTOR_IMAGE"]?.trim() ?? "";
  if (executorImage === "" || executorImage.length > 512 || /\s/.test(executorImage) || executorImage.startsWith("-") || [...executorImage].some((character) => character.charCodeAt(0) < 0x20)) {
    throw new Error("EXECUTOR_IMAGE is not set to an image reference on this worker");
  }
  const scratch = containedRuntimeProfileForHost(platform, arch)?.candidateScratchRoot;
  if (scratch === undefined) throw new Error("this host has no shared runtime directory for driving test runs");
  return { executorImage, buildImage: WEB_API_BUILD_IMAGE, runRoot: join(scratch, "web-api-probes") };
}

/**
 * The real navigator: the channel of the run is the worker's governed route over the chosen provider and the test's budget. The session re-derives the route from this worker's own
 * settings for the revision the plan pins (the same search the groups' checks use), so what runs is exactly the definition that was asked for.
 */
function realNavigator(environment: NodeJS.ProcessEnv): NonNullable<E2EModelCheckDependencies["navigate"]> {
  return async ({ definition, runId, ledger, invoke, collector, signal }) => {
    const config = drivingTestHostConfig(environment);
    const channelFor = (request: DrivingChannelRequest): DockerApplicationModelChannel => ({
      async open(open) {
        const session = await openE2EModelChannelSession({ runId: request.runId, modelRoute: request.modelRoute, policyScope: "standard", socketPath: open.socketPath, allowedSteps: request.allowedSteps,
          credentialSet: { ...open.credentialSet, cookieValues: [] }, deadlineAt: open.deadlineAt, dayBudget: ledger, evidence: collector, signal: open.signal, invoke, environment });
        return { async close() {
          const summary = await session.close();
          return { ...summary, transcripts: collector.transcripts(), valueKey: open.valueKey, definition: session.definition };
        } };
      },
    });
    const navigator = createDrivingNavigator({ docker: createProcessDockerCli(), ...config, modelChannelFor: channelFor, receiptsOf: () => collector.receipts(), roundScope: "standard" });
    return navigator({ definition, runId, signal });
  };
}

/** A short digest of a request's bytes, for the server to tell one request from another when it has no id. */
export const requestFingerprint = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
