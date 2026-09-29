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
