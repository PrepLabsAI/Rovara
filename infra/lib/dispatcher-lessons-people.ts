import { aws_iam as iam } from "aws-cdk-lib";
import type { aws_dynamodb as dynamodb, aws_lambda as lambda } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES, TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES } from "@agentx/contracts";

/** The variable the dispatcher's lessons people port reads the sign-in table's name from (packages/broker/src/aws/worker-machines/dispatcher-people.ts); the broker's own is the same name. */
export const DISPATCHER_SIGNIN_TABLE_VARIABLE = "DEVELOPER_SIGNIN_TABLE_NAME";
export const DISPATCHER_LESSONS_PEOPLE_POLICY_ID = "DispatcherLessonsPeople";
/** The two statements' Sids; tests/contract/dispatcher-lessons-people-infrastructure.test.ts pins them. */
export const DISPATCHER_MEMBER_READ_SID = "ReadCompanyMemberRoster";
export const DISPATCHER_DEVELOPER_READ_SID = "ReadDeveloperDisplay";

/** One GetItem grant: this table, these partition-key prefixes, a projection inside these attributes. A read with no projection has no `dynamodb:Attributes` and falls to the `Null` condition's refusal. */
function signInRead(sid: string, table: { readonly tableArn: string }, leadingKeys: string, attributes: readonly string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid,
    actions: ["dynamodb:GetItem"],
    resources: [table.tableArn],
    conditions: {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [leadingKeys] },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": [...attributes] },
      // GetItem carries no dynamodb:Select, so this holds trivially; it keeps the grant a projected read if Select is ever sent.
      StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
    },
  });
}

/**
 * The dispatcher's lessons people port (aws/worker-machines/dispatcher-people.ts) reads who is on a project's roster, so a worker step is given the lessons learned from other people's tasks.
 * It needs the sign-in table's name and two reads of that table, and nothing else: one strongly consistent GetItem of `COMPANY_MEMBER#<id>`/`COMPANY` or of `DEVELOPER#<id>`/`META`, always with a
 * projection (the code refuses any other command, table, key or an unprojected read before sending it). The grant is therefore exactly `dynamodb:GetItem` on the table (not its indexes), one
 * statement per key family, each limited to its partition-key prefix and to the shared attribute lists the readers project (@agentx/contracts task-person-attributes.ts). No Query, no Scan, no write.
 * The sign-in table is AWS-managed encrypted, so there is no key grant. One inline policy of its own: the dispatcher's default policy is left as it is. Both layouts (the legacy install, named
 * environments) take it from the one call site, with no switch: while Slack company mode and company sign-in are off there are no member rows, so no source lesson is shown, as before.
 */
export function connectDispatcherLessonsPeople(scope: Construct, dispatcher: lambda.Function, signInTable: dynamodb.Table): iam.Policy {
  dispatcher.addEnvironment(DISPATCHER_SIGNIN_TABLE_VARIABLE, signInTable.tableName);
  return new iam.Policy(scope, DISPATCHER_LESSONS_PEOPLE_POLICY_ID, {
    roles: [dispatcher.role!],
    statements: [
      signInRead(DISPATCHER_MEMBER_READ_SID, signInTable, "COMPANY_MEMBER#*", TASK_PERSON_COMPANY_MEMBER_ATTRIBUTES),
      signInRead(DISPATCHER_DEVELOPER_READ_SID, signInTable, "DEVELOPER#*", TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES),
    ],
  });
}
