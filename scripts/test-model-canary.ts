// M1.4 Task 4.9 step 3 (gate G1, decision D1), extended by Task 4.10C: the plan-first model check of a TEST installation, run by the qualified runner. The same checks the control
// plane's admin routes ask for (`POST /v1/admin/e2e/model-checks`), asked here with the operator's own AWS profile where the TEST installation has no admin sign-in for the CLI.
//
//   npx tsx scripts/test-model-canary.ts --env agentxlivetest123 --profile agentx-test --instance <runner instance ID> [--model <id>]            # plan only; no AWS call
//   npx tsx scripts/test-model-canary.ts --env agentxlivetest123 --profile agentx-test --instance <runner instance ID> --model <id> --apply     # gate G1: the owner's explicit OK first
//   npx tsx scripts/test-model-canary.ts --env agentxlivetest123 --profile agentx-test --instance <runner instance ID> --discover --apply       # lists the models; no model call
//
// What --apply does, and all it does:
// 1. reads the control-plane outputs (artifact bucket, state table), the worker role's unique ID (iam get-role) and the worker model settings (SSM, ids and ARNs only; no secret is
//    read), and derives the route of the model (`--model`, else the installation's choice, else Rovara's recommendation), exactly as the broker and the worker do;
// 2. puts `e2e-runtime/<role unique ID>:<instance ID>/canary-request.json`: a v2 model check request that names the check (a new id), its kind and, for a driving test, the route's id
//    and definition digest. The budget is the worker's and cannot be raised by the request: at most 6 calls, 36,000 input tokens in all and 512 output tokens per call;
// 3. waits (bounded) for `canary-result.json` to name this check (an earlier answer under the key is not an answer), and judges it with the broker's own validator;
// 4. only for a driving test that passed: writes the rows the broker writes (the gating row `E2E_MODEL_ROUTE_CANARY#<routeId>#<definitionDigest>` with `test: "driving/v1"`, the shape
//    row, the test row). A failed test writes its test row only; a discovery writes the discovery row.
// It prints the receipts' digests and counts; no prompt or answer text exists to print. Exit 0 when the check is recorded and, for a driving test, passed; 1 when it did not pass, was not
// trusted or no result came; 2 for bad arguments. A runner serves up to 12 checks.
//
// Why the runner: the governed route refuses to start where AWS_PROFILE, shared credential files or proxies could redirect the call (the operator's machine), and the check must prove the
// route as the agent steps use it: the worker's settings, its instance role and the runner subnet's path to the provider.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DRIVING_TEST_BUDGET, E2E_MODEL_CHECK_REQUEST_SCHEMA, MODEL_CHECK_MAX_PER_RUNNER } from "../packages/contracts/src/e2e-model-check.js";
import { E2E_AGENT_RECOMMENDED_MODELS } from "../packages/contracts/src/e2e-agent-models.js";
import { environmentSettingsPrefix, environmentStackName } from "../packages/contracts/src/environments.js";
import { e2eQualificationPrefix } from "../packages/contracts/src/session.js";
import type { ModelProvider } from "../packages/contracts/src/model-providers.js";
import { recordDrivingTest, validateModelCheckResult, type ExpectedModelCheck } from "../packages/broker/src/e2e/model-checks.js";
import { e2eAgentInstallationFromParameters, e2eModelDiscoveryKey, readE2EModelRouteShape } from "../packages/broker/src/e2e/model-route-registry.js";
import { deriveE2EAgentRouteForModel, e2eAgentRouteDefinitionDigest, type E2EAgentInstallation } from "../packages/model-runtime/src/e2e-route-derive.js";
import { Runner, type ReleaseOptions } from "./release-common.js";
import { loadAllowlist, parseOptions } from "./test-deploy.js";
import { classifyGetObjectFailure, roleNameFromArn } from "./test-qualify-runtime.js";

export const CHECK_BOUNDS = DRIVING_TEST_BUDGET;
const DEFAULT_REGION = "us-east-1";
const INSTANCE = /^i-[0-9a-f]{8,17}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const POLL_MS = 10_000;

export interface CanaryArgs { env: string; profile: string; region: string; instance: string; apply: boolean; timeoutMinutes: number; model?: string; discover: boolean }

export function parseCanaryArgs(argv: readonly string[], allowlist: readonly string[] = loadAllowlist()): CanaryArgs {
  const { values, flags } = parseOptions(argv, { values: ["--env", "--profile", "--region", "--instance", "--timeout-minutes", "--model"], flags: ["--apply", "--discover"] });
  const env = values.get("--env");
  if (env === undefined) throw new Error("--env is required");
  if (env === "production" || /(^|-)prod(uction)?($|-)/.test(env)) throw new Error("the model check never runs against production");
  if (!allowlist.includes(env)) throw new Error("test-model-canary only targets allowlisted TEST installations");
  const profile = values.get("--profile");
  if (profile === undefined) throw new Error("--profile is required");
  const instance = values.get("--instance");
  if (instance === undefined || !INSTANCE.test(instance)) throw new Error("--instance must be the qualified runner's instance ID, such as i-0123456789abcdef0");
  const timeoutMinutes = Number(values.get("--timeout-minutes") ?? "10");
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 30) throw new Error("--timeout-minutes must be a whole number from 1 to 30");
  const model = values.get("--model");
  if (model !== undefined && !MODEL_ID.test(model)) throw new Error("--model must be a model id");
  const discover = flags.has("--discover");
  if (discover && model !== undefined) throw new Error("--discover lists models and takes no --model");
  return { env, profile, region: values.get("--region") ?? DEFAULT_REGION, instance, apply: flags.has("--apply"), timeoutMinutes, ...(model === undefined ? {} : { model }), discover };
}

export function formatCanaryPlan(args: CanaryArgs): string {
  const what = args.discover ? "Model discovery (no model call)"
    : `Model driving test of ${args.model ?? "the installation's chosen model"}: at most ${CHECK_BOUNDS.maxCalls} model calls, ${CHECK_BOUNDS.maxInputTokensTotal.toLocaleString("en-US")} input tokens in all and ${CHECK_BOUNDS.maxOutputTokensPerCall} output tokens per call`;
  return [
    `${what} on ${args.env} (${args.region}), runner ${args.instance}.`,
    "1. read the control-plane outputs, the worker role's unique ID and the worker model settings (ids and ARNs; no secret), and derive the route",
    `2. put e2e-runtime/<role unique ID>:${args.instance}/canary-request.json (a v2 request: the check's id, its kind${args.discover ? "" : ", the route id and definition digest"}; the budget is the worker's own)`,
    `3. wait up to ${args.timeoutMinutes} minutes for canary-result.json to name this check; judge it with the broker's validator (the runner serves up to ${MODEL_CHECK_MAX_PER_RUNNER} checks)`,
    args.discover ? "4. record the discovery row E2E_MODEL_ROUTES / E2E_MODEL_DISCOVERY#<provider>"
      : "4. only for a passed test: write E2E_MODEL_ROUTES / E2E_MODEL_ROUTE_CANARY#<routeId>#<definitionDigest> (test driving/v1), the shape row and the test row; a failed test writes its test row only",
  ].join("\n");
}

export interface CanaryFacts { bucket: string; stateTable: string; roleId: string; installation: E2EAgentInstallation }
export interface CanaryEffects {
  resolveFacts(): Promise<CanaryFacts>;
  getObject(key: string): Promise<Buffer | undefined>;
  putObject(key: string, bytes: Buffer): Promise<void>;
  /** The stored request shape of a model, as the setup approval reads it. */
  readShape(routeId: string, modelId: string): Promise<"minimal" | undefined>;
  /** Writes what the broker writes for a validated driving test. */
  recordDrive(validated: Extract<ReturnType<typeof validateModelCheckResult>, { kind: "drive" }>, checkId: string): Promise<void>;
  /** Writes the discovery row of a validated discovery. */
  recordDiscovery(provider: string, report: unknown, checkId: string): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  print(line: string): void;
  newCheckId?: () => string;
}

export async function runModelCanary(args: CanaryArgs, effects: CanaryEffects): Promise<number> {
  if (!args.apply) throw new Error("the model check runs only with --apply, after the owner's explicit OK (gate G1)");
  const facts = await effects.resolveFacts();
  const provider = facts.installation.provider as ModelProvider | undefined;
  if (provider === undefined) throw new Error("the installation has no AI navigation route to check: it has no model provider setting");
  const checkId = (effects.newCheckId ?? randomUUID)();
  const prefix = e2eQualificationPrefix(facts.roleId, args.instance);
  let request: Record<string, unknown> = { schemaVersion: E2E_MODEL_CHECK_REQUEST_SCHEMA, checkId, kind: args.discover ? "discover" : "drive" };
  let expected: ExpectedModelCheck = { checkId, kind: args.discover ? "discover" : "drive", provider };
  if (!args.discover) {
    const chosen = facts.installation.e2eModel === undefined || ["", "default", "none"].includes(facts.installation.e2eModel) ? undefined : facts.installation.e2eModel;
    const modelId = args.model ?? chosen ?? E2E_AGENT_RECOMMENDED_MODELS[provider];
    const standard = deriveE2EAgentRouteForModel(facts.installation, modelId, "standard", 1);
    const minimal = deriveE2EAgentRouteForModel(facts.installation, modelId, "minimal", 1);
    if (standard.status !== "available" || minimal.status !== "available") throw new Error("the model is not one Rovara can use with this installation's provider in this Region");
    const stored = await effects.readShape(standard.definition.routeId, modelId);
    const definition = stored === "minimal" ? minimal.definition : standard.definition;
    request = { ...request, routeId: definition.routeId, definitionDigest: e2eAgentRouteDefinitionDigest(definition) };
    expected = { ...expected, startShape: stored === "minimal" ? "minimal" : "standard", definitions: { standard: standard.definition, minimal: minimal.definition } };
    effects.print(`route ${definition.routeId} (${definition.provider} ${definition.modelId}${stored === "minimal" ? ", minimal request shape" : ""}), definition digest ${e2eAgentRouteDefinitionDigest(definition)}; check ${checkId}`);
  } else effects.print(`discovery of ${provider} models; check ${checkId}`);
  await effects.putObject(`${prefix}canary-request.json`, Buffer.from(`${JSON.stringify(request)}\n`, "utf8"));

  const deadline = effects.now() + args.timeoutMinutes * 60_000;
  let result: unknown;
  for (;;) {
    const bytes = await effects.getObject(`${prefix}canary-result.json`);
    if (bytes !== undefined) {
      try { result = JSON.parse(bytes.toString("utf8")); } catch { result = undefined; }
      // An earlier answer under the key is not this check's.
      if (typeof result === "object" && result !== null && (result as { checkId?: unknown }).checkId === checkId) break;
    }
    if (effects.now() >= deadline) { effects.print(`no result for this check within ${args.timeoutMinutes} minutes; nothing was recorded (the runner serves checks for seven days after it qualified)`); return 1; }
    await effects.sleep(POLL_MS);
  }
  const validated = validateModelCheckResult(result, expected);
  if (!validated.ok) { effects.print(`not recorded: ${validated.reason}`); return 1; }
  if (validated.kind === "discover") {
    await effects.recordDiscovery(provider, validated.discovery, checkId);
    effects.print(`discovery ${validated.discovery.status}${validated.discovery.unverifiedReason === undefined ? "" : ` (${validated.discovery.unverifiedReason})`}: ${validated.discovery.models.filter((model) => model.visible).length} of ${validated.discovery.models.length} eligible models visible`);
    for (const model of validated.discovery.models.filter((item) => item.visible).slice(0, 20)) effects.print(`  ${model.modelId}: ${model.state}${model.quotas.filter((quota) => quota.code !== null).map((quota) => `, ${quota.scope} ${quota.code} ${quota.tokensPerMinute ?? "unknown"} tokens per minute`).join("")}`);
    return 0;
  }
  const { finding, definition, definitionDigest } = validated;
  for (const receipt of finding.receipts) {
    effects.print(`receipt ${receipt.receiptId}: case ${receipt.caseId}, outcome ${receipt.outcome}, inputTokens ${receipt.inputTokens}, outputTokens ${receipt.outputTokens}, latencyMs ${receipt.latencyMs}, routeRevision ${receipt.routeRevision}, promptSha256 ${receipt.promptSha256}, responseSha256 ${receipt.responseSha256 ?? "null"}`);
  }
  await effects.recordDrive(validated, checkId);
  effects.print(finding.outcome === "passed" ? `driving test passed (${finding.payloadShape} request shape, ${finding.calls} calls); recorded E2E_MODEL_ROUTE_CANARY#${definition.routeId}#${definitionDigest} (driving/v1)`
    : `driving test failed${finding.failure === null ? "" : `: ${finding.failure.class}${finding.failure.signal === null ? "" : ` (${finding.failure.signal})`}`}; its test row is recorded, no gating row`);
  return finding.outcome === "passed" ? 0 : 1;
}

function outputsOf(stack: { Outputs?: Array<{ OutputKey?: string | undefined; OutputValue?: string | undefined }> | undefined }): Record<string, string> {
  return Object.fromEntries((stack.Outputs ?? []).flatMap((output) => (output.OutputKey && output.OutputValue !== undefined ? [[output.OutputKey, output.OutputValue]] : [])));
}

function createAwsEffects(args: CanaryArgs, runner: Runner): CanaryEffects {
  const config = { region: args.region, profile: args.profile, maxAttempts: 3 };
  const cloudFormation = new CloudFormationClient(config);
  const ssm = new SSMClient(config);
  const documents = DynamoDBDocumentClient.from(new DynamoDBClient(config));
  let bucket = "";
  let table = "";
  const output = async (kind: "control-plane" | "foundation", key: string) => {
    const name = environmentStackName(args.env, kind);
    const stack = (await cloudFormation.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
    const value = stack === undefined ? undefined : outputsOf(stack)[key];
    if (!value) throw new Error(`stack ${name} has no output ${key}`);
    return value;
  };
  return {
    async resolveFacts() {
      bucket = await output("control-plane", "ArtifactBucketName");
      table = await output("control-plane", "StateTableName");
      const roleArn = await output("foundation", "Ec2WorkerInstanceRoleArn");
      const role = runner.aws(["iam", "get-role", "--role-name", roleNameFromArn(roleArn), "--query", "Role.RoleId", "--output", "text"], true);
      if (role.status !== 0) throw new Error(`reading the worker role failed (iam:GetRole on ${roleArn})`);
      const installation = await e2eAgentInstallationFromParameters(environmentSettingsPrefix(args.env), async (names) => {
        const found = (await ssm.send(new GetParametersCommand({ Names: [...names] }))).Parameters ?? [];
        return new Map(found.flatMap((parameter) => (parameter.Name !== undefined && parameter.Value !== undefined ? [[parameter.Name, parameter.Value] as const] : [])));
      }, args.region);
      return { bucket, stateTable: table, roleId: role.stdout.trim(), installation };
    },
    async getObject(key) {
      const file = `${process.env["TMPDIR"] ?? "/tmp"}/test-model-canary-${randomUUID()}`;
      const result = runner.aws(["s3api", "get-object", "--bucket", bucket, "--key", key, "--region", args.region, file], true);
      if (result.status === 0) { const { readFileSync, rmSync } = await import("node:fs"); const bytes = readFileSync(file); rmSync(file, { force: true }); return bytes; }
      if (classifyGetObjectFailure(result.stderr) === "absent") return undefined;
      throw new Error(`reading s3://${bucket}/${key} failed: ${result.stderr.trim().slice(0, 300)}`);
    },
    async putObject(key, bytes) {
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const file = `${mkdtempSync(`${process.env["TMPDIR"] ?? "/tmp"}/test-model-canary-`)}/body.json`;
      writeFileSync(file, bytes, { mode: 0o600 });
      const put = runner.aws(["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", file, "--server-side-encryption", "AES256", "--region", args.region, "--output", "json"], true);
      if (put.status !== 0) throw new Error(`putting s3://${bucket}/${key} failed: ${put.stderr.trim().slice(0, 300)}`);
    },
    async readShape(routeId, modelId) { return readE2EModelRouteShape({ documentClient: documents, tableName: table }, routeId, modelId); },
    async recordDrive(validated, checkId) { await recordDrivingTest({ documentClient: documents, tableName: table, now: Date.now }, validated, checkId); },
    async recordDiscovery(provider, report, checkId) {
      await documents.send(new PutCommand({ TableName: table, Item: { ...e2eModelDiscoveryKey(provider), entityType: "E2E_MODEL_DISCOVERY", provider, report, checkId, recordedAt: new Date().toISOString() } }));
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
    print: (line) => console.log(line),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseCanaryArgs(argv);
  console.log(formatCanaryPlan(args));
  if (!args.apply) { console.log("\nDry run: nothing was read, sent or written. Add --apply, after the owner's explicit OK (gate G1), to make the check."); return 0; }
  const options: ReleaseOptions = { region: args.region, repository: "", profile: args.profile, allowDirty: false, skipChecks: false, dryRun: false };
  return runModelCanary(args, createAwsEffects(args, new Runner(options)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
