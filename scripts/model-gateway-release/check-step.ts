// Step 3: ModelGatewayCheck (#1578).
// Verifies the live model gateway satisfies this Code (digest-equal, ECS settled, /healthz runPrice, price-fetch freshness),
// then records /agentx/release/model-gateway-last-good/<env> in the release account.
import { CONTROL_PLANE_STACK_NAME, modelGatewayStackName } from "./context.js";
import { IMAGE_DIGEST } from "./ecr.js";
import { buildLastGood, readLastGood, readLegacyLastGood, writeLastGood } from "./lastgood.js";
import { StageError } from "./types.js";
import type { GateVerdict, GatewayManifest, PipelineEnv, Ports } from "./types.js";

const SERVICE_ARN = /^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:service\/([^/]+)\/([^/]+)$/u;
const PINNED = /@(sha256:[0-9a-f]{64})$/u;
const HOST = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/u;
const BASELINE_RUN_PRICE_VERSION = 1;
const PRICE_MAX_AGE_MS = 48 * 3_600_000;

export interface CheckStepArgs {
  env: PipelineEnv;
  repoDir: string;
  dryRun: boolean;
  manifest: GatewayManifest;
  gatewayUrlOverride?: string | null;
  pollAttempts?: number;
  pollWaitMs?: number;
  ports: Ports;
  log: (line: string) => void;
}

async function checkDigestEqual(args: CheckStepArgs): Promise<GateVerdict> {
  const want = args.manifest.gateway.digest;
  if (want === null || !IMAGE_DIGEST.test(want)) {
    return { name: "gateway-digest-equal", phase: "gateway-live", result: "fail", failures: ["manifest holds no valid gateway digest"] };
  }
  const stack = modelGatewayStackName(args.env);
  const live = await args.ports.cfn.describeStack(stack);
  if (live === null) return { name: "gateway-digest-equal", phase: "gateway-live", result: "fail", failures: [`stack ${stack} does not exist`] };
  const have = live.parameters.ImageDigest;
  if (have !== want) {
    return { name: "gateway-digest-equal", phase: "gateway-live", result: "fail", failures: [`${stack} runs ${have ?? "none"}, expected ${want}`] };
  }
  const wantCode = args.manifest.gateway.codeSha;
  if (args.manifest.mode !== "adopt" && wantCode !== null && live.outputs.DeployedCodeSha !== wantCode) {
    return { name: "gateway-digest-equal", phase: "gateway-live", result: "fail", failures: [`${stack} DeployedCodeSha is ${live.outputs.DeployedCodeSha ?? "absent"}, expected ${wantCode}`] };
  }
  args.log(`${stack}: live ImageDigest matches ${want.slice(0, 19)}... (${live.status})`);
  return { name: "gateway-digest-equal", phase: "gateway-live", result: "pass", data: { digest: want, stackStatus: live.status } };
}

async function resolveServiceArn(ports: Ports, stack: string): Promise<{ arn: string; source: string } | string> {
  const described = await ports.cfn.describeStack(stack);
  if (described === null) return `gateway stack ${stack} does not exist`;
  const output = described.outputs.ServiceArn;
  if (output !== undefined) return SERVICE_ARN.test(output) ? { arn: output, source: "stack output" } : "ServiceArn output is not an ECS service ARN";
  const resources = await ports.cfn.listStackResources(stack);
  const services = resources.filter((r) => r.resourceType === "AWS::ECS::Service").map((r) => r.physicalId);
  if (services.length !== 1 || !SERVICE_ARN.test(services[0]!)) return `stack has no ServiceArn output and ${services.length} ECS services`;
  return { arn: services[0]!, source: "stack resources" };
}

interface EcsService {
  runningCount?: number;
  desiredCount?: number;
  deployments?: Array<{ rolloutState?: string; taskDefinition?: string }>;
}

async function judgeSettledOnce(ports: Ports, cluster: string, arn: string, expected: string): Promise<string | null> {
  const answer = (await ports.aws.json(["ecs", "describe-services", "--cluster", cluster, "--services", arn])) as { services?: EcsService[] } | null;
  const service = answer?.services?.[0];
  if (service === undefined) return "ECS does not know the gateway service";
  const deployments = service.deployments ?? [];
  if (deployments.length !== 1 || deployments[0]!.rolloutState !== "COMPLETED") {
    return `not settled: ${deployments.length} deployment(s), rollout ${deployments[0]?.rolloutState ?? "none"}`;
  }
  if (typeof service.desiredCount !== "number" || service.desiredCount < 1 || service.runningCount !== service.desiredCount) {
    return `not settled: running ${String(service.runningCount)} of ${String(service.desiredCount)}`;
  }
  const td = deployments[0]!.taskDefinition ?? "";
  const def = (await ports.aws.json(["ecs", "describe-task-definition", "--task-definition", td])) as {
    taskDefinition?: { containerDefinitions?: Array<{ image?: string }> };
  } | null;
  const pinned = PINNED.exec(def?.taskDefinition?.containerDefinitions?.[0]?.image ?? "");
  if (pinned === null) return "task definition image is not pinned by digest";
  if (pinned[1] !== expected) return `service runs ${pinned[1]!.slice(0, 19)}..., not ${expected.slice(0, 19)}...`;
  return null;
}

async function checkSettled(args: CheckStepArgs): Promise<GateVerdict> {
  const expected = args.manifest.gateway.digest;
  if (expected === null) return { name: "gateway-settled", phase: "gateway-live", result: "fail", failures: ["manifest has no gateway digest"] };
  const found = await resolveServiceArn(args.ports, modelGatewayStackName(args.env));
  if (typeof found === "string") return { name: "gateway-settled", phase: "gateway-live", result: "fail", failures: [found] };
  const cluster = SERVICE_ARN.exec(found.arn)![1]!;
  const attempts = args.pollAttempts ?? 12;
  const waitMs = args.pollWaitMs ?? 15_000;
  let problem: string | null = "not tried";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { problem = await judgeSettledOnce(args.ports, cluster, found.arn, expected); } catch (error) {
      problem = `ECS read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (problem === null) {
      args.log(`gateway-settled: try ${attempt} settled on ${expected.slice(0, 19)}...`);
      return { name: "gateway-settled", phase: "gateway-live", result: "pass", data: { digest: expected, source: found.source, attempts: attempt } };
    }
    args.log(`gateway-settled: try ${attempt}/${attempts}: ${problem}`);
    if (attempt < attempts) await args.ports.clock.sleep(waitMs);
  }
  return { name: "gateway-settled", phase: "gateway-live", result: "fail", failures: [`gateway not settled after ${attempts} tries: ${problem}`] };
}

export function judgeHealthz(status: number, body: string | undefined, required: number): string | null {
  if (status !== 200) return `/healthz answered ${status === 0 ? "connection failed" : status}`;
  let doc: { ok?: unknown; runPrice?: { version?: unknown; admissionVersion?: unknown; snapshotVersion?: unknown } } | null;
  try { doc = JSON.parse(body ?? "") as typeof doc; } catch { return "/healthz did not answer JSON"; }
  if (doc === null || typeof doc !== "object" || doc.ok !== true) return "/healthz does not say ok";
  const price = doc.runPrice;
  if (price === undefined || price === null) return "gateway serves no runPrice section";
  if (price.version !== required) return `runPrice.version is ${String(price.version)}, Code needs ${required}`;
  if (price.admissionVersion !== 1) return `runPrice.admissionVersion is ${String(price.admissionVersion)}, not 1`;
  if (typeof price.snapshotVersion !== "number" || !Number.isSafeInteger(price.snapshotVersion) || price.snapshotVersion <= 0) {
    return "runPrice.snapshotVersion is not a positive whole number";
  }
  return null;
}

async function resolveGatewayOrigin(args: CheckStepArgs): Promise<string | null> {
  if (args.gatewayUrlOverride !== undefined && args.gatewayUrlOverride !== null && HOST.test(args.gatewayUrlOverride)) {
    return args.gatewayUrlOverride;
  }
  const controlPlane = await args.ports.cfn.describeStack(CONTROL_PLANE_STACK_NAME);
  const cpHost = controlPlane?.parameters.CoreModelGatewayHost?.trim() ?? "";
  if (cpHost !== "" && HOST.test(`https://${cpHost}`)) return `https://${cpHost}`;
  const gateway = await args.ports.cfn.describeStack(modelGatewayStackName(args.env));
  const certArn = gateway?.parameters.CertificateArn;
  if (certArn === undefined || certArn === "") return null;
  const cert = (await args.ports.aws.json(["acm", "describe-certificate", "--certificate-arn", certArn])) as {
    Certificate?: { DomainName?: string; SubjectAlternativeNames?: string[] };
  } | null;
  const names = [cert?.Certificate?.DomainName, ...(cert?.Certificate?.SubjectAlternativeNames ?? [])].filter(
    (name): name is string => typeof name === "string" && name !== "" && !name.startsWith("*."),
  );
  for (const name of names) {
    const candidate = `https://${name}`;
    if (HOST.test(candidate)) return candidate;
  }
  return null;
}

async function requiredRunPriceVersion(args: CheckStepArgs): Promise<number> {
  const sha = args.manifest.gateway.codeSha ?? args.manifest.code.sha;
  const source = await args.ports.exec("git", ["-C", args.repoDir, "show", `${sha}:infra/lib/control-plane.ts`]);
  const found = source.code === 0 ? /"ModelRunPriceVersion",\s*\{\s*value:\s*"([0-9]+)"/u.exec(source.stdout) : null;
  return found === null ? BASELINE_RUN_PRICE_VERSION : Math.max(BASELINE_RUN_PRICE_VERSION, Number(found[1]));
}

async function checkRunPrice(args: CheckStepArgs): Promise<GateVerdict> {
  const origin = await resolveGatewayOrigin(args);
  if (origin === null) {
    return { name: "gateway-runprice", phase: "gateway-live", result: "fail", failures: ["could not resolve model gateway HTTPS origin from CoreModelGatewayHost or CertificateArn"] };
  }
  const required = await requiredRunPriceVersion(args);
  const attempts = args.pollAttempts ?? 12;
  const waitMs = args.pollWaitMs ?? 15_000;
  let problem: string | null = "not tried";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const answer = await args.ports.http.get(`${origin}/healthz`, 10_000).catch((): { status: number; body?: string } => ({ status: 0 }));
    problem = judgeHealthz(answer.status, answer.body, required);
    if (problem === null) {
      const snapshot = (JSON.parse(answer.body ?? "{}") as { runPrice: { snapshotVersion: unknown } }).runPrice.snapshotVersion;
      args.log(`gateway-runprice: try ${attempt} ok, runPrice v${required}, snapshot ${String(snapshot)}`);
      return { name: "gateway-runprice", phase: "gateway-live", result: "pass", data: { requiredVersion: required, snapshotVersion: snapshot, attempts: attempt } };
    }
    args.log(`gateway-runprice: try ${attempt}/${attempts}: ${problem}`);
    if (attempt < attempts) await args.ports.clock.sleep(waitMs);
  }
  return { name: "gateway-runprice", phase: "gateway-live", result: "fail", failures: [`gateway /healthz failed after ${attempts} tries: ${problem}`] };
}

async function checkPriceFreshness(args: CheckStepArgs): Promise<GateVerdict> {
  const resources = await args.ports.cfn.listStackResources(modelGatewayStackName(args.env));
  const groups = resources.filter((r) => r.resourceType === "AWS::Logs::LogGroup" && r.logicalId.startsWith("PriceFetchLogs"));
  if (groups.length !== 1) {
    return { name: "price-freshness", phase: "gateway-live", result: "fail", failures: [`expected 1 PriceFetchLogs log group, found ${groups.length}`] };
  }
  const now = args.ports.clock.now().getTime();
  const doc = (await args.ports.aws.json([
    "logs", "filter-log-events", "--log-group-name", groups[0]!.physicalId,
    "--filter-pattern", '{ $.event = "price_fetched" }',
    "--start-time", String(now - PRICE_MAX_AGE_MS),
  ])) as { events?: Array<{ timestamp?: number }> } | null;
  const stamps = (doc?.events ?? []).map((e) => e.timestamp).filter((t): t is number => typeof t === "number");
  if (stamps.length > 0) {
    const latest = Math.max(...stamps);
    const ageHours = Math.round((now - latest) / 360_000) / 10;
    args.log(`price-freshness: last successful price fetch ${ageHours} h ago`);
    return { name: "price-freshness", phase: "gateway-live", result: "pass", data: { ageHours, lastFetchedAt: new Date(latest).toISOString() } };
  }
  if (args.manifest.mode === "adopt" || args.dryRun) {
    return { name: "price-freshness", phase: "gateway-live", result: "skipped", skippedReason: "no price_fetched event in last 48h (read-only adopt/dry-run)" };
  }
  return { name: "price-freshness", phase: "gateway-live", result: "fail", failures: ["prices are stale: no price_fetched event in the last 48 hours"] };
}

export async function checkStep(args: CheckStepArgs): Promise<GatewayManifest> {
  const { manifest, env, ports, log } = args;
  if (manifest.skipped) {
    log(`skipping model gateway check step (${manifest.skipReason ?? "skipped"})`);
    return manifest;
  }
  const stage = manifest.stages[env];
  if (stage === undefined) throw new StageError("REFUSED", `manifest has no ${env} stage record`);
  const verdicts = [
    await checkDigestEqual(args),
    await checkSettled(args),
    await checkRunPrice(args),
    await checkPriceFreshness(args),
  ];
  stage.gates.push(...verdicts);
  const failed = verdicts.filter((v) => v.result === "fail");
  if (failed.length > 0) {
    const detail = failed.map((v) => `${v.name}: ${(v.failures ?? []).join("; ")}`).join(" | ");
    throw new StageError("GATE_FAILED", `gateway live check failed: ${detail}`);
  }
  if (args.dryRun) {
    stage.warnings.push("dry run: last-good record not written");
    return manifest;
  }
  let previous = await readLastGood(ports, env);
  if (previous === null && manifest.mode === "adopt") {
    previous = await readLegacyLastGood(ports, env);
  }
  const passedNames = verdicts.filter((v) => v.result === "pass").map((v) => v.name);
  const record = buildLastGood(manifest, env, passedNames, previous, ports.clock.now());
  await writeLastGood(ports, record);
  log(`recorded model gateway last-good (${env}): ${record.gateway.digest.slice(0, 19)}... (Code ${record.gateway.codeSha?.slice(0, 12) ?? "none"})`);
  return manifest;
}
