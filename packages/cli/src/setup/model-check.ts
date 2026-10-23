// `agentx project model-check discover | test` (M1.4 Task 4.10C): the on-account checks of the AI navigation model. `discover` lists the models this account can use, in tiers, and
// makes no model call. `test` runs the driving test of one model on the qualified runner: it shows the worst-case cost first, asks for confirmation, and polls for the answer.
// Both go through the control plane (an administrator's sign-in is the only authority); neither reads a secret.
import { DRIVING_TEST_BUDGET, E2E_AGENT_ELIGIBLE_MODELS, agentXError } from "@agentx/contracts";
import type { Prompter } from "../init/prompts.js";
import { adminResponseBody } from "../admin/http.js";
import type { AdminSession } from "./services.js";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const POLL_MS = 10_000;
/** `test` waits this long for the runner's answer. */
export const MODEL_CHECK_WAIT_MS = 10 * 60_000;

const idOf = (started: Record<string, unknown>): string => (typeof started["checkId"] === "string" ? started["checkId"] : "");
const clean = (text: unknown, max = 300): string => (typeof text === "string" ? text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, max) : "");
const usd = (value: number): string => `$${value.toFixed(4)}`;

interface TierRow { modelId: string; label: string; scope: string | null; testedAt?: string; payloadShape?: string; worstCaseUsd?: number; reason?: string }
interface Tiers {
  discovery: { status: string; unverifiedReason?: string; checkedAt?: string };
  why: string;
  recommended: TierRow | null;
  current?: TierRow | null;
  worksOnAccount: TierRow[];
  notUsable: TierRow[];
  canBeTested: TierRow[];
  canBeTestedMore: number;
}
export interface ModelCheckView { status: string; checkId: string; kind: string; sentence: string; tiers?: Tiers; drive?: { modelId: string; payloadShape: string; calls: number; inputTokens: number; outputTokens: number } }

export interface ModelCheckInput {
  env: string; session: AdminSession; fetch: typeof fetch; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number;
}

async function send(input: ModelCheckInput, method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await input.fetch(`${input.session.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/e2e/model-checks${path}`, {
    method, headers: { authorization: `Bearer ${input.session.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
  });
  return await adminResponseBody(response) as Record<string, unknown>;
}

async function wait(input: ModelCheckInput, checkId: string): Promise<ModelCheckView> {
  const deadline = input.now() + MODEL_CHECK_WAIT_MS;
  for (;;) {
    const view = await send(input, "GET", `/${encodeURIComponent(checkId)}`) as unknown as ModelCheckView;
    if (view.status !== "pending") return view;
    if (input.now() >= deadline) throw agentXError("RUNTIME_UNAVAILABLE", `the runner did not answer within ${MODEL_CHECK_WAIT_MS / 60_000} minutes (it may be busy or gone); check it, then ask again`);
    await input.sleep(POLL_MS);
  }
}

/** The tiers as text, and the exact commands that choose a model and test it. */
export function formatTiers(tiers: Tiers, env: string): string[] {
  const lines: string[] = [];
  const idOf = (row: TierRow) => `\`${clean(row.modelId, 200)}\``;
  lines.push(tiers.discovery.status === "listed" ? `Models this account can see (checked ${clean(tiers.discovery.checkedAt, 40)}):`
    : tiers.discovery.status === "unverified" ? `Rovara could not list your models (${clean(tiers.discovery.unverifiedReason, 40)}); the driving test will confirm a model.` : "No discovery on record yet; run discover.");
  if (tiers.recommended !== null) {
    const note = tiers.why === "default-not-usable" ? " (Rovara's own default is not usable on this account)" : "";
    lines.push(`Recommended: ${idOf(tiers.recommended)} (${clean(tiers.recommended.label, 80)})${tiers.recommended.testedAt === undefined ? `, not tested yet${tiers.recommended.worstCaseUsd === undefined ? "" : ` (worst case of one driving test ${usd(tiers.recommended.worstCaseUsd)})`}` : `, tested ${tiers.recommended.testedAt.slice(0, 10)}`}${note}`);
  } else lines.push("Recommended: none of the models Rovara can use is available on this account.");
  if (tiers.worksOnAccount.length > 0) {
    lines.push("Works on your account:");
    for (const row of tiers.worksOnAccount) lines.push(`  ${idOf(row)}, driving test passed ${clean(row.testedAt, 40).slice(0, 10)}${row.payloadShape === "minimal" ? ", with the minimal request shape" : ""}`);
  }
  if (tiers.notUsable.length > 0) {
    lines.push("Not usable:");
    for (const row of tiers.notUsable) lines.push(`  ${idOf(row)}: ${clean(row.reason)}`);
  }
  if (tiers.canBeTested.length > 0) {
    lines.push("Can be tested (visible to this account, not driven yet; worst-case cost of one driving test):");
    for (const row of tiers.canBeTested) lines.push(`  ${idOf(row)}  ${row.worstCaseUsd === undefined ? "" : usd(row.worstCaseUsd)}`);
    if (tiers.canBeTestedMore > 0) lines.push(`  and ${tiers.canBeTestedMore} more`);
  }
  const pick = tiers.recommended;
  if (pick !== null) {
    lines.push(`To test it:    agentx --env ${env} project model-check test --model ${clean(pick.modelId, 200)}`);
    lines.push(`To choose it:  agentx --env ${env} config set models.e2eAgent ${clean(pick.modelId, 200)}`);
  }
  return lines;
}

/** `discover`: asks the runner for a discovery (no model call), then shows the tiers. When no runner can be asked, the tiers on record are shown instead, and the reason is said. */
export async function discoverModelCheck(input: ModelCheckInput): Promise<{ tiers: Tiers; fresh: boolean }> {
  let view: ModelCheckView | undefined;
  let reason: string | undefined;
  try {
    const started = await send(input, "POST", "", { kind: "discover" });
    const checkId = idOf(started);
    input.write("Asked the runner to list the models this account can see (no model is called)...");
    view = await wait(input, checkId);
  } catch (error) {
    reason = error instanceof Error ? error.message : "the runner could not be asked";
  }
  if (view?.status === "discovered" && view.tiers !== undefined) {
    for (const line of formatTiers(view.tiers, input.env)) input.write(line);
    return { tiers: view.tiers, fresh: true };
  }
  if (view !== undefined) input.write(clean(view.sentence));
  if (reason !== undefined) input.write(`Could not ask the runner: ${clean(reason)}. Showing what is on record.`);
  const record = await send(input, "GET", "") as unknown as { tiers: Tiers };
  for (const line of formatTiers(record.tiers, input.env)) input.write(line);
  return { tiers: record.tiers, fresh: false };
}

/** The worst case the driving test of a model can cost, from the pinned prices: the whole budget at the model's input and output price. */
export function drivingTestCostLine(modelId: string | undefined): string {
  const budget = `at most ${DRIVING_TEST_BUDGET.maxCalls} model calls, ${DRIVING_TEST_BUDGET.maxInputTokensTotal.toLocaleString("en-US")} input tokens and ${DRIVING_TEST_BUDGET.maxOutputTokensPerCall} output tokens per call`;
  const row = modelId === undefined ? undefined : E2E_AGENT_ELIGIBLE_MODELS.find((item) => item.modelId === modelId);
  if (row === undefined) return `A driving test makes ${budget}; its price depends on the model.`;
  const worst = (DRIVING_TEST_BUDGET.maxInputTokensTotal * row.inputUsdPerMTok + DRIVING_TEST_BUDGET.maxCalls * DRIVING_TEST_BUDGET.maxOutputTokensPerCall * row.outputUsdPerMTok) / 1_000_000;
  return `A driving test of \`${modelId}\` makes ${budget}: worst case ${usd(worst)} on this account (it usually costs about a tenth of that).`;
}

/** `test`: the driving test of one model (or the installation's chosen one) on the runner. */
export async function testModelCheck(input: ModelCheckInput & { prompter: Prompter; model?: string; assumeYes?: boolean }): Promise<ModelCheckView> {
  if (input.model !== undefined && !MODEL_ID.test(input.model)) throw agentXError("CONFIG_INVALID", "--model is not a model id");
  let modelId = input.model;
  if (modelId === undefined) {
    // The model a test without --model drives is the installation's choice (or Rovara's recommendation): the control plane says which.
    const record = await send(input, "GET", "") as unknown as { tiers?: Tiers };
    modelId = record.tiers?.current?.modelId;
  }
  input.write(drivingTestCostLine(modelId));
  const go = input.assumeYes === true || await input.prompter.confirm(`Run the driving test${modelId === undefined ? "" : ` of ${modelId}`} on the runner?`, { defaultValue: false });
  if (!go) throw agentXError("CONFIRMATION_DECLINED", "the driving test was not run");
  const started = await send(input, "POST", "", { kind: "drive", ...(input.model === undefined ? {} : { modelId: input.model }) });
  const checkId = idOf(started);
  input.write("The runner is driving the fixture app with the model; this takes a few minutes...");
  const view = await wait(input, checkId);
  input.write(clean(view.sentence, 600));
  if (view.status === "passed") input.write(`The route is now approvable. Choose it with: agentx --env ${input.env} config set models.e2eAgent ${clean(view.drive?.modelId, 200)}, then approve setup again.`);
  return view;
}
