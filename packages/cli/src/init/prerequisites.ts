import { readOpenRouterKey, openRouterRouting, openRouterModel, MissingOpenRouterSecret, defaultBedrockModel } from "@agentx/model-runtime/config";
import type { ModelsAnswers } from "../deploy/answer-schemas.js";
// FR-015: everything init checks before it creates anything. Every problem is collected and
// reported together, with what to change; cdk bootstrap (which creates the CDKToolkit stack) is
// offered only when every other check has passed.
import { DescribeAddressesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { ServiceQuotasClient, GetServiceQuotaCommand } from "@aws-sdk/client-service-quotas";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { agentXError, AgentXError } from "@agentx/contracts";
import { assertCdkBootstrapped, type CommandRunner } from "../deploy/cdk-engine.js";
import { releaseRegionProblem, type ReleaseCoverage } from "../deploy/release.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { InitAnswers } from "./install-state.js";
import type { Prompter } from "./prompts.js";

export interface PrerequisiteChecks {
  /** A one-token Bedrock Converse call. */
  converse(modelId: string): Promise<void>;
  /** Checks an OpenRouter model. `key`, when given, is the key init collected but has not stored
   * yet (the secret is created only after the plan); otherwise the key is read from config.secretArn. */
  openRouter?(modelId: string, config: OpenRouterCheckConfig, key?: string): Promise<void>;
  /** Regional on-demand Standard EC2 vCPU quota. */
  ec2Quota(): Promise<number>;
  /** The regional EC2-VPC Elastic IP quota (L-0263D0A3) and how many addresses are allocated now. */
  elasticIps(): Promise<{ quota: number; allocated: number }>;
  /** The command's --version output, or undefined when it is not installed. */
  commandVersion(command: string): Promise<string | undefined>;
  cdkBootstrapped(): Promise<boolean>;
  runCdkBootstrap(): Promise<void>;
  oidcDiscovery(issuer: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

/** The foundation stack gives each of its two NAT gateways its own Elastic IP. */
export const NAT_ELASTIC_IPS = 2;

export type ModelRole = "orchestrator" | "classifier" | "worker";
export type OpenRouterCheckConfig = Partial<NonNullable<ModelsAnswers["openRouter"]>>;
/** An OpenRouter key collected by init's questions, not yet stored in Secrets Manager. */
export interface PendingOpenRouterKey { key: string; providers?: readonly string[] }
/** One prerequisite's result, for the page's checklist (spec 040 FR-023). `detail` is the ok line
 * without its "ok " prefix, or the problem exactly as the error lists it. `technical` is extra raw
 * detail (an error code, an ARN) the page keeps collapsed rather than putting in `detail` (spec 048
 * FR-027, FR-060); Task 12 is the first to fill it in. */
export interface PrerequisiteCheck { label: string; ok: boolean; detail: string; technical?: string }

/** Who init's prerequisite problems are being written for: the terminal's flags and commands, or
 * the page's own words and buttons (spec 048 FR-065, FR-027, FR-080). */
export type CheckAudience = "page" | "terminal";
/** The release's own images (spec 048 FR-065): installed by pulling through this install's image
 * cache rather than building locally, so each must already be public on Amazon ECR Public and
 * pinned to a digest before anything is created, unless the answers name an image of their own. */
export interface ReleaseImages { worker?: string | undefined; slack?: string | undefined }

const IMAGE_WORDS = { worker: "coding", slack: "Slack connection" } as const;
const IMAGE_FLAGS = { worker: "--worker-image", slack: "--slack-image" } as const;

/** Spec 048 FR-065 and SC-009: each image the release deploys must be one AWS pulls through this
 * install's image cache (public.ecr.aws, pinned to a digest), unless the answers name their own.
 * The live check of 2026-10-01 met this only 15 minutes into the build. */
export function releaseImageChecks(input: { version: string; images: ReleaseImages; overrides?: ReleaseImages; audience: CheckAudience }): PrerequisiteCheck[] {
  return (["worker", "slack"] as const).map((which): PrerequisiteCheck => {
    const label = `The ${IMAGE_WORDS[which]} image`;
    const override = input.overrides?.[which];
    if (override !== undefined) return { label, ok: true, detail: "uses the image address you gave", technical: override };
    const ref = input.images[which];
    // Narrowed here (rather than computed as a fourth, "no problem" branch below) so the ok
    // return can write `technical: ref` directly: once ref passes every check it is never
    // undefined, so a conditional spread for it on this path was dead code.
    if (ref !== undefined && ref.startsWith("public.ecr.aws/") && /@sha256:[a-f0-9]{64}$/.test(ref)) {
      return { label, ok: true, detail: "AWS can pull it", technical: ref };
    }
    const problem = ref === undefined ? "missing" : !ref.startsWith("public.ecr.aws/") ? "not-public" : "not-pinned";
    const words = IMAGE_WORDS[which];
    const flag = `${IMAGE_FLAGS[which]} <repository@sha256:...>`;
    const detail = input.audience === "page"
      ? {
        missing: `This release has no ${words} image. Use a published AgentX release.`,
        "not-public": `This release's ${words} image is not on Amazon ECR Public, so AWS cannot pull it. Use a published AgentX release, or start the install again with an image address AWS can reach.`,
        "not-pinned": `This release's ${words} image is not pinned to one exact version, so AWS cannot pull it safely. Use a published AgentX release.`,
      }[problem]
      : {
        missing: `release ${input.version} has no ${which} image digest; use a published release, or pass ${flag}`,
        "not-public": `release ${input.version}'s ${which} image ${ref ?? ""} is not a public.ecr.aws/ reference, so the install would fail after about 15 minutes; use a published release, or pass ${flag} with an image AWS can pull`,
        "not-pinned": `release ${input.version}'s ${which} image ${ref ?? ""} is not pinned to a digest; use a published release, or pass ${flag}`,
      }[problem];
    return { label, ok: false, detail, ...(ref === undefined ? {} : { technical: ref }) };
  });
}

/** FR-017: shown once, on the account card. */
export const DEDICATED_ACCOUNT_NOTE = "Tip: a separate AWS account just for AgentX keeps its costs and permissions apart from your other work.";
/** FR-016. */
export const ROOT_WARNING = "You are signed in as the AWS root user. AgentX works, but AWS advises an admin user instead.";
/** AWS's guide to an IAM user with admin rights. Confirm it loads before committing (curl -sI); if AWS moved it, use the IAM User Guide page on creating an administrative user. */
export const ADMIN_USER_GUIDE_URL = "https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-account-iam.html";
export const isRootUser = (arn: string): boolean => /^arn:aws[a-z-]*:iam::\d{12}:root$/.test(arn);

const errorName = (error: unknown) => (error instanceof Error ? error.name : "");
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** True when the error means the service has no endpoint in the region: an SDK client refuses to
 * even build a request (UnknownEndpoint / EndpointError), or DNS resolution for the regional
 * hostname failed outright (ENOTFOUND), rather than the request reaching AWS and being refused. */
export function endpointMissing(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const record = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (record.name === "UnknownEndpoint" || record.name === "EndpointError" || record.code === "ENOTFOUND") return true;
    if (typeof record.message === "string" && /getaddrinfo ENOTFOUND/.test(record.message)) return true;
    current = record.cause;
  }
  return false;
}

/** Names the inference-profile prefix a model id needs in `region`, or, where none can be guessed
 * reliably (item 8), sends the person to the console instead of a wrong id: `ca-` and `sa-` regions
 * are not covered by the `us.`/`eu.`/`apac.` cross-region profile families, so guessing would print
 * an id that does not exist. */
function inferenceProfileHint(modelId: string, region: string, change: string): string {
  if (region.startsWith("us-gov-")) return `use us-gov.${modelId} instead (${change})`;
  if (region.startsWith("eu-")) return `use eu.${modelId} instead (${change})`;
  if (region.startsWith("ap-")) return `use apac.${modelId} instead (${change})`;
  if (region.startsWith("ca-") || region.startsWith("sa-")) {
    return `use the inference profile id listed in the Bedrock console for ${region} instead (${change})`;
  }
  return `use us.${modelId} instead (${change})`;
}

/** How modelCheckProblem's messages say to change a model and to try again. init's defaults name its
 * flags; agentx doctor names agentx config set (a model is changed there after install). */
export interface ModelProblemWording { changeModel: string; rerun: string; region: string }
const initWording = (role: ModelRole): ModelProblemWording => ({ changeModel: `--${role}-model`, rerun: "run agentx init again", region: "choose another region with --region" });
/** How a model problem reads on the page: what to do there, not a flag (spec 048 FR-027, FR-080). */
const pageWording = (): ModelProblemWording => ({ changeModel: "the model question", rerun: "choose Check again", region: "start again in another region" });

/** Turns a failed one-token Converse call into a message that says what to change, for the
 * failures a new account hits in practice (Review Focus 5): the Anthropic one-time usage form, a
 * model id that must be called through an inference profile, an id Bedrock does not recognize in
 * this region, access denied for some other reason, a throttled check, a timed-out check, and a
 * model that failed for no clear reason at all. Every branch ends by saying what to try next. */
export function modelCheckProblem(input: { modelId: string; role: ModelRole; region: string; error: unknown; wording?: ModelProblemWording }): string {
  const { modelId, role, region, error } = input;
  const wording = input.wording ?? initWording(role);
  const name = errorName(error);
  const message = errorMessage(error);
  if (endpointMissing(error)) return `Amazon Bedrock is not available in ${region}; ${wording.region}`;
  // Item 1: Bedrock reports the Anthropic one-time usage-form problem as AccessDeniedException in
  // some accounts and ResourceNotFoundException in others; only the message says which problem
  // this is, so it is checked before any check on the error's name.
  if (/use case/i.test(message)) {
    return `${modelId}: Anthropic models need a one-time usage form submitted in the Bedrock console. Open the Bedrock console in ${region}, Model catalog, choose the model and submit the form; submitting it in your organization's management account covers every member account. Then ${wording.rerun}`;
  }
  if (name === "ValidationException" && /on-demand throughput/i.test(message)) {
    return `${modelId} must be called through an inference profile in ${region}; ${inferenceProfileHint(modelId, region, wording.changeModel)}`;
  }
  if (name === "ResourceNotFoundException" || (name === "ValidationException" && /model identifier is invalid/i.test(message))) {
    return `${modelId} is not a Bedrock model id available in ${region}; check the id, or choose another with ${wording.changeModel}`;
  }
  if (name === "AccessDeniedException") {
    // Item 7: AWS retired the Bedrock console's "Model access" page (What's New, October 2025);
    // serverless models are enabled automatically in commercial regions, so a plain access denial
    // now means a role or SCP denies bedrock:InvokeModel, or (for a Marketplace model) the role
    // is missing aws-marketplace:Subscribe.
    return `${modelId}: this account or your credentials cannot call it in ${region} (${message}). Your role or an SCP may deny bedrock:InvokeModel for this model; for a Marketplace model, the role also needs aws-marketplace:Subscribe. Check your permissions, or choose another model with ${wording.changeModel}`;
  }
  if (name === "ThrottlingException") return `Bedrock throttled the check of ${modelId}; wait a minute and ${wording.rerun}`;
  // Item 2: awsPrerequisiteChecks' own withDeadline already builds this exact, complete message
  // (naming the model, the region, and what to try), so it is returned as-is rather than wrapped
  // a second time.
  if (name === "TimeoutError") return message;
  return `${modelId} did not answer a one-token test call in ${region}: ${message}; check your credentials or network, or choose another model with ${wording.changeModel}`;
}

function nodeVersionOk(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

/** Everything `agentx init` must confirm before it creates a single resource: the account and
 * region has EC2 capacity quota, each distinct model answers, the identity provider (when self-hosted)
 * agrees with itself, and the chosen engine's tooling is in place. Every problem found is collected
 * and reported together (FR-015): a person fixing an account should not have to run init five
 * times to hear about a fifth thing wrong each time. */
export async function checkPrerequisites(input: {
  answers: InitAnswers; release: ReleaseCoverage; caller: { account: string; arn: string };
  checks: PrerequisiteChecks; prompter: Prompter; write: (line: string) => void;
  openRouterKey?: PendingOpenRouterKey;
  /** The release's own images (FR-065); checked only when given, so a caller with no release
   * images to check (most existing callers and tests) sees no change at all. */
  images?: ReleaseImages;
  /** Who the problems collected below are written for. Default "terminal": the terminal's own
   * problems, flags and commands, exactly as before this spec. */
  audience?: CheckAudience;
  onCheck?: (check: PrerequisiteCheck) => void;
}): Promise<void> {
  const { answers, checks, write } = input;
  const { region } = answers;
  const audience: CheckAudience = input.audience ?? "terminal";
  const problems: string[] = [];
  // Each check is reported as it finishes (the page's checklist); the lines written and the
  // problems collected are exactly what they were before.
  const passed = (label: string, line: string) => { write(line); input.onCheck?.({ label, ok: true, detail: line.replace(/^ok /, "") }); };
  const failed = (label: string, problem: string, technical?: string) => {
    problems.push(problem);
    input.onCheck?.({ label, ok: false, detail: problem, ...(technical === undefined ? {} : { technical }) });
  };
  write(`AWS account ${input.caller.account} as ${input.caller.arn}`);
  write(DEDICATED_ACCOUNT_NOTE);

  // The same check and wording as agentx deploy's, collected with every other problem. The cdk
  // engine synthesizes its own templates for any region (issue 152), so only the templates engine needs it.
  if (answers.engine === "templates") {
    const regionProblem = releaseRegionProblem(input.release, region);
    if (regionProblem !== undefined) failed("Region", regionProblem); else input.onCheck?.({ label: "Region", ok: true, detail: `${region} is covered by this release` });
  }

  // FR-065, SC-009: the release's own images, checked before anything else that would create
  // something, so a release that cannot be pulled is refused alongside every other problem.
  if (input.images !== undefined) {
    for (const check of releaseImageChecks({ version: input.release.manifest.version, images: input.images, ...(answers.images === undefined ? {} : { overrides: answers.images }), audience })) {
      if (check.ok) input.onCheck?.(check);
      else failed(check.label, check.detail, check.technical);
    }
  }

  try {
    const quota = await checks.ec2Quota();
    if (!Number.isFinite(quota) || quota < 1) {
      failed("EC2 vCPU quota", `EC2 Standard on-demand vCPU quota in ${region} must be at least 1 for an m6g.medium worker; request an increase in Service Quotas`);
    } else passed("EC2 vCPU quota", `ok EC2 Standard on-demand vCPU quota is ${quota} in ${region}`);
  } catch (error) {
    failed("EC2 vCPU quota", `could not check EC2 vCPU quota in ${region}: ${errorMessage(error)}; check Service Quotas read permission and your network`);
  }

  // The foundation stack's NAT gateways fail five minutes in when the region is out of addresses.
  try {
    const { quota, allocated } = await checks.elasticIps();
    if (!Number.isFinite(quota) || !Number.isFinite(allocated)) throw new Error("the Elastic IP quota or address count did not return a number");
    const free = Math.max(0, quota - allocated);
    if (free < NAT_ELASTIC_IPS) {
      const command = `aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-0263D0A3 --desired-value ${allocated + NAT_ELASTIC_IPS} --region ${region}`;
      if (audience === "page") {
        failed("Elastic IPs", `this install needs ${NAT_ELASTIC_IPS} Elastic IPs for its network, but ${allocated} of the ${quota} allowed in ${region} are already in use. Release addresses you no longer use, or ask AWS for more EC2-VPC Elastic IPs in Service Quotas.`, command);
      } else {
        failed("Elastic IPs", `this environment needs ${NAT_ELASTIC_IPS} Elastic IPs for its NAT gateways, but ${allocated} of the ${quota} allowed in ${region} are already allocated. `
          + `Release addresses you no longer use, or raise the EC2-VPC Elastic IPs quota (L-0263D0A3) in Service Quotas: ${command}`);
      }
    } else passed("Elastic IPs", `ok ${free} of ${quota} EC2-VPC Elastic IPs free in ${region}; this environment needs ${NAT_ELASTIC_IPS}`);
  } catch (error) {
    failed("Elastic IPs", `could not check Elastic IPs in ${region}: ${errorMessage(error)}; check EC2 DescribeAddresses and Service Quotas read permission and your network`);
  }

  const roles: Array<[ModelRole, string]> = [
    ["orchestrator", answers.models.orchestrator],
    ["classifier", answers.models.classifier],
    ["worker", answers.models.worker],
  ];
  const seen = new Set<string>();
  for (const [role, modelId] of roles) {
    const provider = answers.models.providers?.[role] ?? "amazon-bedrock";
    const identifier = `${provider}/${modelId}`;
    if (seen.has(identifier)) continue;
    if (provider === "openrouter") {
      try {
        const pending = input.openRouterKey;
        if (!answers.models.openRouter && pending === undefined) {
          openRouterModel(modelId);
          throw new MissingOpenRouterSecret();
        }
        if (!checks.openRouter) throw new Error("OpenRouter check is not configured");
        if (answers.models.openRouter) await checks.openRouter(modelId, answers.models.openRouter);
        else if (pending !== undefined) await checks.openRouter(modelId, pending.providers === undefined ? {} : { providers: [...pending.providers] }, pending.key);
        seen.add(identifier);
        passed(`Model ${identifier}`, `ok ${identifier} supports tools and answers`);
      } catch (error) {
        if (error instanceof MissingOpenRouterSecret) {
          const fallback = defaultBedrockModel(role);
          try {
            const fallbackKey = `${fallback.provider}/${fallback.modelId}`;
            if (!seen.has(fallbackKey)) await checks.converse(fallback.modelId);
            seen.add(fallbackKey);
            passed(`Model ${identifier}`, `ok ${identifier}: OpenRouter secret missing; using default ${fallback.provider}/${fallback.modelId}`);
          } catch (fallbackError) {
            failed(`Model ${fallback.modelId}`, modelCheckProblem({ modelId: fallback.modelId, role, region, error: fallbackError, ...(audience === "page" ? { wording: pageWording() } : {}) }));
          }
        } else {
          failed(`Model ${identifier}`, `${identifier}: OpenRouter preflight failed; check the model's tool support, secret read permission, key credits and routing allowlist`);
        }
      }
      continue;
    }
    seen.add(identifier);
    try {
      try {
        await checks.converse(modelId);
      } catch (error) {
        if (errorName(error) !== "ThrottlingException") throw error;
        await checks.sleep(2000);
        await checks.converse(modelId);
      }
      passed(`Model ${modelId}`, `ok ${modelId} answers`);
    } catch (error) {
      failed(`Model ${modelId}`, modelCheckProblem({ modelId, role, region, error, ...(audience === "page" ? { wording: pageWording() } : {}) }));
    }
  }

  // On the page, "check --oidc-issuer" names a terminal flag nobody can type there; the page's own
  // words say where to fix it instead (spec 048 FR-027, FR-080).
  const forAudience = (message: string) => (audience === "page" ? message.replace(/; check --oidc-issuer$/, "; check the sign-in issuer address") : message);
  if (answers.identity.mode === "oidc") {
    const issuer = answers.identity.issuer.replace(/\/$/, "");
    const url = `${issuer}/.well-known/openid-configuration`;
    try {
      const document = (await checks.oidcDiscovery(answers.identity.issuer)) as { issuer?: unknown };
      const named = typeof document.issuer === "string" ? document.issuer.replace(/\/$/, "") : undefined;
      // Item 6: name a next step for a mismatched issuer too.
      if (named !== issuer) failed("OIDC discovery", forAudience(`the OIDC discovery document at ${url} names issuer ${named ?? "nothing"}, not ${issuer}; check --oidc-issuer`));
      else passed("OIDC discovery", `ok OIDC discovery at ${url}`);
    } catch (error) {
      // Item 3: awsPrerequisiteChecks' own oidcDiscovery already builds a complete message (naming
      // the issuer/URL and saying to check --oidc-issuer) for every failure it can throw, so it is
      // reported as-is rather than wrapped a second time.
      failed("OIDC discovery", forAudience(errorMessage(error)));
    }
  }

  let needsBootstrap = false;
  if (answers.engine === "cdk") {
    // A passing Node, npx or bootstrap check writes no line, as before; the page still lists it.
    const node = await checks.commandVersion("node");
    if (node === undefined || !nodeVersionOk(node)) failed("Node", `the cdk engine needs Node 22.19 or later (found ${node?.trim() ?? "no node"})`);
    else input.onCheck?.({ label: "Node", ok: true, detail: `Node ${node.trim()}` });
    const npx = await checks.commandVersion("npx");
    if (npx === undefined) failed("npx", "the cdk engine needs npx (it comes with npm)");
    else input.onCheck?.({ label: "npx", ok: true, detail: `npx ${npx.trim()}` });
    let bootstrapRead = false;
    try {
      needsBootstrap = !(await checks.cdkBootstrapped());
      bootstrapRead = true;
    } catch (error) {
      // Item 4: a failed read of the bootstrap parameter (anything other than "not bootstrapped",
      // which cdkBootstrapped() already turns into `false`) is one more collected problem, not an
      // early abort: every other check still runs, and cdk bootstrap is not offered this run.
      failed("CDK bootstrap", `could not check CDK bootstrap: ${errorMessage(error)}; check your credentials can read SSM`);
    }
    // Outside the try: a failing page callback is never reported as a failed bootstrap read.
    if (bootstrapRead && !needsBootstrap) input.onCheck?.({ label: "CDK bootstrap", ok: true, detail: `CDK is bootstrapped in ${region}` });
  }

  // cdk bootstrap creates the CDKToolkit stack (Review Focus 5's sibling concern): offered only
  // once every other check has passed, so init never asks to create something before it is sure
  // nothing else is going to stop the run anyway.
  if (needsBootstrap && problems.length === 0) {
    const target = `aws://${answers.account}/${region}`;
    write(`CDK is not bootstrapped in ${region}. cdk bootstrap creates the CDKToolkit stack (an S3 bucket, an ECR repository and deploy roles) that the cdk engine needs.`);
    if (await input.prompter.confirm(`Run cdk bootstrap ${target} now?`, { defaultValue: false })) {
      await checks.runCdkBootstrap();
      passed("CDK bootstrap", `ok CDK bootstrapped in ${region}`);
    } else if (audience === "page") {
      failed("CDK bootstrap", "This region is not prepared for deploying from source code. Prepare it, or deploy with published templates, which need no preparation.");
    } else {
      failed("CDK bootstrap", `CDK is not bootstrapped in ${region}; run npx cdk bootstrap ${target}, or use --engine templates, which needs no bootstrap`);
    }
  }

  if (problems.length > 0) {
    throw agentXError("CONFIG_INVALID", `init cannot start; nothing was created:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

// Item 2: `maxAttempts: 1` turns off the SDK's own retry loop (checkPrerequisites already retries
// once on throttling, so the call is attempted at most twice in total, not up to 2 x 3), and the
// request handler's own timeouts bound a single attempt well inside CONVERSE_DEADLINE_MS below.
export const CONVERSE_CLIENT_MAX_ATTEMPTS = 1;
export const CONVERSE_REQUEST_HANDLER_OPTIONS = { requestTimeout: 15_000, connectionTimeout: 5_000 } as const;
const CONVERSE_DEADLINE_MS = 20_000;
const OIDC_DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Races `run(signal)` against a `ms` deadline: if the deadline wins, the signal handed to `run` is
 * aborted and the returned promise rejects with a `TimeoutError` carrying `message`. Uses a plain
 * `setTimeout` (not the native, non-fake-timer-friendly `AbortSignal.timeout`) so a hung call fails
 * clearly and deterministically instead of hanging `agentx init` forever, and so this is directly
 * testable with fake timers and a `run` that never resolves.
 */
export async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, message: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error(message), { name: "TimeoutError" }));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function awsPrerequisiteChecks(input: { region: string; account: string; store: ParameterStore; runner: CommandRunner; fetch: typeof fetch }): PrerequisiteChecks {
  const bedrock = new BedrockRuntimeClient({
    region: input.region,
    maxAttempts: CONVERSE_CLIENT_MAX_ATTEMPTS,
    requestHandler: new NodeHttpHandler(CONVERSE_REQUEST_HANDLER_OPTIONS),
  });
  const quotas = new ServiceQuotasClient({ region: input.region });
  const ec2 = new EC2Client({ region: input.region });
  return {
    async openRouter(modelId, config, suppliedKey) {
      openRouterModel(modelId);
      const key = suppliedKey ?? await readOpenRouterKey(config.secretArn ?? "");
      const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
      await withDeadline(async (signal) => {
        const catalog = await input.fetch("https://openrouter.ai/api/v1/models", { headers, signal });
        if (!catalog.ok) throw new Error("model catalog unavailable");
        const body = await catalog.json() as { data?: Array<{ id: string; supported_parameters?: string[] }> };
        if (!body.data?.some((model) => model.id === modelId && model.supported_parameters?.includes("tools"))) throw new Error("model must support tools");
        const response = await input.fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST", headers, signal,
          body: JSON.stringify({ model: modelId, max_tokens: 16, messages: [{ role: "user", content: "Reply OK." }],
            tools: [{ type: "function", function: { name: "ping", description: "Return OK", parameters: { type: "object", properties: {} } } }],
            provider: openRouterRouting({ AGENTX_OPENROUTER_PROVIDERS: config.providers?.join(",") ?? "" }),
          }),
        });
        if (!response.ok) throw new Error("model check failed");
        const result = await response.json() as { choices?: unknown[]; error?: unknown };
        if (result.error || !result.choices?.length) throw new Error("model returned no completion");
      }, CONVERSE_DEADLINE_MS, "OpenRouter preflight timed out");
    },
    async converse(modelId) {
      await withDeadline(
        (signal) => bedrock.send(new ConverseCommand({ modelId, messages: [{ role: "user", content: [{ text: "Reply with OK." }] }], inferenceConfig: { maxTokens: 1 } }), { abortSignal: signal }),
        CONVERSE_DEADLINE_MS,
        `${modelId} did not answer a one-token test call in ${input.region} within ${CONVERSE_DEADLINE_MS / 1000}s; check your credentials or network, or try again`,
      );
    },
    async ec2Quota() {
      const response = await quotas.send(new GetServiceQuotaCommand({ ServiceCode: "ec2", QuotaCode: "L-1216C47A" }));
      return response.Quota?.Value ?? 0;
    },
    async elasticIps() {
      const [quota, addresses] = await Promise.all([
        quotas.send(new GetServiceQuotaCommand({ ServiceCode: "ec2", QuotaCode: "L-0263D0A3" })),
        ec2.send(new DescribeAddressesCommand({ Filters: [{ Name: "domain", Values: ["vpc"] }] })),
      ]);
      const value = quota.Quota?.Value;
      if (typeof value !== "number") throw new Error("the Elastic IP quota L-0263D0A3 did not return a number");
      return { quota: value, allocated: addresses.Addresses?.length ?? 0 };
    },
    async commandVersion(command) {
      try {
        return (await input.runner.run(command, ["--version"], { cwd: process.cwd(), display: `${command} --version` })).stdout;
      } catch {
        return undefined;
      }
    },
    async cdkBootstrapped() {
      try {
        await assertCdkBootstrapped({ store: input.store, region: input.region });
        return true;
      } catch (error) {
        // F11: assertCdkBootstrapped throws this one AgentXError only when the bootstrap
        // parameter itself was not found (never bootstrapped); every other failure it can throw
        // (access denied, throttled, any other read error) is a plain Error that already carries
        // its own context, and must be rethrown rather than read as "not bootstrapped" (reading it
        // that way would send someone to run cdk bootstrap when what actually needs fixing is
        // their credentials).
        if (error instanceof AgentXError && error.code === "CONFIG_INVALID" && /is not bootstrapped/.test(error.message)) return false;
        throw error;
      }
    },
    async runCdkBootstrap() {
      const target = `aws://${input.account}/${input.region}`;
      await input.runner.run("npx", ["cdk", "bootstrap", target], { cwd: process.cwd(), display: `npx cdk bootstrap ${target}` });
    },
    async oidcDiscovery(issuer) {
      // Item 3: bounded with its own deadline, parses the body itself (rather than trusting
      // `response.json()`'s own error, which does not name the issuer), and every failure names
      // the issuer/URL and says to check --oidc-issuer.
      const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
      let response: Response;
      try {
        response = await input.fetch(url, { signal: AbortSignal.timeout(OIDC_DISCOVERY_TIMEOUT_MS) });
      } catch (error) {
        const detail = errorName(error) === "TimeoutError" ? `did not answer within ${OIDC_DISCOVERY_TIMEOUT_MS / 1000}s` : errorMessage(error);
        throw new Error(`could not reach the OIDC discovery document at ${url} (${detail}); check --oidc-issuer`, { cause: error });
      }
      if (!response.ok) throw new Error(`the OIDC discovery document at ${url} answered HTTP ${response.status}; check --oidc-issuer`);
      const text = await response.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`the OIDC discovery document at ${url} is not valid JSON; check --oidc-issuer`);
      }
    },
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  };
}
