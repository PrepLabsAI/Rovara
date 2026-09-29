// Spec 025 R6: change a few parameters of a deployed stack without a release: a change set with
// UsePreviousTemplate and UsePreviousValue for every other parameter, so NoEcho values are never
// sent again. It shows the parameter changes and the resource changes, and asks first.
import { CreateChangeSetCommand, DeleteChangeSetCommand, DescribeChangeSetCommand, DescribeStacksCommand, ExecuteChangeSetCommand, type Change, type Stack } from "@aws-sdk/client-cloudformation";
import { agentXError } from "@agentx/contracts";
import { SIGN_IN_SINCE_PARAMETER_NAMES } from "../signin/settings.js";
import type { ChangeSetChange } from "./deployer.js";

export interface ParameterChange { name: string; from: string; to: string }
export interface ParameterUpdateInput {
  cloudFormation: { send(command: unknown): Promise<unknown> };
  stackName: string; roleArn: string; changes: Record<string, string>;
  confirm: (event: { stackName: string; parameters: ParameterChange[]; changes: ChangeSetChange[] }) => Promise<boolean>;
  write: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number;
  /** Which command is changing the stack: names the change set and the messages. Default "sign-in". */
  label?: "sign-in" | "config";
}

const NO_CHANGES = ["didn't contain changes", "No updates are to be performed"];
const ENDED = new Set(["EXECUTE_COMPLETE", "EXECUTE_FAILED", "OBSOLETE"]);

/** DescribeChangeSet's own "gone" error, once CloudFormation has cleaned it up after execution;
 * mirrors templates-engine.ts's isChangeSetNotFound. Any other error while polling after execute
 * (throttling, a transient network error, ...) must be rethrown, never treated as "finished". */
function isChangeSetNotFound(error: unknown): boolean {
  return error instanceof Error && (error.name === "ChangeSetNotFoundException" || error.name === "ChangeSetNotFound");
}

export async function updateStackParameters(input: ParameterUpdateInput): Promise<{ changed: boolean }> {
  const label = input.label ?? "sign-in";
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = input.pollMs ?? 5_000;
  const deadline = now() + (input.timeoutMs ?? 30 * 60_000);
  const { stackName } = input;

  const describe = async (): Promise<Stack> => {
    try {
      const stack = ((await input.cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))) as { Stacks?: Stack[] }).Stacks?.[0];
      if (stack !== undefined) return stack;
    } catch (error) {
      if (!(error instanceof Error && error.name === "ValidationError" && /does not exist/.test(error.message))) throw error;
    }
    throw agentXError("CONFIG_INVALID", `stack ${stackName} does not exist; install the environment first`);
  };

  const stack = await describe();
  const status = stack.StackStatus ?? "";
  if (status.endsWith("_IN_PROGRESS")) throw agentXError("CONFIG_INVALID", `stack ${stackName} is busy (${status}); try again when it finishes`);
  if (status.endsWith("_FAILED") || status === "ROLLBACK_COMPLETE") throw agentXError("CONFIG_INVALID", `stack ${stackName} is ${status}; fix it in the CloudFormation console first`);
  const current = new Map((stack.Parameters ?? []).map((parameter) => [parameter.ParameterKey ?? "", parameter.ParameterValue ?? ""]));
  const missing = Object.keys(input.changes).filter((name) => !current.has(name));
  if (missing.length > 0 && label === "config") {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} has no ${missing.join(", ")} parameter; it runs an older AgentX release, so upgrade it with agentx upgrade, then run this again`);
  }
  if (missing.length > 0 && missing.every((name) => SIGN_IN_SINCE_PARAMETER_NAMES.has(name))) {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} was deployed from an older AgentX release (it has no ${missing.join(", ")} parameter); upgrade the environment with agentx deploy, then run this again`);
  }
  if (missing.length > 0) {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} was deployed from an AgentX release without developer sign-in (it has no ${missing.join(", ")} parameter); upgrade the environment to a release with developer sign-in, then run this again`);
  }
  const parameters = Object.entries(input.changes).filter(([name, to]) => current.get(name) !== to).map(([name, to]) => ({ name, from: current.get(name) ?? "", to }));
  if (parameters.length === 0) return { changed: false };

  const changeSetName = `agentx-${label === "config" ? "config" : "signin"}-${Math.floor(now() / 1000)}`;
  const id = { StackName: stackName, ChangeSetName: changeSetName };
  await input.cloudFormation.send(new CreateChangeSetCommand({
    ...id,
    ChangeSetType: "UPDATE",
    UsePreviousTemplate: true,
    Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
    RoleARN: input.roleArn,
    Parameters: [...current.keys()].map((key) => (Object.hasOwn(input.changes, key) ? { ParameterKey: key, ParameterValue: input.changes[key] } : { ParameterKey: key, UsePreviousValue: true })),
  }));
  const deleteChangeSet = () => input.cloudFormation.send(new DeleteChangeSetCommand(id)).catch(() => undefined);

  let changeSet: { Status?: string; StatusReason?: string; ExecutionStatus?: string; Changes?: Change[] };
  for (;;) {
    changeSet = await input.cloudFormation.send(new DescribeChangeSetCommand(id)) as typeof changeSet;
    if (changeSet.Status === "CREATE_COMPLETE" || changeSet.Status === "FAILED") break;
    if (now() > deadline) { await deleteChangeSet(); throw agentXError("RUNTIME_UNAVAILABLE", `the change set for ${stackName} took too long to prepare; nothing changed, run this again`); }
    await sleep(pollMs);
  }
  if (changeSet.Status === "FAILED") {
    await deleteChangeSet();
    if (NO_CHANGES.some((phrase) => (changeSet.StatusReason ?? "").includes(phrase))) return { changed: false };
    throw agentXError("CONFIG_INVALID", `the change set for ${stackName} failed: ${changeSet.StatusReason ?? "no reason given"}; nothing changed`);
  }
  const changes: ChangeSetChange[] = (changeSet.Changes ?? []).map((change) => ({
    action: change.ResourceChange?.Action ?? "", logicalId: change.ResourceChange?.LogicalResourceId ?? "",
    type: change.ResourceChange?.ResourceType ?? "", replacement: change.ResourceChange?.Replacement ?? "",
  }));
  if (!(await input.confirm({ stackName, parameters, changes }))) {
    await deleteChangeSet();
    throw agentXError("CONFIG_INVALID", `the ${label} change to ${stackName} was not applied; nothing changed`);
  }
  await input.cloudFormation.send(new ExecuteChangeSetCommand({ ...id, ClientRequestToken: changeSetName }));
  input.write(`Updating ${stackName}; this usually takes one to three minutes`);
  for (;;) {
    const executed = await input.cloudFormation.send(new DescribeChangeSetCommand(id)).catch((error: unknown) => {
      if (isChangeSetNotFound(error)) return undefined;
      throw error;
    }) as { ExecutionStatus?: string } | undefined;
    const finished = executed === undefined || ENDED.has(executed.ExecutionStatus ?? "");
    const stackStatus = finished ? (await describe()).StackStatus ?? "" : "";
    if (finished && !stackStatus.endsWith("_IN_PROGRESS")) {
      if (stackStatus !== "UPDATE_COMPLETE") throw agentXError("CONFIG_INVALID", `stack ${stackName} ended in ${stackStatus}; ${label === "config" ? "the setting" : "sign-in"} did not change. See the stack's events in the CloudFormation console`);
      return { changed: true };
    }
    if (now() > deadline) throw agentXError("RUNTIME_UNAVAILABLE", `stack ${stackName} is still updating after 30 minutes; check it in the CloudFormation console`);
    await sleep(pollMs);
  }
}
