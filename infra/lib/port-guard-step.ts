// L14: the release pipeline's port-guard step. The controller's private name list (regular expressions, one per line) is an SSM SecureString in the release
// account. The pipeline carries only the parameter's NAME (a stack parameter, then a plain build variable); the value is fetched and decrypted inside the
// step by scripts/port-guard-pipeline.ts, never echoed, and a list that cannot be loaded fails the step (no run with only the built-in list).
//
// THIS FILE IS A GUARD FILE (scripts/port-guard.ts, `GUARD_FILES`): a change goes through review by hand.
import { CfnParameter, aws_iam as iam } from "aws-cdk-lib";
import type { Construct } from "constructs";

/** The build variable that carries the SSM parameter's name (never its value). */
export const PORT_GUARD_NAMES_PARAMETER_VARIABLE = "PORT_GUARD_NAMES_PARAMETER";

/** The stack parameter that takes the name. Required (no default), so a deploy without it fails instead of building a step that cannot load the list. */
export function portGuardNamesParameter(scope: Construct): CfnParameter {
  return new CfnParameter(scope, "PortGuardNamesParameterName", {
    type: "String",
    allowedPattern: "^/[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)*$",
    description: "Name of the SSM SecureString that holds the port guard's private name list (the name only, never the list)",
  });
}

/** Build variables for the step: the name, as plain text (it is not a secret). */
export function portGuardStepVariables(parameterName: string): Record<string, string> {
  return { [PORT_GUARD_NAMES_PARAMETER_VARIABLE]: parameterName };
}

const SAFE_ARG = /^[A-Za-z0-9_./:@=,-]+$/;

/**
 * The buildspec commands of the step. `set +x` first so no later command (or an inherited `set -x`) can print a value; the commands themselves never
 * touch the value. Fails the build when the variable is empty. The guard's own arguments (range, --allow-guard-edits, ...) come from the caller.
 */
export function portGuardStepCommands(guardArgs: readonly string[]): string[] {
  for (const arg of guardArgs) {
    if (!SAFE_ARG.test(arg)) throw new Error(`port-guard step: unsafe argument ${JSON.stringify(arg)}`);
  }
  const variable = "$" + PORT_GUARD_NAMES_PARAMETER_VARIABLE;
  return [
    "set +x",
    `test -n "${variable}" || { echo "port-guard: ${PORT_GUARD_NAMES_PARAMETER_VARIABLE} is not set; refusing to run without the private name list" >&2; exit 2; }`,
    `node scripts/port-guard-pipeline.ts ${guardArgs.join(" ")}`.trimEnd(),
  ];
}

export interface PortGuardNamesReadProps {
  partition: string;
  region: string;
  account: string;
  /** The SSM parameter's name, with its leading slash. */
  parameterName: string;
  /** The customer-managed key that encrypts the SecureString; omit only for the AWS-managed `alias/aws/ssm` key. */
  keyArn?: string;
}

/** The read grant for the build role: get that one parameter, decrypt with that one key through SSM. Nothing else. */
export function portGuardNamesReadStatements(props: PortGuardNamesReadProps): iam.PolicyStatement[] {
  const statements = [
    new iam.PolicyStatement({
      sid: "ReadPortGuardNames",
      actions: ["ssm:GetParameter"],
      resources: [`arn:${props.partition}:ssm:${props.region}:${props.account}:parameter${props.parameterName}`],
    }),
  ];
  if (props.keyArn !== undefined) {
    statements.push(
      new iam.PolicyStatement({
        sid: "DecryptPortGuardNames",
        actions: ["kms:Decrypt"],
        resources: [props.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `ssm.${props.region}.amazonaws.com` } },
      }),
    );
  }
  return statements;
}
