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
import { AgentXError, agentXError, environmentStackName, EnvironmentNameSchema, STACK_PARTS, type StackPart } from "@agentx/contracts";
import type { CallerIdentity } from "../environments/adopt.js";
import { cloudFormationStackReader, stsCallerIdentity } from "../environments/adopt.js";
import { ssmParameterStore, type ParameterStore } from "../environments/parameter-store.js";
import { settingsParameterName } from "../environments/settings.js";
import { ACCOUNT_PATTERN, BudgetAnswersSchema, IdentityAnswersSchema, ImagesAnswersSchema, ModelsAnswersSchema, REGION_PATTERN } from "./answer-schemas.js";
import { assertCdkBootstrapped, assertSourceAtRelease, buildSource, cdkDeployer, type CommandRunner } from "./cdk-engine.js";
import { synthDeclaredParameters } from "./cdk-source.js";
import type { ChangeSetChange, DeployEvent, StackDeployer, StackOutputs } from "./deployer.js";
import { deployEnvironment, type DeployAnswers, type DeployEnvironmentResult } from "./deploy-environment.js";
import { writeExportBundle } from "./export-bundle.js";
import { installOrder, type DeployPart } from "./parameters.js";
import { assertReleaseCoversRegion, loadRelease, type LoadedRelease } from "./release.js";
import { CALLBACK_SIGNING_KEY_BYTES, secretsManagerValueStore, type SecretValueStore } from "./signing-key.js";
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
  /** The cdk engine's stack-outputs reader (CloudFormation DescribeStacks by default). */
  stackOutputs?: (stackName: string) => Promise<StackOutputs | undefined>;
  /** The deployed stacks' parameters an upgrade keeps (DescribeStacks by default). */
  stackParameters?: (stackName: string) => Promise<Record<string, string> | undefined>;
  /** The templates engine's AWS clients (real CloudFormation and S3 clients by default). */
  templatesClients?: TemplatesEngineClients;
  /** Overrides the interactive y/N confirmation entirely (and so skips the stdin-is-a-terminal check below). */
  confirm?: ConfirmFn;
  /** Overrides the "is stdin a terminal" check the built-in interactive confirm needs. */
  isInteractive?: () => boolean;
  now?: () => number;
}

// ---- DeployAnswersSchema: mirrors DeployAnswers (deploy-environment.ts), strict -----------------
// Identity, models, images and the region/account patterns live in answer-schemas.ts, shared with
// `agentx init`'s own InitAnswersSchema (install-state.ts), so both answer files agree on what a
// valid region, account, identity, models or images answer looks like.

const GithubAnswersSchema = z
  .object({
    // Still accepted from answer files written before #123; the control plane no longer takes them.
    account: z.string().min(1).optional(),
    appId: z.string().min(1),
    installationId: z.string().min(1).optional(),
    privateKeySecretArn: z.string().min(1),
    credentialRef: z.string().min(1).optional(),
  })
  .strict();

/** Your own OIDC provider must name who administers AgentX (adminClaim and adminValues) and the
 * client `agentx login` uses (clientId): without them the deploy either grants nobody admin or
 * never writes environment settings, so the answers file is refused before anything is deployed. */
function requireOidcAdminAndClient(answers: { identity: z.infer<typeof IdentityAnswersSchema> }, context: z.RefinementCtx): void {
  if (answers.identity.mode !== "oidc") return;
  const identity = answers.identity;
  if (identity.adminClaim === undefined) {
    context.addIssue({ code: "custom", path: ["identity", "adminClaim"], message: "is required with your own OIDC provider" });
  }
  if (identity.adminValues === undefined) {
    context.addIssue({ code: "custom", path: ["identity", "adminValues"], message: "is required with your own OIDC provider" });
  }
  if (identity.clientId === undefined) {
    context.addIssue({ code: "custom", path: ["identity", "clientId"], message: "is required with your own OIDC provider (agentx login needs it)" });
  }
}

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
    slackAppPostedMessages: z.enum(["accept", "ignore"]).optional(),
    budget: BudgetAnswersSchema.optional(),
  })
  .strict()
  .superRefine(requireOidcAdminAndClient);

/** The first zod issue's path and message, so a schema failure always names the field. */
function firstIssueMessage(prefix: string, error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return `${prefix}: invalid`;
  return `${prefix}: ${issue.path.join(".")} ${issue.message}`.trim();
}

// Parsed answers are rebuilt into `DeployAnswers` field by field (rather than trusted as-is) because
// zod's `.optional()` infers `T | undefined`, which `exactOptionalPropertyTypes` treats as a different
// type than an absent `T`-typed optional key. The identity and images rebuilds are shared with
// `agentx init` (../init/deploy-steps.ts), whose saved answers use the same schemas.

/** A parsed identity answer (answer-schemas.ts's IdentityAnswersSchema) as `DeployAnswers["identity"]`. */
export function deployIdentityAnswers(identity: z.infer<typeof IdentityAnswersSchema>): DeployAnswers["identity"] {
  if (identity.mode === "cognito") return { mode: "cognito" };
  return {
    mode: "oidc",
    issuer: identity.issuer,
    audience: identity.audience,
    ...(identity.adminClaim === undefined ? {} : { adminClaim: identity.adminClaim }),
    ...(identity.adminValues === undefined ? {} : { adminValues: identity.adminValues }),
    ...(identity.clientId === undefined ? {} : { clientId: identity.clientId }),
  };
}

/** A parsed images answer as `DeployAnswers["images"]`, or undefined when there is none. */
export function deployImagesAnswers(images: { worker?: string | undefined; slack?: string | undefined } | undefined): DeployAnswers["images"] {
  if (images === undefined) return undefined;
  return {
    ...(images.worker === undefined ? {} : { worker: images.worker }),
    ...(images.slack === undefined ? {} : { slack: images.slack }),
  };
}

function toDeployAnswers(parsed: z.infer<typeof DeployAnswersSchema>): DeployAnswers {
  const images = deployImagesAnswers(parsed.images);
  return {
    env: parsed.env,
    region: parsed.region,
    account: parsed.account,
    ...(parsed.partition === undefined ? {} : { partition: parsed.partition }),
    models: parsed.models,
    identity: deployIdentityAnswers(parsed.identity),
    github: {
      ...(parsed.github.account === undefined ? {} : { account: parsed.github.account }),
      appId: parsed.github.appId,
      ...(parsed.github.installationId === undefined ? {} : { installationId: parsed.github.installationId }),
      privateKeySecretArn: parsed.github.privateKeySecretArn,
      ...(parsed.github.credentialRef === undefined ? {} : { credentialRef: parsed.github.credentialRef }),
    },
    ...(parsed.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: parsed.permissionsBoundaryArn }),
    ...(parsed.operatorPrincipalArn === undefined ? {} : { operatorPrincipalArn: parsed.operatorPrincipalArn }),
    ...(images === undefined ? {} : { images }),
    ...(parsed.slackAppPostedMessages === undefined ? {} : { slackAppPostedMessages: parsed.slackAppPostedMessages }),
    ...(parsed.budget === undefined ? {} : { budget: parsed.budget }),
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
 * (a "changes" event's entries are only action/logicalId/type/replacement, and a "kept" event names
 * parameters without their values), so this is safe by
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
    case "kept":
      return `kept ${event.stackName}: ${event.kept.join(", ") || "nothing"}${event.dropped.length === 0 ? "" : `; not in this release, so not sent: ${event.dropped.join(", ")}`}`;
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

/** CloudFormation's Replacement is "True", "Conditional" (it depends on a value only known at
 * deploy time) or "False"; both of the first two can replace the resource. */
function replacementFlag(replacement: string): string {
  if (replacement === "True") return " [replacement]";
  if (replacement === "Conditional") return " [replacement: conditional]";
  return "";
}

/** Prints a change set's changes (only action/logicalId/type/replacement — never a parameter value)
 * and asks y/N before executing it. */
export function interactiveConfirm(io: Writer, ask: Ask): ConfirmFn {
  return async (event) => {
    io.write(`Changes for ${event.stackName}:\n`);
    for (const change of event.changes) {
      io.write(`  ${change.action} ${change.logicalId} (${change.type})${replacementFlag(change.replacement)}\n`);
    }
    const answer = await ask(`Execute this change set for ${event.stackName}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
}

// ---- the real CommandRunner (ruling b) ----------------------------------------------------------

const STDERR_TAIL_LINES = 20;
/** A single unbroken line (no newline) is never buffered past this many characters: past it, we
 * force a cut rather than let a verbose or misbehaving child grow our own memory without bound. */
const MAX_PENDING_LENGTH = 64 * 1024;
/** The longest secret this runner ever redacts: a callback signing key, `CALLBACK_SIGNING_KEY_BYTES`
 * random bytes base64url-encoded (the one real source of truth for that length, so this can never
 * silently drift out of sync with it). A forced cut always keeps at least this many characters
 * unemitted, so a secret of this length is never split across the cut with only part of it ever
 * having reached `redact`. */
const MAX_SECRET_LENGTH = Buffer.alloc(CALLBACK_SIGNING_KEY_BYTES).toString("base64url").length;

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
 *
 * A single line that never ends (no newline, ever) would otherwise buffer without limit; past
 * `MAX_PENDING_LENGTH`, `push` forces a cut instead. It redacts the *whole* buffered line first —
 * so a secret entirely inside it is found and replaced regardless of where the cut below falls, and
 * a secret that has only partly arrived (so `redact` can't match it yet, since some of its
 * characters haven't been pushed) is left as raw text — then keeps at least `MAX_SECRET_LENGTH - 1`
 * trailing characters unemitted: exactly enough that a not-yet-complete secret, which can only be
 * that many characters long so far, is guaranteed to still be entirely in the retained tail, never
 * straddling the cut with part of it already written out.
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
      if (pending.length > MAX_PENDING_LENGTH) {
        const redacted = redact(pending);
        const cut = Math.max(0, redacted.length - (MAX_SECRET_LENGTH - 1));
        write(redacted.slice(0, cut));
        pending = redacted.slice(cut);
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
          if (options.quiet !== true) stdoutStream.push(text);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderrBuffer += text;
          stderrStream.push(text);
        });
        child.on("error", (error) => {
          // Symmetry with "close" below: anything already buffered (e.g. a child that wrote a
          // partial line, then failed for an unrelated reason) still gets redacted and flushed
          // out, rather than silently dropped.
          stdoutStream.flush();
          stderrStream.flush();
          reject(new Error(`${options.display} could not start: ${errorMessage(error)}`));
        });
        child.on("close", (code) => {
          stdoutStream.flush();
          stderrStream.flush();
          if (code === 0) {
            resolvePromise({ stdout, stderr: stderrBuffer });
            return;
          }
          const tailed = tail(redact(stderrBuffer), STDERR_TAIL_LINES);
          reject(new Error(`${options.display} exited with code ${code ?? "unknown"}${tailed === "" ? "" : `:\n${tailed}`}`));
        });
      });
    },
  };
}

/** A stack's current parameter values (NoEcho ones read back as "****" and are never used here: none
 * is in OPERATOR_PARAMETERS), or undefined when the stack does not exist. Built on
 * cloudFormationStackReader, which owns the absent-stack handling. */
export function cloudFormationParametersReader(client: CloudFormationClient): (stackName: string) => Promise<Record<string, string> | undefined> {
  const reader = cloudFormationStackReader(client);
  return async (stackName) => (await reader.describe(stackName))?.parameters;
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

// ---- AWS failures as CLI error codes -------------------------------------------------------------

const CREDENTIAL_ERROR_NAMES = new Set(["CredentialsProviderError", "InvalidClientTokenId", "UnrecognizedClientException", "SignatureDoesNotMatch"]);

function isCredentialFailure(error: Error): boolean {
  return CREDENTIAL_ERROR_NAMES.has(error.name) || error.name.startsWith("ExpiredToken") || /session has expired/i.test(error.message);
}

function isAccessDenied(error: Error): boolean {
  return error.name.startsWith("AccessDenied");
}

/** The error and every `cause` beneath it (bounded, in case of a cycle). */
function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && chain.length < 10; current = current.cause) chain.push(current);
  return chain;
}

/**
 * Gives an AWS failure the CLI error code that says what to do about it: missing or expired
 * credentials become AUTH_REQUIRED (sign in again) and an access denial FORBIDDEN (ask for the
 * permission), checked on the error and anything it wraps as a cause. The outermost message is
 * kept, since it carries our own context. An AgentXError keeps its own code; anything else is
 * returned unchanged.
 */
export function cliErrorFor(error: unknown): unknown {
  if (error instanceof AgentXError || !(error instanceof Error)) return error;
  const chain = causeChain(error);
  // agentXError takes no cause, so it is attached afterwards: the SDK error (request id, status) stays reachable.
  if (chain.some(isCredentialFailure)) return Object.assign(agentXError("AUTH_REQUIRED", `AWS credentials missing or expired: ${error.message}`), { cause: error });
  if (chain.some(isAccessDenied)) return Object.assign(agentXError("FORBIDDEN", `AWS denied the request: ${error.message}`), { cause: error });
  return error;
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

export type DeployCommandResult = DeployEnvironmentResult & {
  env: string;
  /** The install order's parts that exist after this run, and those that still do not. */
  deployedParts: DeployPart[];
  missingParts: DeployPart[];
};

/** The exact `agentx deploy` command that deploys `missingParts` with the same release, answers and engine. */
export function resumeCommand(options: DeployCommandOptions, missingParts: DeployPart[]): string {
  return [
    "agentx deploy --mode install",
    ...(options.engine === "cdk" ? [`--engine cdk --source ${options.source ?? "<source>"}`] : []),
    `--parts ${missingParts.join(",")}`,
    `--release ${options.releaseDir}`,
    `--answers ${options.answersFile}`,
    ...(options.yes ? ["--yes"] : []),
  ].join(" ");
}

export async function runDeploy(options: DeployCommandOptions, deps: DeployCliDependencies, services: DeployCommandServices): Promise<DeployCommandResult> {
  try {
    return await deployCommand(options, deps, services);
  } catch (error) {
    throw cliErrorFor(error);
  }
}

async function deployCommand(options: DeployCommandOptions, deps: DeployCliDependencies, services: DeployCommandServices): Promise<DeployCommandResult> {
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
  // The templates engine can only deploy the templates the release was built for; the cdk engine
  // synthesizes its own. Refused here, before the confirmation setup, the caller's identity, the
  // lock or the key (prepareDeployment checks it again for its other callers).
  if (options.engine === "templates") assertReleaseCoversRegion(release, answers.region);

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

  const prepared = await prepareDeployment({
    engine: options.engine,
    env: answers.env,
    region: answers.region,
    account: answers.account,
    ...(answers.partition === undefined ? {} : { partition: answers.partition }),
    identityMode: answers.identity.mode,
    release,
    ...(options.source === undefined ? {} : { source: options.source }),
    deps,
    stderr: services.stderr,
  });

  const onEvent = (event: DeployEvent) => services.stderr.write(`${progressLine(event)}\n`);

  try {
    const result = await deployEnvironment({
      mode: options.mode,
      engine: options.engine,
      answers,
      release,
      deployer: prepared.deployer,
      store: prepared.store,
      secrets: prepared.secrets,
      holder: prepared.holder,
      ...(parts === undefined ? {} : { parts }),
      deployedParameters: deps.stackParameters ?? cloudFormationParametersReader(new CloudFormationClient({ region: answers.region })),
      ...(prepared.declaredParameters === undefined ? {} : { declaredParameters: prepared.declaredParameters }),
      onEvent,
      ...(confirm === undefined ? {} : { confirm }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });

    const order = installOrder(answers.identity.mode);
    return {
      ...result,
      env: answers.env,
      deployedParts: order.filter((part) => result.outputs[part] !== undefined),
      missingParts: order.filter((part) => result.outputs[part] === undefined),
    };
  } finally {
    await prepared.cleanup();
  }
}

// ---- preparing a deployment: shared by agentx deploy and agentx init's deploy steps --------------

export interface PreparedDeployment {
  deployer: StackDeployer;
  store: ParameterStore;
  secrets: SecretValueStore;
  /** The caller's own ARN: the environment lock's holder. */
  holder: string;
  partition: string;
  /** The cdk engine's synth of its source: the parameter names each part's template declares
   * (issue 152), for deployEnvironment's declaredParameters. Undefined for the templates engine, which
   * reads them from the release's own templates, and when a test overrides the whole deployer. */
  declaredParameters?: (part: DeployPart) => ReadonlySet<string>;
  /** Removes the cdk engine's outputs directory; a no-op for templates. */
  cleanup(): Promise<void>;
}

/**
 * Everything `agentx deploy` does between loading the answers and calling deployEnvironment: the
 * region coverage check (templates engine), the caller's account and partition checks, the
 * parameter and secret stores, and the engine (cdk: the source checkout at the release tag, the
 * bootstrap check, the build and an outputs directory). `agentx init` builds its deployment here
 * too, once per run, so both commands refuse and deploy identically.
 */
export async function prepareDeployment(input: {
  engine: "templates" | "cdk";
  env: string;
  region: string;
  account: string;
  partition?: string;
  identityMode: "cognito" | "oidc";
  release: LoadedRelease;
  source?: string;
  deps: DeployCliDependencies;
  stderr: Writer;
}): Promise<PreparedDeployment> {
  const { deps, release, region } = input;
  if (input.engine === "templates") assertReleaseCoversRegion(release, region);

  const identity = deps.identity ?? stsCallerIdentity(new STSClient({ region }));
  const caller = await identity.get();
  if (caller.account !== input.account) {
    throw agentXError(
      "CONFIG_INVALID",
      `the answers file names account ${input.account}, but the AWS credentials in use belong to account ${caller.account}; use credentials for ${input.account} or fix the answers file`,
    );
  }
  const holder = caller.arn;
  const partition = partitionFromArn(caller.arn);
  if (input.partition !== undefined && input.partition !== partition) {
    throw agentXError(
      "CONFIG_INVALID",
      `the answers file declares partition ${input.partition}, but the caller identity's own ARN (${caller.arn}) is in partition ${partition}`,
    );
  }

  const store = deps.store ?? ssmParameterStore(new SSMClient({ region }));
  const secrets = deps.secrets ?? secretsManagerValueStore(new SecretsManagerClient({ region }));

  let deployer: StackDeployer;
  let cdkOutputsDir: string | undefined;
  let declaredParameters: PreparedDeployment["declaredParameters"];
  if (deps.deployer !== undefined) {
    deployer = deps.deployer;
  } else if (input.engine === "cdk") {
    const source = input.source;
    if (source === undefined) throw agentXError("CONFIG_INVALID", "--source is required for --engine cdk");
    const runner = deps.commandRunner ?? realCommandRunner(input.stderr);
    await assertSourceAtRelease({ runner, source, version: release.manifest.version });
    await assertCdkBootstrapped({ store, region });
    // After the cheap checks, before any cdk deploy: infra/dist is gitignored, so only a fresh
    // install and build guarantees `cdk deploy` synthesizes the tagged source.
    await buildSource({ runner, source });
    // Issue 152: one synth of the built source, with the deploy's own app and context, says which
    // parameters each stack declares; the release's templates may not exist (a source-built agentx).
    declaredParameters = await synthDeclaredParameters({ runner, source, env: input.env, region, identityMode: input.identityMode });
    cdkOutputsDir = await mkdtemp(join(tmpdir(), "agentx-cdk-outputs-"));
    deployer = cdkDeployer({
      runner,
      source,
      env: input.env,
      region,
      identityMode: input.identityMode,
      outputsDir: cdkOutputsDir,
      outputs: deps.stackOutputs ?? cloudFormationOutputsReader(new CloudFormationClient({ region })),
    });
  } else {
    const clients: TemplatesEngineClients = deps.templatesClients ?? { cloudFormation: new CloudFormationClient({ region }), s3: new S3Client({ region }) };
    deployer = buildTemplatesDeployer({ clients, release, env: input.env, region, partition });
  }

  const outputsDir = cdkOutputsDir;
  return {
    deployer,
    store,
    secrets,
    holder,
    partition,
    ...(declaredParameters === undefined ? {} : { declaredParameters }),
    async cleanup() {
      if (outputsDir !== undefined) await rm(outputsDir, { recursive: true, force: true });
    },
  };
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
  orchestratorProvider?: string; classifierProvider?: string; workerProvider?: string;
  openrouterSecretArn?: string; openrouterProviders?: string;
}

export interface InitExportResult {
  dir: string;
  files: string[];
}

function buildIdentityAnswers(options: InitExportOptions): DeployAnswers["identity"] {
  if (options.identity === "cognito") return { mode: "cognito" };
  // The same fields DeployAnswersSchema requires of your own OIDC provider, refused by flag name.
  const adminValues = (options.adminValues ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const required: Array<[flag: string, value: string | undefined]> = [
    ["--oidc-issuer", options.oidcIssuer],
    ["--oidc-audience", options.oidcAudience],
    ["--oidc-client-id", options.oidcClientId],
    ["--admin-claim", options.adminClaim],
    ["--admin-values", adminValues.length === 0 ? undefined : adminValues.join(",")],
  ];
  const missing = required.find(([, value]) => value === undefined || value.trim() === "");
  if (missing !== undefined) throw agentXError("CONFIG_INVALID", `--identity oidc requires ${missing[0]}`);
  return {
    mode: "oidc",
    issuer: options.oidcIssuer as string,
    audience: options.oidcAudience as string,
    adminClaim: options.adminClaim as string,
    adminValues,
    clientId: options.oidcClientId as string,
  };
}

/** Writes the export bundle (export-bundle.ts). Makes two read-only AWS calls, so it needs
 * credentials for the target account: sts GetCallerIdentity (the account, which `--account`, when
 * given, must match), then that account's settings parameter in SSM (an environment already
 * installed there, production included, is refused). It writes nothing to AWS. Validates
 * `--region` and `--account` with the same patterns `DeployAnswersSchema` validates
 * `agentx deploy`'s answers file with, since `writeExportBundle` itself only ever refuses a region
 * the release doesn't cover, not a malformed one. */
export async function runInitExport(options: InitExportOptions, deps: DeployCliDependencies): Promise<InitExportResult> {
  try {
    return await initExport(options, deps);
  } catch (error) {
    throw cliErrorFor(error);
  }
}

async function initExport(options: InitExportOptions, deps: DeployCliDependencies): Promise<InitExportResult> {
  if (!REGION_PATTERN.test(options.region)) {
    throw agentXError("CONFIG_INVALID", `--region ${options.region} must look like us-east-1`);
  }
  const identityAnswers = buildIdentityAnswers(options);
  if (options.account !== undefined && !ACCOUNT_PATTERN.test(options.account)) {
    throw agentXError("CONFIG_INVALID", `--account ${options.account} must be a 12-digit AWS account id`);
  }
  // The settings check below reads the credentials' own account, so --account must be that account:
  // otherwise an installed environment (production included) in the exported account slips past.
  const account = (await (deps.identity ?? stsCallerIdentity(new STSClient({ region: options.region }))).get()).account;
  if (options.account !== undefined && options.account !== account) {
    throw agentXError("CONFIG_INVALID", `--account ${options.account} does not match your AWS credentials, which are for account ${account}; use credentials for ${options.account}, or leave --account off`);
  }
  if (!ACCOUNT_PATTERN.test(account)) {
    throw agentXError("CONFIG_INVALID", `--account ${account} must be a 12-digit AWS account id`);
  }
  // Spec decision (2026-09-27): any environment, production too, may be exported while nothing is
  // installed there. Any value at its settings parameter counts as installed (read-only).
  const store = deps.store ?? ssmParameterStore(new SSMClient({ region: options.region }));
  if ((await store.get(settingsParameterName(options.env))) !== undefined) {
    throw agentXError("CONFIG_INVALID", `environment ${options.env} is already installed in this account; export a bundle for a new --env`);
  }

  if (options.openrouterProviders && !options.openrouterSecretArn) throw agentXError("CONFIG_INVALID", "--openrouter-providers requires --openrouter-secret-arn");
  const answers: DeployAnswers = {
    env: options.env,
    region: options.region,
    account,
    models: ModelsAnswersSchema.parse({ orchestrator: options.orchestratorModel, classifier: options.classifierModel, worker: options.workerModel,
      ...(options.orchestratorProvider || options.classifierProvider || options.workerProvider ? { providers: {
        ...(options.orchestratorProvider ? { orchestrator: options.orchestratorProvider } : {}),
        ...(options.classifierProvider ? { classifier: options.classifierProvider } : {}),
        ...(options.workerProvider ? { worker: options.workerProvider } : {}),
      } } : {}),
      ...(options.openrouterSecretArn ? { openRouter: { secretArn: options.openrouterSecretArn, ...(options.openrouterProviders ? { providers: options.openrouterProviders.split(",") } : {}) } } : {}),
    }),
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
