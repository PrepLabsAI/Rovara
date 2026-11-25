// The pipeline-side "flip" of the permanent API address (DEC 254zzz505; conversion plan 5.5 step 6, plan rev 9.2).
//
// The address stack (infra/lib/api-address.ts) takes the control plane's API id as its one parameter, `ApiId`. Pointing the address at another API (the flip, and
// the flip-back) is ONE parameter update of that stack, run only through here, never as a hand-typed parameter. This creates a named change set with the new ApiId
// (previous template, every other parameter kept) and REFUSES, deleting the change set, unless it contains exactly one change: a Modify of the AWS::ApiGatewayV2::ApiMapping,
// in place (Replacement False), caused by the ApiId property alone. Anything else (a Replace, a second change, an Add or Remove, another resource) is refused.
//
//   tsx scripts/address-flip.ts (--env <environment> | --legacy) --api-id <new HTTP API id> [--region <r>] [--profile <p>] [--change-set-name <name>] [--execute]
//
// The stack is derived from the environment (agentx-<env>-address, or AgentXApiAddress for the legacy install), never taken free-form: another environment's address stack in the same
// account would otherwise pass every check. `--stack` is accepted only as a check, and only when it equals that derived name.
//
// Without --execute it creates and checks the change set, then leaves it for the pipeline's approval step (the name is printed); with --execute it also runs it and waits.
// UNVERIFIED (to be proved on a scratch stack before the first real flip): that the mapping's ApiId updates in place. If it is a replacement this REFUSES; and were the guard
// bypassed, the replacement would clash on the domain name and roll back, leaving the address mapped.
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { PUBLIC_API_ORIGIN_OUTPUT, publicApiAddressStackName } from "../packages/contracts/src/api-address.js";

// The CloudFormation shapes the flip reads (the `aws cloudformation ... --output json` documents). Local types on purpose: the public repository does not import the AWS SDK for CloudFormation;
// the flip calls the `aws` CLI, as the release scripts do.
export interface Change {
  Type?: string;
  ResourceChange?: {
    Action?: string;
    LogicalResourceId?: string;
    ResourceType?: string;
    Replacement?: string;
    Scope?: string[];
    Details?: Array<{ Target?: { Attribute?: string; Name?: string; RequiresRecreation?: string } }>;
  };
}
export interface Stack {
  StackName?: string;
  StackStatus?: string;
  Parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }>;
  Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
}
export interface DescribeChangeSetCommandOutput {
  Status?: string;
  StatusReason?: string;
  ExecutionStatus?: string;
  Parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }>;
  Changes?: Change[];
  NextToken?: string | undefined;
}
type Output = NonNullable<Stack["Outputs"]>[number];

/** The five calls the flip makes. A command is its name (the class name) and its CloudFormation API input; the port's `send` runs it. */
class FlipCommand<Input> {
  constructor(readonly input: Input) {}
}
export class DescribeStacksCommand extends FlipCommand<{ StackName: string }> {}
export class CreateChangeSetCommand extends FlipCommand<{
  StackName: string; ChangeSetName: string; ChangeSetType: "UPDATE"; UsePreviousTemplate: true; Description: string;
  Parameters: Array<{ ParameterKey: string; ParameterValue?: string; UsePreviousValue?: true }>;
}> {}
export class DescribeChangeSetCommand extends FlipCommand<{ StackName: string; ChangeSetName: string; NextToken?: string }> {}
export class ExecuteChangeSetCommand extends FlipCommand<{ StackName: string; ChangeSetName: string }> {}
export class DeleteChangeSetCommand extends FlipCommand<{ StackName: string; ChangeSetName: string }> {}

/** Runs a program with arguments and an environment and returns its standard output; throws on a non-zero exit. Tests pass a fake. */
export type RunProgram = (file: string, args: readonly string[], environment: NodeJS.ProcessEnv) => string;
const runProgram: RunProgram = (file, args, environment) => {
  try {
    return execFileSync(file, [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
};

/**
 * The port over the `aws` CLI: one attempt per call (AWS_MAX_ATTEMPTS=1, so a timed-out call is never silently repeated), no pager, JSON output, no shell (execFile). The flip's
 * own polling is the only retry. Every argument is a separate argv entry; the API id and names are checked against their patterns before they get here.
 */
export function awsCliCloudFormation(options: { region?: string | undefined; profile?: string | undefined; run?: RunProgram }): FlipCloudFormation {
  const run = options.run ?? runProgram;
  const environment: NodeJS.ProcessEnv = { ...process.env, AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "" };
  const common = ["--output", "json", "--no-cli-pager", ...(options.region === undefined ? [] : ["--region", options.region]), ...(options.profile === undefined ? [] : ["--profile", options.profile])];
  const call = (operation: string, args: readonly string[]): unknown => {
    const text = run("aws", ["cloudformation", operation, ...args, ...common], environment);
    return text.trim() === "" ? {} : JSON.parse(text);
  };
  return {
    async send(raw: unknown): Promise<unknown> {
      if (raw instanceof DescribeStacksCommand) return call("describe-stacks", ["--stack-name", raw.input.StackName]);
      if (raw instanceof CreateChangeSetCommand) {
        const input = raw.input;
        return call("create-change-set", [
          "--stack-name", input.StackName, "--change-set-name", input.ChangeSetName, "--change-set-type", input.ChangeSetType, "--use-previous-template", "--description", input.Description,
          "--parameters", ...input.Parameters.map((parameter) => `ParameterKey=${parameter.ParameterKey},${parameter.UsePreviousValue === true ? "UsePreviousValue=true" : `ParameterValue=${parameter.ParameterValue ?? ""}`}`),
        ]);
      }
      if (raw instanceof DescribeChangeSetCommand) {
        // The CLI follows the pages itself and returns every change; a continuation token is passed through only if a caller gives one.
        const input = raw.input;
        return call("describe-change-set", ["--stack-name", input.StackName, "--change-set-name", input.ChangeSetName, ...(input.NextToken === undefined ? [] : ["--no-paginate", "--starting-token", input.NextToken])]);
      }
      if (raw instanceof ExecuteChangeSetCommand) return call("execute-change-set", ["--stack-name", raw.input.StackName, "--change-set-name", raw.input.ChangeSetName]);
      if (raw instanceof DeleteChangeSetCommand) return call("delete-change-set", ["--stack-name", raw.input.StackName, "--change-set-name", raw.input.ChangeSetName]);
      throw new Error("unsupported CloudFormation command");
    },
  };
}

const API_ID_PATTERN = /^[a-z0-9]{10}$/u;
const CHANGE_SET_NAME_PATTERN = /^[a-zA-Z][-a-zA-Z0-9]{0,127}$/u;
const APIMAPPING_TYPE = "AWS::ApiGatewayV2::ApiMapping";
/** A stack that is not mid-operation and not stuck: a flip needs one that a plain update can start from. */
const UPDATABLE_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]);

/** The port the flip calls CloudFormation through: the `aws` CLI adapter below, or a fake that returns recorded responses. */
export interface FlipCloudFormation {
  send(command: unknown): Promise<unknown>;
}

export interface FlipDependencies {
  cloudFormation: FlipCloudFormation;
  /** Waits between polls; tests pass an immediate one. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** The clock, for the default change set name. */
  now?: () => number;
  /** Polls before giving up on a change set or an execution (default 120, five seconds apart). */
  maxPolls?: number;
}

export interface FlipInput {
  /** The install's environment name, or undefined for the legacy install: the address stack's name is derived from it. */
  env: string | undefined;
  /** Optional, and only a check: it must equal the stack name derived from `env`. */
  stackName?: string;
  /** The HTTP API id the address should point at. */
  apiId: string;
  changeSetName?: string;
  /** Run the change set after it passes the guard. */
  execute?: boolean;
}

export interface FlipResult {
  stackName: string;
  changeSetName: string;
  changeSetId: string;
  previousApiId: string;
  apiId: string;
  mappingLogicalId: string;
  executed: boolean;
}

/** Thrown when a change set fails the guard (and has been deleted) or the flip cannot start; `problems` says each reason. */
export class FlipRefused extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the address flip was refused:\n- ${problems.join("\n- ")}`);
    this.name = "FlipRefused";
  }
}

const describeChange = (change: Change): string => {
  const resource = change.ResourceChange;
  if (change.Type !== "Resource" || resource === undefined) return `a ${change.Type ?? "unknown"} change`;
  return `${resource.Action ?? "?"} ${resource.LogicalResourceId ?? "?"} (${resource.ResourceType ?? "?"}, Replacement ${resource.Replacement ?? "unset"})`;
};

type ResourceChange = NonNullable<Change["ResourceChange"]>;

/** The problems with which properties the one change touches: every one must be ApiId, changed in place. */
function detailProblems(resource: ResourceChange): string[] {
  const details = resource.Details ?? [];
  if (details.length === 0) return ["the change set does not say which property changes, so it cannot be shown to be ApiId alone"];
  return details.flatMap((detail) => {
    const target = detail.Target;
    if (target?.Attribute !== "Properties" || target.Name !== "ApiId") return [`the change targets ${target?.Attribute ?? "?"} ${target?.Name ?? "?"}, not the ApiId property`];
    return target.RequiresRecreation === "Never" ? [] : [`the ApiId change requires recreation (${target.RequiresRecreation ?? "unset"})`];
  });
}

/** The problems with the kind of the one change: an in-place Modify of the ApiMapping, of Properties alone. */
function kindProblems(resource: ResourceChange): string[] {
  const problems: string[] = [];
  if (resource.ResourceType !== APIMAPPING_TYPE) problems.push(`the one change is on ${resource.ResourceType ?? "an unknown resource type"}, not ${APIMAPPING_TYPE}`);
  if (resource.Action !== "Modify") problems.push(`the one change is ${resource.Action ?? "of unknown kind"}, not a Modify`);
  if (resource.Replacement !== "False") problems.push(`the ApiMapping change is not an in-place update (Replacement ${resource.Replacement ?? "unset"}); a replacement is never allowed`);
  const scope = resource.Scope ?? [];
  if (scope.length !== 1 || scope[0] !== "Properties") problems.push(`the change touches ${scope.length === 0 ? "an unknown scope" : scope.join(", ")}, not Properties alone`);
  return problems;
}

/**
 * Everything wrong with a change set as the flip's: empty means it is exactly one in-place Modify of the ApiMapping, caused by ApiId alone. Pure: the recorded change-set JSON
 * fixtures in tests/fixtures/address-flip drive it.
 */
export function flipChangeSetProblems(changes: readonly Change[]): string[] {
  if (changes.length !== 1) {
    return [`the change set has ${changes.length} changes, not exactly one: ${changes.length === 0 ? "nothing would change" : changes.map(describeChange).join("; ")}`];
  }
  const change = changes[0]!;
  const resource = change.ResourceChange;
  if (change.Type !== "Resource" || resource === undefined) return [`the one change is not a resource change (${describeChange(change)})`];
  return [...kindProblems(resource), ...detailProblems(resource)];
}

const outputOf = (stack: Stack, key: string): string | undefined => stack.Outputs?.find((output: Output) => output.OutputKey === key)?.OutputValue;
const parameterOf = (stack: Stack, key: string): string | undefined => stack.Parameters?.find((parameter) => parameter.ParameterKey === key)?.ParameterValue;

async function describeStack(cloudFormation: FlipCloudFormation, stackName: string): Promise<Stack> {
  const response = (await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))) as { Stacks?: Stack[] };
  const stack = response.Stacks?.[0];
  if (stack === undefined) throw new FlipRefused([`the stack ${stackName} was not found`]);
  return stack;
}

/** Every change of a change set, across pages, with its status. */
async function describeChangeSet(cloudFormation: FlipCloudFormation, stackName: string, changeSetName: string): Promise<DescribeChangeSetCommandOutput> {
  let nextToken: string | undefined;
  let first: DescribeChangeSetCommandOutput | undefined;
  const changes: Change[] = [];
  do {
    const page = (await cloudFormation.send(new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName, ...(nextToken === undefined ? {} : { NextToken: nextToken }) }))) as DescribeChangeSetCommandOutput;
    first ??= page;
    changes.push(...(page.Changes ?? []));
    nextToken = page.NextToken;
  } while (nextToken !== undefined);
  return { ...first, Changes: changes, NextToken: undefined };
}

async function waitFor<T>(poll: () => Promise<T>, done: (value: T) => boolean, deps: Required<Pick<FlipDependencies, "sleep" | "maxPolls">>, what: string): Promise<T> {
  for (let attempt = 0; attempt < deps.maxPolls; attempt += 1) {
    const value = await poll();
    if (done(value)) return value;
    await deps.sleep(5000);
  }
  throw new Error(`gave up waiting for ${what}`);
}

type Polling = Required<Pick<FlipDependencies, "sleep" | "maxPolls">>;

/** The refusals before anything is created: the stack is the environment's address stack, in a state a plain update can start from, and not already pointing at the new API. */
async function checkedAddressStack(cloudFormation: FlipCloudFormation, input: FlipInput): Promise<{ stackName: string; stack: Stack; previousApiId: string }> {
  let stackName: string;
  try {
    stackName = publicApiAddressStackName(input.env);
  } catch {
    throw new FlipRefused([`${JSON.stringify(input.env)} is not a valid environment name`]);
  }
  if (input.stackName !== undefined && input.stackName !== stackName) throw new FlipRefused([`${JSON.stringify(input.stackName)} is not the address stack of ${input.env === undefined ? "the legacy install" : `environment ${input.env}`} (${stackName}); the stack is derived from the environment`]);
  const stack = await describeStack(cloudFormation, stackName);
  // The address stack, and no other: it is the one with these outputs and this parameter.
  const previousApiId = parameterOf(stack, "ApiId");
  if (previousApiId === undefined || outputOf(stack, PUBLIC_API_ORIGIN_OUTPUT) === undefined) throw new FlipRefused([`${stackName} is not an address stack (no ApiId parameter and ${PUBLIC_API_ORIGIN_OUTPUT} output)`]);
  if (!UPDATABLE_STATUSES.has(stack.StackStatus ?? "")) throw new FlipRefused([`${stackName} is ${stack.StackStatus ?? "in an unknown status"}, not one a flip can start from`]);
  if (previousApiId === input.apiId) throw new FlipRefused([`the address already points at ${input.apiId}; there is nothing to flip`]);
  return { stackName, stack, previousApiId };
}

/** Best effort, and never a replacement for the reason the flip stopped: returns a sentence to append when the delete itself failed. */
async function discardChangeSet(cloudFormation: FlipCloudFormation, stackName: string, changeSetName: string): Promise<string[]> {
  try {
    await cloudFormation.send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }));
    return [];
  } catch (error) {
    return [`the change set ${changeSetName} could not be deleted (${error instanceof Error ? error.message : String(error)}); it was NOT executed, delete it by hand`];
  }
}

/** Waits for the change set to settle and returns the one logical id it would modify; deletes the change set and throws unless it is exactly the flip's one in-place Modify. */
async function checkedChangeSet(cloudFormation: FlipCloudFormation, polling: Polling, stackName: string, changeSetName: string, apiId: string): Promise<string> {
  let settled: DescribeChangeSetCommandOutput;
  try {
    settled = await waitFor(
      () => describeChangeSet(cloudFormation, stackName, changeSetName),
      (value) => value.Status === "CREATE_COMPLETE" || value.Status === "FAILED",
      polling,
      `change set ${changeSetName}`,
    );
  } catch (error) {
    // A change set that never settled may become available later, unchecked: remove it now.
    const leftover = await discardChangeSet(cloudFormation, stackName, changeSetName);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${leftover.length === 0 ? "; the change set was deleted" : `; ${leftover[0]}`}`, { cause: error });
  }
  if (settled.Status === "FAILED") throw new FlipRefused([`the change set could not be created: ${settled.StatusReason ?? "no reason given"}`, ...(await discardChangeSet(cloudFormation, stackName, changeSetName))]);
  const echoed = settled.Parameters?.find((parameter) => parameter.ParameterKey === "ApiId")?.ParameterValue;
  const problems = [...(echoed === undefined || echoed === apiId ? [] : [`the change set's ApiId is ${echoed}, not ${apiId}`]), ...flipChangeSetProblems(settled.Changes ?? [])];
  if (problems.length > 0) throw new FlipRefused([...problems, ...(await discardChangeSet(cloudFormation, stackName, changeSetName))]);
  return settled.Changes![0]!.ResourceChange!.LogicalResourceId ?? "?";
}

/** Runs the checked change set and judges the outcome only once it is final. */
async function executeChangeSet(cloudFormation: FlipCloudFormation, polling: Polling, stackName: string, changeSetName: string, apiId: string): Promise<void> {
  await cloudFormation.send(new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }));
  // CloudFormation can still report the pre-execute state for a moment after ExecuteChangeSet returns: judge nothing until the change set itself has finished executing
  // (its ExecutionStatus leaves AVAILABLE and EXECUTE_IN_PROGRESS), and only then until the stack has left every *_IN_PROGRESS status (a failed update then rolls back).
  await waitFor(
    () => describeChangeSet(cloudFormation, stackName, changeSetName),
    (value) => value.ExecutionStatus !== undefined && !["AVAILABLE", "EXECUTE_IN_PROGRESS"].includes(value.ExecutionStatus),
    polling,
    `change set ${changeSetName} to finish executing`,
  );
  const after = await waitFor(
    () => describeStack(cloudFormation, stackName),
    (value) => !(value.StackStatus ?? "").endsWith("_IN_PROGRESS"),
    polling,
    `stack ${stackName} to finish updating`,
  );
  if (after.StackStatus !== "UPDATE_COMPLETE") {
    throw new Error(`the flip did not complete: ${stackName} is ${after.StackStatus ?? "in an unknown status"}${after.StackStatus === "UPDATE_ROLLBACK_COMPLETE" ? " (rolled back: the address still points at the previous API)" : ""}`);
  }
  if (outputOf(after, "MappedApiId") !== apiId) throw new Error(`the stack updated but its MappedApiId output is ${outputOf(after, "MappedApiId") ?? "missing"}, not ${apiId}; check the address by hand`);
}

/** Creates the flip's change set and checks it; refuses (deleting the change set) unless it is exactly one in-place ApiMapping Modify. With `execute`, runs it and checks the outcome. */
export async function flipAddress(dependencies: FlipDependencies, input: FlipInput): Promise<FlipResult> {
  const { cloudFormation } = dependencies;
  const polling = { sleep: dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))), maxPolls: dependencies.maxPolls ?? 120 };
  if (!API_ID_PATTERN.test(input.apiId)) throw new FlipRefused([`${JSON.stringify(input.apiId)} is not an HTTP API id (10 lowercase letters and digits)`]);
  const changeSetName = input.changeSetName ?? `address-flip-${input.apiId}-${(dependencies.now ?? Date.now)()}`;
  if (!CHANGE_SET_NAME_PATTERN.test(changeSetName)) throw new FlipRefused([`${JSON.stringify(changeSetName)} is not a valid change set name`]);

  const { stackName, stack, previousApiId } = await checkedAddressStack(cloudFormation, input);
  // The previous template and every other parameter kept: the only difference is ApiId. No capabilities are passed, so a template that needs IAM refuses to create.
  const created = (await cloudFormation.send(new CreateChangeSetCommand({
    StackName: stackName,
    ChangeSetName: changeSetName,
    ChangeSetType: "UPDATE",
    UsePreviousTemplate: true,
    Description: `Point the address at API ${input.apiId} (was ${previousApiId})`,
    Parameters: (stack.Parameters ?? []).map((parameter) => parameter.ParameterKey === "ApiId"
      ? { ParameterKey: "ApiId", ParameterValue: input.apiId }
      : { ParameterKey: parameter.ParameterKey as string, UsePreviousValue: true }),
  }))) as { Id?: string };
  const mappingLogicalId = await checkedChangeSet(cloudFormation, polling, stackName, changeSetName, input.apiId);
  const result: FlipResult = { stackName, changeSetName, changeSetId: created.Id ?? changeSetName, previousApiId, apiId: input.apiId, mappingLogicalId, executed: false };
  if (input.execute !== true) return result;
  await executeChangeSet(cloudFormation, polling, stackName, changeSetName, input.apiId);
  return { ...result, executed: true };
}

interface Arguments {
  env: string | undefined;
  stackName: string | undefined;
  apiId: string;
  region: string | undefined;
  profile: string | undefined;
  changeSetName: string | undefined;
  execute: boolean;
}

export function parseFlipArguments(argv: readonly string[]): Arguments {
  const usage = "usage: address-flip.ts (--env <environment> | --legacy) --api-id <new HTTP API id> [--stack <check>] [--region r] [--profile p] [--change-set-name n] [--execute]";
  const values = new Map<string, string>();
  let execute = false;
  let legacy = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--execute") { execute = true; continue; }
    if (flag === "--legacy") { legacy = true; continue; }
    if (!["--env", "--stack", "--api-id", "--region", "--profile", "--change-set-name"].includes(flag)) throw new Error(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    values.set(flag, value);
    index += 1;
  }
  const env = values.get("--env");
  const apiId = values.get("--api-id");
  if (apiId === undefined || (env === undefined) === !legacy) throw new Error(usage);
  return { env, stackName: values.get("--stack"), apiId, region: values.get("--region"), profile: values.get("--profile"), changeSetName: values.get("--change-set-name"), execute };
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseFlipArguments(argv);
  const cloudFormation = awsCliCloudFormation({ region: args.region, profile: args.profile });
  const result = await flipAddress({ cloudFormation }, { env: args.env, apiId: args.apiId, execute: args.execute, ...(args.stackName === undefined ? {} : { stackName: args.stackName }), ...(args.changeSetName === undefined ? {} : { changeSetName: args.changeSetName }) });
  console.log(`${result.executed ? "Flipped" : "Change set ready"}: ${result.stackName} ${result.previousApiId} -> ${result.apiId} (the one Modify is ${result.mappingLogicalId}); change set ${result.changeSetName}`);
  if (!result.executed) console.log("Nothing was changed. Run it through the pipeline's approval step, or repeat with --execute.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
