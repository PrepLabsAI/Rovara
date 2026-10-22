// M1.4 Task 4.9 step 3 (gate G1, decision D1): the plan-first model canary. One real model call, made by the qualified runner's worker through the governed route.
//
//   npx tsx scripts/test-model-canary.ts --env agentxlivetest123 --profile agentx-test --instance <runner instance ID>            # plan only; no AWS call
//   npx tsx scripts/test-model-canary.ts --env agentxlivetest123 --profile agentx-test --instance <runner instance ID> --apply    # gate G1: the owner's explicit OK first
//
// What --apply does, and all it does:
// 1. reads the control-plane outputs (artifact bucket, state table), the worker role's unique ID (iam get-role) and the worker model settings (SSM, ids and ARNs only; no secret is
//    read), and derives the route the installation gives, exactly as the broker and the worker do;
// 2. refuses if the runner already answered a canary (`<prefix>canary-result.json` exists): a runner serves one;
// 3. puts `e2e-runtime/<role unique ID>:<instance ID>/canary-request.json`, naming the route's id and definition digest and the bounds: at most 1 call, input at most 32,000
//    tokens, output at most 1,024 tokens. The runner's worker (`packages/worker/src/e2e-model-canary-cli.ts`, started by the boot qualification hook) refuses anything else;
// 4. waits (bounded) for `canary-result.json`, checks the receipt is the one call it asked for, within the bounds, on the planned route, with outcome `ok`;
// 5. only then writes the registry row `E2E_MODEL_ROUTES / E2E_MODEL_ROUTE_CANARY#<routeId>#<definitionDigest>` (conditional: never overwritten).
// It prints the receipt's digests and counts; no prompt or answer text exists to print. Exit 0 when the row is recorded, 1 when the call was not ok or no result came, 2 for bad arguments.
//
// Why the runner: the governed route refuses to start where AWS_PROFILE, shared credential files or proxies could redirect the call (the operator's machine), and the canary must
// prove the route as the agent steps use it: the worker's settings, its instance role and the runner subnet's path to the provider.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { E2EModelReceiptSchema } from "../packages/contracts/src/e2e-model-channel.js";
import { environmentSettingsPrefix, environmentStackName } from "../packages/contracts/src/environments.js";
import { e2eQualificationPrefix } from "../packages/contracts/src/session.js";
import { e2eAgentInstallationFromParameters, e2eModelRouteCanaryKey } from "../packages/broker/src/e2e/model-route-registry.js";
import { deriveE2EAgentRoute, e2eAgentRouteDefinitionDigest, type E2EAgentInstallation } from "../packages/model-runtime/src/e2e-route-derive.js";
import { Runner, type ReleaseOptions } from "./release-common.js";
import { loadAllowlist, parseOptions } from "./test-deploy.js";
import { classifyGetObjectFailure, roleNameFromArn } from "./test-qualify-runtime.js";

export const CANARY_BOUNDS = Object.freeze({ maxCalls: 1, maxInputTokens: 32_000, maxOutputTokens: 1024 } as const);
const DEFAULT_REGION = "us-east-1";
const INSTANCE = /^i-[0-9a-f]{8,17}$/;
const POLL_MS = 10_000;

export interface CanaryArgs { env: string; profile: string; region: string; instance: string; apply: boolean; timeoutMinutes: number }

export function parseCanaryArgs(argv: readonly string[], allowlist: readonly string[] = loadAllowlist()): CanaryArgs {
  const { values, flags } = parseOptions(argv, { values: ["--env", "--profile", "--region", "--instance", "--timeout-minutes"], flags: ["--apply"] });
  const env = values.get("--env");
  if (env === undefined) throw new Error("--env is required");
  if (env === "production" || /(^|-)prod(uction)?($|-)/.test(env)) throw new Error("the model canary never runs against production");
  if (!allowlist.includes(env)) throw new Error("test-model-canary only targets allowlisted TEST installations");
  const profile = values.get("--profile");
  if (profile === undefined) throw new Error("--profile is required");
  const instance = values.get("--instance");
  if (instance === undefined || !INSTANCE.test(instance)) throw new Error("--instance must be the qualified runner's instance ID, such as i-0123456789abcdef0");
  const timeoutMinutes = Number(values.get("--timeout-minutes") ?? "10");
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 30) throw new Error("--timeout-minutes must be a whole number from 1 to 30");
  return { env, profile, region: values.get("--region") ?? DEFAULT_REGION, instance, apply: flags.has("--apply"), timeoutMinutes };
}

export function formatCanaryPlan(args: CanaryArgs): string {
  return [
    `Model canary on ${args.env} (${args.region}), runner ${args.instance}: at most 1 model call, input at most 32,000 tokens, output at most 1,024 tokens (thinking off, effort low).`,
    "1. read the control-plane outputs, the worker role's unique ID and the worker model settings (ids and ARNs; no secret), and derive the route",
    `2. refuse if e2e-runtime/<role unique ID>:${args.instance}/canary-result.json already exists`,
    `3. put e2e-runtime/<role unique ID>:${args.instance}/canary-request.json (route id, definition digest, the bounds above)`,
    `4. wait up to ${args.timeoutMinutes} minutes for canary-result.json; check the receipt is the one call asked for, within the bounds, outcome ok`,
    "5. only on an ok receipt: write E2E_MODEL_ROUTES / E2E_MODEL_ROUTE_CANARY#<routeId>#<definitionDigest> in the state table (never overwritten)",
  ].join("\n");
}

export interface CanaryFacts { bucket: string; stateTable: string; roleId: string; installation: E2EAgentInstallation }
export interface CanaryEffects {
  resolveFacts(): Promise<CanaryFacts>;
  getObject(key: string): Promise<Buffer | undefined>;
  putObject(key: string, bytes: Buffer): Promise<void>;
  putCanaryRow(item: Record<string, unknown>): Promise<"written" | "exists">;
  now(): number;
  sleep(ms: number): Promise<void>;
  print(line: string): void;
  newCanaryId?: () => string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export async function runModelCanary(args: CanaryArgs, effects: CanaryEffects): Promise<number> {
  if (!args.apply) throw new Error("the canary makes a real model call only with --apply, after the owner's explicit OK (gate G1)");
  const facts = await effects.resolveFacts();
  const derived = deriveE2EAgentRoute(facts.installation, 1);
  if (derived.status === "unavailable") throw new Error(`the installation has no AI navigation route to call: ${derived.detail}`);
  const definition = derived.definition;
  const definitionDigest = e2eAgentRouteDefinitionDigest(definition);
  const prefix = e2eQualificationPrefix(facts.roleId, args.instance);
  if (await effects.getObject(`${prefix}canary-result.json`) !== undefined) throw new Error(`runner ${args.instance} already answered a model canary (${prefix}canary-result.json exists); a runner serves one`);
  const canaryId = (effects.newCanaryId ?? randomUUID)();
  const request = { schemaVersion: "rovara-e2e-model-canary-request/v1", canaryId, routeId: definition.routeId, definitionDigest, ...CANARY_BOUNDS };
  effects.print(`route ${definition.routeId} (${definition.provider} ${definition.modelId}), definition digest ${definitionDigest}; canary ${canaryId}`);
  await effects.putObject(`${prefix}canary-request.json`, Buffer.from(`${JSON.stringify(request)}\n`, "utf8"));

  const deadline = effects.now() + args.timeoutMinutes * 60_000;
  let bytes: Buffer | undefined;
  while ((bytes = await effects.getObject(`${prefix}canary-result.json`)) === undefined) {
    if (effects.now() >= deadline) { effects.print(`no canary result within ${args.timeoutMinutes} minutes; nothing was recorded (the runner waits 2 hours after qualifying for a request)`); return 1; }
    await effects.sleep(POLL_MS);
  }
  let result: unknown;
  try { result = JSON.parse(bytes.toString("utf8")); } catch { result = undefined; }
  const refuse = (why: string): number => { effects.print(`not recorded: ${why}`); return 1; };
  if (!isObject(result) || result["schemaVersion"] !== "rovara-e2e-model-canary-result/v1") return refuse("the result is not a canary result");
  if (result["status"] === "refused") return refuse(`the runner refused the canary (${String(result["code"]).slice(0, 64)}); no call was made`);
  if (result["status"] !== "called") return refuse(`the canary did not run (${String(result["reason"] ?? result["status"]).slice(0, 64)})`);
  if (result["canaryId"] !== canaryId) return refuse("the result is for another canary");
  if (result["routeId"] !== definition.routeId || result["definitionDigest"] !== definitionDigest) return refuse("the runner called another route than the one planned");
  if (result["calls"] !== 1) return refuse("the runner did not make exactly one call");
  const parsed = E2EModelReceiptSchema.safeParse(result["receipt"]);
  if (!parsed.success) return refuse("the receipt is malformed");
  const receipt = parsed.data;
  const payloadSha = typeof result["providerPayloadSha256"] === "string" && /^[a-f0-9]{64}$/.test(result["providerPayloadSha256"]) ? result["providerPayloadSha256"] : null;
  effects.print(`receipt ${receipt.receiptId}: outcome ${receipt.outcome}, provider ${receipt.provider}, modelId ${receipt.modelId}, servedModelId ${receipt.servedModelId ?? "null"}, `
    + `inputTokens ${receipt.inputTokens}, outputTokens ${receipt.outputTokens}, latencyMs ${receipt.latencyMs}, routeRevision ${receipt.routeRevision}, promptSha256 ${receipt.promptSha256}, `
    + `responseSha256 ${receipt.responseSha256 ?? "null"}, providerPayloadSha256 ${payloadSha ?? "null"}${result["usageMissing"] === true ? ", usage missing" : ""}`);
  if (receipt.runId !== canaryId || receipt.caseId !== "model-canary") return refuse("the receipt is not this canary's call");
  if (receipt.routeId !== definition.routeId || receipt.provider !== definition.provider || receipt.modelId !== definition.modelId) return refuse("the receipt names another route or model");
  if (receipt.outcome !== "ok") return refuse(`the call's outcome is ${receipt.outcome}`);
  if (receipt.inputTokens > CANARY_BOUNDS.maxInputTokens || receipt.outputTokens > CANARY_BOUNDS.maxOutputTokens) return refuse("the call passed the canary's token bounds");

  const written = await effects.putCanaryRow({
    ...e2eModelRouteCanaryKey(definition.routeId, definitionDigest), entityType: "E2E_MODEL_ROUTE_CANARY", routeId: definition.routeId, definitionDigest,
    provider: definition.provider, modelId: definition.modelId, servedModelId: receipt.servedModelId, canaryId, instanceId: args.instance, receipt, providerPayloadSha256: payloadSha,
    recordedAt: new Date(effects.now()).toISOString(),
  });
  effects.print(written === "written" ? `recorded E2E_MODEL_ROUTE_CANARY#${definition.routeId}#${definitionDigest}` : `the canary row for this exact route was already recorded; left as it was`);
  return 0;
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
    async putCanaryRow(item) {
      try {
        await documents.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
        return "written";
      } catch (error) {
        if ((error as { name?: unknown }).name === "ConditionalCheckFailedException") return "exists";
        throw error;
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
    print: (line) => console.log(line),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseCanaryArgs(argv);
  console.log(formatCanaryPlan(args));
  if (!args.apply) { console.log("\nDry run: nothing was read, sent or written. Add --apply, after the owner's explicit OK (gate G1), to make the one call."); return 0; }
  const options: ReleaseOptions = { region: args.region, repository: "", profile: args.profile, allowDirty: false, skipChecks: false, dryRun: false };
  return runModelCanary(args, createAwsEffects(args, new Runner(options)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
