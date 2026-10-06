// SC-005: every AWS action each day-2 command uses. tests/contract/day-two-permissions.test.ts
// checks each is already allowed by the operator role, so a command that starts using a new action
// fails that test until the operator policy (and the spec) are changed on purpose. The lists are kept
// by hand; Task 20's IAM policy simulator run is the real proof that they cover every call.
export const CONFIG_AWS_ACTIONS: readonly string[] = [
  "sts:GetCallerIdentity",
  "ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter",
  "cloudformation:DescribeStacks", "cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet",
  "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet", "iam:PassRole",
  "bedrock:InvokeModel",
  "secretsmanager:GetSecretValue", "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:TagResource",
  // InitSecrets.arn reads a secret's ARN with DescribeSecret; an S3 HeadObject answers 404 only with ListBucket.
  "secretsmanager:DescribeSecret", "s3:ListBucket",
  "sns:ListSubscriptionsByTopic", "sns:Subscribe",
];

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

/** agentx upgrade's actions under the operator role: the templates engine's change sets, the access
 * stack comparison (GetTemplate), the settings and lock, the callback signing key, and doctor at the
 * end. Deploying a changed access stack, and any cdk-engine upgrade, need admin credentials
 * (question 9, ruling F20), so neither is listed. */
export const UPGRADE_AWS_ACTIONS: readonly string[] = [
  "sts:GetCallerIdentity",
  "ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter", "ssm:GetParametersByPath",
  "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:DescribeEvents", "cloudformation:GetTemplate",
  "cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet",
  "cloudformation:UpdateTerminationProtection", "iam:PassRole",
  "s3:GetObject", "s3:PutObject",
  // InitSecrets.arn reads a secret's ARN with DescribeSecret; an S3 HeadObject answers 404 only with ListBucket (ruling F13).
  "secretsmanager:DescribeSecret", "s3:ListBucket",
  "secretsmanager:GetSecretValue", "secretsmanager:CreateSecret", "secretsmanager:TagResource",
  ...DOCTOR_AWS_ACTIONS,
];
