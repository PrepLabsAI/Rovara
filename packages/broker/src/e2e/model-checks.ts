import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import {
  DRIVING_TEST_BUDGET, DRIVING_TEST_FIRST_CALL_CASE_ID, E2EModelCheckResultSchema, E2EModelFailureSchema, E2E_AGENT_ELIGIBLE_MODELS, E2E_AGENT_RECOMMENDED_MODELS, E2E_MODEL_CHECK_REQUEST_SCHEMA,
  E2E_MODEL_DRIVING_TEST_MARKER, INDEX_EXPIRY_ATTRIBUTE, ModelDiscoveryReportSchema, e2eAgentModelsFor, e2eModelRouteRevision, e2eQualificationPrefix, indexExpiresAt,
  type E2EDrivingTestFinding, type E2EModelFailureClass, type E2EModelRouteDefinition, type ModelProvider,
} from "@agentx/contracts";
import { E2E_FAILURE_CLASS_AGENT_CODE } from "@agentx/verifier";
import { deriveE2EAgentRouteForModel, e2eAgentRouteDefinitionDigest, type E2EAgentInstallation } from "@agentx/model-runtime/e2e-route-derive";
import { rankModels, type ModelDiscoveryReport, type ModelTestRecord, type NotUsableReason, type RankedModels, type Tiered } from "@agentx/model-runtime/model-discovery";
import { E2E_OWNER_SENTENCES, modelSentenceContext } from "./owner-sentences.js";
import { e2eModelCheckKey, e2eModelCheckLatestKey, e2eModelCheckRunnerKey, e2eModelDiscoveryKey, e2eModelRouteCanaryKey, e2eModelRouteShapeKey, e2eModelRouteTestKey, readE2EModelRouteShape } from "./model-route-registry.js";

/**
 * The broker's side of the on-account model check (M1.4 Task 4.10C): the two admin routes, the validation of the runner's result, and the rows a validated result writes.
 *
 * `POST /v1/admin/e2e/model-checks { kind, modelId? }` derives the route the check is for, finds the runner that serves checks, puts the request under the runner's own transport
 * prefix and answers 202 with the check's id. `GET .../model-checks/<checkId>` answers `pending` until the runner's result names the check, then validates it (the shared validator
 * below, which the TEST operator script uses too), writes the rows, and answers with the owner's sentence. Nothing here reads a secret or keeps message text: results hold digests,
 * counts, fixed codes and receipts.
 */

export class ModelCheckError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, readonly code: string, message: string) { super(message); this.name = "ModelCheckError"; }
}

export interface ModelCheckDependencies {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
  now: () => number;
  /** Puts an object under the artifact bucket. Only the request key of a runner's prefix is ever put. */
  putObject: (key: string, body: string) => Promise<void>;
  /** Gets an object's bytes, or undefined when it is not there. Only the result key of a runner's prefix is ever read. */
  getObject: (key: string) => Promise<Uint8Array | undefined>;
  installation: () => Promise<E2EAgentInstallation>;
  /** The READY web runtime row of the installation, or undefined: its state, expiry and transport correlation. */
  readRuntimeRow: () => Promise<Record<string, unknown> | undefined>;
  newCheckId?: () => string;
}

const REQUEST_KEY = "canary-request.json";
const RESULT_KEY = "canary-result.json";
const CHECK_TTL_MS = 24 * 60 * 60_000;
const PENDING_WINDOW_MS = 10 * 60_000;
const RESULT_MAX_BYTES = 262_144;

const LABELS: Record<ModelProvider, string> = { "amazon-bedrock": "Amazon Bedrock", openrouter: "OpenRouter", anthropic: "Anthropic", openai: "OpenAI" };

// ---------------------------------------------------------------------------------------------------------------------
// The owner's sentence for a failure class
// ---------------------------------------------------------------------------------------------------------------------

/** The agent code (and so the approved sentence) of a failure class; an unclassified failure keeps `model-unavailable`. */
export function failureClassCode(failureClass: E2EModelFailureClass) {
  return failureClass === "unknown" ? "model-unavailable" as const : E2E_FAILURE_CLASS_AGENT_CODE[failureClass];
}
export function failureClassSentence(failureClass: E2EModelFailureClass, definition: { provider: string; modelId: string } | undefined): string {
  return E2E_OWNER_SENTENCES.agentCode(failureClassCode(failureClass), modelSentenceContext(definition));
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation of a runner's result
// ---------------------------------------------------------------------------------------------------------------------

export interface ExpectedModelCheck {
  checkId: string;
  kind: "drive" | "discover";
  provider: ModelProvider;
  /** For a drive: the shape the request named (the stored one); a test that began in the minimal shape has no retry. */
  startShape?: "standard" | "minimal";
  /** For a drive: the definitions of the model in each request shape, at revision 1, as the broker derives them. */
  definitions?: { standard: E2EModelRouteDefinition; minimal: E2EModelRouteDefinition };
}

export type ValidatedModelCheck =
  | { ok: true; kind: "drive"; finding: E2EDrivingTestFinding; definition: E2EModelRouteDefinition; definitionDigest: string }
  | { ok: true; kind: "discover"; discovery: ModelDiscoveryReport }
  | { ok: false; reason: string };

const refuse = (reason: string): ValidatedModelCheck => ({ ok: false, reason });
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * Judges a runner's answer to a check. `ok: false` carries a fixed reason and writes nothing. A driving test is accepted as a pass only when everything agrees: the right check, route
 * and tested definition; every receipt the check's own, on the route's provider and model; the whole budget held; one retry at most, and only after a rejected request; and the
 * deterministic oracle's PASS with one download whose receipts equal the executor's report. The receipts and counts of a failed test are judged the same way, so a failure that does
 * not add up is refused too.
 */
export function validateModelCheckResult(raw: unknown, expected: ExpectedModelCheck): ValidatedModelCheck {
  const parsed = E2EModelCheckResultSchema.safeParse(raw);
  if (!parsed.success) return refuse("the result is not a model check result");
  const result = parsed.data;
  if (result.status === "refused") return refuse(`the runner refused the check (${result.code}); no call was made`);
  if (result.status === "failed") return refuse(`the check did not run (${result.reason})`);
  if (result.checkId !== expected.checkId) return refuse("the result is for another check");
  if (result.status === "discovered") {
    if (expected.kind !== "discover") return refuse("the runner discovered models when a driving test was asked for");
    if (result.discovery.provider !== expected.provider) return refuse("the discovery is for another provider");
    return { ok: true, kind: "discover", discovery: result.discovery as ModelDiscoveryReport };
  }
  if (expected.kind !== "drive" || expected.definitions === undefined) return refuse("the runner drove a model when a discovery was asked for");
  const finding = result.drive;
  const definition = finding.payloadShape === "minimal" ? expected.definitions.minimal : expected.definitions.standard;
  const definitionDigest = e2eAgentRouteDefinitionDigest(definition);
  if (finding.routeId !== definition.routeId || finding.definitionDigest !== definitionDigest || finding.routeRevision !== e2eModelRouteRevision(definition)) return refuse("the runner tested another route than the one asked for");
  if (finding.provider !== definition.provider || finding.modelId !== definition.modelId) return refuse("the runner tested another model than the one asked for");

  const receipts = finding.receipts;
  const revisions = new Set([e2eModelRouteRevision(expected.definitions.standard), e2eModelRouteRevision(expected.definitions.minimal)]);
  // A call is a receipt of a request the route took (a refusal for budget is the budget holding, not a call).
  if (receipts.filter((item) => item.outcome !== "budget").length !== finding.calls || finding.calls > DRIVING_TEST_BUDGET.maxCalls) return refuse("the receipts are not the calls the test says it made");
  if (sum(receipts.map((item) => item.inputTokens)) !== finding.inputTokens || finding.inputTokens > DRIVING_TEST_BUDGET.maxInputTokensTotal) return refuse("the test passed its input token budget");
  if (sum(receipts.map((item) => item.outputTokens)) !== finding.outputTokens || receipts.some((item) => item.outputTokens > DRIVING_TEST_BUDGET.maxOutputTokensPerCall)) return refuse("the test passed its output token budget");
  for (const receipt of receipts) {
    if (receipt.runId !== result.checkId) return refuse("a receipt is not this check's call");
    if (receipt.routeId !== definition.routeId || receipt.provider !== definition.provider || receipt.modelId !== definition.modelId || !revisions.has(receipt.routeRevision)) return refuse("a receipt names another route or model");
  }
  if (new Set(receipts.map((item) => item.receiptId)).size !== receipts.length) return refuse("a receipt id repeats");
  const byPosition = new Map<string, number[]>();
  for (const receipt of receipts) byPosition.set(`${receipt.caseId}\0${receipt.stepIndex}`, [...(byPosition.get(`${receipt.caseId}\0${receipt.stepIndex}`) ?? []), receipt.callIndex]);
  for (const indexes of byPosition.values()) if ([...indexes].sort((a, b) => a - b).some((value, index) => value !== index)) return refuse("the receipts have a gap in their call indexes");

  const first = receipts.filter((item) => item.caseId === DRIVING_TEST_FIRST_CALL_CASE_ID).sort((a, b) => a.callIndex - b.callIndex);
  const navigation = receipts.filter((item) => item.caseId !== DRIVING_TEST_FIRST_CALL_CASE_ID);
  const testedRevision = e2eModelRouteRevision(definition);
  // One retry at most, only after a rejected request, and only in the minimal shape.
  const startShape = expected.startShape ?? "standard";
  if (first.length > (startShape === "minimal" ? 1 : 2)) return refuse("the test retried more than once");
  if (first.length === 2) {
    const [before, after] = first as [typeof first[number], typeof first[number]];
    if (finding.payloadShape !== "minimal" || before.failure?.class !== "request-rejected" || before.routeRevision !== e2eModelRouteRevision(expected.definitions.standard) || after.routeRevision !== testedRevision) {
      return refuse("the retry is not one minimal-shape retry after a rejected request");
    }
  } else if (first.length === 1 && first[0]!.routeRevision !== testedRevision) return refuse("the first call is not in the tested shape");
  if (navigation.some((item) => item.routeRevision !== testedRevision)) return refuse("the navigation was not in the tested shape");
  if (finding.payloadShape === "minimal" && startShape === "standard" && first.length !== 2) return refuse("a minimal shape is only the result of a retry");
  if (finding.payloadShape === "standard" && startShape === "minimal") return refuse("the test began in the minimal shape and cannot end in the standard one");

  const lastFailed = [...receipts].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.callIndex - b.callIndex).filter((item) => item.outcome !== "ok").at(-1);
  if (finding.failure !== null) {
    const failure = E2EModelFailureSchema.safeParse(finding.failure);
    if (!failure.success) return refuse("the failure is not a known class");
    if (!receipts.some((item) => item.failure?.class === finding.failure!.class && item.failure.signal === finding.failure!.signal)) return refuse("the failure is not on any receipt");
  }
  if (finding.outcome === "passed") {
    if (finding.failure !== null) return refuse("a pass has a failure");
    if (finding.caseVerdict !== "passed" || finding.caseCode !== null) return refuse("the deterministic oracle's verdict is not PASS");
    if (first.length === 0 || first.at(-1)!.outcome !== "ok") return refuse("the first call did not succeed");
    if (navigation.length === 0) return refuse("no navigation call was made");
    if (receipts.some((item) => item.outcome === "budget")) return refuse("a call was refused for budget");
    const report = finding.reported;
    if (report === null || report.downloads !== 1 || !report.csvPassed) return refuse("the navigation did not end in exactly one download that passed the CSV check");
    if (navigation.filter((item) => item.outcome === "ok").length !== report.modelCalls) return refuse("the receipts are not equal to the report");
  } else if (finding.failure === null && lastFailed !== undefined) {
    // A failed test whose last failed call carries a class must say it.
    if (lastFailed.failure !== undefined) return refuse("the failure of the last failed call is missing");
  }
  return { ok: true, kind: "drive", finding, definition, definitionDigest };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------------------------

/** What a validated driving test writes: the gating row and the shape row on a pass (never overwriting a gating row), and the model's test row either way. One transaction. */
export async function recordDrivingTest(deps: Pick<ModelCheckDependencies, "documentClient" | "tableName" | "now">, validated: Extract<ValidatedModelCheck, { kind: "drive" }>, checkId: string): Promise<void> {
  const { finding, definition, definitionDigest } = validated;
  const at = new Date(deps.now()).toISOString();
  const test = { ...e2eModelRouteTestKey(definition.routeId, definition.modelId), entityType: "E2E_MODEL_TEST", routeId: definition.routeId, modelId: definition.modelId, provider: definition.provider,
    outcome: finding.outcome, failureClass: finding.failure?.class ?? null, signal: finding.failure?.signal ?? null, payloadShape: finding.payloadShape, testedAt: at, checkId,
    calls: finding.calls, inputTokens: finding.inputTokens, outputTokens: finding.outputTokens };
  if (finding.outcome !== "passed") {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: test }));
    return;
  }
  const items = [
    { Put: { TableName: deps.tableName, Item: test } },
    { Put: { TableName: deps.tableName, Item: { ...e2eModelRouteShapeKey(definition.routeId, definition.modelId), entityType: "E2E_MODEL_ROUTE_SHAPE", payloadShape: finding.payloadShape, testedAt: at } } },
    { Put: { TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)", Item: {
      ...e2eModelRouteCanaryKey(definition.routeId, definitionDigest), entityType: "E2E_MODEL_ROUTE_CANARY", test: E2E_MODEL_DRIVING_TEST_MARKER, routeId: definition.routeId, definitionDigest,
      provider: definition.provider, modelId: definition.modelId, payloadShape: finding.payloadShape, checkId, calls: finding.calls, inputTokens: finding.inputTokens, outputTokens: finding.outputTokens, recordedAt: at } } },
  ];
  try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
  catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name !== "TransactionCanceledException" && name !== "ConditionalCheckFailedException") throw error;
    // The gating row for this exact definition was already there: it stays as it was, and the test and shape rows are refreshed.
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items.slice(0, 2) }));
  }
}

/** The driving tests on record for a provider's models (a keyed Query of the registry partition). */
export async function readModelTests(deps: Pick<ModelCheckDependencies, "documentClient" | "tableName">, routeId: string): Promise<ModelTestRecord[]> {
  const out: ModelTestRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 5; page += 1) {
    const response = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": "E2E_MODEL_ROUTES", ":prefix": `E2E_MODEL_TEST#${routeId}#` }, ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }) }));
    for (const item of (response.Items ?? []) as Array<Record<string, unknown>>) {
      if (typeof item["modelId"] !== "string" || (item["outcome"] !== "passed" && item["outcome"] !== "failed") || typeof item["testedAt"] !== "string") continue;
      const failure = E2EModelFailureSchema.safeParse({ class: item["failureClass"], signal: item["signal"] ?? null });
      out.push({ modelId: item["modelId"], outcome: item["outcome"], failureClass: failure.success ? failure.data.class : null, signal: failure.success ? failure.data.signal : null,
        ...(item["payloadShape"] === "minimal" || item["payloadShape"] === "standard" ? { payloadShape: item["payloadShape"] } : {}), testedAt: item["testedAt"] });
    }
    startKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (startKey === undefined) break;
  }
  return out;
}

/** The last test of one model, for a proposal's sentence. */
export async function readModelTest(deps: Pick<ModelCheckDependencies, "documentClient" | "tableName">, routeId: string, modelId: string): Promise<ModelTestRecord | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eModelRouteTestKey(routeId, modelId), ConsistentRead: true }));
  const item = response.Item as Record<string, unknown> | undefined;
  if (item === undefined || (item["outcome"] !== "passed" && item["outcome"] !== "failed") || typeof item["testedAt"] !== "string") return undefined;
  const failure = E2EModelFailureSchema.safeParse({ class: item["failureClass"], signal: item["signal"] ?? null });
  return { modelId, outcome: item["outcome"], failureClass: failure.success ? failure.data.class : null, testedAt: item["testedAt"] };
}

/**
 * The sentence a setup proposal shows when the installation's route has no passed driving test: which model must be tested, and why the last test (if any) did not pass. The
 * command to run is added by the CLI, which knows the environment.
 */
export async function untestedRouteSentence(deps: Pick<ModelCheckDependencies, "documentClient" | "tableName">, untested: { provider: ModelProvider; modelId: string; routeId: string }): Promise<string> {
  let why = "not run";
  try {
    const last = await readModelTest(deps, untested.routeId, untested.modelId);
    // The class sentence ends with "(agentx project model-check test --model <id>)" in places: the proposal gives the real command itself, so the placeholder one is left out here.
    if (last?.outcome === "failed") why = failureClassSentence(last.failureClass ?? "unknown", untested).replace(/ \(agentx project model-check test --model <id>\)/u, "").replace(/[.\s]+$/u, "");
  } catch { /* the sentence then says "not run" */ }
  return `AI navigation steps will not run: the driving test with ${LABELS[untested.provider]} \`${untested.modelId}\` has not passed (${why})`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------------------------------------------------

/** The worst-case cost of one driving test of a model, from the pinned catalog's prices: 36,000 input and 3,072 output tokens. */
export function drivingTestWorstCaseUsd(row: { inputUsdPerMTok: number; outputUsdPerMTok: number }): number {
  const cost = (DRIVING_TEST_BUDGET.maxInputTokensTotal * row.inputUsdPerMTok + DRIVING_TEST_BUDGET.maxCalls * DRIVING_TEST_BUDGET.maxOutputTokensPerCall * row.outputUsdPerMTok) / 1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}

const NOT_USABLE_WORDS: Record<"limit-zero" | "needs-access" | "not-in-region", string> = {
  "limit-zero": "this account's limit for the model is zero", "needs-access": "the account has no access to the model yet", "not-in-region": "the model is not offered in this Region",
};

export interface TierRow { modelId: string; label: string; scope: "geographic" | "global" | null; inputUsdPerMTok: number; outputUsdPerMTok: number; testedAt?: string; payloadShape?: "standard" | "minimal"; worstCaseUsd: number;
  /** Not usable only: a fixed sentence. */ reason?: string }
export interface ModelTiers {
  discovery: { status: "listed" | "unverified" | "none"; unverifiedReason?: string; checkedAt?: string };
  why: RankedModels["why"];
  recommended: TierRow | null;
  /** The model a driving test with no modelId drives: the installation's setting, or Rovara's recommendation. */
  current: TierRow | null;
  worksOnAccount: TierRow[];
  notUsable: TierRow[];
  canBeTested: TierRow[];
  /** How many more models can be tested than are listed. */
  canBeTestedMore: number;
}
const MAX_CAN_BE_TESTED = 12;

function describeTiers(ranked: RankedModels, report: ModelDiscoveryReport | null, provider: ModelProvider, quotaText: (modelId: string) => string, currentRow: Tiered | undefined): ModelTiers {
  const row = (item: Tiered): TierRow => ({ modelId: item.modelId, label: item.label, scope: item.scope, inputUsdPerMTok: item.inputUsdPerMTok, outputUsdPerMTok: item.outputUsdPerMTok,
    ...(item.testedAt === undefined ? {} : { testedAt: item.testedAt }), ...(item.payloadShape === undefined ? {} : { payloadShape: item.payloadShape }), worstCaseUsd: drivingTestWorstCaseUsd(item) });
  const reasonOf = (item: Tiered & { reason: NotUsableReason }): string => (item.reason.code === "test-failed" ? failureClassSentence(item.reason.failureClass, { provider, modelId: item.modelId })
    : `${NOT_USABLE_WORDS[item.reason.code]}${item.reason.code === "limit-zero" ? quotaText(item.modelId) : ""}`);
  return {
    discovery: report === null ? { status: "none" } : { status: report.status, ...(report.unverifiedReason === undefined ? {} : { unverifiedReason: report.unverifiedReason }), checkedAt: report.checkedAt },
    why: ranked.why,
    recommended: ranked.recommended === null ? null : row(ranked.recommended),
    current: currentRow === undefined ? null : row({ ...currentRow }),
    worksOnAccount: ranked.worksOnAccount.map(row),
    notUsable: ranked.notUsable.map((item) => ({ ...row(item), reason: reasonOf(item) })),
    canBeTested: ranked.canBeTested.slice(0, MAX_CAN_BE_TESTED).map(row),
    canBeTestedMore: Math.max(0, ranked.canBeTested.length - MAX_CAN_BE_TESTED),
  };
}

/** The quota text of a limit-zero model, from the report's own quota entries (the two codes and their values). */
function quotaSentence(report: ModelDiscoveryReport | null): (modelId: string) => string {
  return (modelId) => {
    const quotas = report?.models.find((item) => item.modelId === modelId)?.quotas ?? [];
    const parts = quotas.filter((entry) => entry.code !== null).map((entry) => `${entry.scope === "geographic" ? (modelId.startsWith("us.") ? "US-only" : "geographic") : "Global"} \`${entry.code}\` ${entry.tokensPerMinute ?? "unknown"}`);
    return parts.length === 0 ? "" : `; ${parts.join(", ")} tokens per minute`;
  };
}

/** The tiers the owner sees, from the last discovery on record, the tests on record and the installation's setting. */
export async function readModelTiers(deps: ModelCheckDependencies, installation: E2EAgentInstallation, report: ModelDiscoveryReport | null): Promise<ModelTiers> {
  const provider = (installation.provider ?? "amazon-bedrock") as ModelProvider;
  const region = installation.region ?? null;
  const eligible = e2eAgentModelsFor(provider, region);
  const recommended = E2E_AGENT_RECOMMENDED_MODELS[provider];
  const routeId = "rovara-e2e-default";
  const tests = await readModelTests(deps, routeId);
  const current = installation.e2eModel === undefined || ["", "default", "none"].includes(installation.e2eModel) ? undefined : installation.e2eModel;
  // The recommended model is offered wherever the installation is, as its route has always been.
  const recommendedRow = E2E_AGENT_ELIGIBLE_MODELS.find((item) => item.provider === provider && item.modelId === recommended);
  const rows = recommendedRow === undefined || eligible.some((item) => item.modelId === recommended) ? eligible : [...eligible, recommendedRow];
  const ranked = rankModels({ report, eligible: rows, recommended, tests, current });
  return describeTiers(ranked, report, provider, quotaSentence(report), rows.find((item) => item.modelId === (current ?? recommended)));
}

export async function readDiscoveryReport(deps: Pick<ModelCheckDependencies, "documentClient" | "tableName">, provider: string): Promise<ModelDiscoveryReport | null> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eModelDiscoveryKey(provider), ConsistentRead: true }));
  const item = response.Item as Record<string, unknown> | undefined;
  const parsed = item === undefined ? undefined : ModelDiscoveryReportSchema.safeParse(item["report"]);
  return parsed?.success ? parsed.data as ModelDiscoveryReport : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------------------------------

const FRESH_DISCOVERY_MS = 7 * 24 * 60 * 60_000;
const CHECK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where checks go: the runner the installation's READY web runtime was qualified on (a row an operator tool records with the registration), bound to that registration. */
async function runnerPrefix(deps: ModelCheckDependencies, profileId: string): Promise<string> {
  const row = await deps.readRuntimeRow();
  const now = deps.now();
  if (row === undefined || row["state"] !== "READY" || typeof row["expiresAt"] !== "string" || Date.parse(row["expiresAt"]) <= now || typeof row["transportCorrelationId"] !== "string") {
    throw new ModelCheckError(409, "no-ready-runtime", "no browser and API runtime is READY, so there is no runner to check a model on; qualify the runtime first");
  }
  const pointer = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eModelCheckRunnerKey(profileId), ConsistentRead: true }))).Item as Record<string, unknown> | undefined;
  if (pointer === undefined || pointer["transportCorrelationId"] !== row["transportCorrelationId"] || typeof pointer["roleId"] !== "string" || typeof pointer["instanceId"] !== "string") {
    throw new ModelCheckError(409, "no-model-check-runner", "the READY runtime's runner is not recorded for model checks; requalify the runtime with the current tooling");
  }
  try { return e2eQualificationPrefix(pointer["roleId"], pointer["instanceId"]); }
  catch { throw new ModelCheckError(409, "no-model-check-runner", "the recorded model check runner is not valid; requalify the runtime"); }
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/** The definitions of one model in both request shapes at revision 1, or an error that never carries the model id. */
async function definitionsFor(deps: ModelCheckDependencies, installation: E2EAgentInstallation, modelId: string): Promise<{ standard: E2EModelRouteDefinition; minimal: E2EModelRouteDefinition; stored: "standard" | "minimal" }> {
  const standard = deriveE2EAgentRouteForModel(installation, modelId, "standard", 1);
  const minimal = deriveE2EAgentRouteForModel(installation, modelId, "minimal", 1);
  if (standard.status !== "available" || minimal.status !== "available") throw new ModelCheckError(400, "model-not-eligible", "that model is not one Rovara can use with this installation's provider in this Region");
  const shape = await readE2EModelRouteShape(deps, standard.definition.routeId, modelId);
  return { standard: standard.definition, minimal: minimal.definition, stored: shape === "minimal" ? "minimal" : "standard" };
}

export async function startModelCheck(deps: ModelCheckDependencies, body: unknown, profileId: string): Promise<{ checkId: string }> {
  const input = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as { kind?: unknown; modelId?: unknown };
  if (Object.keys(input).some((key) => key !== "kind" && key !== "modelId") || (input.kind !== "drive" && input.kind !== "discover")) throw new ModelCheckError(400, "invalid-request", "a model check is a drive or a discover, with an optional modelId");
  if (input.modelId !== undefined && (typeof input.modelId !== "string" || !MODEL_ID.test(input.modelId))) throw new ModelCheckError(400, "invalid-request", "the modelId is not a model id");
  const installation = await deps.installation();
  if (installation.provider === undefined) throw new ModelCheckError(409, "no-provider", "the installation has no model provider setting");
  const provider = installation.provider as ModelProvider;
  const checkId = (deps.newCheckId ?? randomUUID)();
  let request: Record<string, unknown> = { schemaVersion: E2E_MODEL_CHECK_REQUEST_SCHEMA, checkId, kind: input.kind };
  let record: Record<string, unknown> = { kind: input.kind, provider };
  if (input.kind === "drive") {
    const modelId = typeof input.modelId === "string" ? input.modelId : (installation.e2eModel === undefined || ["", "default", "none"].includes(installation.e2eModel) ? E2E_AGENT_RECOMMENDED_MODELS[provider] : installation.e2eModel);
    const defs = await definitionsFor(deps, installation, modelId);
    const definition = defs.stored === "minimal" ? defs.minimal : defs.standard;
    request = { ...request, routeId: definition.routeId, definitionDigest: e2eAgentRouteDefinitionDigest(definition) };
    record = { ...record, modelId, routeId: definition.routeId, definitionDigest: e2eAgentRouteDefinitionDigest(definition) };
  }
  const prefix = await runnerPrefix(deps, profileId);
  const now = deps.now();
  // What the request asks for, apart from its id: a retried POST (a lost 202, a double click) has the same one.
  const fingerprint = createHash("sha256").update(JSON.stringify([input.kind, record["modelId"] ?? null, record["definitionDigest"] ?? null])).digest("hex");
  const expires = indexExpiresAt(new Date(now + CHECK_TTL_MS).toISOString());
  const latestItem = (id: string) => ({ ...e2eModelCheckLatestKey(), entityType: "E2E_MODEL_CHECK_LATEST", checkId: id, requestedAt: now, state: "pending", fingerprint, [INDEX_EXPIRY_ATTRIBUTE]: expires });
  const writeCheck = async (id: string) => {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...e2eModelCheckKey(id), entityType: "E2E_MODEL_CHECK", checkId: id, ...record, prefix, requestedAt: now, state: "pending", [INDEX_EXPIRY_ATTRIBUTE]: expires } }));
    await deps.putObject(`${prefix}${REQUEST_KEY}`, `${JSON.stringify({ ...request, checkId: id })}\n`);
  };
  // One check at a time per runner, held by ONE conditional write of the latest pointer: of two POSTs at once, one wins and the other is told which check is running. A pointer that
  // is not pending, or has been pending longer than the window (the runner never answered), is replaced.
  const cutoff = now - PENDING_WINDOW_MS;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: latestItem(checkId),
        ConditionExpression: "attribute_not_exists(pk) OR #state <> :pending OR requestedAt < :cutoff", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":pending": "pending", ":cutoff": cutoff } }));
      await writeCheck(checkId);
      return { checkId };
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
    }
    const running = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eModelCheckLatestKey(), ConsistentRead: true }))).Item as Record<string, unknown> | undefined;
    if (running === undefined || running["state"] !== "pending" || typeof running["checkId"] !== "string") continue;
    // The same request again: answer with the check that is already running, and put its request again (the first put may be what was lost). The runner serves an id once.
    if (running["fingerprint"] === fingerprint) { await writeCheck(running["checkId"]); return { checkId: running["checkId"] }; }
    throw new ModelCheckError(409, "check-in-progress", `a model check is already running (${running["checkId"]}); wait for it to finish`);
  }
  throw new ModelCheckError(409, "check-in-progress", "a model check is already running; wait for it to finish");
}

export interface ModelCheckView {
  status: "pending" | "passed" | "failed" | "discovered" | "refused";
  checkId: string;
  kind: "drive" | "discover";
  /** The owner's sentence for the outcome. */
  sentence: string;
  drive?: { modelId: string; payloadShape: "standard" | "minimal"; calls: number; inputTokens: number; outputTokens: number };
  tiers?: ModelTiers;
}

export async function readModelCheck(deps: ModelCheckDependencies, checkId: string): Promise<ModelCheckView> {
  if (!CHECK_ID.test(checkId)) throw new ModelCheckError(404, "no-such-check", "there is no such model check");
  const row = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: e2eModelCheckKey(checkId), ConsistentRead: true }))).Item as Record<string, unknown> | undefined;
  if (row === undefined || (row["kind"] !== "drive" && row["kind"] !== "discover") || typeof row["prefix"] !== "string") throw new ModelCheckError(404, "no-such-check", "there is no such model check (checks are kept for one day)");
  const kind = row["kind"];
  const provider = row["provider"] as ModelProvider;
  if (row["state"] === "done" && typeof row["view"] === "string") return JSON.parse(row["view"]) as ModelCheckView;
  const bytes = await deps.getObject(`${row["prefix"]}${RESULT_KEY}`);
  const pending: ModelCheckView = { status: "pending", checkId, kind, sentence: "The runner has not answered yet." };
  if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength > RESULT_MAX_BYTES) return pending;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return pending; }
  // A result for another check (an earlier one still under the key) is not an answer yet.
  if (typeof raw !== "object" || raw === null || (raw as { checkId?: unknown }).checkId !== checkId) return pending;

  const installation = await deps.installation();
  let expected: ExpectedModelCheck;
  let definitions: Awaited<ReturnType<typeof definitionsFor>> | undefined;
  if (kind === "drive") {
    definitions = await definitionsFor(deps, installation, String(row["modelId"]));
    expected = { checkId, kind, provider, definitions, startShape: row["definitionDigest"] === e2eAgentRouteDefinitionDigest(definitions.minimal) ? "minimal" : "standard" };
  } else expected = { checkId, kind, provider };
  const validated = validateModelCheckResult(raw, expected);
  let view: ModelCheckView;
  if (!validated.ok) {
    view = { status: "refused", checkId, kind, sentence: `The check could not be trusted, so nothing was recorded (${validated.reason}).` };
  } else if (validated.kind === "discover") {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...e2eModelDiscoveryKey(provider), entityType: "E2E_MODEL_DISCOVERY", provider, report: validated.discovery, checkId, recordedAt: new Date(deps.now()).toISOString() } }));
    view = { status: "discovered", checkId, kind, sentence: validated.discovery.status === "listed" ? "Rovara listed the models this account can see." : `Rovara could not list your models (${validated.discovery.unverifiedReason ?? "unknown"}); the driving test will confirm a model.`,
      tiers: await readModelTiers(deps, installation, validated.discovery) };
  } else {
    await recordDrivingTest(deps, validated, checkId);
    const { finding, definition } = validated;
    const drive = { modelId: definition.modelId, payloadShape: finding.payloadShape, calls: finding.calls, inputTokens: finding.inputTokens, outputTokens: finding.outputTokens };
    if (finding.outcome === "passed") {
      view = { status: "passed", checkId, kind, drive, sentence: `The driving test passed with \`${definition.modelId}\`${finding.payloadShape === "minimal" ? ", with the minimal request shape" : ""}: it clicked through the built-in fixture, downloaded one file and the checks agreed.` };
    } else {
      const caseWords = finding.caseVerdict === "none" ? undefined : `the navigation ended ${finding.caseVerdict === "unknown" ? `unresolved (${finding.caseCode ?? "unknown"})` : "with a failed check"}`;
      view = { status: "failed", checkId, kind, drive, sentence: finding.failure !== null ? failureClassSentence(finding.failure.class, definition) : `The driving test did not pass with \`${definition.modelId}\`${caseWords === undefined ? "" : `: ${caseWords}`}.` };
    }
  }
  // Recorded once: a second read answers from the stored view.
  try {
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: e2eModelCheckKey(checkId), UpdateExpression: "SET #state = :done, #view = :view",
      ConditionExpression: "#state = :pending", ExpressionAttributeNames: { "#state": "state", "#view": "view" }, ExpressionAttributeValues: { ":done": "done", ":pending": "pending", ":view": JSON.stringify(view) } }));
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: e2eModelCheckLatestKey(), UpdateExpression: "SET #state = :done",
      ConditionExpression: "checkId = :checkId", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":done": "done", ":checkId": checkId } }));
  } catch { /* a concurrent read recorded it first, or the latest pointer moved on */ }
  return view;
}

/** The tiers on record, with no check: what `discover` shows when its last report is fresh. */
export async function readCurrentTiers(deps: ModelCheckDependencies): Promise<ModelTiers> {
  const installation = await deps.installation();
  const report = await readDiscoveryReport(deps, installation.provider ?? "amazon-bedrock");
  const fresh = report !== null && deps.now() - Date.parse(report.checkedAt) <= FRESH_DISCOVERY_MS;
  return readModelTiers(deps, installation, fresh ? report : null);
}
