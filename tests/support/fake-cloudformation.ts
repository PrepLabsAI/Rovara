// A CloudFormation client for parameter-only updates (spec 025 R6): one stack, one change set.
import { CreateChangeSetCommand, DeleteChangeSetCommand, DescribeChangeSetCommand, DescribeStacksCommand, ExecuteChangeSetCommand } from "@aws-sdk/client-cloudformation";

const STACK = "agentx-staging-control-plane";

/** The control plane's sign-in parameters as a fresh 25a install leaves them. */
export const SIGN_IN_PARAMETERS: Record<string, string> = {
  CallbackSigningKey: "****", SlackTeamId: "", DeveloperSignInSlack: "disabled", DeveloperOidcIssuer: "", DeveloperOidcClientId: "",
  DeveloperOidcRequiredClaim: "", DeveloperOidcRequiredValues: "[]", DeveloperOidcDisplayName: "Company sign-in",
  DeveloperSignInSlackSince: "0", DeveloperOidcSince: "0",
};

type Command = { constructor: { name: string }; input: Record<string, unknown> };

/** Applies an executed change set's parameters, so a later update sees the new values. */
export function fakeCloudFormation(options: { parameters?: Record<string, string>; status?: string; changeSet?: { status: "CREATE_COMPLETE" | "FAILED"; reason?: string }; finalStatus?: string; absent?: boolean } = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const parameters: Record<string, string> = { ...(options.parameters ?? { CallbackSigningKey: "****", SlackTeamId: "", DeveloperSignInSlack: "disabled", DeveloperOidcIssuer: "" }) };
  let pending: Array<{ ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean }> = [];
  let executed = false;
  return {
    calls,
    parameters,
    async send(command: Command): Promise<unknown> {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command instanceof DescribeStacksCommand) {
        if (options.absent) throw Object.assign(new Error(`Stack with id ${STACK} does not exist`), { name: "ValidationError" });
        return { Stacks: [{ StackName: STACK, StackStatus: executed ? options.finalStatus ?? "UPDATE_COMPLETE" : options.status ?? "UPDATE_COMPLETE", Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) }] };
      }
      if (command instanceof CreateChangeSetCommand) {
        pending = (command.input.Parameters ?? []) as typeof pending;
        executed = false;
        return { Id: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/agentx-signin/1" };
      }
      if (command instanceof DescribeChangeSetCommand) {
        return {
          Status: options.changeSet?.status ?? "CREATE_COMPLETE", StatusReason: options.changeSet?.reason,
          ExecutionStatus: executed ? "EXECUTE_COMPLETE" : "AVAILABLE",
          Changes: [{ ResourceChange: { Action: "Modify", LogicalResourceId: "DeveloperSignInFunction1A2B3C4D", ResourceType: "AWS::Lambda::Function", Replacement: "False" } }],
        };
      }
      if (command instanceof ExecuteChangeSetCommand) {
        executed = true;
        if ((options.finalStatus ?? "UPDATE_COMPLETE") === "UPDATE_COMPLETE") {
          for (const parameter of pending) if (parameter.ParameterValue !== undefined) parameters[parameter.ParameterKey] = parameter.ParameterValue;
        }
        return {};
      }
      if (command instanceof DeleteChangeSetCommand) return {};
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
}
