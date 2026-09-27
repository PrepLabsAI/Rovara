// Wires the deploy engines (templates-engine.ts, cdk-engine.ts), the deploy orchestrator
// (deploy-environment.ts) and the export bundle (export-bundle.ts) together for `agentx deploy` and
// `agentx init --export`. Everything that would otherwise touch AWS is overridable through
// `DeployCliDependencies` (main.ts's `CliDependencies.deploy`), the same seam the `env` commands use
// (`CliDependencies.environments`), so tests exercise the real wiring against fakes, never AWS.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";
import { agentXError, environmentStackName, EnvironmentNameSchema, STACK_PARTS, type StackPart } from "@agentx/contracts";
import type { CallerIdentity } from "../environments/adopt.js";
import { stsCallerIdentity } from "../environments/adopt.js";
import { ssmParameterStore, type ParameterStore } from "../environments/parameter-store.js";
import { assertCdkBootstrapped, assertSourceAtRelease, cdkDeployer, type CommandRunner } from "./cdk-engine.js";
import type { ChangeSetChange, DeployEvent, StackDeployer, StackOutputs } from "./deployer.js";
import { deployEnvironment, type DeployAnswers, type DeployEnvironmentResult } from "./deploy-environment.js";
import { writeExportBundle } from "./export-bundle.js";
import type { DeployPart } from "./parameters.js";
import { loadRelease } from "./release.js";
import { secretsManagerValueStore, type SecretValueStore } from "./signing-key.js";
import { templatesDeployer, type TemplatesEngineClients } from "./templates-engine.js";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface Writer {
  write(text: string): unknown;
}

export type ConfirmFn = (event: { stackName: string; changes: ChangeSetChange[] }) => Promise<boolean>;
export type Ask = (prompt: string) => Promise<string>;

/** Overrides for `agentx deploy` and `agentx init --export`, for tests: never touch AWS. */
export interface DeployCliDependencies {
  store?: ParameterStore;
  secrets?: SecretValueStore;
  /** sts GetCallerIdentity: the deploy lock's holder and (for the templates engine) the partition. */
  identity?: CallerIdentity;
  /** Overrides the whole deploy engine, bypassing the templates/cdk engine and any AWS client construction. */
  deployer?: StackDeployer;
  /** The cdk engine's shell-out, and `assertSourceAtRelease`'s git calls. */
  commandRunner?: CommandRunner;
  /** Overrides the interactive y/N confirmation entirely (and so skips the stdin-is-a-terminal check below). */
  confirm?: ConfirmFn;
  /** Overrides the "is stdin a terminal" check the built-in interactive confirm needs. */
  isInteractive?: () => boolean;
  now?: () => number;
}

// ---- DeployAnswersSchema: mirrors DeployAnswers (deploy-environment.ts), strict -----------------

const IdentityAnswersSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("cognito") }).strict(),
  z
    .object({
      mode: z.literal("oidc"),
      issuer: z.string().url(),
      audience: z.string().min(1),
      adminClaim: z.string().min(1).optional(),
      adminValues: z.array(z.string().min(1)).min(1).optional(),
      clientId: z.string().min(1).optional(),
    })
    .strict(),
]);

const GithubAnswersSchema = z
  .object({
    account: z.string().min(1),
    appId: z.string().min(1),
    installationId: z.string().min(1),
    privateKeySecretArn: z.string().min(1),
    credentialRef: z.string().min(1).optional(),
  })
  .strict();

const ModelsAnswersSchema = z.object({ orchestrator: z.string().min(1), classifier: z.string().min(1), worker: z.string().min(1) }).strict();

const ImagesAnswersSchema = z.object({ worker: z.string().min(1).optional(), slack: z.string().min(1).optional() }).strict();

/** Shared with `runInitExport`'s own `--region`/`--account` validation, so both commands refuse the
 * same malformed values the same way. */
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;
const ACCOUNT_PATTERN = /^\d{12}$/;

export const DeployAnswersSchema = z
  .object({
    env: EnvironmentNameSchema,
    region: z.string().regex(REGION_PATTERN, "region must look like us-east-1"),
    account: z.string().regex(ACCOUNT_PATTERN, "account must be a 12-digit AWS account id"),
    partition: z.string().min(1).optional(),
    models: ModelsAnswersSchema,
    identity: IdentityAnswersSchema,
    github: GithubAnswersSchema,
    permissionsBoundaryArn: z.string().min(1).optional(),
    operatorPrincipalArn: z.string().min(1).optional(),
    images: ImagesAnswersSchema.optional(),
  })
  .strict();

/** The first zod issue's path and message, so a schema failure always names the field. */
function firstIssueMessage(prefix: string, error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return `${prefix}: invalid`;
  return `${prefix}: ${issue.path.join(".")} ${issue.message}`.trim();
}

/** `DeployAnswersSchema`'s parsed shape, rebuilt into `DeployAnswers` field by field (rather than
 * trusted as-is) because zod's `.optional()` infers `T | undefined`, which `exactOptionalPropertyTypes`
 * treats as a different type than an absent `T`-typed optional key. */
function toDeployAnswers(parsed: z.infer<typeof DeployAnswersSchema>): DeployAnswers {
  return {
    env: parsed.env,
    region: parsed.region,
    account: parsed.account,
    ...(parsed.partition === undefined ? {} : { partition: parsed.partition }),
    models: parsed.models,
    identity:
      parsed.identity.mode === "cognito"
        ? { mode: "cognito" as const }
        : {
            mode: "oidc" as const,
            issuer: parsed.identity.issuer,
            audience: parsed.identity.audience,
            ...(parsed.identity.adminClaim === undefined ? {} : { adminClaim: parsed.identity.adminClaim }),
            ...(parsed.identity.adminValues === undefined ? {} : { adminValues: parsed.identity.adminValues }),
            ...(parsed.identity.clientId === undefined ? {} : { clientId: parsed.identity.clientId }),
          },
    github: {
      account: parsed.github.account,
      appId: parsed.github.appId,
      installationId: parsed.github.installationId,
      privateKeySecretArn: parsed.github.privateKeySecretArn,
      ...(parsed.github.credentialRef === undefined ? {} : { credentialRef: parsed.github.credentialRef }),
    },
    ...(parsed.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: parsed.permissionsBoundaryArn }),
    ...(parsed.operatorPrincipalArn === undefined ? {} : { operatorPrincipalArn: parsed.operatorPrincipalArn }),
    ...(parsed.images === undefined
      ? {}
      : {
          images: {
            ...(parsed.images.worker === undefined ? {} : { worker: parsed.images.worker }),
            ...(parsed.images.slack === undefined ? {} : { slack: parsed.images.slack }),
          },
        }),
  };
}

/** Reads and validates `--answers`, throwing CONFIG_INVALID naming the field on any failure (an
 * unreadable file, invalid JSON, or a schema mismatch). */
export async function loadDeployAnswers(path: string): Promise<DeployAnswers> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `could not read answers file ${path}: ${errorMessage(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw agentXError("CONFIG_INVALID", `answers file ${path} is not valid JSON`);
  }
  const parsed = DeployAnswersSchema.safeParse(json);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", firstIssueMessage(`answers file ${path} is invalid`, parsed.error));
  return toDeployAnswers(parsed.data);
}

/** `--parts a,b,c` into `DeployPart[]`, refusing an unknown part by name. `undefined` (the flag
 * omitted) means "the whole order for the mode", exactly as `DeployEnvironmentInput.parts` documents. */
export function parseParts(raw: string | undefined): DeployPart[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const invalid = names.find((name) => !STACK_PARTS.includes(name as StackPart));
  if (invalid !== undefined) throw agentXError("CONFIG_INVALID", `--parts names an unknown part ${invalid}; expected one of ${STACK_PARTS.join(", ")}`);
  return names as DeployPart[];
}

/** The partition segment of an ARN (`arn:<partition>:...`), as ruling (c) requires: the caller
 * identity's own ARN, never a separately-supplied value, so the templates engine's S3 host suffix
 * always matches the account actually deploying. */
export function partitionFromArn(arn: string): string {
  const match = /^arn:([^:]+):/.exec(arn);
  if (match?.[1] === undefined) throw agentXError("CONFIG_INVALID", `caller identity ARN ${arn} is not a valid ARN`);
  return match[1];
}

/** A plain progress line for one deploy event: its kind, the stack it concerns, and its outcome —
 * never a parameter value. `DeployEvent` itself carries no parameter value in any of its variants
 * (a "changes" event's entries are only action/logicalId/type/replacement), so this is safe by
 * construction, not just by omission. */
export function progressLine(event: DeployEvent): string {
  switch (event.kind) {
    case "uploading":
      return `uploading ${event.what}`;
    case "changes":
      return `changes ${event.stackName}: ${event.changes.length} change${event.changes.length === 1 ? "" : "s"}`;
    case "no-changes":
      return `no-changes ${event.stackName}`;
    case "deploying":
      return `deploying ${event.stackName}`;
    case "deployed":
      return `deployed ${event.stackName}`;
  }
}

// ---- the interactive y/N confirmation -----------------------------------------------------------

/** Reads one line from the real terminal, prompting on stderr (stdout is reserved for the command's
 * own JSON/plain result). */
export function readlineAsk(): Ask {
  return async (prompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  };
}

/** Prints a change set's changes (only action/logicalId/type/replacement — never a parameter value)
 * and asks y/N before executing it. */
export function interactiveConfirm(io: Writer, ask: Ask): ConfirmFn {
  return async (event) => {
    io.write(`Changes for ${event.stackName}:\n`);
    for (const change of event.changes) {
      io.write(`  ${change.action} ${change.logicalId} (${change.type})${change.replacement === "True" ? " [replacement]" : ""}\n`);
    }
    const answer = await ask(`Execute this change set for ${event.stackName}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
}

// ---- the real CommandRunner (ruling b) ----------------------------------------------------------

const STDERR_TAIL_LINES = 20;

function tail(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/**
 * Buffers `push`ed text to line boundaries before handing each complete line to `write` (redacted
 * first): a secret split across two `data` chunks with no newline between them is assembled here
 * before `redact` ever sees it, rather than redacted chunk-by-chunk (which would miss it). `flush`
 * hands over whatever partial line remains — a child that never writes a final newline (or dies
 * mid-line) must still have its last line redacted, not silently dropped or left un-redacted.
 */
function lineBufferedRedactor(write: (text: string) => void, redact: (text: string) => string): { push(chunk: string): void; flush(): void } {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
        write(redact(pending.slice(0, index + 1)));
        pending = pending.slice(index + 1);
      }
    },
    flush() {
      if (pending === "") return;
      write(redact(pending));
      pending = "";
    },
  };
}

/**
 * Shells out with `node:child_process` `spawn` (`shell: false`), streaming the child's own stdout
 * and stderr to `stderr` as it runs — redacted through `options.redact`, buffered to line boundaries
 * so a secret split across two `data` chunks is still caught (a verbose cdk run, `-v`/`--debug`/
 * `CDK_DEBUG`, can log a CreateChangeSet call's parameters, including the callback signing key) —
 * and resolving with the captured (unredacted; this value is never printed, only read back by our
 * own code, e.g. `assertSourceAtRelease`'s git output) stdout once it exits cleanly.
 *
 * On a non-zero exit, throws an error naming the exit code, `options.display` (never the raw argv,
 * which can carry the cdk engine's callback-signing-key parameter) and the last ~20 lines of stderr,
 * run through `options.redact` — the same redaction `options.display` itself was already built with.
 * A failure to even start the child (e.g. the executable is missing) is wrapped the same way: the
 * raw spawn error's `spawnargs` property carries the same unredacted argv, so it is never surfaced
 * as-is.
 */
export function realCommandRunner(stderr: Writer): CommandRunner {
  return {
    run(command, args, options) {
      return new Promise((resolvePromise, reject) => {
        const redact = options.redact ?? ((text: string) => text);
        const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderrBuffer = "";
        const stdoutStream = lineBufferedRedactor((text) => stderr.write(text), redact);
        const stderrStream = lineBufferedRedactor((text) => stderr.write(text), redact);
        child.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stdout += text;
          stdoutStream.push(text);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderrBuffer += text;
          stderrStream.push(text);
        });
        child.on("error", (error) => reject(new Error(`${options.display} could not start: ${errorMessage(error)}`)));
        child.on("close", (code) => {
          stdoutStream.flush();
          stderrStream.flush();
          if (code === 0) {
            resolvePromise({ stdout });
            return;
          }
          const tailed = tail(redact(stderrBuffer), STDERR_TAIL_LINES);
          reject(new Error(`${options.display} exited with code ${code ?? "unknown"}${tailed === "" ? "" : `:\n${tailed}`}`));
        });
      });
    },
  };
}

// ---- reading a stack's outputs directly, for the cdk engine's StackDeployer.outputs -------------

function isStackAbsentError(error: unknown): boolean {
  return error instanceof Error && error.name === "ValidationError" && /does not exist/.test(error.message);
}

export function cloudFormationOutputsReader(client: CloudFormationClient): (stackName: string) => Promise<StackOutputs | undefined> {
  return async (stackName) => {
    let stack;
    try {
      const { Stacks } = await client.send(new DescribeStacksCommand({ StackName: stackName }));
      stack = Stacks?.[0];
    } catch (error) {
      if (isStackAbsentError(error)) return undefined;
      throw error;
    }
    if (stack === undefined) return undefined;
    const outputs: StackOutputs = {};
    for (const output of stack.Outputs ?? []) {
      if (output.OutputKey !== undefined && output.OutputValue !== undefined) outputs[output.OutputKey] = output.OutputValue;
    }
    return outputs;
  };
}

// ---- the templates engine's artifactBucket (ruling d) -------------------------------------------

/**
 * Wraps the real `templatesDeployer` so its lazy `artifactBucket` closure can be synchronous (as
 * `templatesDeployer` requires) while still reflecting the access stack's real output: this deployer
 * opportunistically captures the access stack's outputs from every `deploy`/`outputs` call that
 * happens to carry them (whether this run deployed access itself, or `deployEnvironment` merely read
 * an already-installed access stack's outputs while resuming or upgrading), and throws a clear error
 * if `artifactBucket` is ever needed before that has happened.
 */
function buildTemplatesDeployer(input: { clients: TemplatesEngineClients; env: string; region: string; partition: string; release: Parameters<typeof templatesDeployer>[0]["release"] }): StackDeployer {
  let accessOutputs: StackOutputs | undefined;
  const accessStackName = environmentStackName(input.env, "access");
  const raw = templatesDeployer({
    clients: input.clients,
    release: input.release,
    env: input.env,
    region: input.region,
    partition: input.partition,
    artifactBucket: () => {
      const bucket = accessOutputs?.ArtifactBucketName;
      if (bucket === undefined) {
        throw agentXError("CONFIG_INVALID", "the access stack's ArtifactBucketName output is not yet known; deploy the access stack first");
      }
      return bucket;
    },
  });
  return {
    async deploy(request) {
      const result = await raw.deploy(request);
      if (request.part === "access") accessOutputs = result;
      return result;
    },
    async outputs(stackName) {
      const result = await raw.outputs(stackName);
      if (stackName === accessStackName && result !== undefined) accessOutputs = result;
      return result;
    },
  };
}

// ---- agentx deploy -------------------------------------------------------------------------------

export interface DeployCommandOptions {
  mode: "install" | "upgrade";
  engine: "templates" | "cdk";
  releaseDir: string;
  answersFile: string;
  parts?: string;
  source?: string;
  yes: boolean;
  /** The global `--env`, but only when it was actually given on the command line (main.ts checks
   * this with commander's option-value-source API); omitted, the answers file's own `env` is
   * authoritative and nothing is cross-checked. */
  expectedEnv?: string;
}

export interface DeployCommandServices {
  stderr: Writer;
}

export async function runDeploy(options: DeployCommandOptions, deps: DeployCliDependencies, services: DeployCommandServices): Promise<DeployEnvironmentResult & { env: string }> {
  if (options.engine === "cdk" && options.source === undefined) {
    throw agentXError("CONFIG_INVALID", "--source is required for --engine cdk");
  }
  if (!options.yes && options.engine === "cdk") {
    throw agentXError("CONFIG_INVALID", "--engine cdk has no change set review; pass --yes to deploy with cdk");
  }

  const answers = await loadDeployAnswers(options.answersFile);
  if (options.expectedEnv !== undefined && options.expectedEnv !== answers.env) {
    throw agentXError("CONFIG_INVALID", `--env ${options.expectedEnv} does not match the answers file's environment ${answers.env}`);
  }
  const parts = parseParts(options.parts);
  const release = await loadRelease(options.releaseDir);

  let confirm: ConfirmFn | undefined;
  if (!options.yes) {
    if (deps.confirm !== undefined) {
      confirm = deps.confirm;
    } else {
      const interactive = (deps.isInteractive ?? (() => process.stdin.isTTY === true))();
      if (!interactive) throw agentXError("CONFIG_INVALID", "agentx deploy needs --yes when stdin is not a terminal");
      confirm = interactiveConfirm(services.stderr, readlineAsk());
    }
  }

  const identity = deps.identity ?? stsCallerIdentity(new STSClient({ region: answers.region }));
  const caller = await identity.get();
  const holder = caller.arn;
  const partition = partitionFromArn(caller.arn);
  if (answers.partition !== undefined && answers.partition !== partition) {
    throw agentXError(
      "CONFIG_INVALID",
      `the answers file declares partition ${answers.partition}, but the caller identity's own ARN (${caller.arn}) is in partition ${partition}`,
    );
  }

  const store = deps.store ?? ssmParameterStore(new SSMClient({ region: answers.region }));
  const secrets = deps.secrets ?? secretsManagerValueStore(new SecretsManagerClient({ region: answers.region }));

  let deployer: StackDeployer;
  let cdkOutputsDir: string | undefined;
  if (deps.deployer !== undefined) {
    deployer = deps.deployer;
  } else if (options.engine === "cdk") {
    // The engine==="cdk"+no-source guard above already refused when this is undefined.
    const source = options.source as string;
    const runner = deps.commandRunner ?? realCommandRunner(services.stderr);
    await assertSourceAtRelease({ runner, source, version: release.manifest.version });
    await assertCdkBootstrapped({ store, region: answers.region });
    cdkOutputsDir = await mkdtemp(join(tmpdir(), "agentx-cdk-outputs-"));
    deployer = cdkDeployer({
      runner,
      source,
      env: answers.env,
      region: answers.region,
      identityMode: answers.identity.mode,
      outputsDir: cdkOutputsDir,
      outputs: cloudFormationOutputsReader(new CloudFormationClient({ region: answers.region })),
    });
  } else {
    const clients: TemplatesEngineClients = { cloudFormation: new CloudFormationClient({ region: answers.region }), s3: new S3Client({ region: answers.region }) };
    deployer = buildTemplatesDeployer({ clients, release, env: answers.env, region: answers.region, partition });
  }

  const onEvent = (event: DeployEvent) => services.stderr.write(`${progressLine(event)}\n`);

  try {
    const result = await deployEnvironment({
      mode: options.mode,
      engine: options.engine,
      answers,
      release,
      deployer,
      store,
      secrets,
      holder,
      ...(parts === undefined ? {} : { parts }),
      onEvent,
      ...(confirm === undefined ? {} : { confirm }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });

    return { ...result, env: answers.env };
  } finally {
    if (cdkOutputsDir !== undefined) await rm(cdkOutputsDir, { recursive: true, force: true });
  }
}

// ---- agentx init --export ------------------------------------------------------------------------

export interface InitExportOptions {
  env: string;
  dir: string;
  region: string;
  account?: string;
  releaseDir: string;
  identity: "cognito" | "oidc";
  oidcIssuer?: string;
  oidcAudience?: string;
  oidcClientId?: string;
  adminClaim?: string;
  /** Comma list, raw. */
  adminValues?: string;
  permissionsBoundaryArn?: string;
  operatorPrincipalArn?: string;
  orchestratorModel: string;
  classifierModel: string;
  workerModel: string;
}

export interface InitExportResult {
  dir: string;
  files: string[];
}

function buildIdentityAnswers(options: InitExportOptions): DeployAnswers["identity"] {
  if (options.identity === "cognito") return { mode: "cognito" };
  if (options.oidcIssuer === undefined || options.oidcAudience === undefined) {
    throw agentXError("CONFIG_INVALID", "--oidc-issuer and --oidc-audience are required with --identity oidc");
  }
  const adminValues = options.adminValues
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return {
    mode: "oidc",
    issuer: options.oidcIssuer,
    audience: options.oidcAudience,
    ...(options.adminClaim === undefined ? {} : { adminClaim: options.adminClaim }),
    ...(adminValues === undefined || adminValues.length === 0 ? {} : { adminValues }),
    ...(options.oidcClientId === undefined ? {} : { clientId: options.oidcClientId }),
  };
}

/** Writes the export bundle (export-bundle.ts). Makes no AWS call at all when `--account` is given;
 * otherwise reads (never writes) the caller's own account with sts GetCallerIdentity. Validates
 * `--region` and the account (whichever source it came from) with the same patterns
 * `DeployAnswersSchema` validates `agentx deploy`'s answers file with, since `writeExportBundle`
 * itself only ever refuses a region the release doesn't cover, not a malformed one. */
export async function runInitExport(options: InitExportOptions, deps: DeployCliDependencies): Promise<InitExportResult> {
  if (!REGION_PATTERN.test(options.region)) {
    throw agentXError("CONFIG_INVALID", `--region ${options.region} must look like us-east-1`);
  }
  const identityAnswers = buildIdentityAnswers(options);
  const account = options.account ?? (await (deps.identity ?? stsCallerIdentity(new STSClient({ region: options.region }))).get()).account;
  if (!ACCOUNT_PATTERN.test(account)) {
    throw agentXError("CONFIG_INVALID", `--account ${account} must be a 12-digit AWS account id`);
  }

  const answers: DeployAnswers = {
    env: options.env,
    region: options.region,
    account,
    models: { orchestrator: options.orchestratorModel, classifier: options.classifierModel, worker: options.workerModel },
    identity: identityAnswers,
    // The export bundle always replaces this with `{{github:...}}` markers (markerAnswers in
    // export-bundle.ts); the GitHub App is not set up until the operator configures it, phase 15d.
    github: { account: "", appId: "", installationId: "", privateKeySecretArn: "" },
    ...(options.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: options.permissionsBoundaryArn }),
    ...(options.operatorPrincipalArn === undefined ? {} : { operatorPrincipalArn: options.operatorPrincipalArn }),
  };

  const release = await loadRelease(options.releaseDir);
  const dir = resolve(options.dir);
  const result = await writeExportBundle({ dir, answers, release });
  return { dir, files: result.files };
}
