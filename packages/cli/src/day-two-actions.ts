// SC-005: every AWS action each day-2 command uses. tests/contract/day-two-permissions.test.ts
// checks each is already allowed by the operator role, so a command that starts using a new action
// fails that test until the operator policy (and the spec) are changed on purpose.

/** agentx doctor's reads. It never starts drift detection (question 5): it reads the last result
 * from DescribeStacks. */
export const DOCTOR_AWS_ACTIONS: readonly string[] = [
  "ssm:GetParameter", "ssm:GetParametersByPath",
  "cloudformation:DescribeStacks",
  "secretsmanager:GetSecretValue",
  "bedrock:InvokeModel",
  "servicequotas:GetServiceQuota", "ec2:DescribeAddresses",
  "sns:ListSubscriptionsByTopic", "budgets:ViewBudget",
];
